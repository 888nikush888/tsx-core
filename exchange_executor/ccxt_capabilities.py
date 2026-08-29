from __future__ import annotations

from typing import Any

REST_CAPABILITIES = (
    "fetchBalance",
    "fetchPositions",
    "fetchOpenOrders",
    "fetchMyTrades",
    "createOrder",
    "createOrders",
    "cancelOrder",
    "setLeverage",
)
PRO_CAPABILITIES = ("watchOrders", "watchMyTrades", "watchPositions")
CANDIDATE_REST_REQUIREMENTS = tuple(value for value in REST_CAPABILITIES if value != "createOrders")
CANDIDATE_PRO_REQUIREMENTS = PRO_CAPABILITIES


def capability_flags(client: Any, names: tuple[str, ...]) -> dict[str, bool]:
    available = getattr(client, "has", {})
    if not isinstance(available, dict):
        available = {}
    return {name: available.get(name) is True for name in names}


def missing_capabilities(flags: dict[str, bool], required: tuple[str, ...]) -> list[str]:
    return [name for name in required if flags.get(name) is not True]

