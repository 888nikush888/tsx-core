from __future__ import annotations

import time
import unittest

from ccxt.async_support import bybit, hyperliquid, krakenfutures
from common import ExchangeContractError
from current_state import read_current_state
from ccxt_adapter import _normalized_open_order
from test_current_state import deadline, market


async def network_forbidden(*_args, **_kwargs):
    raise AssertionError("This fixture must never open a provider connection.")


class CurrentProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_bybit_real_ccxt_parser_preserves_conditional_stop_and_position(self):
        rest = bybit()
        rest.fetch = network_forbidden
        contract = market()
        spot = {**contract, "symbol": "COIN0/USDT", "type": "spot", "contract": False, "linear": None, "swap": False, "spot": True}
        rest.set_markets([spot, contract, market(0, "USDC")])
        now = str(int(time.time() * 1000))

        async def page(params, positions=False):
            rows = []
            if params.get("settleCoin") == "USDT":
                if positions:
                    rows = [{"symbol": contract["id"], "side": "Buy", "size": "1", "positionIdx": 0,
                             "avgPrice": "100", "markPrice": "101", "unrealisedPnl": "1", "leverage": "10",
                             "positionIM": "10", "positionMM": "1", "positionValue": "100", "tradeMode": 0,
                             "createdTime": now, "updatedTime": now}]
                else:
                    rows = [{"symbol": contract["id"], "orderId": "stop-remote", "orderLinkId": "", "side": "Sell",
                             "orderType": "Market", "orderStatus": "Untriggered", "qty": "1", "cumExecQty": "0",
                             "leavesQty": "1", "triggerPrice": "90", "reduceOnly": True, "stopOrderType": "StopLoss",
                             "createdTime": now, "updatedTime": now, "positionIdx": 0}]
            return {"retCode": 0, "time": int(time.time() * 1000), "result": {"category": params["category"], "nextPageCursor": "", "list": rows}}

        async def positions(params):
            return await page(params, True)

        rest.privateGetV5OrderRealtime = page
        rest.privateGetV5PositionList = positions
        try:
            orders, positions, sources = await read_current_state(rest, "bybit", deadline())
            self.assertEqual(orders[0]["symbol"], contract["symbol"])
            self.assertEqual(orders[0]["id"], "stop-remote")
            self.assertFalse(orders[0]["clientOrderId"])
            self.assertTrue(orders[0]["reduceOnly"])
            self.assertEqual(float(orders[0]["triggerPrice"]), 90)
            self.assertEqual(orders[0]["status"], "open")
            self.assertEqual(_normalized_open_order(rest, orders[0])["providerTimestamp"], int(now))
            self.assertEqual(positions[0]["symbol"], contract["symbol"])
            self.assertEqual(float(positions[0]["contracts"]), 1)
            self.assertTrue(all(row["completeness"] == "complete" for row in sources))
        finally:
            await rest.close()

    def kraken(self):
        rest = krakenfutures()
        rest.fetch = network_forbidden
        detail = {**market(0, "USD"), "id": "pf_coin0usd"}
        rest.set_markets([detail])
        return rest, detail

    async def test_kraken_real_parser_keeps_entire_account_and_trigger_orders(self):
        rest, detail = self.kraken()
        stamp = rest.iso8601(int(time.time() * 1000))

        async def orders(_params):
            return {"result": "success", "serverTime": stamp, "openOrders": [
                {"order_id": f"remote-{index}", "symbol": detail["id"], "side": "sell", "orderType": "stp",
                 "stopPrice": "90", "limitPrice": "89", "unfilledSize": "1", "filledSize": "0",
                 "reduceOnly": True, "receivedTime": stamp} for index in range(605)]}

        async def positions(_params):
            return {"result": "success", "serverTime": stamp, "openPositions": [
                {"symbol": detail["id"], "side": "long", "size": "1", "price": "100", "unrealizedPnl": "1", "fillTime": stamp}]}

        rest.privateGetOpenorders = orders
        rest.privateGetOpenpositions = positions
        try:
            orders, positions, sources = await read_current_state(rest, "krakenfutures", deadline())
            self.assertEqual(len(orders), 605)
            self.assertEqual(orders[-1]["id"], "remote-604")
            self.assertEqual(orders[-1]["symbol"], detail["symbol"])
            self.assertTrue(orders[-1]["reduceOnly"])
            self.assertEqual(float(orders[-1]["triggerPrice"]), 90)
            self.assertEqual(float(positions[0]["contracts"]), 1)
            self.assertTrue(all(row["scopes"] == [{"scope": "futures:all", "pages": 1, "complete": True}] for row in sources))
        finally:
            await rest.close()

    async def test_kraken_missing_array_is_not_an_empty_account(self):
        for source in ("orders", "positions"):
            for missing in ("collection", "time", "result"):
                rest, _ = self.kraken()

                async def response(kind):
                    result = {"result": "success", "serverTime": rest.iso8601(int(time.time() * 1000)),
                              "openOrders" if kind == "orders" else "openPositions": []}
                    if source == kind:
                        key = {"collection": "openOrders" if kind == "orders" else "openPositions", "time": "serverTime", "result": "result"}[missing]
                        result.pop(key)
                    return result

                async def orders(_params):
                    return await response("orders")

                async def positions(_params):
                    return await response("positions")

                rest.privateGetOpenorders = orders
                rest.privateGetOpenpositions = positions
                try:
                    with self.assertRaises(ExchangeContractError):
                        await read_current_state(rest, "krakenfutures", deadline())
                finally:
                    await rest.close()

    async def test_hyperliquid_real_parser_keeps_original_and_remaining_stop_quantity(self):
        rest = hyperliquid({"walletAddress": "0x" + "1" * 40})
        rest.fetch = network_forbidden
        detail = market(0, "USDC")
        rest.set_markets([{**detail, "id": detail["symbol"]}])

        async def response(params):
            if params["type"] == "perpDexs":
                return [None, {"name": "xyz"}]
            if params["type"] == "clearinghouseState":
                return {"time": str(int(time.time() * 1000)), "assetPositions": [] if params["dex"] else [{"type": "oneWay", "position": {
                    "coin": "COIN0", "szi": "1", "entryPx": "100", "unrealizedPnl": "0", "marginUsed": "10",
                    "positionValue": "100", "leverage": {"type": "cross", "value": "10"}}}]}
            return [] if params["dex"] else [{"coin": "COIN0", "oid": 123, "cloid": None, "side": "A", "sz": "1",
                                             "origSz": "2", "limitPx": "85", "isTrigger": True, "triggerPx": "90",
                                             "orderType": "Stop Market", "reduceOnly": True, "timestamp": int(time.time() * 1000)}]

        rest.publicPostInfo = response
        try:
            orders, positions, _ = await read_current_state(rest, "hyperliquid", deadline())
            self.assertEqual(orders[0]["symbol"], detail["symbol"])
            self.assertEqual(orders[0]["id"], "123")
            self.assertIsNone(orders[0]["clientOrderId"])
            self.assertEqual(float(orders[0]["amount"]), 2)
            self.assertEqual(float(orders[0]["filled"]), 1)
            self.assertEqual(float(orders[0]["stopLossPrice"]), 90)
            self.assertEqual(float(positions[0]["contracts"]), 1)
        finally:
            await rest.close()
