"""Lossless USDT balance, funding and ledger pages for KuCoin Classic Futures."""
from __future__ import annotations

import re
from decimal import Decimal, localcontext
from typing import Any

from history_reader import RecoveryReadBudget
from kucoin_provider_common import (
    exact_decimal,
    exact_integer,
    native_symbol,
    object_data,
    original,
    require,
    rows,
    token,
)


DAY = 86_400_000
FUNDING_SLICE = DAY
FUNDING_PAGE_SIZE = 100
LEDGER_PAGE_SIZE = 50


def _uid(value: Any) -> str:
    return token(value, "money account uid")


def _window(state: Any, *, maximum_width: int) -> tuple[int, int, str | None]:
    require(type(state) is dict, "Invalid KuCoin money checkpoint.")
    since = exact_integer(state.get("windowSince"), "money windowSince")
    until = exact_integer(state.get("windowUntil"), "money windowUntil")
    require(since <= until and until - since <= maximum_width,
            "KuCoin money window is invalid or too wide.")
    cursor = state.get("cursor")
    require(cursor is None or (type(cursor) is str and re.fullmatch(r"[0-9]{1,16}", cursor)),
            "KuCoin money cursor is invalid.")
    return since, until, cursor


def _sum(left: str, right: str, label: str) -> str:
    with localcontext() as context:
        context.prec = 80
        return exact_decimal(Decimal(left) + Decimal(right), label)


def _offset(value: Any, label: str) -> str:
    if type(value) is int:
        require(0 <= value <= 99_999_999_999_999_999_999,
                f"KuCoin {label} must be an exact offset.")
        value = str(value)
    require(type(value) is str and re.fullmatch(r"(?:0|[1-9][0-9]{0,20})", value) is not None,
            f"KuCoin {label} must be an exact offset.")
    return value


async def read_kucoin_balance(rest: Any, budget: RecoveryReadBudget, *,
                              provider_account_uid: str) -> dict[str, Any]:
    uid = _uid(provider_account_uid)
    response = await budget.call(
        lambda: rest.futuresPrivateGetAccountOverview({"currency": "USDT"}),
    )
    data = object_data(response, "account overview")
    require(data.get("currency") == "USDT",
            "KuCoin account overview is not denominated in USDT.")
    equity = exact_decimal(data.get("accountEquity"), "account equity", signed=True)
    unrealized = exact_decimal(data.get("unrealisedPNL"), "unrealized PnL", signed=True)
    margin_balance = exact_decimal(data.get("marginBalance"), "margin balance", signed=True)
    position_margin = exact_decimal(data.get("positionMargin"), "position margin")
    order_margin = exact_decimal(data.get("orderMargin"), "order margin")
    frozen = exact_decimal(data.get("frozenFunds"), "frozen funds")
    available = exact_decimal(data.get("availableBalance"), "available balance", signed=True)
    return {
        "providerAccountUid": uid,
        "reportingCurrency": "USDT",
        "equity": equity,
        "unrealizedPnl": unrealized,
        "marginBalance": margin_balance,
        "positionMargin": position_margin,
        "orderMargin": order_margin,
        "marginUsed": _sum(position_margin, order_margin, "total margin used"),
        "frozenFunds": frozen,
        "availableBalance": available,
        "original": original(data),
    }


def _funding(raw: dict[str, Any], uid: str, symbol: str, since: int,
             until: int) -> dict[str, Any]:
    require(raw.get("symbol") == symbol and raw.get("settleCurrency") == "USDT",
            "KuCoin funding row is outside its requested USDT symbol scope.")
    require(raw.get("marginMode") == "CROSS",
            "KuCoin funding row is outside the reviewed CROSS scope.")
    timestamp = exact_integer(raw.get("timePoint"), "funding time")
    require(since <= timestamp <= until,
            "KuCoin funding row falls outside the requested window.")
    identifier = token(raw.get("id"), "funding id")
    amount = exact_decimal(raw.get("funding"), "funding amount", signed=True)
    return {
        "id": identifier,
        "eventType": "funding",
        "providerAccountUid": uid,
        "providerSymbol": symbol,
        "asset": "USDT",
        "amount": amount,
        "time": timestamp,
        "fundingRate": exact_decimal(raw.get("fundingRate"), "funding rate", signed=True),
        "markPrice": exact_decimal(raw.get("markPrice"), "funding mark price", positive=True),
        "positionQuantity": exact_decimal(raw.get("positionQty"), "funding position quantity",
                                           signed=True),
        "positionCost": exact_decimal(raw.get("positionCost"), "funding position cost",
                                      signed=True),
        "original": original(raw),
    }


