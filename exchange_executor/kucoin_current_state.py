"""Complete raw current-state reader for the bounded KuCoin Classic scope."""
from __future__ import annotations

from typing import Any

from common import IncompleteCurrentStateError
from current_state import CurrentRead
from history_reader import now_ms
from kucoin_provider_common import (
    MAX_SAFE_INTEGER,
    envelope,
    exact_decimal,
    exact_integer,
    market_for,
    native_symbol,
    original,
    provider_page,
    require,
    rows,
    token,
)


PAGE_SIZE = 50


def _whole(value: Any, label: str, *, signed: bool = False) -> int:
    pattern = r"-?(?:0|[1-9][0-9]{0,18})" if signed else r"(?:0|[1-9][0-9]{0,18})"
    if type(value) is str:
        import re

        require(re.fullmatch(pattern, value) is not None,
                f"KuCoin {label} must be an exact whole-contract count.")
        value = int(value)
    lower = -MAX_SAFE_INTEGER if signed else 0
    require(type(value) is int and lower <= value <= MAX_SAFE_INTEGER,
            f"KuCoin {label} must be an exact whole-contract count.")
    return value


def _provider_time(response: Any) -> None:
    value = envelope(response, "server timestamp")
    observed = exact_integer(value, "server timestamp")
    if abs(now_ms() - observed) > 30_000:
        raise IncompleteCurrentStateError("discovery", "provider_snapshot_not_fresh")


def _position(rest: Any, raw: dict[str, Any]) -> dict[str, Any] | None:
    symbol = native_symbol(raw.get("symbol"))
    market = market_for(rest, symbol)
    require(raw.get("settleCurrency") == "USDT" and raw.get("isInverse") is False,
            "Unmanaged non-USDT or inverse KuCoin position requires account review.")
    require(raw.get("crossMode") is True and raw.get("marginMode") == "CROSS"
            and raw.get("positionSide") == "BOTH",
            "KuCoin position is outside the reviewed CROSS/BOTH scope.")
    quantity = _whole(raw.get("currentQty"), "position currentQty", signed=True)
    if quantity == 0:
        return None
    entry = exact_decimal(raw.get("avgEntryPrice"), "position entry price", positive=True)
    mark = exact_decimal(raw.get("markPrice"), "position mark price", positive=True)
    unrealized = exact_decimal(raw.get("unrealisedPnl"), "position unrealized PnL", signed=True)
    leverage = exact_integer(raw.get("realLeverage"), "position leverage", minimum=1,
                             maximum=125)
    return {
        "id": token(raw.get("id"), "position id"),
        "symbol": market["symbol"],
        "providerSymbol": symbol,
        "side": "long" if quantity > 0 else "short",
        "contracts": str(abs(quantity)),
        "entryPrice": entry,
        "markPrice": mark,
        "unrealizedPnl": unrealized,
        "leverage": leverage,
        "marginMode": "cross",
        "info": original(raw),
    }


def _status(raw: dict[str, Any]) -> str:
    value = raw.get("status")
    require(type(value) is str, "KuCoin order status is missing.")
    mapped = {
        "active": "open",
        "open": "open",
        "done": "closed",
        "filled": "closed",
        "cancelled": "canceled",
        "canceled": "canceled",
        "rejected": "rejected",
    }.get(value.lower())
    require(mapped is not None, "KuCoin order status is outside the reviewed vocabulary.")
    is_active = raw.get("isActive")
    cancel_exists = raw.get("cancelExist")
    require(type(is_active) is bool and type(cancel_exists) is bool,
            "KuCoin order activity evidence is missing.")
    require((mapped == "open") == is_active,
            "KuCoin order status conflicts with its activity flag.")
    require(not cancel_exists or mapped == "canceled",
            "KuCoin order cancellation evidence is contradictory.")
    return mapped


