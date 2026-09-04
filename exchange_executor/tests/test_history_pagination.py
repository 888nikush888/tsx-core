from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt.base.errors import RateLimitExceeded
from ccxt.async_support import bybit
from common import ExchangeContractError, RequestDeadline
from history_pagination import DAY, checkpoint, read_history_pages
from history_reader import RecoveryReadBudget


def state(source="fills"):
    since = int(time.time() * 1000) - 2 * DAY
    return {"source": source, "providerSymbol": None, "revision": 0, "baselineSince": since, "windowSince": since,
            "windowUntil": None, "cursor": None, "scannedThrough": None, "nextReadAt": 0, "completeness": "unknown", "reason": "history_pending"}


def budget(remaining=5):
    return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000), remaining)


class PagedBybit:
    def __init__(self, count=1205):
        self.count = count
        self.calls = []
        self.empty_page = True
        self.error = None
        self.last_response_headers = {"Retry-After": "120"}

    async def _page(self, source, params):
        self.calls.append((source, dict(params)))
        if self.error:
            raise self.error
        cursor = params.get("cursor")
        if self.empty_page and cursor is None:
            rows, next_cursor = [], "after-empty"
        else:
            index = 0 if cursor in (None, "after-empty") else int(cursor)
            end = min(index + params["limit"], self.count)
            # Deliberate overlap. The real provider ID survives independently of timestamps.
            rows = [{"id": f"{source}-{i}", "timestamp": params["startTime"]} for i in range(index, end)]
            next_cursor = str(end - 1) if end < self.count else ""
        return {"retCode": 0, "result": {"category": "linear", "list": rows, "nextPageCursor": next_cursor}}

    async def privateGetV5ExecutionList(self, params):
        if params['category'] != 'linear':
            self.calls.append(('fills', dict(params)))
            return {'retCode': 0, 'result': {'category': params['category'], 'list': [], 'nextPageCursor': ''}}
        return await self._page("fills", params)

    async def privateGetV5OrderHistory(self, params):
        return await self._page("orders", params)

    def parse_trade(self, value, _market=None):
        return value

    def parse_order(self, value, _market=None):
        return value

    def safe_market(self, *_args):
        return {"linear": True, "contract": True}


class PaginationTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_ccxt_parser_uses_linear_namespace_even_without_optional_type_hints(self):
        rest = bybit()
        contract = {"id": "BTCUSDT", "symbol": "BTC/USDT:USDT", "base": "BTC", "quote": "USDT", "settle": "USDT",
                    "type": "swap", "spot": False, "swap": True, "future": False, "option": False,
                    "contract": True, "linear": True, "inverse": False, "contractSize": 1}
        spot = {**contract, "symbol": "BTC/USDT", "type": "spot", "spot": True, "swap": False, "contract": False, "linear": None}
        rest.set_markets([spot, contract])
        observed = int(time.time() * 1000) - 1000
        seen = []

        async def execution(params):
            seen.append(params)
            if params['category'] != 'linear':
                return {'retCode': 0, 'result': {'category': params['category'], 'nextPageCursor': '', 'list': []}}
            return {"retCode": 0, "result": {"category": "linear", "nextPageCursor": "", "list": [{
                "symbol": "BTCUSDT", "execId": "real-fill", "orderId": "real-order", "execTime": str(observed),
                "execQty": "1", "execPrice": "100", "execFee": "0.1", "side": "Buy"}]}}

        async def order(_params):
            return {"retCode": 0, "result": {"category": "linear", "nextPageCursor": "", "list": [{
                "symbol": "BTCUSDT", "orderId": "real-order", "createdTime": str(observed), "orderStatus": "Filled",
                "orderType": "Limit", "qty": "1", "cumExecQty": "1", "avgPrice": "100", "price": "100", "side": "Buy"}]}}

        rest.privateGetV5ExecutionList = execution
        rest.privateGetV5OrderHistory = order
        try:
            orders, fills, _ = await read_history_pages(rest, "bybit", [state("orders"), state("fills")], budget())
            self.assertEqual(orders[0]["symbol"], contract["symbol"])
            self.assertEqual(fills[0]["symbol"], contract["symbol"])
            self.assertEqual(fills[0]["order"], "real-order")
            self.assertEqual(fills[0]["timestamp"], observed)
            self.assertNotIn('execType', seen[0], 'ADL/settlement execution evidence must not be filtered away.')
        finally:
            await rest.close()

    async def test_more_than_500_orders_and_1000_fills_with_empty_and_overlapping_pages(self):
        rest = PagedBybit()
        states = [state("orders"), state("fills")]
        seen = {"orders": set(), "fills": set()}
        for _ in range(15):
            before = len(rest.calls)
            orders, fills, updates = await read_history_pages(rest, "bybit", states, budget())
            self.assertLessEqual(len(rest.calls) - before, 5)
            for source, rows in (("orders", orders), ("fills", fills)):
                seen[source].update(row["id"] for row in rows)
            # Roundtrip through the request validator simulates a new executor process.
            states = [checkpoint(update["checkpoint"]) for update in updates]
            if all(row["scannedThrough"] is not None for row in states):
                break
        self.assertEqual(len(seen["orders"]), 1205)
        self.assertEqual(len(seen["fills"]), 1205)
        self.assertTrue(all(row["scannedThrough"] is not None for row in states))
        self.assertEqual(next(row for row in states if row["source"] == "orders")["completeness"], "unknown", "Shorter unfilled-order retention must stay explicit.")
        for source, params in rest.calls:
            self.assertLessEqual(params["endTime"] - params["startTime"], 7 * DAY)
            self.assertLessEqual(params["limit"], 50 if source == "orders" else 100)

    async def test_empty_intermediate_page_preserves_cursor_and_window_across_request(self):
        rest = PagedBybit()
        original = state()
        _, _, first = await read_history_pages(rest, "bybit", [original], budget(1))
        saved = first[0]["checkpoint"]
        self.assertEqual(saved["cursor"], "after-empty")
        self.assertIsNone(saved["scannedThrough"])
        await read_history_pages(rest, "bybit", [checkpoint(saved)], budget(1))
        self.assertEqual(rest.calls[1][1]["cursor"], "after-empty")
        self.assertEqual(rest.calls[1][1]["endTime"], saved["windowUntil"])

    async def test_rate_limit_and_deadline_do_not_skip_failed_page(self):
        rest = PagedBybit()
        original = state()
        rest.error = RateLimitExceeded("429 fixture")
        _, _, updates = await read_history_pages(rest, "bybit", [original], budget())
        self.assertEqual(len(rest.calls), 1)
        saved = updates[0]["checkpoint"]
        for field in ("cursor", "windowSince", "windowUntil", "scannedThrough"):
            self.assertEqual(saved[field], original[field])
        self.assertGreater(saved["nextReadAt"], int(time.time() * 1000) + 119_000)
        await read_history_pages(rest, "bybit", [checkpoint(saved)], budget())
        self.assertEqual(len(rest.calls), 1, "Retry-After survives the next invocation.")
        short = RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 1000))
        _, _, updates = await read_history_pages(rest, "bybit", [original], short)
        self.assertEqual(updates[0]["pages"], 0)
        self.assertEqual(len(rest.calls), 1)

    async def test_missing_or_nonadvancing_cursor_is_not_end_of_history(self):
        for malformed in ({"list": [], "category": "linear"}, {"list": [], "category": "linear", "nextPageCursor": "same"}):
            rest = PagedBybit()

            async def page(_params):
                return {"retCode": 0, "result": malformed}
            rest.privateGetV5ExecutionList = page
            original = state()
            original.update(cursor="same", windowUntil=int(time.time() * 1000))
            with self.assertRaises(ExchangeContractError):
                await read_history_pages(rest, "bybit", [original], budget())

    async def test_unverified_provider_never_claims_empty_history(self):
        rest = PagedBybit()
        _, _, updates = await read_history_pages(rest, "krakenfutures", [state()], budget())
        self.assertEqual(rest.calls, [])
        self.assertEqual(updates[0]["checkpoint"]["completeness"], "unknown")
        self.assertIsNone(updates[0]["checkpoint"]["scannedThrough"])

    async def test_hyperliquid_overlaps_same_timestamp_and_never_skips_saturated_page(self):
        original = state()
        captured = []

        class Rest:
            def handle_public_address(self, *_args):
                return "fixture-wallet", {}

            async def publicPostInfo(self, params):
                captured.append(params)
                return [{"id": str(i), "time": params["startTime"]} for i in range(2000)]

            def parse_trade(self, row):
                return row

        _, fills, updates = await read_history_pages(Rest(), "hyperliquid", [original], budget())
        self.assertEqual(len(fills), 2000)
        self.assertEqual(len(captured), 1)
        self.assertEqual(updates[0]["checkpoint"]["reason"], "timestamp_page_saturated")
        self.assertIsNone(updates[0]["checkpoint"]["scannedThrough"])
        self.assertFalse(captured[0]["aggregateByTime"])

    async def test_hyperliquid_short_page_continues_instead_of_skipping_later_fills(self):
        original = state()
        captured = []
        stamp = original["windowSince"] + 10_000
        dataset = [{"id": str(index), "time": stamp + index, 'coin': 'BTC', 'tid': index, 'oid': index + 1,
                    'px': '10', 'sz': '1', 'side': 'B'} for index in range(7)]

        class Rest:
            def handle_public_address(self, *_args):
                return "fixture-wallet", {}

            async def publicPostInfo(self, params):
                captured.append(params)
                if params['type'] == 'userFills':
                    return dataset[-3:]
                return [row for row in dataset if params['startTime'] <= row['time'] <= params.get('endTime', 2**53 - 1)][:3]

            def parse_trade(self, row):
                return row

        rest = Rest()
        _, rows, updates = await read_history_pages(rest, "hyperliquid", [original], budget())
        self.assertEqual({row["id"] for row in rows}, {str(index) for index in range(7)})
        self.assertEqual(len(captured), 5)
        saved = updates[0]["checkpoint"]
        self.assertIsNone(saved['scannedThrough'], 'The final retention witness cannot exceed the five-request budget.')
        for _ in range(5):
            before = len(captured)
            _, more, updates = await read_history_pages(rest, 'hyperliquid', [checkpoint(saved)], budget())
            rows.extend(more)
            self.assertLessEqual(len(captured) - before, 5)
            saved = updates[0]['checkpoint']
            if saved['scannedThrough'] is not None:
                break
            self.assertIsNone(saved.get('coverage'), 'A pending total probe is not coverage.')
        self.assertEqual({row['id'] for row in rows}, {str(index) for index in range(7)})
        self.assertIsNotNone(saved["scannedThrough"])
        self.assertIsNotNone(saved.get('coverage'))
        self.assertTrue(any(params['type'] == 'userFills' for params in captured))
        self.assertEqual(saved["completeness"], "complete", "Only verified sub-10k total retention can cover this first-fill window.")


if __name__ == "__main__":
    unittest.main()
