from __future__ import annotations

from decimal import Decimal, InvalidOperation
import re
from typing import Any, Iterable


_USD_UNITS = frozenset(("USD", "USDT", "USDC"))
_PRODUCT_FLAGS = ("spot", "swap", "future", "option")
_MAX_MARKETS = 100_000
_BASE_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


class SymbolResolutionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def requested_base(symbol: str) -> str:
    normalized = symbol.upper().replace("/", "").replace("-", "").replace(":", "")
    for suffix in ("USDTUSDT", "USDCUSDC", "USDUSD", "USDT", "USDC", "USD"):
        if normalized.endswith(suffix) and len(normalized) > len(suffix):
            base = normalized[: -len(suffix)]
            if base.isalnum():
                return base
    raise SymbolResolutionError("SYMBOL_INVALID", f"Symbol {symbol} must be a USD, USDC or USDT pair.")


def linear_swap_markets(markets: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    # Discovery only: this prefilter is not the execution admission contract.
    return [
        market for market in markets
        if market.get("contract") is True
        and market.get("swap") is True
        and market.get("linear") is True
        and market.get("active") is not False
        and str(market.get("base") or "").isalnum()
    ]


def _require_metadata(condition: bool, field: str) -> None:
    if not condition:
        raise SymbolResolutionError("SYMBOL_METADATA_UNPROVEN", f"Market metadata is missing or inconsistent: {field}.")


def _token(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 64 and value.isascii() and value.isalnum()


def _text(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 256 and all(32 < ord(char) < 127 for char in value)


def _settlement_policy(preference: tuple[str, ...]) -> None:
    _require_metadata(isinstance(preference, tuple) and 0 < len(preference) <= len(_USD_UNITS), "settlement whitelist")
    _require_metadata(all(isinstance(unit, str) and unit in _USD_UNITS for unit in preference), "settlement whitelist")
    _require_metadata(len(set(preference)) == len(preference), "duplicate settlement whitelist")


def _positive_multiplier(value: Any) -> bool:
    # This is bounded normalized metadata, not proof of a provider-original decimal.
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return False
    text = str(value)
    if len(text) > 128 or text != text.strip():
        return False
    try:
        number = Decimal(text)
    except (InvalidOperation, ValueError):
        return False
    if not number.is_finite() or number <= 0:
        return False
    _sign, digits, exponent = number.as_tuple()
    # Do not normalize using the ambient Decimal context (it can round).
    length = len(digits)
    while length > 1 and digits[length - 1] == 0:
        length -= 1
        exponent += 1
    return max(-exponent, 0) <= 18 and max(length + exponent, 0) <= 36


def _product_kind(market: dict[str, Any]) -> str:
    kind = market.get("type")
    _require_metadata(isinstance(kind, str) and kind in _PRODUCT_FLAGS, "type")
    for flag in _PRODUCT_FLAGS:
        _require_metadata(market.get(flag) is (flag == kind), flag)
    _require_metadata(market.get("contract") is (kind != "spot"), "contract")
    _require_metadata(type(market.get("active")) is bool, "active")
    _require_metadata("expiry" in market, "expiry")
    if kind in ("spot", "swap"):
        _require_metadata(market["expiry"] is None, "perpetual/spot expiry")
    else:
        _require_metadata(type(market["expiry"]) is int and 0 < market["expiry"] <= 9_007_199_254_740_991, "expiry")
    return kind


def _contract_identity(market: dict[str, Any], kind: str) -> None:
    settle = market.get("settle")
    _require_metadata(_token(settle) and settle == settle.upper(), "settle")
    _require_metadata(type(market.get("linear")) is bool and type(market.get("inverse")) is bool, "linear/inverse")
    _require_metadata(market["linear"] != market["inverse"], "linear/inverse conflict")
    _require_metadata(market.get("quanto") is None or market.get("quanto") is False, "quanto")
    expected = f"{market['base']}/{market['quote']}:{settle}"
    actual = market["symbol"]
    matches = actual == expected if kind == "swap" else actual.startswith(expected + "-") and len(actual) > len(expected) + 1
    _require_metadata(matches, "symbol units/type")
    _require_metadata(_positive_multiplier(market.get("contractSize")), "contractSize")


def _execution_candidate(market: dict[str, Any], preference: tuple[str, ...]) -> bool:
    kind = _product_kind(market)
    _require_metadata(_text(market.get("id")) and _text(market.get("symbol")), "id/symbol")
    quote = market.get("quote")
    _require_metadata(_token(quote) and quote == quote.upper(), "quote")
    if kind == "spot":
        _require_metadata(market["symbol"] == f"{market['base']}/{quote}", "spot symbol")
        for flag in ("linear", "inverse"):
            _require_metadata(market.get(flag) is None or market.get(flag) is False, "spot contract flags")
        return False
    _contract_identity(market, kind)
    return (kind == "swap" and market["active"] is True and market["linear"] is True
            and quote in _USD_UNITS and market["settle"] in preference)


def _ranked_candidates(markets: Any, base: str, preference: tuple[str, ...]) -> list[tuple[int, dict[str, Any]]]:
    ranked = []
    try:
        values = markets.values() if isinstance(markets, dict) else iter(markets)
        for count, market in enumerate(values, 1):
            _require_metadata(count <= _MAX_MARKETS, "inventory bound")
            _require_metadata(isinstance(market, dict), "market record")
            market_base = market.get("base")
            # Known SDK punctuation (e.g. HIP-3 xyz-XYZ100) remains a distinct
            # base, never an alias for the requested base or an unknown row.
            _require_metadata(isinstance(market_base, str) and _BASE_TOKEN.fullmatch(market_base) is not None, "base")
            if market_base.upper() == base and _execution_candidate(market, preference):
                ranked.append((preference.index(market["settle"]), market))
    except SymbolResolutionError:
        raise
    except Exception as error:
        raise SymbolResolutionError("SYMBOL_METADATA_UNPROVEN", "Market inventory could not be completely read.") from error
    return ranked


def resolve_symbol(
    markets: dict[str, dict[str, Any]] | Iterable[dict[str, Any]],
    symbol: str,
    settlement_preference: tuple[str, ...],
) -> dict[str, Any]:
    base = requested_base(symbol)
    _settlement_policy(settlement_preference)
    ranked = _ranked_candidates(markets, base, settlement_preference)
    if not ranked:
        raise SymbolResolutionError("SYMBOL_UNAVAILABLE", f"Symbol {symbol} has no active linear perpetual market.")
    best_rank = min(rank for rank, _market in ranked)
    best = [market for rank, market in ranked if rank == best_rank]
    if len(best) != 1:
        raise SymbolResolutionError("SYMBOL_AMBIGUOUS", f"Symbol {symbol} resolves to multiple equally preferred markets.")
    return best[0]
