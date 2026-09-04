from __future__ import annotations

from typing import Any, Callable

from common import ExchangeContractError


def _scalar(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str) and len(value) <= 256:
        return value
    raise ExchangeContractError("Remote economic field exceeds the safe evidence boundary.")


def unresolved_trade(trade: dict[str, Any]) -> dict[str, Any]:
    # Retain the original unified economic values, not raw info, HTTP headers,
    # request credentials or locally invented identifiers/timestamps.
    fields = {
        "exchangeFillId": "id", "exchangeOrderId": "order", "clientOrderId": "clientOrderId",
        "providerSymbol": "symbol", "side": "side", "type": "type", "price": "price",
        "quantity": "amount", "cost": "cost", "filledAt": "timestamp",
    }
    evidence = {target: _scalar(trade.get(source)) for target, source in fields.items()}
    fee = trade.get("fee") if isinstance(trade.get("fee"), dict) else {}
    evidence.update({"fee": _scalar(fee.get("cost")), "feeAsset": _scalar(fee.get("currency")), "feeRate": _scalar(fee.get("rate"))})
    return {
        "kind": "fill", "source": "fetchMyTrades", "reason": "incomplete_fill_identity_or_economics",
        "providerId": str(trade["id"]) if trade.get("id") is not None else None,
        "providerSymbol": trade.get("symbol"), "evidence": evidence,
    }


def normalize_trades(
    trades: list[dict[str, Any]], normalize: Callable[[dict[str, Any]], dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fills, unresolved = [], []
    for trade in trades:
        try:
            fills.append(normalize(trade))
        except (ExchangeContractError, KeyError, TypeError, ValueError, ArithmeticError):
            unresolved.append(unresolved_trade(trade))
    return fills, unresolved
