"""Bounded, positive order lookup evidence. A negative lookup never proves no dispatch."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Awaitable, Callable

from ccxt.base.errors import NetworkError, OrderNotFound, RateLimitExceeded

from common import ExchangeContractError, RequestDeadline
from provider_order_identity import cloid_lookup_identity, cloid_lookup_scope


def now_ms() -> int:
    return int(time.time() * 1000)


def _identifier(value: Any, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 256 or value.strip() != value:
        raise ExchangeContractError("Invalid recovery order identifier.")
    return value


def recovery_request(value: Any) -> dict[str, Any]:
    if value is None:
        return {"since": max(0, now_ms() - 30 * 86_400_000), "orders": []}
    if not isinstance(value, dict) or not isinstance(value.get("orders"), list) or len(value["orders"]) > 250:
        raise ExchangeContractError("Invalid bounded recovery request.")
    since = value.get("since")
    if not isinstance(since, int) or isinstance(since, bool) or not 0 <= since <= now_ms():
        raise ExchangeContractError("Invalid recovery history start.")
    orders = [_recovery_order(row) for row in value["orders"]]
    if len({row["clientOrderId"] for row in orders}) != len(orders):
        raise ExchangeContractError("Recovery order references must be unique.")
    return {"since": since, "orders": orders}


def _recovery_order(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("role") not in {"entry", "stop_loss", "take_profit", "flatten"}:
        raise ExchangeContractError("Invalid recovery order reference.")
    return {"clientOrderId": _identifier(value.get("clientOrderId")),
            "exchangeOrderId": _identifier(value.get("exchangeOrderId"), nullable=True),
            "providerSymbol": _identifier(value.get("providerSymbol"), nullable=True),
            "symbol": _identifier(value.get("symbol")), "role": value["role"]}


@dataclass
class RecoveryReadBudget:
    deadline: RequestDeadline
    remaining: int = 5
    resume_at: int = 0
    calls: int = field(default=0, init=False)

    async def call(self, operation: Callable[[], Awaitable[Any]]) -> Any:
        # Do not create a coroutine which cannot be awaited when the budget is exhausted.
        if self.remaining <= 0 or self.resume_at > now_ms() or self.deadline.remaining_ms() <= 1_250:
            raise RecoveryBudgetExhausted()
        self.remaining -= 1
        self.calls += 1
        timeout = min(10.0, (self.deadline.remaining_ms() - 1_000) / 1_000)
        return await asyncio.wait_for(operation(), timeout=timeout)

    def suspend(self, rest: Any, error: Exception) -> None:
        self.remaining = 0
        minimum = now_ms() + (60_000 if isinstance(error, RateLimitExceeded) else 15_000)
        self.resume_at = max(self.resume_at, minimum, retry_after_time(getattr(rest, "last_response_headers", None)))


def retry_after_time(headers: Any) -> int:
    if not isinstance(headers, dict):
        return 0
    value = next((str(value) for key, value in headers.items() if str(key).lower() == "retry-after"), "")
    if value.isdecimal():
        return now_ms() + min(int(value), 86_400) * 1000
    try:
        return min(int(parsedate_to_datetime(value).timestamp() * 1000), now_ms() + DAY_MS)
    except (ValueError, TypeError, OverflowError):
        return 0


DAY_MS = 86_400_000


class RecoveryBudgetExhausted(Exception):
    pass


def matching_reference(order: dict[str, Any], reference: dict[str, Any], symbol: str) -> bool:
    if order.get("symbol") != symbol or not order.get("id"):
        return False
    if reference["exchangeOrderId"]:
        return str(order["id"]) == reference["exchangeOrderId"]
    proof = order.get("identityEvidence", {})
    return (order.get("clientOrderId") == reference["clientOrderId"]
            or (proof.get("profile") == "hyperliquid_cloid_lookup_v1"
                and proof.get("clientOrderId") == reference["clientOrderId"]))


async def _bybit_lookup(rest: Any, reference: dict[str, Any], symbol: str, budget: RecoveryReadBudget) -> list[dict[str, Any]]:
    params = {"orderId": reference["exchangeOrderId"]} if reference["exchangeOrderId"] else {"orderLinkId": reference["clientOrderId"]}
    if reference["role"] == "stop_loss":
        params["orderFilter"] = "StopOrder"
    orders = await budget.call(lambda: rest.fetch_open_orders(symbol, None, 50, dict(params)))
    if orders:
        return orders
    # fetchOrder for UTA is only a recent-order cache. Query terminal history explicitly.
    return await budget.call(lambda: rest.fetch_canceled_and_closed_orders(symbol, None, 50, dict(params)))


async def _lookup(rest: Any, exchange: str, reference: dict[str, Any], symbol: str, budget: RecoveryReadBudget) -> list[dict[str, Any]]:
    if exchange == "bybit":
        return await _bybit_lookup(rest, reference, symbol, budget)
    identifier = reference["exchangeOrderId"]
    params: dict[str, Any] = {}
    if not identifier:
        if exchange != "hyperliquid":
            raise NotImplementedError("No verified client-only lookup profile.")
        identifier = reference["clientOrderId"]
        params["clientOrderId"] = identifier
        params["user"] = cloid_lookup_scope(rest, identifier)
    started = now_ms()
    result = await budget.call(lambda: rest.fetch_order(identifier, symbol, params))
    if params.get("clientOrderId") and isinstance(result, dict) and result.get("id"):
        result = cloid_lookup_identity(rest, result, identifier, symbol, params["user"], started, now_ms())
    return [result] if isinstance(result, dict) and result.get("id") else []


async def lookup_order_evidence(rest: Any, exchange: str, reference: dict[str, Any], symbol: str,
                                budget: RecoveryReadBudget) -> list[dict[str, Any]]:
    rows = await _lookup(rest, exchange, reference, symbol, budget)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ExchangeContractError("Targeted order lookup returned an invalid collection.")
    if any(not matching_reference(row, reference, symbol) for row in rows):
        raise ExchangeContractError("Targeted order lookup returned a different identity or symbol.")
    return rows


def _listed_order_is_observed(order: dict[str, Any], reference: dict[str, Any], symbol: str) -> bool:
    return (matching_reference(order, reference, symbol)
            and order.get("status") not in (None, "unknown") and order.get("filled") is not None)


async def _recover_reference(
    rest: Any, exchange: str, reference: dict[str, Any], listed: list[dict[str, Any]],
    resolve_symbol: Callable[[dict[str, Any]], str], budget: RecoveryReadBudget,
    recovered: list[dict[str, Any]],
) -> str:
    try:
        symbol = resolve_symbol(reference)
        observed = [_listed_order_is_observed(row, reference, symbol) for row in listed]
        if any(observed):
            return "observed"
        rows = await lookup_order_evidence(rest, exchange, reference, symbol, budget)
        recovered.extend(rows)
        return "observed" if rows else "not_found"
    except OrderNotFound:
        return "not_found"
    except (NotImplementedError, KeyError):
        return "unsupported"
    except RecoveryBudgetExhausted:
        return "budget_exhausted"
    except (NetworkError, RateLimitExceeded, TimeoutError) as error:
        # Respect provider cooldown: do not issue more historical lookups this request.
        budget.suspend(rest, error)
        return "transient"


async def recover_order_evidence(
    rest: Any, exchange: str, references: list[dict[str, Any]], listed: list[dict[str, Any]],
    resolve_symbol: Callable[[dict[str, Any]], str], budget: RecoveryReadBudget,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    recovered: list[dict[str, Any]] = []
    checked: list[dict[str, str]] = []
    for reference in references:
        status = await _recover_reference(rest, exchange, reference, listed, resolve_symbol, budget, recovered)
        checked.append({"clientOrderId": reference["clientOrderId"], "status": status})
    return recovered, checked


def source_evidence(source: str, started: int, completeness: str, reason: str | None = None,
                    since: int | None = None) -> dict[str, Any]:
    return {"source": source, "startedAt": started, "completedAt": now_ms(),
            "completeness": completeness, "reason": reason, "since": since}