def normalize_kucoin_order(rest: Any, raw: dict[str, Any], *, stop_scope: bool,
                           terminal_allowed: bool) -> dict[str, Any]:
    symbol = native_symbol(raw.get("symbol"))
    market = market_for(rest, symbol)
    require(raw.get("settleCurrency") == "USDT" and raw.get("marginMode") == "CROSS"
            and raw.get("positionSide") == "BOTH",
            "KuCoin order is outside the reviewed USDT/CROSS/BOTH scope.")
    reduce_only = raw.get("reduceOnly")
    require(type(reduce_only) is bool, "KuCoin order reduce-only evidence is missing.")
    side = raw.get("side")
    require(side in {"buy", "sell"}, "KuCoin order side is invalid.")
    order_type = token(raw.get("type"), "order type").lower()
    require(order_type in {"limit", "market"}, "KuCoin order type is outside the reviewed scope.")
    quantity = _whole(raw.get("size"), "order size")
    filled = _whole(raw.get("dealSize"), "order filled size")
    require(quantity > 0 and filled <= quantity, "KuCoin order quantity evidence is inconsistent.")
    price = exact_decimal(raw.get("price"), "order price")
    leverage = exact_integer(raw.get("leverage"), "order leverage", minimum=1, maximum=125)
    status = _status(raw)
    require(terminal_allowed or status == "open",
            "KuCoin current-order page contains a terminal order.")
    stop_kind = raw.get("stop")
    if stop_scope:
        require(stop_kind in {"up", "down"} and reduce_only,
                "KuCoin stop scope contains an unprotected or non-stop order.")
        trigger = exact_decimal(raw.get("stopPrice"), "stop trigger price", positive=True)
        trigger_type = token(raw.get("stopPriceType"), "stop trigger type")
    else:
        require(stop_kind in {None, ""}, "KuCoin normal-order scope contains a stop order.")
        require(raw.get("stopPrice") is None and raw.get("stopPriceType") in {None, ""},
                "KuCoin normal order contains unexpected trigger evidence.")
        trigger = None
        trigger_type = None
    return {
        "id": token(raw.get("id"), "order id"),
        "clientOrderId": token(raw.get("clientOid"), "client order id", nullable=True),
        "symbol": market["symbol"],
        "providerSymbol": symbol,
        "type": order_type,
        "side": side,
        "amount": str(quantity),
        "filled": str(filled),
        "remaining": str(quantity - filled),
        "price": None if price == "0" else price,
        "triggerPrice": trigger,
        "triggerType": trigger_type,
        "reduceOnly": reduce_only,
        "leverage": leverage,
        "marginMode": "cross",
        "status": status,
        "timestamp": exact_integer(raw.get("createdAt"), "order creation time"),
        "lastUpdateTimestamp": exact_integer(raw.get("updatedAt"), "order update time"),
        "info": original(raw),
    }


async def _positions(rest: Any, read: CurrentRead) -> None:
    scope = "classic:positions"
    read.begin("positions", [scope])
    response = await read.call("positions", scope, lambda: rest.futuresPrivateGetPositions({}))
    for raw in rows(envelope(response, "positions"), "positions"):
        parsed = _position(rest, raw)
        if parsed is not None:
            read.add("positions", parsed)
    read.complete("positions", scope)


async def _order_scope(rest: Any, read: CurrentRead, scope: str, method: Any,
                       *, stop_scope: bool) -> None:
    page_number = 1
    expected_total = None
    seen = 0
    while True:
        params = {"currentPage": page_number, "pageSize": PAGE_SIZE}
        if not stop_scope:
            params["status"] = "active"
        response = await read.call("orders", scope, lambda: method(dict(params)))
        page_rows, total_pages, total = provider_page(response, scope, page_number, PAGE_SIZE)
        require(expected_total is None or total == expected_total,
                "KuCoin current-order total changed during pagination.")
        expected_total = total
        seen += len(page_rows)
        for raw in page_rows:
            read.add("orders", normalize_kucoin_order(rest, raw, stop_scope=stop_scope,
                                                       terminal_allowed=False))
        if page_number >= total_pages:
            require(seen == total,
                    "KuCoin current-order pages do not cover their declared total.")
            read.complete("orders", scope)
            return
        page_number += 1


async def _orders(rest: Any, read: CurrentRead) -> None:
    normal = "classic:orders:active"
    stops = "classic:stops:active"
    read.begin("orders", [normal, stops])
    await _order_scope(rest, read, normal, rest.futuresPrivateGetOrders, stop_scope=False)
    await _order_scope(rest, read, stops, rest.futuresPrivateGetStopOrders, stop_scope=True)


async def read_kucoin_current_state(rest: Any, read: CurrentRead, *,
                                    provider_account_uid: str) -> dict[str, Any]:
    uid = token(provider_account_uid, "account uid")
    _provider_time(await read.budget.call(lambda: rest.publicGetTimestamp({})))
    await _positions(rest, read)
    await _orders(rest, read)
    return {
        "providerAccountUid": uid,
        "orders": list(read.orders.values()),
        "positions": list(read.positions.values()),
        "sources": list(read.sources.values()),
    }
