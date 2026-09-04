from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt.base.errors import OrderNotFound, RateLimitExceeded
from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, RequestDeadline
from history_reader import RecoveryReadBudget, recover_order_evidence, recovery_request


SYMBOL = "BTC/USDT:USDT"


def reference(index=0):
    return {"clientOrderId": f"client-{index}", "exchangeOrderId": f"exchange-{index}",
            "providerSymbol": SYMBOL, "symbol": "BTCUSDT", "role": "entry"}


class HistoryRest:
    has = {"fetchOrders": True}

    def __init__(self):
        self.calls = []
        self.error = None
        self.missing = False
        self.market_data = {"base": "BTC", "symbol": SYMBOL, "contractSize": "1"}

    def market(self, _symbol):
        return self.market_data

    async def fetch_order(self, identifier, symbol, params=None):
        self.calls.append(("target", identifier, symbol, params))
        if self.error:
            raise self.error
        if self.missing:
            raise OrderNotFound("Fixture missing order")
        return {"id": identifier, "clientOrderId": None, "symbol": symbol, "side": "buy", "type": "limit",
                "status": "open", "amount": "1", "filled": "0", "price": "100", "average": None, "reduceOnly": False}

    async def fetch_open_orders(self, *_args):
        self.calls.append(("open", *_args))
        return []

    async def fetch_canceled_and_closed_orders(self, symbol, _since, _limit, params):
        self.calls.append(("terminal", symbol, _since, _limit, params))
        if "orderId" not in params and "orderLinkId" not in params:
            return []
        return [await self.fetch_order(params.get("orderId", "recovered"), symbol)]

    async def fetch_orders(self, *_args):
        self.calls.append(("history", *_args))
        return []

    async def fetch_positions(self):
        return []

    async def fetch_my_trades(self, symbol, since, limit):
        self.calls.append(("trades", symbol, since, limit))
        return []


