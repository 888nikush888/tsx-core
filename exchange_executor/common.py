from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any


class ExchangeContractError(ValueError):
    pass


def decimal_string(value: Any, label: str, *, positive: bool = False) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise ExchangeContractError(f"{label} must be a plain decimal string.")
    text = str(value)
    if "e" in text.lower() or text.startswith("+"):
        raise ExchangeContractError(f"{label} must be a plain decimal string.")
    try:
        number = Decimal(text)
    except InvalidOperation as error:
        raise ExchangeContractError(f"{label} is invalid.") from error
    if not number.is_finite() or number < 0 or (positive and number <= 0):
        raise ExchangeContractError(f"{label} is outside the allowed range.")
    normalized = format(number, "f").rstrip("0").rstrip(".") if "." in format(number, "f") else format(number, "f")
    return normalized or "0"


def signed_decimal_string(value: Any, label: str) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise ExchangeContractError(f"{label} must be a plain decimal string.")
    text = str(value)
    if "e" in text.lower() or text.startswith("+"):
        raise ExchangeContractError(f"{label} must be a plain decimal string.")
    try:
        number = Decimal(text)
    except InvalidOperation as error:
        raise ExchangeContractError(f"{label} is invalid.") from error
    if not number.is_finite():
        raise ExchangeContractError(f"{label} is outside the allowed range.")
    normalized = format(number, "f").rstrip("0").rstrip(".") if "." in format(number, "f") else format(number, "f")
    return normalized if normalized not in {"", "-0"} else "0"


def account_request(payload: dict[str, Any]) -> dict[str, str]:
    account = payload.get("account")
    if not isinstance(account, dict):
        raise ExchangeContractError("account is required.")
    account_id = account.get("id")
    exchange = account.get("exchange")
    mode = account.get("mode")
    if not isinstance(account_id, str) or exchange not in {"hyperliquid", "bybit"} or mode not in {"testnet", "live"}:
        raise ExchangeContractError("Invalid account contract.")
    return {"id": account_id, "exchange": exchange, "mode": mode}


def response_list(response: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(response, dict) or response.get("retCode") != 0:
        message = response.get("retMsg") if isinstance(response, dict) else "invalid response"
        raise ExchangeContractError(f"{label} failed: {message}")
    result = response.get("result")
    values = result.get("list") if isinstance(result, dict) else None
    if not isinstance(values, list):
        raise ExchangeContractError(f"{label} returned no list.")
    return values


def map_bybit_status(status: str) -> str:
    return {
        "New": "open",
        "Untriggered": "open",
        "PartiallyFilled": "partially_filled",
        "Filled": "filled",
        "Cancelled": "cancelled",
        "Deactivated": "cancelled",
        "Rejected": "rejected",
    }.get(status, "unknown")
