"""One-page raw KuCoin Classic order/fill history adapter.

Traversal is resumable but never promoted to complete: KuCoin's documented
retention and non-real-time fill history leave an unavoidable evidence gap.
"""
from __future__ import annotations

import re
from typing import Any

from history_reader import RecoveryReadBudget
from kucoin_current_state import normalize_kucoin_order
from kucoin_provider_common import (
    exact_decimal,
    exact_integer,
    market_for,
    native_symbol,
    original,
    provider_page,
    require,
    token,
)


DAY = 86_400_000
OVERLAP = 1_000
PAGE_SIZE = 50


def _state(value: Any, expected_uid: str) -> dict[str, Any]:
    require(type(value) is dict and value.get("source") in {"orders", "fills"},
            "Invalid KuCoin history checkpoint source.")
    result = dict(value)
    provider_symbol = result.get("providerSymbol")
    result["providerSymbol"] = (native_symbol(provider_symbol)
                                if provider_symbol is not None else None)
    uid = token(result.get("providerAccountUid"), "history account uid")
    require(uid == token(expected_uid, "expected history account uid"),
            "KuCoin history account identity drifted.")
    for field in ("baselineSince", "windowSince", "windowUntil"):
        result[field] = exact_integer(result.get(field), f"history {field}")
    require(result["baselineSince"] <= result["windowSince"] <= result["windowUntil"]
            and result["windowUntil"] - result["windowSince"] <= 7 * DAY,
            "KuCoin history window is invalid or exceeds seven days.")
    cursor = result.get("cursor")
    require(cursor is None or (type(cursor) is str
            and re.fullmatch(r"[1-9][0-9]{0,8}(?::[0-9]{1,9})?", cursor)),
            "KuCoin history cursor is invalid.")
    return result


def _large_integer(value: Any, label: str) -> int:
    if type(value) is str:
        require(re.fullmatch(r"(?:0|[1-9][0-9]{0,20})", value) is not None,
                f"KuCoin {label} must be an exact provider integer.")
        value = int(value)
    require(type(value) is int and 0 <= value <= 99_999_999_999_999_999_999,
            f"KuCoin {label} must be an exact provider integer.")
    return value


def _fill(rest: Any, raw: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    symbol = native_symbol(raw.get("symbol"))
    require(state["providerSymbol"] is None or symbol == state["providerSymbol"],
            "KuCoin fill returned outside its requested provider symbol.")
    market = market_for(rest, symbol)
    require(raw.get("feeCurrency") == "USDT" and raw.get("settleCurrency") == "USDT",
            "KuCoin fill is not wholly denominated in USDT.")
    require(raw.get("marginMode") == "CROSS" and raw.get("positionSide") == "BOTH",
            "KuCoin fill is outside the reviewed CROSS/BOTH scope.")
    require(raw.get("tradeType") == "trade", "KuCoin fill type is outside the reviewed scope.")
    side = raw.get("side")
    require(side in {"buy", "sell"}, "KuCoin fill side is invalid.")
    size = exact_integer(raw.get("size"), "fill size", minimum=1)
    price = exact_decimal(raw.get("price"), "fill price", positive=True)
    fee = exact_decimal(raw.get("fee"), "fill fee", signed=True)
    created = exact_integer(raw.get("createdAt"), "fill creation time")
    native_time = _large_integer(raw.get("tradeTime"), "fill trade time")
    event_time = native_time // 1_000_000
    require(0 <= created - event_time <= 60_000,
            "KuCoin fill creation time precedes or is detached from its event time.")
    require(state["windowSince"] <= event_time <= state["windowUntil"],
            "KuCoin fill falls outside the requested history window.")
    trade_id = token(raw.get("tradeId"), "fill trade id")
    order_id = token(raw.get("orderId"), "fill order id")
    return {
        "id": trade_id,
        "order": order_id,
        "symbol": market["symbol"],
        "providerSymbol": symbol,
        "side": side,
        "price": price,
        "amount": str(size),
        "timestamp": event_time,
        "fee": {"cost": fee, "currency": "USDT"},
        "identityEvidence": {
            "profile": "kucoin_classic_futures_fill_v1",
            "providerAccountUid": state["providerAccountUid"],
            "providerSymbol": symbol,
            "nativeTradeId": trade_id,
            "nativeOrderId": order_id,
            "nativeTradeTime": str(native_time),
            "nativeCreatedAt": created,
        },
        "info": original(raw),
    }


def _next(state: dict[str, Any], page_number: int, total_pages: int,
          total_rows: int) -> dict[str, Any]:
    if page_number < total_pages:
        return {
            **state,
            "cursor": f"{page_number + 1}:{total_rows}",
            "completeness": "partial",
            "reason": "history_pending",
            "nextReadAt": 0,
        }
    end = state["windowUntil"]
    return {
        **state,
        "cursor": None,
        "scannedThrough": end,
        "windowSince": max(state["baselineSince"], end - OVERLAP),
        "windowUntil": None,
        "completeness": "unknown",
        "reason": "provider_retention_limit",
        "nextReadAt": 0,
    }


async def read_kucoin_history_page(
    rest: Any,
    state: dict[str, Any],
    budget: RecoveryReadBudget,
    provider_account_uid: str,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    checked = _state(state, provider_account_uid)
    cursor_parts = checked["cursor"].split(":") if checked["cursor"] else ["1"]
    page_number = int(cursor_parts[0])
    expected_total = int(cursor_parts[1]) if len(cursor_parts) == 2 else None
    params = {
        "startAt": checked["windowSince"],
        "endAt": checked["windowUntil"],
        "currentPage": page_number,
        "pageSize": PAGE_SIZE,
    }
    if checked["providerSymbol"] is not None:
        params["symbol"] = checked["providerSymbol"]
    fills = checked["source"] == "fills"
    if not fills:
        params["status"] = "done"
    method = rest.futuresPrivateGetFills if fills else rest.futuresPrivateGetOrders
    response = await budget.call(lambda: method(dict(params)))
    raw_rows, total_pages, total_rows = provider_page(
        response, checked["source"], page_number, PAGE_SIZE,
    )
    require(expected_total is None or expected_total == total_rows,
            "KuCoin history total changed during pagination.")
    if fills:
        parsed = [_fill(rest, raw, checked) for raw in raw_rows]
    else:
        parsed = [normalize_kucoin_order(rest, raw, stop_scope=False, terminal_allowed=True)
                  for raw in raw_rows]
    require(len({row["id"] for row in parsed}) == len(parsed),
            "KuCoin history page contains duplicate native identities.")
    return parsed, _next(checked, page_number, total_pages, total_rows), []
