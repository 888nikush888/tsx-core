"""Regional SDK boundaries, not an offered-market or provider-acceptance proof.

All markets and acknowledgements below are synthetic native-shaped fixtures.
The real pinned serializer/signature/parser runs; no provider transport can run.
"""
from __future__ import annotations

import base64
import copy
import hmac
import json
import socket
import sys
import unittest
from urllib.parse import urlsplit
from unittest.mock import AsyncMock, patch

import ccxt
import ccxt.async_support as rest_sdk
import ccxt.pro as pro_sdk


def native_market() -> dict:
    return {
        "instId": "BTC-USDC-SWAP", "instType": "SWAP", "uly": "BTC-USDC",
        "ctVal": "0.01", "ctValCcy": "BTC", "ctType": "linear", "settleCcy": "USDC",
        "state": "live", "expTime": "", "lotSz": "1", "minSz": "1", "tickSz": "0.1",
    }


class MyOkxBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        self.assertEqual(sys.version_info[:2], (3, 12))
        # Install only after unittest created its Windows event-loop self-pipe.
        self.network_guards = []
        for target, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"), (socket, "getaddrinfo")):
            guard = patch.object(target, name, side_effect=AssertionError("No provider network or DNS permitted."))
            self.network_guards.append(guard.start())
            self.addCleanup(guard.stop)

    async def asyncTearDown(self):
        for guard in self.network_guards:
            guard.assert_not_called()

    def client(self, *, pro=False):
        cls = pro_sdk.myokx if pro else rest_sdk.myokx
        client = cls({"enableRateLimit": False, "options": {"adjustForTimeDifference": False}})
        client.fetch = AsyncMock(side_effect=AssertionError("Unspecified SDK transport is forbidden."))
        self.addAsyncCleanup(client.close)
        return client

    def test_rest_and_pro_inheritance_is_exact_but_not_a_single_regional_class(self):
        self.assertIs(rest_sdk.myokx.__bases__[0], rest_sdk.okx)
        self.assertIs(pro_sdk.myokx.__bases__[0], pro_sdk.okx)
        self.assertNotIn(rest_sdk.myokx, pro_sdk.myokx.__mro__)
        for name in ("create_order_request", "create_orders", "parse_order", "fetch_order", "fetch_open_orders",
                     "cancel_order", "fetch_my_trades", "fetch_markets", "parse_market"):
            with self.subTest(method=name):
                self.assertIs(getattr(rest_sdk.myokx, name), getattr(rest_sdk.okx, name))
                self.assertIs(getattr(pro_sdk.myokx, name), getattr(rest_sdk.okx, name))
        for name in ("watch_orders", "watch_my_trades", "watch_positions"):
            with self.subTest(method=name):
                self.assertIs(getattr(pro_sdk.myokx, name), getattr(pro_sdk.okx, name))

    async def test_effective_regional_product_and_loader_declarations_differ(self):
        rest, pro = self.client(), self.client(pro=True)
        self.assertIs(rest.has["swap"], True)
        self.assertIs(pro.has["swap"], False)
        self.assertIs(rest.has["future"], False)
        self.assertIs(pro.has["future"], False)
        self.assertIs(rest.options["mica"], True)
        self.assertIsNone(pro.options.get("mica"))
        for client, types in ((rest, ["spot", "swap"]), (pro, ["spot", "future", "swap", "option"])):
            with self.subTest(pro=client is pro):
                self.assertEqual(client.hostname, "eea.okx.com")
                self.assertEqual(client.options["fetchMarkets"]["types"], types)
                client.fetch_markets_by_type = AsyncMock(return_value=[])
                self.assertEqual(await client.fetch_markets(), [])
                self.assertEqual([call.args[0] for call in client.fetch_markets_by_type.await_args_list], types)
                client.fetch.assert_not_called()

    async def test_signed_ioc_attachment_keeps_original_ids_but_ack_is_parent_only(self):
        client = self.client()
        client.apiKey = "offline-fixture-key"
        client.secret = "offline-fixture-secret"
        client.password = "offline-fixture-passphrase"
        market = client.parse_market(native_market())
        client.set_markets([market])
        attachment = {"attachAlgoClOrdId": "tsxstop1", "slTriggerPx": "90", "slOrdPx": "-1", "slTriggerPxType": "mark"}
        request = {"symbol": market["symbol"], "type": "limit", "side": "buy", "amount": "2", "price": "100.5",
                   "params": {"timeInForce": "IOC", "tdMode": "cross", "posSide": "net", "clOrdId": "tsxparent1",
                              "attachAlgoOrds": [attachment]}}
        original = copy.deepcopy(request)
        ack = {"code": "0", "data": [{"ordId": "900000000000001", "clOrdId": "tsxparent1", "sCode": "0"}]}
        original_ack = copy.deepcopy(ack)

        async def capture(url, method="GET", headers=None, body=None):
            self.assertEqual((url, method), ("https://eea.okx.com/api/v5/trade/batch-orders", "POST"))
            self.assertEqual(json.loads(body), [{"instId": market["id"], "side": "buy", "ordType": "ioc", "sz": "2",
                "px": "100.5", "tdMode": "cross", "posSide": "net", "clOrdId": "tsxparent1", "attachAlgoOrds": [attachment]}])
            message = f"{headers['OK-ACCESS-TIMESTAMP']}{method}{urlsplit(url).path}{body}"
            expected = base64.b64encode(hmac.digest(client.secret.encode(), message.encode(), "sha256")).decode()
            self.assertEqual(headers["OK-ACCESS-SIGN"], expected)
            return copy.deepcopy(ack)

        client.fetch = AsyncMock(side_effect=capture)
        result = await client.create_orders([request])
        client.fetch.assert_awaited_once()
        self.assertEqual(request, original)
        self.assertEqual(ack, original_ack)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], ack["data"][0]["ordId"])
        self.assertEqual(result[0]["clientOrderId"], "tsxparent1")
        self.assertEqual(result[0]["info"], ack["data"][0])
        self.assertIsNone(result[0]["status"], "A placement ACK is not a terminal or fill observation.")
        self.assertNotIn("tsxstop1", [row["clientOrderId"] for row in result])

    async def test_xperp_expiry_is_retained_as_future_not_relabelled_as_swap(self):
        for client in (self.client(), self.client(pro=True)):
            with self.subTest(pro=isinstance(client, pro_sdk.myokx)):
                expiry = client.parse8601("2031-04-04T08:00:00.000Z")
                raw = {**native_market(), "instId": "BTC-USD_UM_XPERP-310404", "instType": "FUTURES",
                       "uly": "BTC-USD", "settleCcy": "USD", "ruleType": "xperp", "expTime": str(expiry)}
                original = copy.deepcopy(raw)
                market = client.parse_market(raw)
                self.assertIs(market["future"], True)
                self.assertIs(market["swap"], False)
                self.assertEqual(market["type"], "future")
                self.assertEqual(market["expiry"], expiry)
                self.assertTrue(market["symbol"].endswith("-310404"))
                self.assertEqual(market["info"], original)
                self.assertEqual(raw, original)
                client.fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
