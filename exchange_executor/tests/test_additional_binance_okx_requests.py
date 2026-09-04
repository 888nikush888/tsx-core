"""Pinned SDK wire characterization, never provider acceptance or certification.

The ordinary batch routes below deliberately preserve the researched limitations:
they do not establish attached protection, account mode, or a never-created child.
All markets/responses are synthetic native fixtures; no transport can escape.
"""
from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock

import ccxt
import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import _market_order_result, _protected_order_results
from common import ExchangeContractError, UnresolvedOrderOutcome


def native_market(exchange: str) -> dict:
    if exchange in ("okx", "myokx"):
        return {
            "instId": "BTC-USDT-SWAP", "instType": "SWAP", "uly": "BTC-USDT",
            "settleCcy": "USDT", "ctVal": "0.01", "ctValCcy": "BTC", "ctType": "linear",
            "lotSz": "1", "minSz": "1", "tickSz": "0.1", "state": "live", "lever": "100",
        }
    inverse = exchange == "binancecoinm"
    return {
        "symbol": "BTCUSD_PERP" if inverse else "BTCUSDT", "contractType": "PERPETUAL",
        "baseAsset": "BTC", "quoteAsset": "USD" if inverse else "USDT",
        "marginAsset": "BTC" if inverse else "USDT", "status": "TRADING",
        "contractSize": 100 if inverse else 1, "quantityPrecision": 0 if inverse else 3,
        "pricePrecision": 1, "orderTypes": ["LIMIT", "MARKET", "STOP_MARKET"],
    }


def protected_specs(symbol: str) -> list[dict]:
    return [
        {"symbol": symbol, "type": "limit", "side": "buy", "amount": "2", "price": "100.5",
         "params": {"clientOrderId": "tsxentry1", "timeInForce": "IOC", "reduceOnly": False}},
        {"symbol": symbol, "type": "market", "side": "sell", "amount": "2",
         "params": {"clientOrderId": "tsxstop1", "triggerPrice": "90", "reduceOnly": True}},
    ]


def attached_stop() -> dict:
    # This explicit native client ID is not synthesized by CCXT's unified stopLoss helper.
    return {"attachAlgoClOrdId": "tsxstop1", "slTriggerPx": "90",
            "slOrdPx": "-1", "slTriggerPxType": "mark"}


def native_parent(market: dict) -> dict:
    return {
        "instId": market["id"], "ordId": "900000000000001", "clOrdId": "tsxentry1",
        "side": "buy", "ordType": "ioc", "px": "100.5", "sz": "2",
        "state": "canceled", "accFillSz": "0", "avgPx": "",
        "attachAlgoOrds": [attached_stop()],
    }