class HistoryReaderTests(unittest.IsolatedAsyncioTestCase):
    def deadline(self):
        return RequestDeadline(int(time.time() * 1000) + 30_000)

    async def test_open_state_shares_five_additional_calls_between_exact_lookup_and_backfill(self):
        rest = HistoryRest()
        page_calls = []

        async def page(params):
            page_calls.append(params)
            return {"retCode": 0, "result": {"category": "linear", "list": [], "nextPageCursor": f"page-{len(page_calls)}"}}

        rest.privateGetV5ExecutionList = page
        rest.parse_trade = lambda row, _market: row

        async def account(value):
            return SimpleNamespace(rest=rest, account=value, account_identity=value["id"])

        start = int(time.time() * 1000) - 2 * 86_400_000
        cursor = {"source": "fills", "providerSymbol": None, "revision": 0, "baselineSince": start, "windowSince": start,
                  "windowUntil": None, "cursor": None, "scannedThrough": None, "nextReadAt": 0, "completeness": "unknown", "reason": "history_pending"}
        request = {"id": "shared-budget", "exchange": "bybit", "mode": "testnet"}
        snapshot = await CcxtAdapter(SimpleNamespace(account=account)).open_state(
            request, self.deadline(), {"since": start, "orders": [reference()], "history": [cursor]})
        self.assertEqual(snapshot["acquisition"]["checkedOrders"][0]["status"], "observed")
        self.assertEqual(len(page_calls), 3, "Two exact Bybit reads leave three additional history pages, not five more.")
        self.assertEqual(snapshot["acquisition"]["history"][0]["pages"], 3)
        self.assertEqual(snapshot["acquisition"]["history"][0]["checkpoint"]["cursor"], "page-3")

    async def test_bounded_lookup_preserves_missing_and_deferred_states(self):
        rest = HistoryRest()
        rest.missing = True
        orders, checked = await recover_order_evidence(rest, "krakenfutures", [reference(i) for i in range(12)], [],
                                                       lambda _row: SYMBOL, RecoveryReadBudget(self.deadline()))
        self.assertEqual(orders, [])
        self.assertEqual(len(rest.calls), 5)
        self.assertEqual([row["status"] for row in checked], ["not_found"] * 5 + ["budget_exhausted"] * 7)

    async def test_deadline_reserves_response_time_and_does_not_start_coroutine(self):
        rest = HistoryRest()
        expired = RequestDeadline(int(time.time() * 1000) + 1_000)
        _, checked = await recover_order_evidence(rest, "krakenfutures", [reference()], [], lambda _row: SYMBOL, RecoveryReadBudget(expired))
        self.assertEqual(rest.calls, [])
        self.assertEqual(checked[0]["status"], "budget_exhausted")

    async def test_rate_limit_stops_additional_lookup_calls(self):
        rest = HistoryRest()
        rest.error = RateLimitExceeded("Fixture 429")
        _, checked = await recover_order_evidence(rest, "hyperliquid", [reference(i) for i in range(3)], [],
                                                 lambda _row: SYMBOL, RecoveryReadBudget(self.deadline()))
        self.assertEqual(len(rest.calls), 1)
        self.assertEqual([row["status"] for row in checked], ["transient", "budget_exhausted", "budget_exhausted"])

    async def test_bybit_uses_exact_terminal_lookup_after_empty_active_list(self):
        rest = HistoryRest()
        rows, checked = await recover_order_evidence(rest, "bybit", [reference()], [], lambda _row: SYMBOL, RecoveryReadBudget(self.deadline()))
        self.assertEqual(rows[0]["id"], "exchange-0")
        self.assertEqual(checked[0]["status"], "observed")
        self.assertEqual(rest.calls[0], ("open", SYMBOL, None, 50, {"orderId": "exchange-0"}))
        self.assertEqual(rest.calls[1], ("terminal", SYMBOL, None, 50, {"orderId": "exchange-0"}))

    async def test_lookup_rejects_foreign_symbol_or_order(self):
        for changed in ({"id": "other"}, {"symbol": "ETH/USDT:USDT"}):
            rest = HistoryRest()
            original = rest.fetch_order

            async def wrong(*args, **kwargs):
                return {**await original(*args, **kwargs), **changed}
            rest.fetch_order = wrong
            with self.assertRaisesRegex(ExchangeContractError, "different identity"):
                await recover_order_evidence(rest, "hyperliquid", [reference()], [], lambda _row: SYMBOL, RecoveryReadBudget(self.deadline()))

    async def test_open_state_includes_old_local_order_and_kraken_symbol_despite_empty_remote_lists(self):
        rest = HistoryRest()
        clients = SimpleNamespace(rest=rest, account={"id": "fixture", "exchange": "krakenfutures", "mode": "testnet"}, account_identity="fixture")

        async def account(_account):
            return clients
        adapter = CcxtAdapter(SimpleNamespace(account=account))
        since = int(time.time() * 1000) - 45 * 86_400_000
        state = await adapter.open_state(clients.account, self.deadline(), {"since": since, "orders": [reference()]})
        self.assertEqual(state["orders"][0]["exchangeOrderId"], "exchange-0")
        self.assertIn(("trades", SYMBOL, since, None), rest.calls)
        self.assertEqual(state["acquisition"]["checkedOrders"], [{"clientOrderId": "client-0", "status": "observed"}])
        self.assertEqual(len(state["acquisition"]["sources"]), 4)
        self.assertTrue(all(state["acquisition"]["startedAt"] <= row["startedAt"] <= row["completedAt"] <= state["acquisition"]["completedAt"]
                            for row in state["acquisition"]["sources"]))
        self.assertEqual(next(row for row in state["acquisition"]["sources"] if row["source"] == "fills")["completeness"], "unknown")

    async def test_history_work_is_serial_per_provider_but_other_providers_are_independent(self):
        rest = HistoryRest()
        active = 0
        peak = 0

        async def positions():
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return []

        async def account(value):
            return SimpleNamespace(rest=rest, account=value, account_identity=value["id"])

        rest.fetch_positions = positions
        adapter = CcxtAdapter(SimpleNamespace(account=account))
        first = {"id": "first", "exchange": "krakenfutures", "mode": "testnet"}
        second = {**first, "id": "second"}
        await asyncio.gather(*(adapter.open_state(value, self.deadline()) for value in (first, second)))
        self.assertEqual(peak, 1)
        peak = 0
        await asyncio.gather(*(adapter.open_state(value, self.deadline()) for value in (first, {**second, "exchange": "bybit"})))
        self.assertEqual(peak, 2)

    async def test_recent_listing_respects_bybit_limits_and_does_not_truncate_other_profiles(self):
        old = int(time.time() * 1000) - 45 * 86_400_000
        for exchange in ("bybit", "hyperliquid", "krakenfutures"):
            with self.subTest(exchange=exchange):
                rest = HistoryRest()
                request = {"id": exchange, "exchange": exchange, "mode": "testnet"}

                async def account(value):
                    return SimpleNamespace(rest=rest, account=value, account_identity=value["id"])

                state = await CcxtAdapter(SimpleNamespace(account=account)).open_state(request, self.deadline(), {"since": old, "orders": []})
                if exchange == "bybit":
                    self.assertIn(("open", None, None, 50), rest.calls)
                    listing = next(call for call in rest.calls if call[0] == "terminal")
                    self.assertEqual(listing[3], 50)
                    self.assertLessEqual(listing[4]["until"] - listing[2], 7 * 86_400_000)
                    trades = next(call for call in rest.calls if call[0] == "trades")
                    self.assertEqual(trades[3], 100)
                    self.assertGreater(trades[2], old)
                else:
                    self.assertIn(("open", None, None, None), rest.calls)
                    if exchange == "krakenfutures":
                        self.assertFalse(any(call[0] == "history" for call in rest.calls), "Kraken fetchOrders is not an unscoped history API.")
                    else:
                        self.assertIn(("history", None, None, None), rest.calls)
                self.assertEqual(next(row for row in state["acquisition"]["sources"] if row["source"] == "orders")["completeness"], "unknown")

    def test_recovery_request_is_bounded_and_contains_only_order_scope(self):
        value = {"since": 1, "orders": [{**reference(), "credentials": "MUST_NOT_CROSS"}]}
        self.assertNotIn("credentials", recovery_request(value)["orders"][0])
        for invalid in ({"since": 1, "orders": [reference()] * 2}, {"since": True, "orders": []}, {"since": 1, "orders": [reference()] * 251}):
            with self.assertRaises(ExchangeContractError):
                recovery_request(invalid)


if __name__ == "__main__":
    unittest.main()
