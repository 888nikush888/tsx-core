from __future__ import annotations

from typing import Any, Iterable


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
    return [
        market for market in markets
        if market.get("contract") is True
        and market.get("swap") is True
        and market.get("linear") is True
        and market.get("active") is not False
        and str(market.get("base") or "").isalnum()
    ]


def resolve_symbol(
    markets: dict[str, dict[str, Any]] | Iterable[dict[str, Any]],
    symbol: str,
    settlement_preference: tuple[str, ...],
) -> dict[str, Any]:
    base = requested_base(symbol)
    values = markets.values() if isinstance(markets, dict) else markets
    candidates = [market for market in linear_swap_markets(values) if str(market.get("base")).upper() == base]
    if not candidates:
        raise SymbolResolutionError("SYMBOL_UNAVAILABLE", f"Symbol {symbol} has no active linear perpetual market.")
    ranked: list[tuple[int, dict[str, Any]]] = []
    for market in candidates:
        settlement = str(market.get("settle") or market.get("quote") or "").upper()
        rank = settlement_preference.index(settlement) if settlement in settlement_preference else len(settlement_preference)
        ranked.append((rank, market))
    best_rank = min(rank for rank, _market in ranked)
    best = [market for rank, market in ranked if rank == best_rank]
    if len(best) != 1:
        raise SymbolResolutionError("SYMBOL_AMBIGUOUS", f"Symbol {symbol} resolves to multiple equally preferred markets.")
    return best[0]

