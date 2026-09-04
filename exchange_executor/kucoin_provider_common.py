"""Lossless primitives for the bounded KuCoin Classic Futures provider helpers.

These helpers accept raw CCXT transport responses only.  They intentionally
reject float-decoded economic fields: callers need an exact response capture
before these helpers can be connected to live provider traffic.
"""
from __future__ import annotations

import copy
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from common import DECIMAL_PATTERN, SIGNED_DECIMAL_PATTERN, ExchangeContractError


MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_ROWS = 100_000
_BINDING = re.compile(r"[a-f0-9]{64}")
_NATIVE_SYMBOL = re.compile(r"[A-Z0-9]{1,64}")
_TOKEN = re.compile(r"[^\x00-\x1f\x7f]{1,256}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ExchangeContractError(message)


def binding(value: Any, label: str) -> str:
    require(type(value) is str and _BINDING.fullmatch(value) is not None,
            f"KuCoin {label} must be a verified binding.")
    return value


def token(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if type(value) is int and 0 <= value <= 999_999_999_999_999_999_999:
        value = str(value)
    require(type(value) is str and value.strip() == value and _TOKEN.fullmatch(value) is not None,
            f"KuCoin {label} is missing or malformed.")
    return value


def native_symbol(value: Any, label: str = "provider symbol") -> str:
    require(type(value) is str and _NATIVE_SYMBOL.fullmatch(value) is not None,
            f"KuCoin {label} is missing or malformed.")
    return value


def exact_integer(value: Any, label: str, *, minimum: int = 0,
                  maximum: int = MAX_SAFE_INTEGER) -> int:
    if type(value) is str:
        require(re.fullmatch(r"(?:0|[1-9][0-9]{0,18})", value) is not None,
                f"KuCoin {label} must be an exact integer.")
        value = int(value)
    if type(value) is Decimal:
        require(value.is_finite() and value == value.to_integral_value(),
                f"KuCoin {label} must be an exact integer.")
        value = int(value)
    require(type(value) is int and minimum <= value <= maximum,
            f"KuCoin {label} must be an exact integer.")
    return value


def exact_decimal(value: Any, label: str, *, signed: bool = False,
                  positive: bool = False) -> str:
    require(type(value) in (str, int, Decimal),
            f"KuCoin {label} requires an exact original decimal, not float/bool.")
    text = str(value)
    pattern = SIGNED_DECIMAL_PATTERN if signed else DECIMAL_PATTERN
    require(pattern.fullmatch(text) is not None,
            f"KuCoin {label} exceeds the exact decimal boundary.")
    try:
        number = Decimal(text)
    except InvalidOperation as error:
        raise ExchangeContractError(f"KuCoin {label} is not a finite decimal.") from error
    require(number.is_finite() and (signed or number >= 0) and (not positive or number > 0),
            f"KuCoin {label} is outside the allowed range.")
    normalized = format(number, "f")
    normalized = normalized.rstrip("0").rstrip(".") if "." in normalized else normalized
    return "0" if normalized in {"", "-0"} else normalized


def envelope(response: Any, label: str) -> Any:
    require(type(response) is dict and response.get("code") == "200000" and "data" in response,
            f"Invalid KuCoin {label} response envelope.")
    return response["data"]


def object_data(response: Any, label: str) -> dict[str, Any]:
    data = envelope(response, label)
    require(type(data) is dict, f"KuCoin {label} omitted its result object.")
    return data


def rows(value: Any, label: str, *, maximum: int = MAX_ROWS) -> list[dict[str, Any]]:
    require(type(value) is list and len(value) <= maximum
            and all(type(row) is dict for row in value),
            f"KuCoin {label} omitted its bounded collection.")
    return value


def provider_page(response: Any, label: str, expected_page: int,
                  requested_size: int) -> tuple[list[dict[str, Any]], int, int]:
    data = object_data(response, label)
    current = exact_integer(data.get("currentPage"), f"{label} currentPage", minimum=1)
    page_size = exact_integer(data.get("pageSize"), f"{label} pageSize", minimum=1,
                              maximum=requested_size)
    total = exact_integer(data.get("totalNum"), f"{label} totalNum")
    total_pages = exact_integer(data.get("totalPage"), f"{label} totalPage")
    page_rows = rows(data.get("items"), f"{label} page", maximum=page_size)
    require(current == expected_page, f"KuCoin {label} page did not advance exactly once.")
    require(total_pages == 0 or current <= total_pages,
            f"KuCoin {label} returned an impossible page boundary.")
    if total == 0:
        require(current == 1 and total_pages in {0, 1} and not page_rows,
                f"KuCoin {label} returned inconsistent empty-page evidence.")
        return page_rows, total_pages, total
    expected_pages = (total + page_size - 1) // page_size
    expected_rows = min(page_size, total - (current - 1) * page_size)
    require(total_pages == expected_pages and len(page_rows) == expected_rows,
            f"KuCoin {label} page counters do not cover the declared collection.")
    return page_rows, total_pages, total


def market_for(rest: Any, symbol: str) -> dict[str, Any]:
    symbol = native_symbol(symbol)
    by_id = getattr(rest, "markets_by_id", None)
    candidates = by_id.get(symbol) if type(by_id) is dict else None
    require(type(candidates) is list and len(candidates) == 1 and type(candidates[0]) is dict,
            "KuCoin market identity is missing or ambiguous.")
    market = candidates[0]
    require(market.get("id") == symbol and market.get("type") == "swap"
            and market.get("swap") is True and market.get("contract") is True
            and market.get("linear") is True and market.get("inverse") is False
            and market.get("active") is True and market.get("settle") == "USDT"
            and market.get("settleId") == "USDT",
            "KuCoin market is not an active linear USDT perpetual.")
    exact_decimal(market.get("contractSize"), "market contractSize", positive=True)
    token(market.get("symbol"), "unified symbol")
    return market


def original(value: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(value)
