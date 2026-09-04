"""Offline boundaries for Phase-009 candidate group C; never provider acceptance."""
from __future__ import annotations

import hashlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import ccxt
import ccxt.async_support as sdk


SOURCE_HASHES = {
    "async_support/woo.py": "123e1b2cb81b61d02d037501710015704bb9ded3e5f1e752db89849839200898",
    "async_support/woofipro.py": "e81dcdf6d7cb51aaba7f31b37e76ba49779df38684a57a86bd90a4b3215345d8",
    "async_support/modetrade.py": "e9289db2b53686ba54687ec7e7ca3747f2bf2de9814ba7191c53af94fe166ce5",
    "async_support/weex.py": "beb23d3eeead7b11d965ef9b017caa7a851e9f13f834a6edc79b6c93e9907bf8",
    "async_support/xt.py": "fc1cee6f675a43faebeef2ea7a35760830360a3b187f3d00ca087ee4e3f119a4",
    "pro/woo.py": "39bb1f6baf5f2429009e74561c5aa64259eda7dd70b42fe8da527dcad8464baa",
    "pro/woofipro.py": "8289f5b43922604a5d60e32abee8b66ea27b0673be7f359924ae48eb396cdd3d",
    "pro/modetrade.py": "f7aea910eb96ef7a25d6ca869d9839eae0ad9b56d0f38768cf215aff46a2f5a5",
    "pro/weex.py": "8a8e44a5e6b32033378526e4fca8a52bbf5d34e3d1bb3cff71f7e3910142b3e9",
    "pro/xt.py": "dbe54604c83c37741165acbdebb40734bf9333f2f74fff738a7bc5d845dbeadc",
}


def market_for(exchange: str) -> dict:
    identifiers = {
        "woo": "PERP_BTC_USDT",
        "woofipro": "PERP_BTC_USDC",
        "modetrade": "PERP_BTC_USDC",
        "weex": "BTCUSDT",
        "xt": "btc_usdt",
    }
    settle = "USDC" if exchange in {"woofipro", "modetrade"} else "USDT"
    return {
        "id": identifiers[exchange],
        "symbol": f"BTC/{settle}:{settle}",
        "base": "BTC",
        "quote": settle,
        "settle": settle,
        "baseId": "BTC",
        "quoteId": settle,
        "settleId": settle,
        "type": "swap",
        "spot": False,
        "swap": True,
        "future": False,
        "option": False,
        "contract": True,
        "linear": True,
        "inverse": False,
        "active": True,
        "contractSize": 1,
        "precision": {"amount": 0.001, "price": 0.1},
        "limits": {},
        "info": {},
    }


def client_for(exchange: str):
    client = getattr(sdk, exchange)({"options": {"adjustForTimeDifference": False}})
    client.fetch = AsyncMock(side_effect=AssertionError("Provider transport is forbidden."))
    client.request = AsyncMock(side_effect=AssertionError("Unexpected SDK endpoint is forbidden."))
    client.set_markets([market_for(exchange)])
    return client


class CandidateGroupCBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def test_pinned_rest_and_pro_sources_are_exact(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        package = Path(ccxt.__file__).resolve().parent
        for relative, expected in SOURCE_HASHES.items():
            with self.subTest(relative=relative):
                actual = hashlib.sha256((package / relative).read_bytes()).hexdigest()
                self.assertEqual(actual, expected)

    async def test_woo_bracket_drops_ioc_and_returns_the_first_child_identity(self):
        client = client_for("woo")
        client.v3PrivatePostTradeAlgoOrder = AsyncMock(return_value={
            "success": True,
            "data": {"rows": [
                {"algoOrderId": "432133", "clientAlgoOrderId": "0", "algoType": "STOP_LOSS"},
                {"algoOrderId": "432130", "clientAlgoOrderId": "tsx-entry", "algoType": "BRACKET"},
            ]},
            "timestamp": "1700000000000",
        })
        try:
            order = await client.create_order(
                "BTC/USDT:USDT", "limit", "buy", "0.01", "50000",
                {"clientOrderId": "tsx-entry", "timeInForce": "IOC",
                 "stopLoss": {"triggerPrice": "45000"}},
            )
            wire = client.v3PrivatePostTradeAlgoOrder.await_args.args[0]
            self.assertEqual((wire["algoType"], wire["type"]), ("BRACKET", "LIMIT"))
            self.assertNotIn("timeInForce", wire)
            self.assertEqual(order["id"], "432133")
            self.assertEqual(order["info"]["algoType"], "STOP_LOSS")
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_woo_funding_parser_substitutes_usd_for_the_usdt_product(self):
        client = client_for("woo")
        try:
            funding = client.parse_income({
                "id": "1286360", "symbol": "PERP_BTC_USDT", "fundingRate": "0.0001",
                "fundingFee": "0.25", "paymentType": "Pay", "status": "COMPLETED",
                "createdTime": 1700000000000, "updatedTime": 1700000000001,
            }, market_for("woo"))
            self.assertEqual((funding["id"], funding["code"], funding["amount"]),
                             ("1286360", "USD", -0.25))
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_orderly_attached_builders_are_not_ioc_brackets(self):
        for exchange in ("woofipro", "modetrade"):
            client = client_for(exchange)
            try:
                wire = client.create_order_request(
                    "BTC/USDC:USDC", "limit", "buy", "0.01", "50000",
                    {"clientOrderId": "tsx-entry", "timeInForce": "IOC",
                     "stopLoss": {"triggerPrice": "45000"}},
                )
                self.assertEqual(wire["algo_type"], "TP_SL")
                self.assertEqual(wire["type"], "LIMIT")
                self.assertNotIn("timeInForce", wire)
                self.assertNotIn("order_type", wire)
                outer = wire["child_orders"][0]
                self.assertEqual(outer["algo_type"], "POSITIONAL_TP_SL")
                self.assertEqual(outer["child_orders"][0]["algo_type"], "TP_SL")
            finally:
                await client.close()

    async def test_orderly_normal_batch_rejects_every_stop_leg_before_send(self):
        for exchange in ("woofipro", "modetrade"):
            client = client_for(exchange)
            client.v1PrivatePostBatchOrder = AsyncMock(
                side_effect=AssertionError("A protected batch must not be sent by this SDK path."))
            orders = [
                {"symbol": "BTC/USDC:USDC", "type": "limit", "side": "buy",
                 "amount": "0.01", "price": "50000", "params": {"clientOrderId": "tsx-entry"}},
                {"symbol": "BTC/USDC:USDC", "type": "market", "side": "sell",
                 "amount": "0.01", "params": {"clientOrderId": "tsx-stop",
                                                   "triggerPrice": "45000", "reduceOnly": True}},
            ]
            try:
                with self.assertRaisesRegex(ccxt.NotSupported, "only support non-stop order"):
                    await client.create_orders(orders)
                client.v1PrivatePostBatchOrder.assert_not_called()
                client.fetch.assert_not_called()
                client.request.assert_not_called()
            finally:
                await client.close()

    async def test_orderly_position_and_funding_normalizers_lose_required_evidence(self):
        native_position = {
            "symbol": "PERP_BTC_USDC", "position_qty": "0.01", "average_open_price": "50000",
            "mark_price": "50100", "margin_mode": "ISOLATED", "leverage": "7",
        }
        native_funding = {
            "symbol": "PERP_BTC_USDC", "funding_rate": "0.0001", "funding_fee": "0.25",
            "payment_type": "Pay", "status": "Accrued", "created_time": 1700000000000,
            "updated_time": 1700000000001,
        }
        for exchange in ("woofipro", "modetrade"):
            client = client_for(exchange)
            try:
                position = client.parse_position(dict(native_position), market_for(exchange))
                funding = client.parse_income(dict(native_funding), market_for(exchange))
                self.assertEqual(position["marginMode"], "cross")
                self.assertIsNone(position["leverage"])
                self.assertIsNone(position["hedged"])
                self.assertIsNone(funding["id"])
                self.assertEqual((funding["code"], funding["amount"]), ("USDC", -0.25))
                if exchange == "modetrade":
                    self.assertIs(client.has["fetchMarginMode"], False)
                    self.assertIsNone(client.has["fetchMarginModes"])
            finally:
                await client.close()

    async def test_weex_attached_stop_has_no_independent_child_identity(self):
        client = client_for("weex")
        try:
            self.assertIs(client.has["createOrders"], False)
            wire = client.create_contract_order_request(
                "BTC/USDT:USDT", "limit", "buy", "0.01", "50000",
                {"clientOrderId": "tsx-entry", "timeInForce": "IOC",
                 "callerMethodName": "createOrders",
                 "stopLoss": {"triggerPrice": "45000", "triggerPriceType": "mark"}},
            )
            self.assertEqual((wire["newClientOrderId"], wire["timeInForce"]), ("tsx-entry", "IOC"))
            self.assertEqual((wire["slTriggerPrice"], wire["SlWorkingType"]), ("45000", "MARK_PRICE"))
            self.assertNotIn("clientAlgoId", wire)
            self.assertNotIn("stopClientOrderId", wire)
            self.assertNotIn("childOrders", wire)
        finally:
            await client.close()

    async def test_weex_current_orders_are_split_between_normal_and_algo_endpoints(self):
        client = client_for("weex")
        client.contractPrivateGetCapiV3OpenOrders = AsyncMock(return_value=[])
        client.contractPrivateGetCapiV3OpenAlgoOrders = AsyncMock(return_value=[])
        try:
            await client.fetch_open_orders("BTC/USDT:USDT")
            client.contractPrivateGetCapiV3OpenOrders.assert_awaited_once()
            client.contractPrivateGetCapiV3OpenAlgoOrders.assert_not_called()
            await client.fetch_open_orders("BTC/USDT:USDT", params={"trigger": True})
            client.contractPrivateGetCapiV3OpenAlgoOrders.assert_awaited_once()
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_xt_attached_stop_replaces_the_entry_and_returns_no_identity(self):
        client = client_for("xt")
        client.privateLinearPostFutureTradeV1EntrustCreateProfit = AsyncMock(return_value={
            "returnCode": 0, "msgInfo": "success", "error": None, "result": True,
        })
        client.privateLinearPostFutureTradeV1OrderCreate = AsyncMock(
            side_effect=AssertionError("The requested entry was not sent."))
        try:
            order = await client.create_order(
                "BTC/USDT:USDT", "limit", "buy", "10", "50000",
                {"clientOrderId": "tsx-entry", "timeInForce": "IOC", "stopLoss": "45000"},
            )
            wire = client.privateLinearPostFutureTradeV1EntrustCreateProfit.await_args.args[0]
            self.assertEqual(wire["triggerStopPrice"], "45000")
            self.assertNotIn("orderType", wire)
            self.assertNotIn("price", wire)
            self.assertIsNone(order["id"])
            client.privateLinearPostFutureTradeV1OrderCreate.assert_not_called()
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_xt_tier_and_position_parsers_do_not_prove_admission_mode(self):
        client = client_for("xt")
        try:
            info = {"symbol": "btc_usdt", "leverageBrackets": [
                {"bracket": 1, "maxNominalValue": "50000", "maintMarginRate": "0.01",
                 "maxLeverage": "50"},
                {"bracket": 2, "maxNominalValue": "250000", "maintMarginRate": "0.02",
                 "maxLeverage": "25"},
            ]}
            tiers = client.parse_market_leverage_tiers(info, market_for("xt"))
            self.assertEqual((tiers[0]["minNotional"], tiers[0]["maxNotional"]), (250000.0, 50000.0))
            position = client.parse_position({
                "symbol": "btc_usdt", "positionSide": "LONG", "positionSize": "10",
                "entryPrice": "50000", "markPrice": "50100", "leverage": "20",
            }, market_for("xt"))
            self.assertEqual(position["marginMode"], "isolated")
            self.assertIsNone(position["hedged"])
            self.assertIsNone(client.urls.get("test"))
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
