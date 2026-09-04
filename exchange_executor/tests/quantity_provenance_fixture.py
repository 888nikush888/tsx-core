"""Emit actual Python output for Node contract tests; SDK transport is fully fake.

This is no broker integration. Synthetic market factors grant no financial scope.
"""
from __future__ import annotations

import asyncio
import json
from decimal import localcontext

from test_fill_quantity_provenance import FillQuantityProvenanceTests


async def fixture():
    probe = FillQuantityProvenanceTests()
    await probe.asyncSetUp()
    rows = []
    try:
        for name, factor, quantity, side in (
            ("unit", "1", "4", "Buy"), ("quarter", "0.25", "4", "Buy"),
            ("large-short", "2.5", "4", "Sell"), ("fractional-short", "0.25", "0.2", "Sell"),
            ("rounded", "0.25", "12345678901234567890.12345679", "Buy"),
            ("sdk-token-rounded", "0.10000000000000001", "4", "Buy"),
            ("parser-canonicalized-spelling", "0.25", "4.000", "Buy"),
        ):
            await probe.loaded_market(factor)
            with localcontext() as context:
                context.prec = 28
                context.rounding = "ROUND_HALF_EVEN"
                rows.append({"name": name, "fill": probe.normalized(quantity, side)})
        return rows
    finally:
        await probe.asyncTearDown()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(fixture()), separators=(",", ":"), ensure_ascii=True))
