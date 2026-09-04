from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from dataclasses import asdict
from decimal import Decimal
from importlib.metadata import version as package_version
from typing import Any

from ccxt_client import credential_generation
from ccxt_profiles import ExchangeProfile, profile_for
from common import ExchangeContractError, RequestDeadline, external_account_id

CCXT_VERSION = "4.5.75"
MAX_EVIDENCE_AGE_MS = 10_000


class ModeReadError(ExchangeContractError):
    pass


def profile_hash(profile: ExchangeProfile) -> str:
    return hashlib.sha256(json.dumps(asdict(profile), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _now() -> int:
    return int(time.time() * 1000)


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ModeReadError(reason)


def _object(value: Any) -> dict[str, Any]:
    _require(isinstance(value, dict), "READBACK_SCHEMA_INVALID")
    return value


def _list(value: Any) -> list[dict[str, Any]]:
    _require(isinstance(value, list) and len(value) <= 10_000, "READBACK_LIST_MISSING_OR_UNBOUNDED")
    _require(all(isinstance(item, dict) for item in value), "READBACK_LIST_INVALID")
    return value


def _leverage(value: Any) -> int:
    _require(isinstance(value, (str, int)) and not isinstance(value, bool), "LEVERAGE_READBACK_MISSING")
    _require(re.fullmatch(r"[1-9][0-9]{0,3}(?:\.0+)?", str(value)) is not None, "LEVERAGE_READBACK_INVALID")
    return int(Decimal(str(value)))


async def _read_value(rest: Any, method: str, params: dict[str, Any], deadline: RequestDeadline) -> Any:
    operation = getattr(rest, method, None)
    _require(callable(operation), "MODE_READBACK_UNSUPPORTED")
    deadline.ensure(250)
    return await asyncio.wait_for(operation(params), timeout=deadline.sdk_timeout_seconds())


async def _read(rest: Any, method: str, params: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
    return _object(await _read_value(rest, method, params, deadline))


async def _bybit_account(rest: Any, deadline: RequestDeadline) -> dict[str, Any]:
    response = await _read(rest, "privateGetV5AccountInfo", {}, deadline)
    _require(type(response.get("retCode")) is int and response["retCode"] == 0, "ACCOUNT_MODE_READ_FAILED")
    result = _object(response.get("result"))
    _require(result.get("unifiedMarginStatus") in (3, 4, 5, 6), "ACCOUNT_MODE_UNSUPPORTED")
    _require(result.get("marginMode") in ("REGULAR_MARGIN", "ISOLATED_MARGIN", "PORTFOLIO_MARGIN"), "MARGIN_MODE_READBACK_MISSING")
    return result


async def _bybit(clients: Any, market: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
    account = await _bybit_account(clients.rest, deadline)
    response = await _read(clients.rest, "privateGetV5PositionList", {"category": "linear", "symbol": market["id"], "limit": 200}, deadline)
    _require(type(response.get("retCode")) is int and response["retCode"] == 0, "POSITION_MODE_READ_FAILED")
    result = _object(response.get("result"))
    _require(result.get("category") == "linear" and result.get("nextPageCursor") == "", "POSITION_MODE_SCOPE_INCOMPLETE")
    rows = _list(result.get("list"))
    _require(len(rows) > 0 and all(row.get("symbol") == market["id"] for row in rows), "POSITION_MODE_SYMBOL_UNPROVEN")
    _require(all(type(row.get("positionIdx")) is int and row["positionIdx"] in (0, 1, 2) for row in rows), "POSITION_MODE_READBACK_MISSING")
    _require(len(rows) == 1 and rows[0]["positionIdx"] == 0, "HEDGE_MODE_UNSUPPORTED")
    leverage = _leverage(rows[0].get("leverage"))
    mode = {"REGULAR_MARGIN": "cross", "ISOLATED_MARGIN": "isolated", "PORTFOLIO_MARGIN": "portfolio"}[account["marginMode"]]
    return {"positionMode": "oneway", "marginMode": mode, "leverage": leverage,
            "leverageSemantics": "configured", "sources": ["v5/account/info", "v5/position/list:symbol"]}


def _bound_hyperliquid_user(clients: Any) -> str:
    user = clients.account_identity
    _require(isinstance(user, str) and re.fullmatch(r"0x[a-fA-F0-9]{40}", user) is not None, "WALLET_BINDING_UNPROVEN")
    _require(str(getattr(clients.rest, "walletAddress", "")).lower() == user.lower(), "WALLET_BINDING_CHANGED")
    return user.lower()


async def _hyperliquid(clients: Any, market: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
    user = _bound_hyperliquid_user(clients)
    abstraction = await _hyperliquid_abstraction(clients.rest, user, deadline)
    _require(abstraction == 'disabled', 'ACCOUNT_MODE_UNSUPPORTED')
    coin = (market.get("info") or {}).get("name") or market.get("base")
    _require(isinstance(coin, str) and ":" not in coin and coin == market.get("base"), "PERP_DEX_SCOPE_UNPROVEN")
    result = await _read(clients.rest, "publicPostInfo", {"type": "activeAssetData", "user": user, "coin": coin}, deadline)
    _require(isinstance(result.get("user"), str) and result["user"].lower() == user and result.get("coin") == coin, "ACTIVE_ASSET_BINDING_MISMATCH")
    leverage = _object(result.get("leverage"))
    _require(leverage.get("type") in ("cross", "isolated"), "MARGIN_MODE_READBACK_MISSING")
    await _hyperliquid_position_consistency(clients.rest, user, coin, leverage, deadline)
    # The documented first-perp-dex AssetPosition is inherently oneWay; this is not a mutable CCXT flag.
    return {"positionMode": "oneway", "marginMode": leverage["type"], "leverage": _leverage(leverage.get("value")),
            "accountAbstraction": abstraction, "leverageSemantics": "configured",
            "sources": ["info/userAbstraction:user", "info/activeAssetData:user+coin", "info/clearinghouseState:user", "hyperliquid/AssetPosition:oneWay"]}


async def _hyperliquid_abstraction(rest: Any, user: str, deadline: RequestDeadline) -> str:
    value = await _read_value(rest, 'publicPostInfo', {'type': 'userAbstraction', 'user': user}, deadline)
    _require(isinstance(value, str) and value in ('disabled', 'default', 'dexAbstraction', 'unifiedAccount', 'portfolioMargin'),
             'ACCOUNT_MODE_UNSUPPORTED')
    return value


async def _hyperliquid_position_consistency(rest: Any, user: str, coin: str, leverage: dict[str, Any], deadline: RequestDeadline) -> None:
    state = await _read(rest, "publicPostInfo", {"type": "clearinghouseState", "user": user}, deadline)
    seen: set[str] = set()
    for row in _list(state.get("assetPositions")):
        _require(row.get("type") == "oneWay", "POSITION_MODE_CONTRADICTORY")
        position = _object(row.get("position"))
        symbol = position.get("coin")
        _require(isinstance(symbol, str) and bool(symbol) and symbol not in seen, "POSITION_MODE_CONTRADICTORY")
        seen.add(symbol)
        if symbol == coin:
            actual = _object(position.get("leverage"))
            _require(actual.get("type") == leverage["type"] and _leverage(actual.get("value")) == _leverage(leverage.get("value")),
                     "LEVERAGE_READBACK_CONTRADICTORY")


async def _kraken_data(rest: Any, deadline: RequestDeadline) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    preferences = await _read(rest, "privateGetLeveragepreferences", {}, deadline)
    positions = await _read(rest, "privateGetOpenpositions", {}, deadline)
    _require(preferences.get("result") == "success" and positions.get("result") == "success", "KRAKEN_MODE_READ_FAILED")
    return _list(preferences.get("leveragePreferences")), _list(positions.get("openPositions"))


def _unique_symbol_rows(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result = {}
    for row in rows:
        symbol = row.get("symbol")
        _require(isinstance(symbol, str) and bool(symbol), "MODE_SYMBOL_MISSING")
        key = symbol.upper()
        _require(key not in result, "POSITION_MODE_CONTRADICTORY")
        result[key] = row
    return result


async def _kraken(clients: Any, market: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
    symbol = str(market.get("id") or "").upper()
    _require(symbol.startswith("PF_"), "KRAKEN_CROSS_MARKET_SCOPE_UNPROVEN")
    preferences, positions = await _kraken_data(clients.rest, deadline)
    preference = _unique_symbol_rows(preferences).get(symbol)
    position = _unique_symbol_rows(positions).get(symbol)
    mode = "cross"
    if preference is not None:
        _leverage(preference.get("maxLeverage"))
        mode = "isolated"
    if position is not None and position.get("maxFixedLeverage") is not None:
        _leverage(position["maxFixedLeverage"])
        mode = "isolated"
    # Cross's effective leverage is not a configurable integer. PUT maxLeverage would switch to isolated.
    return {"positionMode": "oneway", "marginMode": mode, "leverage": None,
            "leverageSemantics": "effective_collateral_ratio",
            "sources": ["v3/leveragepreferences:complete", "v3/openpositions:complete", "kraken/derivatives:netting"]}


def _base_evidence(clients: Any, market: dict[str, Any]) -> dict[str, Any]:
    account = clients.account
    profile = profile_for(account["exchange"])
    _require(profile is not None, "EXECUTION_PROFILE_UNSUPPORTED")
    observed = _now()
    return {"version": 1, "exchange": account["exchange"], "symbol": f'{str(market["base"]).upper()}USDT', "providerSymbol": market["symbol"],
            "accountFingerprint": external_account_id(account["exchange"], account["mode"], clients.account_identity),
            "credentialGeneration": credential_generation(clients), "ccxtVersion": package_version("ccxt"),
            "profileVersion": profile.profile_version, "profileHash": profile_hash(profile),
            "providerApiVersion": profile.execution_capabilities.provider_api_version,
            "origin": "public_bound_account" if account["exchange"] == "hyperliquid" else "authenticated",
            "observedAt": observed, "expiresAt": observed + MAX_EVIDENCE_AGE_MS, "entryAllowed": False,
            "reason": None, "positionMode": "unknown", "marginMode": "unknown", "leverage": None,
            "accountAbstraction": None, "leverageSemantics": "unknown", "sources": []}


async def read_entry_constraints(clients: Any, market: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
    result = _base_evidence(clients, market)
    try:
        _require(result["ccxtVersion"] == CCXT_VERSION, "CCXT_VERSION_UNREVIEWED")
        reader = {"bybit": _bybit, "hyperliquid": _hyperliquid, "krakenfutures": _kraken}[clients.account["exchange"]]
        result.update(await reader(clients, market, deadline))
        _require(result["positionMode"] == "oneway", "POSITION_MODE_UNSUPPORTED")
        _require(result["marginMode"] == "cross", "MARGIN_MODE_UNSUPPORTED")
        _require(_now() < result["expiresAt"], "MODE_READBACK_EXPIRED")
        result["entryAllowed"] = True
    except ModeReadError as error:
        result["reason"] = str(error)
    except TimeoutError:
        result["reason"] = "MODE_READBACK_TIMEOUT"
    except Exception:
        result["reason"] = "MODE_READBACK_FAILED"
    return result


def assert_entry_constraints(clients: Any, market: dict[str, Any], evidence: dict[str, Any]) -> None:
    expected = _base_evidence(clients, market)
    for field in ("version", "exchange", "symbol", "providerSymbol", "accountFingerprint", "credentialGeneration",
                  "ccxtVersion", "profileVersion", "profileHash", "providerApiVersion", "origin"):
        _require(evidence.get(field) == expected[field], "EXECUTION_MODE_BINDING_CHANGED")
    _require(expected["ccxtVersion"] == CCXT_VERSION, "CCXT_VERSION_UNREVIEWED")
    _require(evidence.get("entryAllowed") is True and evidence.get("reason") is None, "EXECUTION_MODE_NOT_PROVEN")
    _require(evidence.get("positionMode") == "oneway" and evidence.get("marginMode") == "cross", "EXECUTION_MODE_UNSUPPORTED")
    if clients.account['exchange'] == 'hyperliquid':
        _require(evidence.get('accountAbstraction') == 'disabled', 'ACCOUNT_MODE_UNSUPPORTED')
    start, end = evidence.get("observedAt"), evidence.get("expiresAt")
    _require(type(start) is int and type(end) is int and 0 <= _now() - start < MAX_EVIDENCE_AGE_MS
             and end == start + MAX_EVIDENCE_AGE_MS and _now() < end, "EXECUTION_MODE_EVIDENCE_EXPIRED")


async def read_account_mode_observation(clients: Any, deadline: RequestDeadline) -> dict[str, Any]:
    """Credential/account verification is not permission to enter an arbitrary symbol."""
    result: dict[str, Any] = {"verified": False, "entryAllowed": False, "requiresSymbolRead": True,
                              "reason": None, "observedAt": _now(), "scope": "account_observation", "ccxtVersion": package_version("ccxt")}
    try:
        _require(package_version("ccxt") == CCXT_VERSION, "CCXT_VERSION_UNREVIEWED")
        exchange = clients.account["exchange"]
        if exchange == "bybit":
            account = await _bybit_account(clients.rest, deadline)
            result.update({"marginMode": account["marginMode"], "origin": "authenticated"})
        elif exchange == "krakenfutures":
            preferences, positions = await _kraken_data(clients.rest, deadline)
            _unique_symbol_rows(preferences)
            _unique_symbol_rows(positions)
            result.update({"marginMode": "symbol_specific", "origin": "authenticated"})
        else:
            user = _bound_hyperliquid_user(clients)
            result['accountAbstraction'] = await _hyperliquid_abstraction(clients.rest, user, deadline)
            state = await _read(clients.rest, "publicPostInfo", {"type": "clearinghouseState", "user": user}, deadline)
            positions = _list(state.get("assetPositions"))
            _require(all(row.get("type") == "oneWay" for row in positions), "POSITION_MODE_CONTRADICTORY")
            result.update({"marginMode": "symbol_specific", "origin": "public_bound_account"})
        _require(0 <= _now() - result['observedAt'] < MAX_EVIDENCE_AGE_MS, "MODE_READBACK_EXPIRED")
        result["verified"] = True
    except ModeReadError as error:
        result["reason"] = str(error)
    except Exception:
        result["reason"] = "ACCOUNT_MODE_READBACK_FAILED"
    return result
