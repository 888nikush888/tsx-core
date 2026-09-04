"""Keep native execution namespaces separate from display IDs and observations."""
from __future__ import annotations

import re
from typing import Any


def _bybit_namespace(market: dict[str, Any]) -> str | None:
    if market.get("option") is True:
        return "option"
    if market.get("spot") is True:
        return "spot"
    if market.get("linear") is True:
        return "linear"
    if market.get("inverse") is True:
        return "inverse"
    return None


def _identifier(value: Any) -> bool:
    return (isinstance(value, str) and bool(value) and value.strip() == value and len(value) <= 256
            and not any(ord(character) < 32 for character in value))


def _timestamp(value: Any) -> bool:
    return type(value) is int and 0 <= value <= 9_007_199_254_740_991


def _numeric_id(value: Any) -> str | None:
    if type(value) in (str, int) and re.fullmatch(r"[0-9]{1,256}", str(value)):
        return str(value)
    return None


def hyperliquid_market_coin(market: dict[str, Any]) -> str | None:
    """CCXT 4.5.75 market.id is an asset index, never the native fill/order coin.

    fetch_swap_markets preserves universe.name in both baseName and info.name.
    Keep that exact native name; do not reconstruct it from unified symbols or
    accept a spot market merely because its ID happens to equal info.coin.
    """
    if (market.get("contract") is not True or market.get("swap") is not True
            or any(market.get(flag) is not False for flag in ("spot", "option", "future"))):
        return None
    info, coin = market.get("info"), market.get("baseName")
    if not isinstance(info, dict) or not _identifier(coin) or info.get("name") != coin:
        return None
    return coin


def _bybit_identity(market: dict[str, Any], trade: dict[str, Any], info: dict[str, Any]) -> str | None:
    namespace = _bybit_namespace(market)
    if (not namespace or info.get("execId") != trade["id"] or info.get("symbol") != market["id"]
            or info.get("orderId") != trade["order"] or type(info.get("execTime")) not in (str, int)
            or str(info["execTime"]) != str(trade["timestamp"])
            or ("category" in info and info["category"] != namespace)):
        return None
    return namespace


def _hyperliquid_identity(market: dict[str, Any], trade: dict[str, Any], info: dict[str, Any]) -> str | None:
    coin = hyperliquid_market_coin(market)
    if (coin is None or info.get("coin") != coin or _numeric_id(info.get("tid")) != trade["id"]
            or _numeric_id(info.get("oid")) != trade["order"] or not _timestamp(info.get("time"))
            or info["time"] != trade["timestamp"]):
        return None
    return coin


def _kraken_identity(market: dict[str, Any], trade: dict[str, Any], info: dict[str, Any]) -> bool:
    return (info.get("identitySource") == "kraken_history_execution_v3"
            and info.get("executionUid") == trade["id"] and info.get("orderUid") == trade["order"]
            and info.get("tradeable") == market["id"] and _identifier(info.get("accountUid"))
            and _timestamp(info.get("executionTimestamp")) and info["executionTimestamp"] == trade["timestamp"])


def native_fill_identity(exchange: str, market: dict[str, Any], trade: dict[str, Any]) -> dict[str, Any] | None:
    info = trade.get("info")
    if (not isinstance(info, dict) or not all(_identifier(market.get(key)) for key in ("id", "symbol"))
            or not all(_identifier(trade.get(key)) for key in ("id", "order"))
            or trade.get("symbol") != market["symbol"] or not _timestamp(trade.get("timestamp"))):
        return None
    profile, namespace, stamp = "", None, None
    provider_market_id = market["id"]
    if exchange == "bybit":
        profile, namespace = "bybit_execution_v1", _bybit_identity(market, trade, info)
    elif exchange == "hyperliquid":
        coin = _hyperliquid_identity(market, trade, info)
        if coin is not None:
            profile, namespace, stamp, provider_market_id = "hyperliquid_user_fill_v1", "perpetual", info["time"], coin
    elif exchange == "krakenfutures" and _kraken_identity(market, trade, info):
        profile, namespace = "kraken_history_execution_v3", "futures"
    if not namespace:
        return None
    return {"version": 1, "profile": profile, "marketNamespace": namespace, "providerMarketId": provider_market_id,
            "providerSymbol": market["symbol"], "providerFillId": trade["id"], "scopeTimestamp": stamp}
