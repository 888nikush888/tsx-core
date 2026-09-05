from __future__ import annotations

from collections import Counter
from typing import Any, Callable

from common import ExchangeContractError, UnresolvedOrderOutcome
from provider_order_identity import kraken_batch_identity


def order_identifier(value: Any, label: str) -> str:
    # CCXT's unified IDs are strings. Do not coerce arbitrary provider objects.
    if (not isinstance(value, str) or not value.strip() or len(value) > 256
            or any(ord(character) < 32 for character in value)):
        raise ExchangeContractError(f"CCXT order omitted a valid {label} identifier.")
    return value


def write_order_identity(order: dict[str, Any], expected_client_id: str = "") -> tuple[str, str]:
    if not isinstance(order, dict):
        raise ExchangeContractError("CCXT order response is not an object.")
    client_id = order_identifier(order.get("clientOrderId") or order.get("client_order_id"), "client")
    remote_id = order_identifier(order.get("id"), "exchange")
    if expected_client_id and client_id != expected_client_id:
        raise ExchangeContractError("CCXT order response does not match the requested client identifier.")
    return client_id, remote_id


def cancel_target(
    orders: list[dict[str, Any]], symbol: str, client_id: str, exchange_id: str | None,
) -> dict[str, Any]:
    order_identifier(client_id, "client")
    if exchange_id is not None:
        order_identifier(exchange_id, "exchange")
    scoped = [order for order in orders if order.get("symbol") == symbol]
    matches = [order for order in scoped if (
        order.get("id") == exchange_id if exchange_id is not None
        else (order.get("clientOrderId") or order.get("client_order_id")) == client_id
    )]
    if len(matches) != 1:
        raise ExchangeContractError("CCXT cannot prove a unique cancellation target on the requested provider symbol.")
    match = matches[0]
    remote_id = order_identifier(match.get("id"), "exchange")
    remote_client = match.get("clientOrderId") or match.get("client_order_id")
    if remote_client is not None and remote_client != client_id:
        raise ExchangeContractError("Cancellation target has a conflicting client identifier.")
    if any((order.get("clientOrderId") or order.get("client_order_id")) == client_id
           and order.get("id") != remote_id for order in scoped):
        raise ExchangeContractError("Cancellation target has a conflicting exchange identifier.")
    # Only this already-proven remote ID may acquire the local client binding.
    return {**match, "clientOrderId": client_id}


def _batch_objects(orders: list[dict[str, Any]], specs: tuple[dict[str, Any], dict[str, Any]],
                   exchange: str) -> list[dict[str, Any]]:
    return [candidate for order in orders if isinstance(order, dict)
            if (candidate := _batch_candidate(order, specs, exchange)) is not None]


def _confirmed_batch(objects: list[dict[str, Any]], expected: list[str],
                     normalize: Callable[[dict[str, Any], str], dict[str, Any]]) -> dict[str, dict[str, Any]]:
    clients = Counter(str(order.get("clientOrderId") or order.get("client_order_id") or "") for order in objects)
    remotes = Counter(str(order.get("id") or "") for order in objects)
    confirmed: dict[str, dict[str, Any]] = {}
    for order in objects:
        client_id = order.get("clientOrderId") or order.get("client_order_id")
        if not isinstance(client_id, str) or client_id not in expected:
            continue
        if clients[client_id] != 1 or remotes[str(order.get("id") or "")] != 1:
            continue
        try:
            confirmed[client_id] = normalize(order, client_id)
        except ExchangeContractError:
            # Keep independent proven legs, but do not fabricate the other leg.
            continue
    return confirmed


def correlate_batch(
    orders: list[dict[str, Any]], specs: tuple[dict[str, Any], dict[str, Any]],
    normalize: Callable[[dict[str, Any], str], dict[str, Any]],
    exchange: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    expected = [order_identifier(spec["params"].get("clientOrderId"), "client") for spec in specs]
    if len(set(expected)) != 2:
        raise ExchangeContractError("Protected order requests require distinct client identifiers.")
    confirmed = _confirmed_batch(_batch_objects(orders, specs, exchange), expected, normalize)
    unresolved = [client_id for client_id in expected if client_id not in confirmed]
    if unresolved or len(orders) != 2:
        raise UnresolvedOrderOutcome(
            "Protected-entry order identity is unresolved; REST reconciliation is required.",
            list(confirmed.values()), unresolved,
        )
    return confirmed[expected[0]], confirmed[expected[1]]


def _batch_candidate(order: dict[str, Any], specs: tuple[dict[str, Any], dict[str, Any]], exchange: str) -> dict[str, Any] | None:
    if exchange != "krakenfutures":
        return order
    proof = kraken_batch_identity(order, specs)
    if proof is None:
        # An explicitly journaled native tag is mandatory evidence, even when a
        # conflicting result also carries a superficially matching unified ID.
        if any("order_tag" in spec["params"] for spec in specs):
            return None
        return order
    return {**order, "clientOrderId": proof["clientOrderId"], "identityEvidence": proof, "_identityOriginal": order}
