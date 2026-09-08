from __future__ import annotations

from decimal import Decimal
from typing import Any

from ccxt_client import decimal_text
from common import ExchangeContractError, decimal_string


STATUSES = {
    "created", "submitting", "open", "partially_filled", "cancel_pending",
    "filled", "cancelled", "rejected", "unknown",
}


def normalized_status(value: Any) -> str:
    return {
        "open": "open", "closed": "filled", "canceled": "cancelled",
        "cancelled": "cancelled", "expired": "cancelled", "rejected": "rejected",
    }.get(str(value or "").lower(), "unknown")


def _merged_status(current: str, incoming: str, filled: Decimal, quantity: Decimal) -> str:
    if "rejected" in {current, incoming} and filled > 0:
        raise ExchangeContractError("Rejected order has conflicting execution evidence.")
    if current in {"filled", "rejected"}:
        return current
    if current == "cancelled":
        return "filled" if incoming == "filled" and filled == quantity else current
    if incoming in {"filled", "cancelled", "rejected"}:
        return incoming
    if current == "cancel_pending":
        return current
    if incoming in {"unknown", "cancel_pending"}:
        return incoming
    if filled > 0:
        return "partially_filled"
    if incoming in {"created", "submitting"} and current != "created":
        return current
    return incoming


def _filled_decimal(value: Any) -> Decimal | None:
    return None if value is None else Decimal(decimal_string(value, "filledQuantity"))


def _average_price(value: Any) -> str | None:
    return None if value is None else decimal_string(value, "averagePrice", positive=True)


def merge_order_evidence(current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    if current.get("status") not in STATUSES or incoming.get("status") not in STATUSES:
        raise ExchangeContractError("Invalid order evidence status.")
    quantity = Decimal(decimal_string(current.get("quantity"), "quantity", positive=True))
    old_filled, new_filled = current.get("filledQuantity"), incoming.get("filledQuantity")
    previous = _filled_decimal(old_filled)
    reported = _filled_decimal(new_filled)
    known = [value for value in (previous, reported) if value is not None]
    filled = max(known) if known else None
    if filled is not None and filled > quantity:
        raise ExchangeContractError("Executed quantity exceeds order quantity.")
    old_average, new_average = current.get("averagePrice"), incoming.get("averagePrice")
    old_average = _average_price(old_average)
    new_average = _average_price(new_average)
    use_new = previous is None or (reported is not None and reported >= previous)
    return {
        "status": _merged_status(current["status"], incoming["status"], filled or Decimal(0), quantity),
        "filledQuantity": None if filled is None else decimal_text(filled),
        "averagePrice": (new_average or old_average) if use_new else old_average,
    }


def merge_ccxt_order(current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    for field in ("id", "symbol", "clientOrderId", "side", "reduceOnly", "amount"):
        left, right = current.get(field), incoming.get(field)
        if (left is not None and right is not None and str(left) != str(right)
                and (field != "amount" or Decimal(str(left)) != Decimal(str(right)))):
            raise ExchangeContractError(f"Remote order has conflicting {field} evidence.")
    quantity = current.get("amount") if current.get("amount") is not None else incoming.get("amount")

    def evidence(order):
        return {
            "status": normalized_status(order.get("status")),
            "quantity": decimal_text(quantity),
            "filledQuantity": None if order.get("filled") is None else decimal_text(order["filled"]),
            "averagePrice": None if order.get("average") is None else decimal_text(order["average"]),
        }

    merged = merge_order_evidence(evidence(current), evidence(incoming))
    provider_status = {"filled": "closed", "cancelled": "canceled", "partially_filled": "open"}.get(merged["status"], merged["status"])
    result = {**current, **{key: value for key, value in incoming.items() if value is not None}}
    return {**result, "status": provider_status, "filled": merged["filledQuantity"], "average": merged["averagePrice"]}
