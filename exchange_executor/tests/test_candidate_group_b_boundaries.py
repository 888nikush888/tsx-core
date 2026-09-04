"""Offline boundaries for Phase-009 candidates Extended, Gate and KuCoin.

These tests characterize the exact installed CCXT 4.5.75 bytes.  They do not
grant a profile, certify an account, call a provider or replace the full
cross-layer acceptance matrix.
"""
from __future__ import annotations

import hashlib
import inspect
import socket
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import ccxt
import ccxt.async_support as sdk
import ccxt.pro as pro_sdk


SOURCE_HASHES = {
    sdk.extended: "44b79c4457110ddccb0a4092a11e17b8a47ccc42eea5f6dcf0a066a2c7320ad7",
    pro_sdk.extended: "9625b78aff71b3672ddd65d01d3d7b70d02224afd58f138f00d36221dc8707f2",
    sdk.gate: "3e6bd51b06345c6a592a6c031c601c77952f0ae0c0fde628e449f886bde9a2ac",
    pro_sdk.gate: "8585879210cfee32bdb0d27f2be341c744ff4606ab8311b6adf2f79105e9bd65",
    sdk.kucoin: "26d6c99e03a4a0c7a050df62aa668896abce5fe2de3787f2be7c43b4ccbcdd9f",
    sdk.kucoinfutures: "a380fd2a4b038c23ac3ebf69c282fa6287c13cd0b82a681f850da09901bfecd3",
    pro_sdk.kucoin: "9e5d3ee27d5daa15168deb5215435755813a3ae70e1c2a7174525cff2d23111d",
    pro_sdk.kucoinfutures: "2f1a04ed8e112698eb06bcf99c5d03aa6666169df9ef3a1ba0d3e88a9c1eec20",
}


def _market(exchange: str) -> dict:
    market_id = {
        "extended": "BTC-USD",
        "gate": "BTC_USDT",
        "kucoin": "XBTUSDTM",
        "kucoinfutures": "XBTUSDTM",
    }[exchange]
    return {
        "id": market_id,
        "symbol": "BTC/USDT:USDT",
        "base": "BTC",
        "quote": "USDT",
        "settle": "USDT",
        "baseId": "BTC",
        "quoteId": "USDT",
        "settleId": "usdt" if exchange == "gate" else "USDT",
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
        "precision": {"amount": 1 if exchange == "gate" else 0.001, "price": 0.1},
        "limits": {"amount": {"min": 1, "max": None}, "price": {"min": None, "max": None}},
        "info": {
            "l2Config": {
                "syntheticId": "1",
                "collateralId": "2",
                "syntheticResolution": 1000,
                "collateralResolution": 1000,
            }
        },
    }


def _client(exchange: str):
    credentials = {
        "enableRateLimit": False,
        "apiKey": "local-fixture-key",
        "secret": "local-fixture-secret",
        "password": "local-fixture-passphrase",
        "privateKey": "1",
        "options": {"adjustForTimeDifference": False, "uta": False, "defaultType": "swap"},
    }
    client = getattr(sdk, exchange)(credentials)
    client.fetch = AsyncMock(side_effect=AssertionError("Provider transport is forbidden."))
    client.request = AsyncMock(side_effect=AssertionError("Unexpected SDK endpoint is forbidden."))
    client.set_markets([_market(exchange)])
    return client


class CandidateGroupBTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        # IsolatedAsyncioTestCase has already created its local loop socketpair.
        # Block every later DNS/provider transport before constructing clients.
        for target in (
            (socket.socket, "connect"),
            (socket.socket, "connect_ex"),
            (socket, "getaddrinfo"),
            (socket, "create_connection"),
        ):
            blocker = patch.object(*target, side_effect=AssertionError("Live transport is forbidden."))
            blocker.start()
            self.addCleanup(blocker.stop)

    async def test_exact_rest_and_pro_sources_are_pinned(self):
        for exchange_class, expected in SOURCE_HASHES.items():
            with self.subTest(exchange=exchange_class.__module__):
                source = Path(inspect.getfile(exchange_class))
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), expected)

    async def test_extended_attached_stop_ack_has_only_the_parent_identity(self):
        client = _client("extended")
        client.fetch_extended_account = AsyncMock(return_value={"l2Key": "1", "l2Vault": "1"})
        client.create_order_settlement_data = Mock(return_value={"r": "1", "s": "2"})
        client.v1PrivatePostUserOrder = AsyncMock(return_value={
            "status": "OK",
            "data": {"id": "2051479786538188800", "externalId": "tsx-entry"},
        })
        try:
            result = await client.create_order(
                "BTC/USDT:USDT",
                "limit",
                "buy",
                "0.01",
                "100",
                {
                    "clientOrderId": "tsx-entry",
                    "timeInForce": "IOC",
                    "builderFeeRate": "0",
                    "stopLoss": {"triggerPrice": "90", "price": "88.7", "type": "MARKET"},
                },
            )
            wire = client.v1PrivatePostUserOrder.await_args.args[0]
            self.assertEqual((result["id"], result["clientOrderId"]), ("2051479786538188800", "tsx-entry"))
            self.assertEqual((wire["id"], wire["stopLoss"]["triggerPrice"]), ("tsx-entry", "90"))
            self.assertNotIn("id", wire["stopLoss"])
            self.assertNotIn("externalId", wire["stopLoss"])
            self.assertEqual(client.v1PrivatePostUserOrder.await_count, 1)
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_gate_unified_stop_cannot_enter_the_normal_batch(self):
        client = _client("gate")
        try:
            orders = [
                {
                    "symbol": "BTC/USDT:USDT",
                    "type": "limit",
                    "side": "buy",
                    "amount": 2,
                    "price": "100",
                    "params": {"clientOrderId": "tsx-entry", "timeInForce": "IOC"},
                },
                {
                    "symbol": "BTC/USDT:USDT",
                    "type": "market",
                    "side": "sell",
                    "amount": 2,
                    "params": {"clientOrderId": "tsx-stop", "reduceOnly": True, "stopLossPrice": "90"},
                },
            ]
            with self.assertRaisesRegex(ccxt.NotSupported, "does not support advanced order properties"):
                client.create_orders_request(orders)
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_gate_native_attached_stop_is_only_a_parent_field(self):
        client = _client("gate")
        try:
            request = client.create_order_request(
                "BTC/USDT:USDT",
                "limit",
                "buy",
                2,
                "100",
                {
                    "clientOrderId": "tsx-entry",
                    "timeInForce": "IOC",
                    "tpsl_sl_trigger_price": "90",
                },
            )
            self.assertEqual(request["tpsl_sl_trigger_price"], "90")
            self.assertEqual(request["text"], "tsx-entry")
            self.assertFalse(any(key in request for key in ("stop_order_id", "stop_text", "stop_client_order_id")))
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_kucoin_identifiers_share_the_classic_execution_implementation_but_not_defaults(self):
        self.assertTrue(issubclass(sdk.kucoinfutures, sdk.kucoin))
        self.assertTrue(issubclass(pro_sdk.kucoinfutures, pro_sdk.kucoin))
        self.assertIs(sdk.kucoinfutures.create_contract_orders, sdk.kucoin.create_contract_orders)
        self.assertIs(sdk.kucoinfutures.fetch_contract_orders_by_status, sdk.kucoin.fetch_contract_orders_by_status)
        self.assertIs(sdk.kucoinfutures.fetch_funding_history, sdk.kucoin.fetch_funding_history)
        general = sdk.kucoin().describe()
        futures = sdk.kucoinfutures().describe()
        self.assertEqual(general["id"], "kucoin")
        self.assertEqual(futures["id"], "kucoinfutures")
        self.assertNotIn("defaultType", general["options"])
        self.assertEqual(futures["options"]["defaultType"], "swap")
        self.assertIs(general["has"]["spot"], True)
        self.assertIs(futures["has"]["spot"], False)

    async def test_kucoin_unified_mode_parsers_invent_safe_looking_defaults(self):
        client = _client("kucoinfutures")
        client.futuresPrivateGetPositionGetPositionMode = AsyncMock(return_value={"code": "200000", "data": {}})
        client.futuresPrivateGetPositionGetMarginMode = AsyncMock(return_value={"code": "200000", "data": {}})
        try:
            position = await client.fetch_position_mode("BTC/USDT:USDT")
            margin = await client.fetch_margin_mode("BTC/USDT:USDT")
            self.assertIs(position["hedged"], False)
            self.assertEqual(margin["marginMode"], "cross")
            client.futuresPrivateGetPositionGetPositionMode.assert_awaited_once()
            client.futuresPrivateGetPositionGetMarginMode.assert_awaited_once()
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_kucoin_funding_normalizer_loses_large_original_id_precision(self):
        client = _client("kucoinfutures")
        original_id = 9_007_199_254_740_993
        client.futuresPrivateGetFundingHistory = AsyncMock(return_value={
            "code": "200000",
            "data": {
                "dataList": [{
                    "id": original_id,
                    "symbol": "XBTUSDTM",
                    "timePoint": 1_700_000_000_000,
                    "fundingRate": "0.0001",
                    "markPrice": "100",
                    "positionQty": "2",
                    "positionCost": "200",
                    "funding": "-0.02",
                    "settleCurrency": "USDT",
                }],
                "hasMore": False,
            },
        })
        try:
            rows = await client.fetch_funding_history("BTC/USDT:USDT", 1_699_999_999_999)
            self.assertEqual(rows[0]["info"]["id"], original_id)
            self.assertIs(type(rows[0]["id"]), float)
            self.assertNotEqual(int(rows[0]["id"]), original_id)
            self.assertEqual(rows[0]["code"], "USDT")
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
