"""Positive native identity witnesses; these never create Node journal ownership."""
from __future__ import annotations

import re
from typing import Any

from common import ExchangeContractError
from fill_identity import hyperliquid_market_coin


def batch_tag_params(request: dict[str, Any], exchange: str) -> dict[str, str]:
    tag = request.get("providerBatchTag")
    if tag is None:
        return {}
    if exchange != "krakenfutures" or tag != {"version": 1, "tag": request.get("clientOrderId")}:
        raise ExchangeContractError("Batch identity tag is not bound to this provider and request.")
    return {"order_tag": tag["tag"]}


def observed_parent_fields(order: dict[str, Any], market: dict[str, Any], exchange: str) -> dict[str, Any]:
    info = order.get("info")
    if exchange != "bybit" or not isinstance(info, dict) or not info.get("parentOrderLinkId"):
        return {}
    parent = info["parentOrderLinkId"]
    if not isinstance(parent, str) or len(parent) > 256 or info.get("orderId") != order.get("id") or info.get("symbol") != market.get("id"):
        raise ExchangeContractError("Bybit parent observation has inconsistent native identity.")
    # Observation only: current certified_batch journals do not prove an attached-parent request.
    return {"providerParentOrderLinkId": parent, "providerParentMarketId": info["symbol"],
            "providerParentStopType": info.get("stopOrderType")}


def kraken_batch_identity(order: dict[str, Any], specs: tuple[dict[str, Any], dict[str, Any]]) -> dict[str, Any] | None:
    info = order.get("info")
    if not isinstance(info, dict) or not isinstance(info.get("order_tag"), str):
        return None
    tag = info["order_tag"]
    matched = [spec for spec in specs if spec["params"].get("order_tag") == tag
               and spec["params"].get("clientOrderId") == tag]
    if len(matched) != 1 or info.get("order_id") != order.get("id"):
        return None
    client = order.get("clientOrderId") or order.get("client_order_id")
    if client is not None and client != tag:
        return None
    symbol = matched[0].get("symbol")
    if not symbol or (order.get("symbol") is not None and order["symbol"] != symbol):
        return None
    return {"version": 1, "profile": "kraken_batch_tag_v1", "tag": tag, "clientOrderId": tag,
            "exchangeOrderId": order["id"], "providerSymbol": symbol}


def cloid_lookup_scope(rest: Any, client_id: str) -> str:
    user = getattr(rest, "walletAddress", None)
    if not isinstance(user, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", user):
        raise ExchangeContractError("Cloid lookup omitted its exact configured account scope.")
    if not re.fullmatch(r"0x[0-9a-fA-F]{32}", client_id):
        raise ExchangeContractError("Cloid lookup requires the original provider client identifier.")
    return user.lower()


def cloid_lookup_identity(rest: Any, order: dict[str, Any], client_id: str, symbol: str,
                          user: str, started: int, completed: int) -> dict[str, Any]:
    info = order.get("info")
    native = info.get("order") if isinstance(info, dict) else None
    if not isinstance(native, dict):
        raise ExchangeContractError("Cloid lookup omitted its original provider order.")
    market = rest.market(symbol)
    oid = native.get("oid")
    if (type(oid) not in (str, int) or str(oid) != order.get("id")
            or not re.fullmatch(r"[0-9]{1,256}", str(oid))):
        raise ExchangeContractError("Cloid lookup returned a conflicting native order identity.")
    coin = hyperliquid_market_coin(market)
    if order.get("symbol") != symbol or coin is None or native.get("coin") != coin:
        raise ExchangeContractError("Cloid lookup returned a conflicting native market identity.")
    if any(value is not None and value != client_id for value in (order.get("clientOrderId"), native.get("cloid"))):
        raise ExchangeContractError("Cloid lookup returned a conflicting client identity.")
    witness = {"version": 1, "profile": "hyperliquid_cloid_lookup_v1", "clientOrderId": client_id,
               "exchangeOrderId": order["id"], "providerSymbol": symbol, "providerMarketId": native["coin"],
               "user": user, "startedAt": started, "completedAt": completed}
    return {**order, "identityEvidence": witness, "_identityOriginal": order}
