"""Classify raw per-leg KuCoin batch acknowledgements without inference."""
from __future__ import annotations

from typing import Any

from common import ExchangeContractError, UnresolvedOrderOutcome
from kucoin_provider_common import native_symbol, require, token


DEFINITE_REJECTION_CODES = {
    "100001", "100003", "200003", "300000", "300001", "300003", "300004",
    "300005", "300006", "300007", "300008", "300009", "300011", "300012",
    "300013", "300016", "330005", "330011",
}


def _expected(value: Any) -> tuple[list[dict[str, str]], dict[str, dict[str, str]]]:
    require(type(value) is list and len(value) == 2,
            "KuCoin batch requires the exact entry and stop-loss leg set.")
    result: list[dict[str, str]] = []
    for row in value:
        require(type(row) is dict and row.get("role") in {"entry", "stop_loss"},
                "KuCoin batch leg role is invalid.")
        result.append({
            "role": row["role"],
            "clientOrderId": token(row.get("clientOrderId"), "expected client order id"),
            "providerSymbol": native_symbol(row.get("providerSymbol")),
        })
    require({row["role"] for row in result} == {"entry", "stop_loss"},
            "KuCoin batch must contain one entry and one stop-loss leg.")
    by_client = {row["clientOrderId"]: row for row in result}
    require(len(by_client) == len(result), "KuCoin expected client order identities are duplicated.")
    return result, by_client


def _message(value: Any) -> str:
    require(type(value) is str and len(value) <= 256
            and not any(ord(character) < 32 for character in value),
            "KuCoin acknowledgement message is malformed.")
    return value


def _unresolved(message: str, expected: list[dict[str, str]],
                confirmed: list[dict[str, Any]]) -> UnresolvedOrderOutcome:
    observed = {row["clientOrderId"] for row in confirmed}
    unresolved = [row["clientOrderId"] for row in expected
                  if row["clientOrderId"] not in observed]
    if not unresolved:
        unresolved = [row["clientOrderId"] for row in expected]
    return UnresolvedOrderOutcome(message, confirmed, unresolved)


def _classify_row(raw: dict[str, Any], leg: dict[str, str]) -> dict[str, Any]:
    require(raw.get("symbol") == leg["providerSymbol"],
            "KuCoin acknowledgement symbol differs from the dispatched leg.")
    provider_code = token(raw.get("code"), "acknowledgement code")
    message = _message(raw.get("msg"))
    order_id = raw.get("orderId")
    if provider_code == "200000":
        exchange_id = token(order_id, "exchange order id")
        status = "accepted"
    else:
        require(provider_code in DEFINITE_REJECTION_CODES,
                "KuCoin acknowledgement code has no reviewed definite-rejection semantics.")
        require(order_id is None,
                "KuCoin rejected acknowledgement unexpectedly contains an order identity.")
        exchange_id = None
        status = "rejected"
    return {
        "role": leg["role"],
        "clientOrderId": leg["clientOrderId"],
        "exchangeOrderId": exchange_id,
        "providerSymbol": leg["providerSymbol"],
        "providerCode": provider_code,
        "message": message,
        "status": status,
    }


def classify_kucoin_batch_ack(response: Any, expected_legs: Any) -> list[dict[str, Any]]:
    """Return an exact result per dispatched leg or an unresolved side-effect error."""
    expected, by_client = _expected(expected_legs)
    if type(response) is not dict or response.get("code") != "200000":
        raise _unresolved("KuCoin batch outcome envelope is unresolved.", expected, [])
    raw_rows = response.get("data")
    if type(raw_rows) is not list or len(raw_rows) > len(expected):
        raise _unresolved("KuCoin batch outcome collection is unresolved.", expected, [])

    confirmed: list[dict[str, Any]] = []
    seen_clients: set[str] = set()
    seen_exchange_ids: set[str] = set()
    try:
        for raw in raw_rows:
            require(type(raw) is dict, "KuCoin batch outcome row is malformed.")
            client_id = token(raw.get("clientOid"), "acknowledgement client order id")
            require(client_id in by_client and client_id not in seen_clients,
                    "KuCoin batch outcome contains an unexpected or duplicate leg.")
            result = _classify_row(raw, by_client[client_id])
            exchange_id = result["exchangeOrderId"]
            require(exchange_id is None or exchange_id not in seen_exchange_ids,
                    "KuCoin batch outcome duplicated an exchange order identity.")
            seen_clients.add(client_id)
            if exchange_id is not None:
                seen_exchange_ids.add(exchange_id)
            confirmed.append(result)
    except ExchangeContractError as error:
        raise _unresolved(str(error), expected, confirmed) from error

    if len(confirmed) != len(expected):
        raise _unresolved("KuCoin batch outcome omitted a dispatched leg.", expected, confirmed)
    by_result = {row["clientOrderId"]: row for row in confirmed}
    return [by_result[row["clientOrderId"]] for row in expected]
