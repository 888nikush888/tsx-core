"""Analysis-only probe: real pinned SDK, fake transport, deliberately one red test.

Synthetic non-1 instrument factors do not certify a currently listed Kraken market.
No provider call, production edit, or test-registry entry is made by this file.
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from decimal import Decimal, localcontext
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "exchange_executor"))

import ccxt  # noqa: E402
from ccxt.async_support import krakenfutures  # noqa: E402
from ccxt_adapter import _normalized_fill  # noqa: E402
from common import ExchangeContractError  # noqa: E402
from kraken_history import _execution  # noqa: E402

UID = "11111111-1111-4111-8111-111111111111"
EXECUTION = "22222222-2222-4222-8222-222222222222"
ORDER = "33333333-3333-4333-8333-333333333333"
STAMP = 1788300000000
SYMBOL = "BTC/USD:USD"


def execution_row(quantity="4", side="Buy"):
    return {"uid": "44444444-4444-4444-8444-444444444444", "timestamp": STAMP,
            "event": {"execution": {"execution": {"uid": EXECUTION, "timestamp": STAMP,
                "quantity": quantity, "price": "100", "orderData": {"fee": "0.01", "positionSize": quantity},
                "order": {"uid": ORDER, "accountUid": UID, "tradeable": "PF_XBTUSD",
                          "direction": side, "clientId": "local-probe-client"}}}}}


class QuantityOriginalProbe(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        self.rest = krakenfutures({"enableRateLimit": False})
        self.calls = []
        self.factor_token = "0.25"

        async def fake_transport(url, method="GET", headers=None, body=None):
            self.assertEqual(method, "GET")
            self.assertEqual(url, "https://futures.kraken.com/derivatives/api/v3/instruments")
            self.calls.append((method, url))
            response = {"result": "success", "serverTime": "2026-09-02T09:00:00.000Z", "instruments": [{
                "symbol": "PF_XBTUSD", "type": "flexible_futures", "tradeable": True,
                "base": "XBT", "quote": "USD", "contractSize": "PROBE_FACTOR_TOKEN",
                "tickSize": 0.5, "contractValueTradePrecision": 4, "marginLevels": []}]}
            original = json.dumps(response).replace('"PROBE_FACTOR_TOKEN"', self.factor_token)
            self.rest.last_http_response = original
            return self.rest.parse_json(original)

        self.rest.fetch = fake_transport

    async def asyncTearDown(self):
        await self.rest.close()

    async def loaded_market(self, factor="0.25"):
        self.factor_token = factor
        markets = await self.rest.fetch_markets()
        self.rest.set_markets(markets)
        return self.rest.market(SYMBOL)

    def normalized(self, quantity="4", side="Buy"):
        trade = _execution(self.rest, execution_row(quantity, side), UID, SYMBOL)
        return _normalized_fill(self.rest, {}, trade, "krakenfutures")

    async def test_actual_sdk_maps_factor_separately_from_minimum_precision(self):
        market = await self.loaded_market()
        self.assertEqual(Decimal(str(market["contractSize"])), Decimal("0.25"))
        self.assertEqual(Decimal(str(market["precision"]["amount"])), Decimal("0.0001"))
        self.assertTrue(market["linear"])
        self.assertEqual(len(self.calls), 1)
        fill = self.normalized()
        self.assertEqual(fill["raw"]["amount"], "4")
        self.assertEqual(fill["quantity"], "1")
        self.assertEqual(fill["identity"]["providerFillId"], EXECUTION)
        self.assertIsNone(fill["feeAsset"])

    async def test_actual_product_for_fraction_large_factor_short_and_unit_control(self):
        for factor, quantity, expected, side in [("1", "4", "4", "Buy"), ("0.25", "4", "1", "Buy"),
                                                 ("2.5", "4", "10", "Sell"), ("0.25", "0.2", "0.05", "Sell")]:
            with self.subTest(factor=factor, quantity=quantity, side=side):
                await self.loaded_market(factor)
                fill = self.normalized(quantity, side)
                self.assertEqual(fill["quantity"], expected)
                self.assertEqual(fill["raw"]["side"], side.lower())

    async def test_original_execution_and_market_are_not_mutated_by_normalization(self):
        market = await self.loaded_market()
        trade = _execution(self.rest, execution_row(), UID, SYMBOL)
        original_trade, original_market = copy.deepcopy(trade), copy.deepcopy(market)
        self.assertIs(_normalized_fill(self.rest, {}, trade, "krakenfutures")["raw"], trade)
        self.assertEqual(trade, original_trade)
        self.assertEqual(market, original_market)

    async def test_invalid_factor_does_not_become_one(self):
        market = await self.loaded_market()
        for factor in (None, 0, -1, "NaN", "Infinity"):
            with self.subTest(factor=factor), self.assertRaises(ExchangeContractError):
                market["contractSize"] = factor
                self.normalized()

    async def test_latest_market_cannot_reconstruct_original_applied_factor(self):
        market = await self.loaded_market()
        first = self.normalized()
        market["contractSize"] = 0.5
        later = self.normalized()
        self.assertEqual(first["raw"], later["raw"])
        self.assertEqual((first["quantity"], later["quantity"]), ("1", "2"))
        self.assertEqual(first["accounting"], later["accounting"], "Existing metadata cannot distinguish these factors.")

    async def test_provider_decimal_token_and_actually_applied_sdk_value_are_distinct(self):
        market = await self.loaded_market("0.10000000000000001")
        self.assertIn('"contractSize": 0.10000000000000001', self.rest.last_http_response)
        self.assertEqual(Decimal(str(market["contractSize"])), Decimal("0.1"))
        self.assertNotEqual(Decimal(str(market["contractSize"])), Decimal("0.10000000000000001"))
        self.assertEqual(self.normalized()["quantity"], "0.4")

    async def test_applied_arithmetic_can_be_rounded_and_must_not_be_called_exact(self):
        await self.loaded_market()
        original = "12345678901234567890.12345679"
        with localcontext() as context:
            context.prec = 100
            exact = Decimal(original) * Decimal("0.25")
        with localcontext() as context:
            context.prec = 28  # The current normalizer uses its ambient Decimal context.
            fill = self.normalized(original)
        self.assertNotEqual(Decimal(fill["quantity"]), exact)
        self.assertEqual(fill["raw"]["amount"], original)

    async def test_red_actual_factor_and_original_quantity_must_survive_as_separate_provenance(self):
        await self.loaded_market()
        fill = self.normalized()
        self.assertIn("quantityNormalization", fill,
                      "Actual 4 x 0.25 = 1 normalization discards its factor; this is the intended red regression.")
        proof = fill["quantityNormalization"]
        self.assertEqual(proof["inputQuantity"], "4")
        self.assertEqual(proof["appliedFactor"], "0.25")
        self.assertEqual(proof["outputQuantity"], "1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
