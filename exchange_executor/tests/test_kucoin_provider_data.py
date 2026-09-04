"""Raw current-state, history and money contracts for KuCoin Classic Futures."""
from __future__ import annotations

import copy
import socket
import time
import unittest
from unittest.mock import AsyncMock, patch

from common import ExchangeContractError, RequestDeadline
from current_state import CurrentRead
from history_reader import RecoveryReadBudget
from kucoin_current_state import read_kucoin_current_state
from kucoin_history import read_kucoin_history_page
from kucoin_money import read_kucoin_balance, read_kucoin_funding_page, read_kucoin_ledger_page


UID = "165000215"
SYMBOL = "XBTUSDTM"
UNIFIED = "BTC/USDT:USDT"
NOW = int(time.time() * 1000)


def budget(calls=20):
    return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000), remaining=calls)


def market():
    return {
        "id": SYMBOL, "symbol": UNIFIED, "base": "BTC", "quote": "USDT", "settle": "USDT",
        "baseId": "XBT", "quoteId": "USDT", "settleId": "USDT", "type": "swap",
        "spot": False, "swap": True, "future": False, "option": False, "contract": True,
        "linear": True, "inverse": False, "active": True, "contractSize": "0.001",
    }


def order(order_id="o1", client_id="c1", *, stop=False, status="active"):
    return {
        "id": order_id, "clientOid": client_id, "symbol": SYMBOL, "type": "market" if stop else "limit",
        "side": "sell" if stop else "buy", "price": "0" if stop else "100", "size": 2, "dealSize": 0,
        "leverage": "20", "marginMode": "CROSS", "positionSide": "BOTH", "reduceOnly": stop,
        "stop": "down" if stop else "", "stopPrice": "90" if stop else None, "stopPriceType": "MP" if stop else "",
        "isActive": status == "active", "cancelExist": status == "cancelled", "status": status,
        "createdAt": NOW - 2_000, "updatedAt": NOW - 1_000, "settleCurrency": "USDT",
    }


def page(items, page_number=1, total_pages=1):
    return {"code": "200000", "data": {
        "currentPage": page_number, "pageSize": 1 if total_pages > 1 else 50,
        "totalNum": total_pages if total_pages > 1 else len(items),
        "totalPage": total_pages, "items": items,
    }}


class CurrentRest:
    def __init__(self):
        self.markets_by_id = {SYMBOL: [market()]}
        self.publicGetTimestamp = AsyncMock(return_value={"code": "200000", "data": NOW})
        self.futuresPrivateGetPositions = AsyncMock(return_value={"code": "200000", "data": [{
            "id": "p1", "symbol": SYMBOL, "currentQty": 2, "avgEntryPrice": "99", "markPrice": "101",
            "unrealisedPnl": "0.004", "realLeverage": "20", "crossMode": True,
            "marginMode": "CROSS", "positionSide": "BOTH", "settleCurrency": "USDT", "isInverse": False,
        }]})
        self.futuresPrivateGetOrders = AsyncMock(return_value=page([order()]))
        self.futuresPrivateGetStopOrders = AsyncMock(return_value=page([order("s1", "c2", stop=True)]))


def history_state(source="fills", cursor=None):
    return {
        "source": source, "providerSymbol": SYMBOL, "cursor": cursor, "revision": 0,
        "baselineSince": NOW - 60_000, "windowSince": NOW - 60_000, "windowUntil": NOW,
        "scannedThrough": None, "nextReadAt": 0, "completeness": "partial", "reason": "history_pending",
        "providerAccountUid": UID, "coverage": None, "retention": None,
    }


class KucoinDataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        global NOW
        NOW = int(time.time() * 1000)
        for target in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                       (socket, "getaddrinfo"), (socket, "create_connection")):
            blocker = patch.object(*target, side_effect=AssertionError("Live transport forbidden."))
            blocker.start()
            self.addCleanup(blocker.stop)

    async def test_current_state_covers_positions_normal_orders_and_untriggered_stops(self):
        rest = CurrentRest()
        read = CurrentRead(budget())
        result = await read_kucoin_current_state(rest, read, provider_account_uid=UID)
        self.assertEqual(read.budget.calls, 4)
        self.assertEqual(result["providerAccountUid"], UID)
        self.assertEqual(len(result["positions"]), 1)
        self.assertEqual(len(result["orders"]), 2)
        self.assertEqual({row["clientOrderId"] for row in result["orders"]}, {"c1", "c2"})
        self.assertEqual({source["completeness"] for source in result["sources"]}, {"complete"})
        self.assertEqual(result["positions"][0]["contracts"], "2")
        self.assertEqual(result["orders"][1]["triggerPrice"], "90")

    async def test_current_state_rejects_repeated_page_and_foreign_or_float_economics(self):
        for mutation in ("page", "settle", "float"):
            with self.subTest(mutation=mutation):
                rest = CurrentRest()
                if mutation == "page":
                    rest.futuresPrivateGetOrders.side_effect = [page([order()], 1, 2), page([order("o2")], 1, 2)]
                elif mutation == "settle":
                    rest.futuresPrivateGetPositions.return_value["data"][0]["settleCurrency"] = "BTC"
                else:
                    rest.futuresPrivateGetPositions.return_value["data"][0]["markPrice"] = 101.0
                with self.assertRaises(ExchangeContractError):
                    await read_kucoin_current_state(rest, CurrentRead(budget()), provider_account_uid=UID)

    async def test_current_state_page_two_is_consumed_once_and_completes(self):
        rest = CurrentRest()
        rest.futuresPrivateGetOrders.side_effect = [page([order()], 1, 2), page([order("o2", "c3")], 2, 2)]
        result = await read_kucoin_current_state(rest, CurrentRead(budget()), provider_account_uid=UID)
        self.assertEqual({row["id"] for row in result["orders"]}, {"o1", "o2", "s1"})
        self.assertEqual(rest.futuresPrivateGetOrders.await_count, 2)

    async def test_fill_page_retains_native_ids_time_fee_and_usdt_originals(self):
        rest = AsyncMock()
        rest.markets_by_id = {SYMBOL: [market()]}
        event_time = NOW - 1_000
        native_trade_time = event_time * 1_000_000
        rest.futuresPrivateGetFills.return_value = page([{
            "tradeId": "9007199254740993001", "orderId": "9007199254740993002", "symbol": SYMBOL,
            "side": "buy", "price": "100", "size": 2, "fee": "-0.0002", "feeCurrency": "USDT",
            "settleCurrency": "USDT", "tradeType": "trade", "marginMode": "CROSS",
            "positionSide": "BOTH", "tradeTime": native_trade_time, "createdAt": event_time + 183,
        }])
        rows, state, events = await read_kucoin_history_page(rest, history_state(), budget(), UID)
        self.assertEqual(events, [])
        self.assertEqual(rows[0]["id"], "9007199254740993001")
        self.assertEqual(rows[0]["order"], "9007199254740993002")
        self.assertEqual(rows[0]["timestamp"], event_time)
        self.assertEqual(rows[0]["fee"], {"cost": "-0.0002", "currency": "USDT"})
        self.assertEqual(rows[0]["identityEvidence"]["nativeTradeTime"], str(native_trade_time))
        self.assertIsNone(state["cursor"])
        self.assertEqual(state["completeness"], "unknown")

    async def test_accountwide_fill_page_does_not_invent_a_symbol_filter(self):
        rest = AsyncMock()
        rest.markets_by_id = {SYMBOL: [market()]}
        event_time = NOW - 1_000
        native_trade_time = event_time * 1_000_000
        rest.futuresPrivateGetFills.return_value = page([{
            "tradeId": "t1", "orderId": "o1", "symbol": SYMBOL, "side": "sell",
            "price": "100", "size": 1, "fee": "0", "feeCurrency": "USDT",
            "settleCurrency": "USDT", "tradeType": "trade", "marginMode": "CROSS",
            "positionSide": "BOTH", "tradeTime": native_trade_time, "createdAt": event_time + 183,
        }])
        state = history_state()
        state["providerSymbol"] = None
        rows, _, _ = await read_kucoin_history_page(rest, state, budget(), UID)
        self.assertEqual(rows[0]["providerSymbol"], SYMBOL)
        self.assertNotIn("symbol", rest.futuresPrivateGetFills.await_args.args[0])

    async def test_history_pages_advance_and_orders_remain_originally_correlated(self):
        rest = AsyncMock()
        rest.markets_by_id = {SYMBOL: [market()]}
        rest.futuresPrivateGetOrders.side_effect = [page([order(status="done")], 1, 2),
                                                     page([order("o2", "c2", status="done")], 2, 2)]
        first, state, _ = await read_kucoin_history_page(rest, history_state("orders"), budget(), UID)
        self.assertEqual((first[0]["id"], first[0]["clientOrderId"], state["cursor"]),
                         ("o1", "c1", "2:2"))
        second, state, _ = await read_kucoin_history_page(rest, state, budget(), UID)
        self.assertEqual(second[0]["id"], "o2")
        self.assertIsNone(state["cursor"])
        self.assertEqual(state["reason"], "provider_retention_limit")

    async def test_history_rejects_float_money_or_uid_drift_before_accepting_rows(self):
        rest = AsyncMock()
        rest.markets_by_id = {SYMBOL: [market()]}
        raw = order(status="done")
        raw["price"] = 100.0
        rest.futuresPrivateGetOrders.return_value = page([raw])
        with self.assertRaises(ExchangeContractError):
            await read_kucoin_history_page(rest, history_state("orders"), budget(), UID)
        with self.assertRaises(ExchangeContractError):
            await read_kucoin_history_page(rest, history_state("orders"), budget(), "changed-uid")

    async def test_usdt_balance_preserves_all_reporting_decimals(self):
        rest = AsyncMock()
        rest.futuresPrivateGetAccountOverview.return_value = {"code": "200000", "data": {
            "currency": "USDT", "accountEquity": "1000", "unrealisedPNL": "-2.5",
            "marginBalance": "997.5", "positionMargin": "100", "orderMargin": "10",
            "frozenFunds": "3", "availableBalance": "884.5",
        }}
        result = await read_kucoin_balance(rest, budget(), provider_account_uid=UID)
        self.assertEqual(result["reportingCurrency"], "USDT")
        self.assertEqual(result["equity"], "1000")
        self.assertEqual(result["unrealizedPnl"], "-2.5")
        self.assertEqual(result["marginUsed"], "110")
        rest.futuresPrivateGetAccountOverview.assert_awaited_once_with({"currency": "USDT"})

    async def test_funding_and_ledger_pages_keep_ids_signs_currency_and_cursor(self):
        rest = AsyncMock()
        rest.futuresPrivateGetFundingHistory.return_value = {"code": "200000", "data": {
            "dataList": [{"id": "9007199254740993001", "symbol": SYMBOL, "timePoint": NOW - 2_000,
                          "fundingRate": "0.0001", "markPrice": "100", "positionQty": "2",
                          "positionCost": "200", "funding": "-0.02", "settleCurrency": "USDT",
                          "marginMode": "CROSS"}],
            "hasMore": False,
        }}
        funding = await read_kucoin_funding_page(
            rest, {"windowSince": NOW - 10_000, "windowUntil": NOW, "cursor": None}, budget(),
            provider_account_uid=UID, provider_symbol=SYMBOL,
        )
        self.assertEqual(funding["records"][0]["amount"], "-0.02")
        self.assertEqual(funding["records"][0]["id"], "9007199254740993001")
        self.assertIsNone(funding["nextCursor"])
        rest.futuresPrivateGetTransactionHistory.return_value = {"code": "200000", "data": {
            "dataList": [{
            "offset": "9007199254740993002", "currency": "USDT", "type": "RealisedPNL",
            "amount": "1.5", "fee": "-0.1", "accountEquity": "1001.4", "time": NOW - 1_000,
            "status": "Completed", "remark": "XBTUSDTM",
        }], "hasMore": False}}
        ledger = await read_kucoin_ledger_page(
            rest, {"windowSince": NOW - 10_000, "windowUntil": NOW, "cursor": None}, budget(), UID,
        )
        self.assertEqual(ledger["records"][0]["amount"], "1.5")
        self.assertEqual(ledger["records"][0]["fee"], "-0.1")
        self.assertEqual(ledger["records"][0]["id"], "9007199254740993002")
        self.assertTrue(ledger["exhausted"])

    async def test_funding_uses_fixed_time_slices_and_never_offset_paginates(self):
        rest = AsyncMock()
        rest.futuresPrivateGetFundingHistory.return_value = {
            "code": "200000", "data": {"dataList": [], "hasMore": False},
        }
        since = NOW - 2 * 86_400_000
        first = await read_kucoin_funding_page(
            rest, {"windowSince": since, "windowUntil": NOW, "cursor": None}, budget(),
            provider_account_uid=UID, provider_symbol=SYMBOL,
        )
        self.assertEqual(first["nextCursor"], str(since + 86_400_000 + 1))
        params = rest.futuresPrivateGetFundingHistory.await_args.args[0]
        self.assertNotIn("offset", params)
        self.assertNotIn("maxCount", params)
        self.assertEqual(params["endAt"] - params["startAt"], 86_400_000)

    async def test_money_readers_reject_float_currency_and_nonadvancing_pages(self):
        rest = AsyncMock()
        balance = {"code": "200000", "data": {
            "currency": "USDT", "accountEquity": 1000.0, "unrealisedPNL": "0", "marginBalance": "1000",
            "positionMargin": "0", "orderMargin": "0", "frozenFunds": "0", "availableBalance": "1000",
        }}
        rest.futuresPrivateGetAccountOverview.return_value = balance
        with self.assertRaises(ExchangeContractError):
            await read_kucoin_balance(rest, budget(), provider_account_uid=UID)
        funding = {"code": "200000", "data": {"dataList": [{
            "id": "1", "symbol": SYMBOL, "timePoint": NOW, "fundingRate": "0", "markPrice": "100",
            "positionQty": "1", "positionCost": "100", "funding": "0", "settleCurrency": "BTC",
            "marginMode": "CROSS",
        }], "hasMore": False}}
        rest.futuresPrivateGetFundingHistory.return_value = funding
        with self.assertRaises(ExchangeContractError):
            await read_kucoin_funding_page(rest, {"windowSince": NOW - 1, "windowUntil": NOW, "cursor": None},
                                           budget(), provider_account_uid=UID, provider_symbol=SYMBOL)
        rest.futuresPrivateGetTransactionHistory.return_value = {
            "code": "200000", "data": {"dataList": [], "hasMore": True},
        }
        with self.assertRaises(ExchangeContractError):
            await read_kucoin_ledger_page(rest, {"windowSince": NOW - 1, "windowUntil": NOW, "cursor": "1"},
                                          budget(), UID)

    async def test_callers_original_state_and_rows_are_never_mutated(self):
        rest = CurrentRest()
        original_position = copy.deepcopy(rest.futuresPrivateGetPositions.return_value)
        await read_kucoin_current_state(rest, CurrentRead(budget()), provider_account_uid=UID)
        self.assertEqual(rest.futuresPrivateGetPositions.return_value, original_position)


if __name__ == "__main__":
    unittest.main()
