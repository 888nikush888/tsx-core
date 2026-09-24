"""Bound, read-only Hyperliquid Testnet diagnostic; never grants provider acceptance.

The public entrypoint pins the direct HTTPS transport and CCXT classes. A separate
private seam admits synthetic transports only for offline tests. No key loader or order command.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import re
import sys
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Awaitable, Callable

import ccxt
import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "exchange_executor"))

import ccxt_profiles  # noqa: E402
from ccxt_client import _assert_hyperliquid_master_key_binding, _credential_fingerprint  # noqa: E402
from ccxt_profiles import PROFILES  # noqa: E402
from ccxt_sdk_policy import HyperliquidNoAutomaticSetup  # noqa: E402
from common import ExchangeContractError, external_account_cache_key, external_account_id  # noqa: E402
from hyperliquid_testnet_preflight import INFO_ENDPOINT, INFO_REQUEST_FIELDS, post_info  # noqa: E402

ORIGIN = "https://api.hyperliquid-testnet.xyz"
MAX_REQUESTS = 16
MAX_BODY_BYTES = 1024
WALLET = re.compile(r"0x[a-fA-F0-9]{40}\Z")
SYMBOL = re.compile(r"[A-Z0-9]{1,24}/USDC:USDC\Z")
InfoTransport = Callable[[dict[str, str], str], Awaitable[Any]]


class BoundPreflightRefused(ValueError):
    """Non-sensitive diagnostic failure; caller must not print its cause."""


def _refuse(condition: bool) -> None:
    if not condition:
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.")


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.")
        result[key] = value
    return result


def _request(url: Any, method: Any, body: Any, wallet: str, coin: str | None) -> dict[str, str]:
    _refuse(url == INFO_ENDPOINT and method == "POST" and isinstance(body, str)
            and len(body.encode("utf-8")) <= MAX_BODY_BYTES)
    try:
        payload = json.loads(body, object_pairs_hook=_object_pairs)
    except (ValueError, TypeError, UnicodeError):
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.") from None
    _refuse(isinstance(payload, dict) and isinstance(payload.get("type"), str)
            and set(payload) == INFO_REQUEST_FIELDS.get(payload["type"]))
    if "user" in payload:
        _refuse(isinstance(payload["user"], str) and WALLET.fullmatch(payload["user"]) is not None
                and hmac.compare_digest(payload["user"].lower(), wallet))
    if "coin" in payload:
        _refuse(coin is not None and payload["coin"] == coin)
    # An SDK default must not broaden market discovery to spot or HIP-3.
    _refuse(payload["type"] in {"spotMeta", "metaAndAssetCtxs", "userAbstraction", "userRole",
                                  "activeAssetData", "clearinghouseState", "openOrders"})
    return payload


class ReadOnlyInfoFetch:
    """Installed before CCXT construction and the first load_markets request."""

    _preflight_transport: InfoTransport
    _preflight_wallet: str
    _preflight_coin: str | None
    _preflight_requests: int

    async def fetch(self, url: Any, method: Any = "GET", headers: Any = None, body: Any = None) -> Any:
        _refuse(self._preflight_requests < MAX_REQUESTS)
        payload = _request(url, method, body, self._preflight_wallet, self._preflight_coin)
        _refuse(not getattr(self, "aiohttp_trust_env", False)
                and not any(getattr(self, name, None) for name in (
                    "httpProxy", "httpsProxy", "socksProxy", "aiohttp_proxy", "proxy", "proxyUrl")))
        self._preflight_requests += 1
        return await self._preflight_transport(payload, url)


def _guarded_class(sdk_class: type[Any]) -> type[Any]:
    return type("BoundReadOnlyHyperliquid", (ReadOnlyInfoFetch, HyperliquidNoAutomaticSetup, sdk_class), {})


async def _sdk_client(sdk_class: type[Any], secret: dict[str, str], wallet: str,
                      transport: InfoTransport) -> Any:
    client = _guarded_class(sdk_class)({
        "enableRateLimit": True, "timeout": 5_000, "aiohttp_trust_env": False,
        "privateKey": secret["privateKey"], "walletAddress": secret["walletAddress"],
        "options": {"defaultType": "swap", "builderFee": False,
                    "fetchMarkets": {"types": ["swap"]}},
    })
    client._preflight_transport = transport
    client._preflight_wallet = wallet
    client._preflight_coin = None
    client._preflight_requests = 0
    try:
        client.set_sandbox_mode(True)
        api = client.urls.get("api")
        _refuse(isinstance(api, dict) and api.get("public") == ORIGIN and api.get("private") == ORIGIN)
        return client
    except Exception:
        try:
            await client.close()
        except Exception:
            pass
        raise


def _decimal(value: Any) -> Decimal:
    _refuse(isinstance(value, str) and len(value) <= 64)
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.") from None
    _refuse(parsed.is_finite())
    return parsed


def _leverage(value: Any) -> Decimal:
    """Provider JSON numeric leverage, without accepting bool or non-finite floats."""
    _refuse(type(value) in (int, float) and 1 <= value <= 50
            and (type(value) is int or math.isfinite(value)))
    try:
        parsed = Decimal(str(value))
    except InvalidOperation:
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.") from None
    _refuse(parsed.is_finite() and parsed == parsed.to_integral_value() and 1 <= parsed <= 50)
    return parsed


def _market_scope(market: Any, symbol: str) -> str:
    _refuse(isinstance(market, dict) and market.get("symbol") == symbol
            and market.get("contract") is True and market.get("swap") is True
            and market.get("linear") is True and market.get("inverse") is False
            and market.get("spot") is False and market.get("option") is False
            and market.get("future") is False and market.get("settle") == "USDC"
            and market.get("active") is True and market.get("expiry") is None)
    info = market.get("info")
    coin = info.get("name") if isinstance(info, dict) else None
    _refuse(isinstance(coin, str) and re.fullmatch(r"[A-Z0-9]{1,24}", coin) is not None
            and market.get("base") == coin and ":" not in coin)
    return coin


def _flat_state(state: Any) -> None:
    _refuse(isinstance(state, dict) and isinstance(state.get("assetPositions"), list)
            and isinstance(state.get("marginSummary"), dict)
            and _decimal(state["marginSummary"].get("totalNtlPos")) == 0)
    for row in state["assetPositions"]:
        _refuse(isinstance(row, dict) and row.get("type") == "oneWay"
                and isinstance(row.get("position"), dict)
                and _decimal(row["position"].get("szi")) == 0)


async def direct_testnet_info(payload: dict[str, str], endpoint: str) -> Any:
    """The only real transport: direct CA-verified HTTPS, no proxies or redirects."""
    return await asyncio.to_thread(post_info, payload, endpoint=endpoint)


async def inspect_bound_testnet_account(
    account: dict[str, str], secret: dict[str, str], symbol: str,
) -> dict[str, Any]:
    """Operational diagnostic: pinned SDK and direct HTTPS only; never grants acceptance."""
    return await _inspect_bound_testnet_account_for_test(
        account, secret, symbol, transport=direct_testnet_info,
        rest_class=ccxt_async.hyperliquid, pro_class=ccxt_pro.hyperliquid,
    )


async def _inspect_bound_testnet_account_for_test(
    account: dict[str, str], secret: dict[str, str], symbol: str, *,
    transport: InfoTransport, rest_class: type[Any], pro_class: type[Any],
) -> dict[str, Any]:
    """Private fake seam for offline tests; callers must use the pinned public entrypoint."""
    _refuse(ccxt.__version__ == "4.5.75" and isinstance(account, dict)
            and account.get("exchange") == "hyperliquid" and account.get("mode") == "testnet"
            and isinstance(account.get("id"), str) and bool(account["id"])
            and isinstance(secret, dict) and set(secret) == {"privateKey", "walletAddress"}
            and isinstance(symbol, str) and SYMBOL.fullmatch(symbol) is not None
            and callable(transport))
    try:
        _assert_hyperliquid_master_key_binding(secret, "hyperliquid")
        wallet = secret["walletAddress"].lower()
        fingerprint = _credential_fingerprint(secret, "hyperliquid", "testnet")
        generation = external_account_cache_key("credential-generation", "v1", fingerprint)
        identity = external_account_id("hyperliquid", "testnet", wallet)
    except (ExchangeContractError, KeyError, TypeError, ValueError):
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.") from None
    _refuse(WALLET.fullmatch(wallet) is not None
            and isinstance(account.get("expectedAccountFingerprint"), str)
            and isinstance(account.get("credentialGeneration"), str)
            and hmac.compare_digest(identity, account["expectedAccountFingerprint"])
            and hmac.compare_digest(generation, account["credentialGeneration"]))
    rest = pro = None
    started = int(time.time() * 1000)
    try:
        rest = await _sdk_client(rest_class, secret, wallet, transport)
        pro = await _sdk_client(pro_class, secret, wallet, transport)
        await asyncio.wait_for(rest.load_markets(), timeout=30)
        coin = _market_scope(rest.market(symbol), symbol)
        rest._preflight_coin = coin
        role = await rest.publicPostInfo({"type": "userRole", "user": wallet})
        _refuse(isinstance(role, dict) and role.get("role") == "user")
        abstraction = await rest.publicPostInfo({"type": "userAbstraction", "user": wallet})
        _refuse(abstraction == "disabled")
        first_state = await rest.publicPostInfo({"type": "clearinghouseState", "user": wallet})
        _flat_state(first_state)
        first_orders = await rest.publicPostInfo({"type": "openOrders", "user": wallet})
        _refuse(isinstance(first_orders, list) and len(first_orders) == 0)
        asset = await rest.publicPostInfo({"type": "activeAssetData", "user": wallet, "coin": coin})
        _refuse(isinstance(asset, dict) and isinstance(asset.get("user"), str)
                and asset["user"].lower() == wallet and asset.get("coin") == coin
                and isinstance(asset.get("leverage"), dict)
                and asset["leverage"].get("type") == "cross"
                and _leverage(asset["leverage"].get("value")) > 0)
        state = await rest.publicPostInfo({"type": "clearinghouseState", "user": wallet})
        _flat_state(state)
        orders = await rest.publicPostInfo({"type": "openOrders", "user": wallet})
        _refuse(isinstance(orders, list) and len(orders) == 0)
        ended = int(time.time() * 1000)
        _refuse(ended >= started and ended - started <= 30_000)
        profile_bytes = Path(ccxt_profiles.__file__).read_bytes()
        return {
            "schemaVersion": 1, "environment": "hyperliquid-testnet", "scope": "diagnostic-only",
            "readOnly": True, "providerAcceptanceVerified": False, "exchange": "hyperliquid",
            "product": "swap:linear:USDC:first-dex", "symbol": symbol,
            "marginMode": "cross", "positionModeEvidence": "first-dex-oneway-contract; no open position readback",
            "ccxtVersion": ccxt.__version__, "profileVersion": PROFILES["hyperliquid"].profile_version,
            "profileFileSha256": hashlib.sha256(profile_bytes).hexdigest(),
            "accountReferenceHash": identity, "credentialGeneration": generation,
            "startedAt": started, "finishedAt": ended, "requestCount": rest._preflight_requests,
            "flat": True, "openOrderCount": 0,
        }
    except (BoundPreflightRefused, asyncio.TimeoutError):
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.") from None
    except Exception:
        # Never include SDK exceptions: they may contain wallet IDs or response bodies.
        raise BoundPreflightRefused("Hyperliquid Testnet read-only preflight is unproved.") from None
    finally:
        for client in (rest, pro):
            if client is not None:
                try:
                    await client.close()
                except Exception:
                    pass
