from __future__ import annotations

import hmac
import time
from decimal import Decimal, InvalidOperation
from typing import Any


class ExchangeContractError(ValueError):
    pass


class RequestDeadline:
    MAX_FUTURE_MS = 35_000

    def __init__(self, deadline_at_ms: int) -> None:
        self.deadline_at_ms = deadline_at_ms

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "RequestDeadline":
        value = payload.get("deadlineAt")
        now = int(time.time() * 1000)
        if not isinstance(value, int) or isinstance(value, bool):
            raise ExchangeContractError("deadlineAt is required.")
        if value <= now or value > now + cls.MAX_FUTURE_MS:
            raise ExchangeContractError("deadlineAt is expired or outside the allowed request budget.")
        return cls(value)

    def remaining_ms(self) -> int:
        return self.deadline_at_ms - int(time.time() * 1000)

    def ensure(self, minimum_ms: int = 1) -> None:
        if self.remaining_ms() < minimum_ms:
            raise ExchangeContractError("Executor request deadline expired before the next operation.")

    def sdk_timeout_seconds(self, cap: float = 10.0) -> float:
        self.ensure(250)
        # Leave response-serialization headroom so an SDK timeout settles before
        # the caller's absolute deadline rather than racing it.
        return max(0.1, min(cap, (self.remaining_ms() - 250) / 1000))


def external_account_id(exchange: str, mode: str, stable_identifier: str) -> str:
    if not stable_identifier:
        raise ExchangeContractError("Exchange account identity is unavailable.")
    return hmac.digest(
        stable_identifier.encode("utf-8"),
        f"external-account-id:v1:{exchange}:{mode}".encode("utf-8"),
        "sha256",
    ).hex()


def external_account_cache_key(exchange: str, mode: str, secret_identifier: str) -> str:
    if not secret_identifier:
        raise ExchangeContractError("Exchange account cache identity is unavailable.")
    return hmac.digest(
        secret_identifier.encode("utf-8"),
        f"{exchange}:{mode}".encode("utf-8"),
        "sha256",
    ).hex()


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


def optional_positive_decimal_string(value: Any, label: str) -> str | None:
    if value is None or value == "":
        return None
    normalized = decimal_string(value, label)
    return normalized if normalized != "0" else None


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
