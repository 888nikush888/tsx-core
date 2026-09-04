"""Kraken's documented v3 account-history envelopes, transported and signed by CCXT."""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from ccxt_client import decimal_text
from common import ExchangeContractError, decimal_string, signed_decimal_string
from history_reader import RecoveryReadBudget
from order_identity import order_identifier


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ExchangeContractError("Invalid Kraken account-history object.")
    return value


def _time(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ExchangeContractError("Kraken history omitted its provider timestamp.")
    return value


def _cursor(state: dict[str, Any]) -> tuple[str, str | None]:
    default = "executions" if state["source"] == "fills" else "orders"
    if state["cursor"] is None:
        return default, None
    try:
        parsed = json.loads(state["cursor"])
    except (TypeError, ValueError) as error:
        raise ExchangeContractError("Invalid Kraken history continuation state.") from error
    parsed = _object(parsed)
    allowed = {"executions"} if default == "executions" else {"orders", "triggers"}
    endpoint, token = parsed.get("endpoint"), parsed.get("token")
    if endpoint not in allowed or (token is not None and (not isinstance(token, str) or not token or len(token) > 3000)):
        raise ExchangeContractError("Kraken history continuation changed its source.")
    return endpoint, token


def _next_token(response: dict[str, Any], rest: Any) -> str | None:
    body_token = response.get("continuationToken")
    headers = getattr(rest, "last_response_headers", {}) or {}
    if not isinstance(headers, dict) or (body_token is not None and not isinstance(body_token, str)):
        raise ExchangeContractError("Invalid Kraken history continuation envelope.")
    header_token = next((value for key, value in headers.items() if str(key).lower() == "next-continuation-token"), None)
    if body_token and header_token and body_token != header_token:
        raise ExchangeContractError("Kraken history continuation headers contradict the body.")
    token = body_token or header_token
    if token is not None and (not isinstance(token, str) or len(token) > 3000 or any(ord(char) < 32 for char in token)):
        raise ExchangeContractError("Invalid Kraken history continuation token.")
    return token or None


async def kraken_history_page(rest: Any, state: dict[str, Any], budget: RecoveryReadBudget
                               ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None, str]:
    endpoint, token = _cursor(state)
    method = getattr(rest, {"executions": "historyGetExecutions", "orders": "historyGetOrders", "triggers": "historyGetTriggers"}[endpoint], None)
    if not callable(method):
        raise NotImplementedError("CCXT does not expose the required Kraken history endpoint.")
    # CCXT 4.5.75 defaults these routes to v2. Its supported `version` parameter
    # selects the documented v3 route without replacing CCXT signing or HTTP.
    params: dict[str, Any] = {"version": "v3", "since": state["windowSince"], "before": state["windowUntil"], "sort": "asc", "count": 500}
    if token:
        params["continuation_token"] = token
    if state["providerSymbol"]:
        params["tradeable"] = rest.market(state["providerSymbol"])["id"]
    response = _object(await budget.call(lambda: method(params)))
    account_uid = order_identifier(response.get("accountUid"), "Kraken history account")
    if state.get("providerAccountUid") not in (None, account_uid):
        raise ExchangeContractError("Kraken history changed its provider account identity.")
    rows = response.get("elements")
    if not isinstance(rows, list) or len(rows) > 500 or type(response.get("len")) is not int or response["len"] != len(rows):
        raise ExchangeContractError("Invalid Kraken account-history collection.")
    next_token = _next_token(response, rest)
    if next_token is not None and next_token == token:
        raise ExchangeContractError("Kraken returned a non-advancing history cursor.")
    fills, events = [], []
    for row in rows:
        _validate_event(row, state)
        if endpoint == "executions":
            fills.append(_execution(rest, row, account_uid, state["providerSymbol"]))
        else:
            events.extend(_order_events(rest, row, account_uid, state["providerSymbol"]))
    cursor = json.dumps({"endpoint": endpoint, "token": next_token}, separators=(",", ":")) if next_token else None
    if cursor is None and endpoint == "orders":
        cursor = json.dumps({"endpoint": "triggers", "token": None}, separators=(",", ":"))
    return fills, events, cursor, account_uid


def _validate_event(value: Any, state: dict[str, Any]) -> None:
    row = _object(value)
    order_identifier(row.get("uid"), "Kraken history event")
    stamp = _time(row.get("timestamp"))
    if not state["windowSince"] <= stamp <= state["windowUntil"]:
        raise ExchangeContractError("Kraken history event falls outside the requested time window.")


def _market(rest: Any, order: dict[str, Any], account_uid: str, expected: str | None) -> dict[str, Any]:
    if order.get("accountUid") != account_uid:
        raise ExchangeContractError("Kraken history row belongs to a different account.")
    market = rest.safe_market(order.get("tradeable"))
    if not market.get("contract") or not market.get("symbol") or (expected and market["symbol"] != expected):
        raise ExchangeContractError("Kraken history row belongs to a different market scope.")
    return market


def _execution(rest: Any, row: dict[str, Any], account_uid: str, expected: str | None) -> dict[str, Any]:
    execution = _object(_object(_object(row.get("event")).get("execution")).get("execution"))
    order = _object(execution.get("order"))
    market = _market(rest, order, account_uid, expected)
    data = execution.get("orderData")
    fee = data.get("fee") if isinstance(data, dict) else None
    return {"id": order_identifier(execution.get("uid"), "Kraken execution"),
            "order": order_identifier(order.get("uid"), "Kraken execution order"), "clientOrderId": order.get("clientId") or None,
            "symbol": market["symbol"], "side": str(order.get("direction", "")).lower(),
            "timestamp": _time(execution.get("timestamp")), "price": decimal_string(execution.get("price"), "execution price", positive=True),
            "amount": decimal_string(execution.get("quantity"), "execution quantity", positive=True),
            # No estimated fee from CCXT's maker/taker rate. v3 does not specify a fee asset here.
            "fee": {"cost": signed_decimal_string(fee, "execution fee") if fee is not None else None, "currency": None},
            "historyMissingFee": fee is None, "info": {"providerEventId": row["uid"],
                "identitySource": "kraken_history_execution_v3", "executionUid": execution["uid"], "orderUid": order["uid"],
                "tradeable": order["tradeable"], "accountUid": account_uid, "executionTimestamp": execution["timestamp"]}}


def _order_events(rest: Any, row: dict[str, Any], account_uid: str, expected: str | None) -> list[dict[str, Any]]:
    event = _object(row.get("event"))
    if len(event) != 1:
        raise ExchangeContractError("Kraken history event has an ambiguous type.")
    kind, payload = next(iter(event.items()))
    payload = _object(payload)
    # Retain both sides of edits. Do not mistake remaining quantity or an old trigger
    # event for a current, complete order snapshot.
    orders = [(key, value) for key, value in payload.items() if key in {
        "order", "oldOrder", "newOrder", "attemptedOrder", "oldOrderTrigger", "newOrderTrigger", "attemptedOrderTrigger"}]
    if not orders:
        if kind not in {"OrderNotFound", "OrderTriggerNotFound"} or payload.get("accountUid") != account_uid:
            raise ExchangeContractError("Kraken history omitted the order evidence for its event type.")
        return [_event(row, kind, {"exchangeOrderId": order_identifier(payload.get("orderId"), "Kraken historical order")}, expected)]
    return [_order_event(rest, row, kind, label, _object(order), account_uid, expected) for label, order in orders]


def _order_event(rest: Any, row: dict[str, Any], kind: str, label: str, order: dict[str, Any], account_uid: str,
                 expected: str | None) -> dict[str, Any]:
    market = _market(rest, order, account_uid, expected)
    filled = order.get("filled")
    if filled is not None:
        contracts = Decimal(decimal_string(decimal_text(filled), "historical cumulative contracts"))
        size = Decimal(decimal_string(decimal_text(market.get("contractSize")), "historical contract size", positive=True))
        filled = decimal_text(contracts * size)
    fields = {"exchangeOrderId": order_identifier(order.get("uid"), "Kraken historical order"),
              "clientOrderId": order.get("clientId") or None, "providerSymbol": market["symbol"],
              "side": order.get("direction"), "providerReportedQuantity": decimal_string(decimal_text(order.get("quantity"), ""), "historical reported quantity"),
              "filledQuantity": filled, "price": order.get("limitPrice"), "reduceOnly": order.get("reduceOnly"),
              "triggerPrice": (order.get("triggerOptions") or {}).get("triggerPrice"), "eventOrderField": label}
    return _event(row, kind, fields, market["symbol"])


def _event(row: dict[str, Any], kind: str, evidence: dict[str, Any], symbol: str | None) -> dict[str, Any]:
    return {"kind": "order", "source": "fetchOrders", "reason": "historical_order_event",
            "providerId": row["uid"], "providerSymbol": symbol,
            "evidence": {**evidence, "providerEventId": row["uid"], "eventType": kind, "providerTimestamp": row["timestamp"]}}