class AdditionalBinanceOkxRequestsTests(unittest.IsolatedAsyncioTestCase):
    def client(self, exchange: str):
        client = getattr(ccxt_async, exchange)()
        self.addAsyncCleanup(client.close)
        client.fetch = AsyncMock(side_effect=AssertionError("Real provider transport is forbidden."))
        client.request = AsyncMock(side_effect=AssertionError("Unexpected SDK endpoint is forbidden."))
        raw = native_market(exchange)
        market = client.parse_market(raw)
        self.assertEqual(market["info"], raw)
        client.set_markets([market])
        return client, market

    def capture(self, client, endpoint: tuple[str, str, str], response):
        requests = []

        async def request(path, api, method, params, *args, **kwargs):
            self.assertEqual((path, api, method), endpoint)
            requests.append(copy.deepcopy(params))
            return copy.deepcopy(response)

        client.request = AsyncMock(side_effect=request)
        return requests

    def assert_transport(self, client):
        client.request.assert_awaited_once()
        client.fetch.assert_not_awaited()
        self.assertFalse(client.apiKey)
        self.assertFalse(client.secret)

    def test_exact_sdk_and_python_runtime(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        self.assertEqual(sys.version_info[:2], (3, 12))

    async def assert_binance_batch(self, exchange: str, api: str, stop_client_field: str):
        client, market = self.client(exchange)
        specs = protected_specs(market["symbol"])
        original = copy.deepcopy(specs)
        requests = self.capture(client, ("batchOrders", api, "POST"), [])
        self.assertEqual(await client.create_orders(specs), [])
        self.assertEqual(requests, [{"batchOrders": [
            {"symbol": market["id"], "side": "BUY", "newClientOrderId": "tsxentry1",
             "newOrderRespType": "RESULT", "type": "LIMIT", "quantity": "2",
             "price": "100.5", "timeInForce": "IOC", "reduceOnly": False},
            {"symbol": market["id"], "side": "SELL", stop_client_field: "tsxstop1",
             "newOrderRespType": "RESULT", "type": "STOP_MARKET", "quantity": "2",
             "triggerPrice": "90", "reduceOnly": True},
        ]}])
        self.assertEqual(specs, original)
        self.assert_transport(client)
        return market

    async def test_binanceusdm_stop_still_goes_to_ordinary_batch_not_algo_route(self):
        market = await self.assert_binance_batch("binanceusdm", "fapiPrivate", "clientAlgoId")
        self.assertTrue(market["linear"])
        self.assertEqual(market["settle"], "USDT")

    async def test_binancecoinm_batch_is_inverse_and_keeps_native_stop_client_id(self):
        market = await self.assert_binance_batch("binancecoinm", "dapiPrivate", "newClientOrderId")
        self.assertTrue(market["inverse"])
        self.assertFalse(market["linear"])
        self.assertEqual(market["settle"], "BTC")
        self.assertEqual(market["contractSize"], 100)

    async def test_okx_two_legs_remain_independent_ioc_and_trigger_batch_members(self):
        client, market = self.client("okx")
        specs = protected_specs(market["symbol"])
        original = copy.deepcopy(specs)
        requests = self.capture(client, ("trade/batch-orders", "private", "POST"), {"code": "0", "data": []})
        self.assertEqual(await client.create_orders(specs), [])
        self.assertEqual(requests, [[
            {"instId": market["id"], "tdMode": "cross", "clOrdId": "tsxentry1",
             "side": "buy", "ordType": "ioc", "sz": "2", "px": "100.5", "reduceOnly": False},
            {"instId": market["id"], "tdMode": "cross", "clOrdId": "tsxstop1", "side": "sell",
             "ordType": "trigger", "sz": "2", "triggerPx": "90", "orderPx": "-1", "reduceOnly": True},
        ]])
        self.assertEqual(specs, original)
        self.assert_transport(client)

    async def test_okx_attached_native_stop_preserves_cap_and_ids_but_ack_only_identifies_parent(self):
        client, market = self.client("okx")
        entry = protected_specs(market["symbol"])[0]
        entry["params"]["attachAlgoOrds"] = [attached_stop()]
        original = copy.deepcopy(entry)
        ack = {"ordId": "900000000000001", "clOrdId": "tsxentry1", "sCode": "0", "sMsg": ""}
        requests = self.capture(client, ("trade/batch-orders", "private", "POST"), {"code": "0", "data": [ack]})
        orders = await client.create_orders([entry])
        self.assertEqual(requests, [[{
            "instId": market["id"], "tdMode": "cross", "clOrdId": "tsxentry1", "side": "buy",
            "ordType": "ioc", "sz": "2", "px": "100.5", "reduceOnly": False,
            "attachAlgoOrds": [attached_stop()],
        }]])
        self.assertEqual(entry, original)
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0]["id"], ack["ordId"])
        self.assertEqual(orders[0]["clientOrderId"], "tsxentry1")
        self.assertEqual(orders[0]["info"], ack)
        self.assertIsNone(orders[0]["filled"])
        with self.assertRaises(ExchangeContractError):
            _market_order_result(orders[0], market, "tsxentry1")
        self.assert_transport(client)

    async def test_okx_and_myokx_tier_max_notional_is_unconverted_native_contract_count(self):
        for exchange in ("okx", "myokx"):
            with self.subTest(exchange=exchange):
                client, market = self.client(exchange)
                raw = [{"instId": market["id"], "tier": "1", "minSz": "0", "maxSz": "100",
                        "mmr": "0.005", "maxLever": "100"}]
                original = copy.deepcopy(raw)
                tiers = client.parse_market_leverage_tiers(raw, market)
                self.assertTrue(market["swap"] and market["linear"])
                self.assertEqual(market["symbol"], "BTC/USDT:USDT")
                self.assertEqual(Decimal(str(market["contractSize"])), Decimal("0.01"))
                self.assertEqual(market["info"]["ctValCcy"], "BTC")
                self.assertEqual(len(tiers), 1)
                self.assertEqual(tiers[0]["currency"], "USDT")
                self.assertEqual(tiers[0]["symbol"], market["symbol"])
                self.assertEqual(tiers[0]["minNotional"], 0)
                self.assertEqual(tiers[0]["maxNotional"], 100)
                self.assertEqual(tiers[0]["maxLeverage"], 100)
                self.assertEqual(tiers[0]["info"], original[0])
                quote_notional = Decimal(raw[0]["maxSz"]) * Decimal(market["info"]["ctVal"]) * Decimal("50000")
                self.assertEqual(quote_notional, Decimal("50000"))
                self.assertNotEqual(quote_notional, Decimal(str(tiers[0]["maxNotional"])))
                self.assertEqual(raw, original)
                client.request.assert_not_awaited()
                client.fetch.assert_not_awaited()

    async def test_okx_parsed_partial_fill_stays_contracts_until_boundary_converts_to_base(self):
        client, market = self.client("okx")
        raw = {**native_parent(market), "state": "partially_filled", "accFillSz": "1", "avgPx": "100"}
        original = copy.deepcopy(raw)
        order = client.parse_order(raw, market)
        self.assertEqual(order["amount"], 2)
        self.assertEqual(order["filled"], 1)
        self.assertEqual(order["remaining"], 1)
        result = _market_order_result(order, market, "tsxentry1")
        self.assertEqual(result["filledQuantity"], "0.01")
        self.assertEqual(result["status"], "partially_filled")
        self.assertEqual(result["exchangeOrderId"], raw["ordId"])
        self.assertEqual(result["providerSymbol"], market["symbol"])
        self.assertEqual(raw, original)
        client.request.assert_not_awaited()
        client.fetch.assert_not_awaited()

    async def assert_zero_fill_unresolved(self, child_raw: dict | None):
        client, market = self.client("okx")
        parent_raw = native_parent(market)
        original_parent = copy.deepcopy(parent_raw)
        parent = client.parse_order(parent_raw, market)
        self.assertEqual(parent["status"], "canceled")
        self.assertEqual(parent["filled"], 0)
        orders = [parent]
        if child_raw is not None:
            original_child = copy.deepcopy(child_raw)
            child = client.parse_order(child_raw, market)
            self.assertIsNone(child["id"])
            with self.assertRaises(ExchangeContractError):
                _market_order_result(child, market, "tsxstop1")
            orders.append(child)
            self.assertEqual(child_raw, original_child)
        specs = tuple(protected_specs(market["symbol"]))
        with self.assertRaises(UnresolvedOrderOutcome) as caught:
            _protected_order_results(orders, market, specs, "okx")
        details = caught.exception.details
        self.assertEqual(details["unresolvedClientOrderIds"], ["tsxstop1"])
        self.assertEqual(len(details["confirmedOrders"]), 1)
        confirmed = details["confirmedOrders"][0]
        self.assertEqual(confirmed["clientOrderId"], "tsxentry1")
        self.assertEqual(confirmed["exchangeOrderId"], "900000000000001")
        self.assertEqual(confirmed["filledQuantity"], "0")
        self.assertEqual(confirmed["status"], "cancelled")
        self.assertEqual(parent_raw, original_parent)
        client.request.assert_not_awaited()
        client.fetch.assert_not_awaited()

    async def test_okx_ioc_zero_fill_without_child_does_not_invent_cancel_identity(self):
        await self.assert_zero_fill_unresolved(None)

    async def test_okx_idless_cancelled_child_cannot_be_confirmed(self):
        await self.assert_zero_fill_unresolved({
            "instId": "BTC-USDT-SWAP", "clOrdId": "tsxstop1", "ordType": "conditional",
            "side": "sell", "sz": "2", "accFillSz": "0", "state": "canceled",
        })

    async def test_okx_attach_algo_id_is_not_an_executing_child_algo_id(self):
        await self.assert_zero_fill_unresolved({
            "instId": "BTC-USDT-SWAP", "clOrdId": "tsxstop1", "ordType": "conditional",
            "side": "sell", "sz": "2", "accFillSz": "0", "state": "canceled",
            "attachAlgoId": "900000000000002", "attachAlgoClOrdId": "tsxstop1",
        })


if __name__ == "__main__":
    unittest.main()
