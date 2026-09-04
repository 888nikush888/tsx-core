"""Observe already-applied Kraken quantity arithmetic without granting unit authority.

No I/O or new market lookup: the caller supplies the actual operands and result.
Original hashes cover retained normalized raw, not unretained provider envelopes.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any

SAFE_INTEGER = 9_007_199_254_740_991


def _safe_json(value: Any) -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")  # Reject unpaired or explicitly encoded surrogates.
        return
    if type(value) is int and abs(value) <= SAFE_INTEGER:
        return
    if isinstance(value, list):
        for item in value:
            _safe_json(item)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for key, item in value.items():
            _safe_json(key)
            _safe_json(item)
        return
    raise ValueError("Quantity provenance requires exact JSON scalars, not floats or unsafe integers.")


def normalization_hash(domain: str, value: Any) -> str:
    """Unicode-codepoint key order; integer-only JSON shared with the Node validator."""
    _safe_json(value)
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256((domain + "\n" + canonical).encode("utf-8")).hexdigest()


def _decimal_text(value: Decimal) -> str:
    rendered = format(value, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def _reduce_coefficient(coefficient: int, exponent: int) -> tuple[int, int]:
    while coefficient and coefficient % 10 == 0:
        coefficient //= 10
        exponent += 1
    return coefficient, exponent


def _coefficient(value: Decimal) -> tuple[int, int]:
    parts = value.as_tuple()
    coefficient = 0
    for digit in parts.digits:
        coefficient = coefficient * 10 + digit
    return _reduce_coefficient(-coefficient if parts.sign else coefficient, int(parts.exponent))


def _exact_product(quantity: Decimal, factor: Decimal, output: Decimal) -> bool:
    # Integer coefficients cannot round or modify the ambient Decimal context.
    quantity_coefficient, quantity_exponent = _coefficient(quantity)
    factor_coefficient, factor_exponent = _coefficient(factor)
    product = _reduce_coefficient(quantity_coefficient * factor_coefficient, quantity_exponent + factor_exponent)
    return product == _coefficient(output)


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 256 and value.strip() == value and all(ord(char) >= 32 for char in value)


def _market_evidence(market: dict[str, Any], factor: Decimal) -> dict[str, Any] | None:
    if market.get("contract") is not True or market.get("linear") is not True or market.get("inverse") is not False:
        return None
    fields = {"providerMarketId": market.get("id"), "providerSymbol": market.get("symbol"),
              "base": market.get("base"), "quote": market.get("quote"), "settlementAsset": market.get("settle")}
    if not all(_identifier(value) for value in fields.values()):
        return None
    evidence = {**fields, "contract": True, "linear": True, "inverse": False,
                "appliedContractSize": _decimal_text(factor), "source": "ccxt-4.5.75-loaded-market",
                "observedAt": None, "providerContractSize": None, "providerOriginalStatus": "not-retained"}
    return {**evidence, "sourceHash": normalization_hash("kraken-normalization-market-v1", evidence)}


def observe_fill_quantity(market: dict[str, Any], trade: dict[str, Any], identity: dict[str, Any] | None,
                          quantity: Decimal, factor: Decimal, output: Decimal, *, decimal_precision: int,
                          decimal_rounding: str, normalized_at: int) -> dict[str, Any] | None:
    """Supplement a native v3 fill; missing evidence never becomes an inferred factor.

    Arithmetic arguments are the very operands/result used by the existing caller.
    This observation does not certify the event-time instrument or authorize money.
    """
    if identity is None or identity.get("profile") != "kraken_history_execution_v3":
        return None
    evidence = _market_evidence(market, factor)
    if evidence is None:
        return None
    original_hash = normalization_hash("kraken-normalization-original-v1", trade)
    return {"version": 1, "source": "kraken-execution-normalization-v1", "inputField": "execution.quantity",
            "inputQuantity": _decimal_text(quantity), "inputUnit": "kraken_native_execution_quantity",
            "appliedFactor": _decimal_text(factor), "outputQuantity": _decimal_text(output), "outputUnit": "base",
            "arithmetic": {"operation": "multiply", "decimalPrecision": decimal_precision,
                           "decimalRounding": decimal_rounding, "exactProduct": _exact_product(quantity, factor, output)},
            "market": evidence, "nativeIdentity": dict(identity), "originalExecutionHash": original_hash,
            "normalizedAt": normalized_at}