async def read_kucoin_funding_page(
    rest: Any,
    state: dict[str, Any],
    budget: RecoveryReadBudget,
    *,
    provider_account_uid: str,
    provider_symbol: str,
) -> dict[str, Any]:
    uid = _uid(provider_account_uid)
    symbol = native_symbol(provider_symbol)
    since, until, cursor = _window(state, maximum_width=90 * DAY)
    slice_since = int(cursor) if cursor is not None else since
    require(since <= slice_since <= until,
            "KuCoin funding time cursor is outside its original window.")
    slice_until = min(until, slice_since + FUNDING_SLICE)
    params = {
        "symbol": symbol,
        "startAt": slice_since,
        "endAt": slice_until,
    }
    data = object_data(
        await budget.call(lambda: rest.futuresPrivateGetFundingHistory(dict(params))),
        "funding history",
    )
    page_rows = rows(data.get("dataList"), "funding history", maximum=FUNDING_PAGE_SIZE)
    has_more = data.get("hasMore")
    require(type(has_more) is bool, "KuCoin funding history omitted continuation evidence.")
    require(not has_more,
            "KuCoin funding time slice is saturated and cannot advance safely by offset.")
    records = [_funding(raw, uid, symbol, slice_since, slice_until) for raw in page_rows]
    require(len({row["id"] for row in records}) == len(records),
            "KuCoin funding page contains duplicate identities.")
    return {
        "providerAccountUid": uid,
        "records": records,
        "nextCursor": str(slice_until + 1) if slice_until < until else None,
        "exhausted": slice_until >= until,
        "completeness": "unknown",
        "reason": "provider_retention_limit",
    }


def _ledger(raw: dict[str, Any], uid: str, since: int, until: int) -> dict[str, Any]:
    require(raw.get("currency") == "USDT", "KuCoin ledger row is not denominated in USDT.")
    timestamp = exact_integer(raw.get("time"), "ledger time")
    require(since <= timestamp <= until, "KuCoin ledger row falls outside the requested window.")
    offset = _offset(raw.get("offset"), "ledger offset")
    status = token(raw.get("status"), "ledger status")
    require(status in {"Pending", "Completed"},
            "KuCoin ledger status is outside the reviewed vocabulary.")
    remark = token(raw.get("remark"), "ledger remark")
    return {
        "id": offset,
        "eventType": token(raw.get("type"), "ledger event type"),
        "providerAccountUid": uid,
        "asset": "USDT",
        "amount": exact_decimal(raw.get("amount"), "ledger amount", signed=True),
        "fee": exact_decimal(raw.get("fee"), "ledger fee", signed=True),
        "accountEquity": exact_decimal(raw.get("accountEquity"), "ledger account equity",
                                       signed=True),
        "time": timestamp,
        "status": status,
        "remark": remark,
        "offset": offset,
        "original": original(raw),
    }


async def read_kucoin_ledger_page(
    rest: Any,
    state: dict[str, Any],
    budget: RecoveryReadBudget,
    provider_account_uid: str,
) -> dict[str, Any]:
    uid = _uid(provider_account_uid)
    since, until, cursor = _window(state, maximum_width=DAY)
    params = {
        "currency": "USDT",
        "startAt": since,
        "endAt": until,
        "forward": False,
        "maxCount": LEDGER_PAGE_SIZE,
    }
    if cursor is not None:
        params["offset"] = _offset(cursor, "ledger cursor")
    response = await budget.call(lambda: rest.futuresPrivateGetTransactionHistory(dict(params)))
    data = object_data(response, "transaction history")
    page_rows = rows(data.get("dataList"), "transaction history", maximum=LEDGER_PAGE_SIZE)
    has_more = data.get("hasMore")
    require(type(has_more) is bool, "KuCoin ledger omitted continuation evidence.")
    require(not has_more or page_rows,
            "KuCoin ledger returned a non-advancing continuation page.")
    records = [_ledger(raw, uid, since, until) for raw in page_rows]
    require(len({row["id"] for row in records}) == len(records),
            "KuCoin ledger page contains duplicate identities.")
    offsets = [int(row["offset"]) for row in records]
    next_cursor = str(min(offsets)) if has_more else None
    require(next_cursor is None or next_cursor != cursor,
            "KuCoin ledger continuation offset did not advance.")
    return {
        "providerAccountUid": uid,
        "records": records,
        "nextCursor": next_cursor,
        "exhausted": not has_more,
        "completeness": "unknown",
        "reason": "provider_retention_limit",
    }
