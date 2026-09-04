"""Actual pinned SDK parsing and fill normalization; all transport is intercepted.

Non-1 markets here are synthetic, not approved Kraken quantity/Cashleg profiles.
The hash covers retained normalized raw, never an unavailable full HTTP original.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import unittest
from decimal import Decimal, ROUND_DOWN, getcontext, localcontext
from pathlib import Path
from unittest.mock import patch

import ccxt
from ccxt.async_support import krakenfutures

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import _normalized_fill
from common import ExchangeContractError
from fill_quantity_provenance import normalization_hash
from kraken_history import _execution

ACCOUNT = "11111111-1111-4111-8111-111111111111"
EXECUTION = "22222222-2222-4222-8222-222222222222"
ORDER = "33333333-3333-4333-8333-333333333333"
STAMP = 1788300000000
NORMALIZED_AT = STAMP + 60_000
SYMBOL = "BTC/USD:USD"


def execution_row(quantity="4", side="Buy"):
    return {"uid": "44444444-4444-4444-8444-444444444444", "timestamp": STAMP,
            "event": {"execution": {"execution": {"uid": EXECUTION, "timestamp": STAMP,
                "quantity": quantity, "price": "100", "orderData": {"fee": "0.01", "positionSize": quantity},
                "order": {"uid": ORDER, "accountUid": ACCOUNT, "tradeable": "PF_XBTUSD",
                          "direction": side, "clientId": "local-probe-client"}}}}}


def expected_hash(domain, value):
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((domain + "\n" + canonical).encode("utf-8")).hexdigest()


class FillQuantityProvenanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        self.rest = krakenfutures({"enableRateLimit": False})
        self.calls = []
        self.factor_token = "0.25"

        async def fake_transport(url, method="GET", headers=None, body=None):
            self.assertEqual((method, url), ("GET", "https://futures.kraken.com/derivatives/api/v3/instruments"))
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
        self.rest.set_markets(await self.rest.fetch_markets())
        return self.rest.market(SYMBOL)

    def trade(self, quantity="4", side="Buy"):
        return _execution(self.rest, execution_row(quantity, side), ACCOUNT, SYMBOL)

    def normalized(self, quantity="4", side="Buy", trade=None):
        with patch("ccxt_adapter.now_ms", return_value=NORMALIZED_AT):
            return _normalized_fill(self.rest, {}, self.trade(quantity, side) if trade is None else trade, "krakenfutures")

    async def test_actual_factor_and_original_quantity_survive_separately(self):
        await self.loaded_market()
        precision, rounding = getcontext().prec, getcontext().rounding
        fill = self.normalized()
        self.assertIn("quantityNormalization", fill,
                      "The current 4 x 0.25 = 1 normalization discards its applied factor.")
        proof = fill["quantityNormalization"]
        self.assertEqual((proof["inputQuantity"], proof["appliedFactor"], proof["outputQuantity"]), ("4", "0.25", "1"))
        self.assertEqual((proof["version"], proof["source"], proof["inputField"]),
                         (1, "kraken-execution-normalization-v1", "execution.quantity"))
        self.assertEqual((proof["inputUnit"], proof["outputUnit"]), ("kraken_native_execution_quantity", "base"))
        self.assertEqual(proof["nativeIdentity"], fill["identity"])
        self.assertEqual(proof["normalizedAt"], NORMALIZED_AT)
        self.assertNotEqual(proof["normalizedAt"], fill["filledAt"])
        self.assertEqual(proof["arithmetic"], {"operation": "multiply", "decimalPrecision": precision,
                                              "decimalRounding": rounding, "exactProduct": True})
        self.assertEqual(len(self.calls), 1, "Normalization performs no additional instrument read.")

    async def test_synthetic_unit_fraction_large_factor_short_and_fractional_input(self):
        for factor, quantity, expected, side in [("1", "4", "4", "Buy"), ("0.25", "4", "1", "Buy"),
                                                 ("2.5", "4", "10", "Sell"), ("0.25", "0.2", "0.05", "Sell")]:
            with self.subTest(factor=factor, quantity=quantity, side=side):
                await self.loaded_market(factor)
                fill = self.normalized(quantity, side)
                proof = fill["quantityNormalization"]
                self.assertEqual(fill["quantity"], expected)
                self.assertEqual((proof["inputQuantity"], proof["appliedFactor"], proof["outputQuantity"]),
                                 (quantity, factor, expected))
                self.assertTrue(proof["arithmetic"]["exactProduct"])
                self.assertEqual(fill["raw"]["side"], side.lower())
                self.assertIsNone(fill["feeAsset"], "Quantity metadata must not invent a fee asset.")

    async def test_unretained_provider_decimal_spelling_is_not_reconstructed(self):
        await self.loaded_market()
        row = execution_row("4.000")
        trade = _execution(self.rest, row, ACCOUNT, SYMBOL)
        self.assertEqual(row["event"]["execution"]["execution"]["quantity"], "4.000")
        self.assertEqual(trade["amount"], "4", "The existing parser has already canonicalized the input token.")
        fill = self.normalized(trade=trade)
        self.assertEqual(fill["raw"]["amount"], "4")
        self.assertEqual(fill["quantityNormalization"]["inputQuantity"], "4")
        self.assertEqual(fill["quantity"], "1")

    async def test_retained_raw_and_market_are_unchanged_and_hash_scope_is_explicit(self):
        market = await self.loaded_market()
        trade = self.trade()
        original_trade, original_market = copy.deepcopy(trade), copy.deepcopy(market)
        fill = self.normalized(trade=trade)
        self.assertIs(fill["raw"], trade)
        self.assertEqual((trade, market), (original_trade, original_market))
        proof = fill["quantityNormalization"]
        self.assertEqual(proof["originalExecutionHash"], expected_hash("kraken-normalization-original-v1", trade))
        self.assertNotEqual(proof["originalExecutionHash"], expected_hash("kraken-normalization-original-v1", execution_row()),
                            "The complete provider execution envelope is not retained by the existing parser.")
        evidence = proof["market"]
        self.assertEqual(evidence["sourceHash"], expected_hash("kraken-normalization-market-v1",
                         {key: value for key, value in evidence.items() if key != "sourceHash"}))
        self.assertEqual((evidence["providerMarketId"], evidence["providerSymbol"], evidence["base"],
                          evidence["quote"], evidence["settlementAsset"]), ("PF_XBTUSD", SYMBOL, "BTC", "USD", "USD"))
        self.assertEqual((evidence["contract"], evidence["linear"], evidence["inverse"]), (True, True, False))

    async def test_original_provider_token_is_not_claimed_after_sdk_float_parsing(self):
        market = await self.loaded_market("0.10000000000000001")
        self.assertIn('"contractSize": 0.10000000000000001', self.rest.last_http_response)
        self.assertEqual(Decimal(str(market["contractSize"])), Decimal("0.1"))
        proof = self.normalized()["quantityNormalization"]
        self.assertEqual((proof["appliedFactor"], proof["outputQuantity"]), ("0.1", "0.4"))
        self.assertEqual(proof["market"]["appliedContractSize"], "0.1")
        self.assertEqual(proof["market"]["providerOriginalStatus"], "not-retained")
        self.assertIsNone(proof["market"]["providerContractSize"])
        self.assertIsNone(proof["market"]["observedAt"])

    async def test_decimal_rounding_is_preserved_and_not_called_exact(self):
        await self.loaded_market()
        original = "12345678901234567890.12345679"
        with localcontext() as context:
            context.prec = 100
            exact = Decimal(original) * Decimal("0.25")
        for precision, rounding in ((28, "ROUND_HALF_EVEN"), (18, ROUND_DOWN)):
            with self.subTest(precision=precision), localcontext() as context:
                context.prec, context.rounding = precision, rounding
                expected = Decimal(original) * Decimal("0.25")
                context.clear_flags()
                fill = self.normalized(original)
                self.assertEqual(Decimal(fill["quantity"]), expected)
                self.assertNotEqual(Decimal(fill["quantity"]), exact)
                self.assertEqual(fill["raw"]["amount"], original)
                self.assertEqual(fill["quantityNormalization"]["arithmetic"], {
                    "operation": "multiply", "decimalPrecision": precision,
                    "decimalRounding": rounding, "exactProduct": False})

    async def test_helper_does_not_change_ambient_context_or_flags(self):
        await self.loaded_market()
        with localcontext() as context:
            context.prec = 28
            context.clear_flags()
            Decimal("12345678901234567890.12345679") * Decimal("0.25")
            expected_flags = dict(context.flags)
            context.clear_flags()
            self.normalized("12345678901234567890.12345679")
            self.assertEqual(context.flags, expected_flags)
            self.assertIs(getcontext(), context)
            self.assertEqual(context.prec, 28)

    async def test_factor_is_not_read_again_after_the_actual_product(self):
        market = await self.loaded_market()

        class ChangingMarket(dict):
            factor_reads = 0

            def __getitem__(self, key):
                if key == "contractSize":
                    self.factor_reads += 1
                    return Decimal("0.25") if self.factor_reads == 1 else Decimal("2.5")
                return super().__getitem__(key)

        changing = ChangingMarket(market)
        trade = self.trade()
        with patch.object(self.rest, "market", return_value=changing):
            fill = self.normalized(trade=trade)
        self.assertEqual(changing.factor_reads, 1)
        self.assertEqual((fill["quantity"], fill["quantityNormalization"]["appliedFactor"]), ("1", "0.25"))

    async def test_later_market_observation_does_not_rewrite_prior_provenance(self):
        market = await self.loaded_market()
        first = self.normalized()
        original_proof = copy.deepcopy(first["quantityNormalization"])
        market["contractSize"] = 0.5
        later = self.normalized()
        self.assertEqual(first["raw"], later["raw"])
        self.assertEqual(first["accounting"], later["accounting"])
        self.assertEqual((first["quantity"], later["quantity"]), ("1", "2"))
        self.assertEqual(first["quantityNormalization"], original_proof)
        self.assertEqual(first["quantityNormalization"]["originalExecutionHash"], later["quantityNormalization"]["originalExecutionHash"])
        self.assertNotEqual(first["quantityNormalization"]["market"]["sourceHash"], later["quantityNormalization"]["market"]["sourceHash"])

    async def test_invalid_factor_does_not_become_one(self):
        market = await self.loaded_market()
        for factor in (None, 0, -1, "NaN", "Infinity"):
            with self.subTest(factor=factor), self.assertRaises(ExchangeContractError):
                market["contractSize"] = factor
                self.normalized()

    async def test_unproven_native_identity_or_market_flags_do_not_create_observation(self):
        market = await self.loaded_market()
        trade = self.trade()
        for field, value in (("executionUid", "different"), ("accountUid", None), ("tradeable", "PF_OTHERUSD")):
            changed = {**trade, "info": {**trade["info"], field: value}}
            with self.subTest(native_field=field):
                self.assertNotIn("quantityNormalization", self.normalized(trade=changed))
        for field, value in (("contract", None), ("contract", 1), ("linear", None), ("linear", 1), ("inverse", None), ("inverse", 0)):
            with self.subTest(market_field=field, value=value), patch.object(self.rest, "market", return_value={**market, field: value}):
                self.assertNotIn("quantityNormalization", self.normalized(trade=trade))

    async def test_original_hash_binds_account_order_execution_and_economics(self):
        await self.loaded_market()
        trade = self.trade()
        original_hash = self.normalized(trade=trade)["quantityNormalization"]["originalExecutionHash"]
        for changed in ({**trade, "info": {**trade["info"], "accountUid": "another-account"}},
                        {**trade, "order": "another-order", "info": {**trade["info"], "orderUid": "another-order"}},
                        {**trade, "id": "another-execution", "info": {**trade["info"], "executionUid": "another-execution"}},
                        {**trade, "price": "101"}, {**trade, "amount": "5"}, {**trade, "fee": {"cost": "0.02", "currency": None}}):
            with self.subTest(raw=changed):
                self.assertNotEqual(self.normalized(trade=changed)["quantityNormalization"]["originalExecutionHash"], original_hash)


class QuantityCanonicalHashTests(unittest.TestCase):
    def test_canonical_key_order_is_codepoint_order_and_strings_keep_original_unicode(self):
        value = {"😀": "é", "\ue000": [None, True, False, 9_007_199_254_740_991], "10": "ten", "2": "two",
                 "nested": {"z": "\u2028", "a": "\"\\\n\b\t\f\r"}}
        reversed_value = dict(reversed(list(value.items())))
        expected = expected_hash("kraken-normalization-original-v1", value)
        self.assertEqual(normalization_hash("kraken-normalization-original-v1", value), expected)
        self.assertEqual(normalization_hash("kraken-normalization-original-v1", reversed_value), expected)
        self.assertNotEqual(normalization_hash("kraken-normalization-market-v1", value), expected)

    def test_float_unsafe_integer_surrogate_and_non_json_values_are_rejected(self):
        for value in (1.0, 0.1, float("nan"), float("inf"), 9_007_199_254_740_992, -9_007_199_254_740_992,
                      "\ud800", {"\udfff": "value"}, {"nested": [1.0]}, (1, 2), {1: "key"}, object()):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                normalization_hash("kraken-normalization-original-v1", value)


if __name__ == "__main__":
    unittest.main()
