"""Pinned CCXT 4.5.75 request-path tests for the isolated KuCoin helpers.

The actual SDK accessors and signer run, but ``fetch`` is replaced after the
asyncio loop exists.  DNS and socket calls are blocked for the entire fixture.
"""
from __future__ import annotations

import socket
import time
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import ccxt
import ccxt.async_support as sdk

from common import RequestDeadline
from current_state import CurrentRead
from history_reader import RecoveryReadBudget
from kucoin_current_state import read_kucoin_current_state
from kucoin_history import read_kucoin_history_page
from kucoin_identity import read_kucoin_classic_observation
from kucoin_money import read_kucoin_balance, read_kucoin_funding_page, read_kucoin_ledger_page


UID = "165000215"
NATIVE = "XBTUSDTM"
UNIFIED = "BTC/USDT:USDT"
FINGERPRINT = "a" * 64
GENERATION = "b" * 64


def budget(calls=20):
    return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000), remaining=calls)


def market():
    return {
        "id": NATIVE, "symbol": UNIFIED, "base": "BTC", "quote": "USDT", "settle": "USDT",
        "baseId": "XBT", "quoteId": "USDT", "settleId": "USDT", "type": "swap",
        "spot": False, "swap": True, "future": False, "option": False, "contract": True,
        "linear": True, "inverse": False, "active": True, "contractSize": "0.001",
        "precision": {"amount": 1, "price": 1},
        "limits": {"amount": {"min": 1, "max": None}, "price": {"min": None, "max": None}},
    }


def page(items):
    return {"code": "200000", "data": {
        "currentPage": 1, "pageSize": 50, "totalNum": len(items), "totalPage": 1, "items": items,
    }}


def raw_order(now, *, stop=False, status="active"):
    return {
        "id": "s1" if stop else "o1", "clientOid": "cs" if stop else "co", "symbol": NATIVE,
        "type": "market" if stop else "limit", "side": "sell" if stop else "buy",
        "price": "0" if stop else "100", "size": 2, "dealSize": 0, "leverage": "20",
        "marginMode": "CROSS", "positionSide": "BOTH", "reduceOnly": stop,
        "stop": "down" if stop else "", "stopPrice": "90" if stop else None,
        "stopPriceType": "MP" if stop else "", "isActive": status == "active",
        "cancelExist": False, "status": status, "createdAt": now - 2_000,
        "updatedAt": now - 1_000, "settleCurrency": "USDT",
    }


class KucoinProviderSdkBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, "4.5.75")
        for target in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                       (socket, "getaddrinfo"), (socket, "create_connection")):
            blocker = patch.object(*target, side_effect=AssertionError("Live transport forbidden."))
            blocker.start()
            self.addCleanup(blocker.stop)

    def client(self, exchange="kucoinfutures"):
        rest = getattr(sdk, exchange)({
            "enableRateLimit": False,
            "apiKey": "local-fixture-key",
            "secret": "local-fixture-secret",
            "password": "local-fixture-passphrase",
            "options": {"uta": False, "defaultType": "swap", "adjustForTimeDifference": False},
        })
        rest.set_markets([market()])
        self.addAsyncCleanup(rest.close)
        return rest

    async def test_both_sdk_ids_sign_the_five_exact_mode_and_binding_reads(self):
        for exchange in ("kucoin", "kucoinfutures"):
            with self.subTest(exchange=exchange):
                rest = self.client(exchange)
                calls = []

                async def intercepted(url, method="GET", headers=None, body=None):
                    parsed = urlsplit(url)
                    calls.append((parsed.path, parse_qs(parsed.query), method))
                    self.assertTrue(headers.get("KC-API-SIGN"))
                    data = {
                        "/api/v1/user/api-key": {
                            "apiVersion": 3, "permission": "General,Futures", "createdAt": 1,
                            "uid": UID, "isMaster": True, "region": "PW", "siteType": "global",
                            "apiKey": "must-not-escape", "remark": "must-not-escape",
                        },
                        "/api/ua/v1/account/mode": {
                            "selfAccountMode": "CLASSIC", "unifiedSubAccount": [],
                            "classicSubAccount": [UID],
                        },
                        "/api/v2/position/getPositionMode": {"positionMode": 0},
                        "/api/v2/position/getMarginMode": {"symbol": NATIVE, "marginMode": "CROSS"},
                        "/api/v2/getCrossUserLeverage": {"symbol": NATIVE, "leverage": "20"},
                    }[parsed.path]
                    return {"code": "200000", "data": data}

                rest.fetch = intercepted
                result = await read_kucoin_classic_observation(
                    rest, NATIVE, budget(5), account_fingerprint=FINGERPRINT,
                    credential_generation=GENERATION,
                )
                self.assertEqual(result["providerAccountUid"], UID)
                self.assertNotIn("must-not-escape", repr(result))
                self.assertEqual([path for path, _, _ in calls], [
                    "/api/v1/user/api-key", "/api/ua/v1/account/mode",
                    "/api/v2/position/getPositionMode", "/api/v2/position/getMarginMode",
                    "/api/v2/getCrossUserLeverage",
                ])
                self.assertEqual(calls[-1][1]["symbol"], [NATIVE])

    async def test_raw_accessors_keep_current_history_and_money_query_boundaries(self):
        rest = self.client()
        now = int(time.time() * 1000)
        event_time = now - 1_000
        calls = []

        async def intercepted(url, method="GET", headers=None, body=None):
            parsed = urlsplit(url)
            query = parse_qs(parsed.query)
            calls.append((parsed.path, query, method))
            if parsed.path != "/api/v1/timestamp":
                self.assertTrue(headers.get("KC-API-SIGN"))
            if parsed.path == "/api/v1/timestamp":
                return {"code": "200000", "data": now}
            if parsed.path == "/api/v1/positions":
                return {"code": "200000", "data": [{
                    "id": "p1", "symbol": NATIVE, "currentQty": 2, "avgEntryPrice": "99",
                    "markPrice": "101", "unrealisedPnl": "0.004", "realLeverage": "20",
                    "crossMode": True, "marginMode": "CROSS", "positionSide": "BOTH",
                    "settleCurrency": "USDT", "isInverse": False,
                }]}
            if parsed.path == "/api/v1/orders":
                return page([raw_order(now, status="active")])
            if parsed.path == "/api/v1/stopOrders":
                return page([raw_order(now, stop=True)])
            if parsed.path == "/api/v1/fills":
                return page([{
                    "tradeId": "t1", "orderId": "o1", "symbol": NATIVE, "side": "buy",
                    "price": "100", "size": 2, "fee": "-0.01", "feeCurrency": "USDT",
                    "settleCurrency": "USDT", "tradeType": "trade", "marginMode": "CROSS",
                    "positionSide": "BOTH", "tradeTime": event_time * 1_000_000,
                    "createdAt": event_time + 100,
                }])
            if parsed.path == "/api/v1/account-overview":
                return {"code": "200000", "data": {
                    "currency": "USDT", "accountEquity": "100", "unrealisedPNL": "0",
                    "marginBalance": "100", "positionMargin": "10", "orderMargin": "2",
                    "frozenFunds": "0", "availableBalance": "88",
                }}
            if parsed.path == "/api/v1/funding-history":
                return {"code": "200000", "data": {"dataList": [], "hasMore": False}}
            if parsed.path == "/api/v1/transaction-history":
                return {"code": "200000", "data": {"dataList": [], "hasMore": False}}
            self.fail(f"Unexpected signed SDK path: {parsed.path}")

        rest.fetch = intercepted
        current = await read_kucoin_current_state(
            rest, CurrentRead(budget()), provider_account_uid=UID,
        )
        state = {
            "source": "fills", "providerSymbol": None, "cursor": None, "revision": 0,
            "baselineSince": now - 10_000, "windowSince": now - 10_000, "windowUntil": now,
            "scannedThrough": None, "nextReadAt": 0, "completeness": "partial",
            "reason": "history_pending", "providerAccountUid": UID,
            "coverage": None, "retention": None,
        }
        fills, _, _ = await read_kucoin_history_page(rest, state, budget(), UID)
        balance = await read_kucoin_balance(rest, budget(), provider_account_uid=UID)
        funding = await read_kucoin_funding_page(
            rest, {"windowSince": now - 10_000, "windowUntil": now, "cursor": None}, budget(),
            provider_account_uid=UID, provider_symbol=NATIVE,
        )
        ledger = await read_kucoin_ledger_page(
            rest, {"windowSince": now - 10_000, "windowUntil": now, "cursor": None}, budget(), UID,
        )
        self.assertEqual((len(current["orders"]), len(current["positions"])), (2, 1))
        self.assertEqual(fills[0]["timestamp"], event_time)
        self.assertEqual(balance["marginUsed"], "12")
        self.assertTrue(funding["exhausted"] and ledger["exhausted"])
        by_path = {path: query for path, query, _ in calls}
        self.assertEqual(by_path["/api/v1/orders"]["status"], ["active"])
        self.assertNotIn("symbol", by_path["/api/v1/fills"])
        self.assertNotIn("offset", by_path["/api/v1/funding-history"])
        self.assertNotIn("maxCount", by_path["/api/v1/funding-history"])
        self.assertEqual(by_path["/api/v1/transaction-history"]["forward"], ["false"])


if __name__ == "__main__":
    unittest.main()
