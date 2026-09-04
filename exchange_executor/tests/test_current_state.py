from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, IncompleteCurrentStateError, RequestDeadline
from current_state import read_current_state
from server import execute


def deadline():
    return RequestDeadline(int(time.time() * 1000) + 30_000)


def market(index=0, settle="USDT"):
    return {"id": f"COIN{index}{settle}", "symbol": f"COIN{index}/{settle}:{settle}", "base": f"COIN{index}",
            "quote": settle, "settle": settle, "linear": True, "contract": True, "contractSize": 1,
            "type": "swap", "spot": False, "swap": True, "future": False, "option": False, "inverse": False}


class PagedBybit:
    has = {}

    def __init__(self, orders=505, positions=205):
        self.counts = {"orders": orders, "positions": positions}
        self.markets = {row["symbol"]: row for i in range(max(orders, positions, 1)) for row in (market(i), market(i, "USDC"))}
        self.calls = []
        self.change = lambda response, _source, _params: response

    def market(self, symbol):
        return self.markets[symbol]

    def safe_market(self, identifier, *_args):
        return next(row for row in self.markets.values() if row["id"] == identifier)

    def raw(self, source, index, settle):
        detail = market(index, settle)
        return {"id": f"order-{settle}-{index}", "symbol": detail["id"], "positionIdx": 0, "size": "1",
                "side": "buy" if source == "orders" else "long", "amount": "1", "filled": "0", "status": "open",
                "type": "limit", "price": "100", "average": None, "reduceOnly": False,
                "contracts": "1", "entryPrice": "100", "unrealizedPnl": "0"}

    def parse_order(self, raw, detail=None):
        return {**raw, "symbol": detail["symbol"]}

    parse_position = parse_order

    async def page(self, source, params):
        self.calls.append((source, dict(params)))
        rows, cursor = [], ""
        if params["category"] == "linear":
            count = self.counts[source] if params["settleCoin"] == "USDT" else 1
            previous = params.get("cursor")
            if previous is None:
                cursor = "after-empty"  # Empty page is not an end marker when a cursor is present.
            else:
                start = 0 if previous == "after-empty" else int(previous)
                end = min(start + params["limit"], count)
                rows = [self.raw(source, index, params["settleCoin"]) for index in range(start, end)]
                cursor = str(end - 1) if end < count else ""  # Deliberate overlap.
        result = {"retCode": 0, "time": int(time.time() * 1000), "result": {"category": params["category"], "list": rows, "nextPageCursor": cursor}}
        return self.change(result, source, params)

    async def privateGetV5PositionList(self, params):
        return await self.page("positions", params)

    async def privateGetV5OrderRealtime(self, params):
        return await self.page("orders", params)

    async def fetch_positions(self):
        return []  # Old wrapper path cannot prove all pages or settlements.

    async def fetch_open_orders(self, *_args):
        return []

    async def fetch_my_trades(self, *_args):
        return []


class HyperRest:
    def __init__(self):
        self.calls = []
        self.change = lambda response, _params: response

    def handle_public_address(self, *_args):
        return "0x" + "1" * 40, {}

    def parse_order(self, row):
        return {**row, "id": str(row["oid"]), "symbol": row["coin"], "side": "buy"}

    def parse_position(self, row):
        return {"symbol": row["position"]["coin"], "side": "long", "contracts": "1"}

    async def publicPostInfo(self, params):
        self.calls.append(dict(params))
        if params["type"] == "perpDexs":
            return self.change([None, {"name": "xyz"}], params)
        coin = "BTC" if params["dex"] == "" else "xyz:ABC"
        response = {"time": int(time.time() * 1000), "assetPositions": [{"position": {"coin": coin, "szi": "1"}}]} if params["type"] == "clearinghouseState" else [
            {"coin": coin, "oid": 1, "sz": "1", "origSz": "1", "side": "B"}]
        return self.change(response, params)


class CurrentStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_adapter_reads_all_current_bybit_pages_and_settlements(self):
        rest = PagedBybit()
        request = {"id": "fixture", "exchange": "bybit", "mode": "testnet"}

        async def account(value):
            return SimpleNamespace(rest=rest, account=value, account_identity=value["id"])

        state = await CcxtAdapter(SimpleNamespace(account=account)).open_state(request, deadline())
        self.assertEqual(len(state["orders"]), 506)
        self.assertEqual(len(state["positions"]), 206)
        self.assertIn("order-USDC-0", {row["exchangeOrderId"] for row in state["orders"]})
        for source in state["acquisition"]["sources"]:
            if source["source"] in {"orders", "positions"}:
                self.assertEqual(source["completeness"], "complete")
                self.assertTrue(all(row["complete"] and row["pages"] > 0 for row in source["scopes"]))
        for source, params in rest.calls:
            self.assertEqual(params["limit"], 50 if source == "orders" else 200)
            self.assertNotIn("orderFilter", params, "Conditional stops must not be excluded.")

    async def test_current_page_budget_and_deadline_never_return_a_partial_success(self):
        for limit, request_deadline in ((3, deadline()), (64, RequestDeadline(int(time.time() * 1000) + 1000))):
            rest = PagedBybit()
            with self.assertRaises(IncompleteCurrentStateError):
                await read_current_state(rest, "bybit", request_deadline, maximum_calls=limit)
            self.assertLessEqual(len(rest.calls), limit)
            if request_deadline.remaining_ms() < 1250:
                self.assertEqual(rest.calls, [])

    async def test_old_provider_timestamp_does_not_become_fresh_at_local_receipt(self):
        for exchange, rest in (("bybit", PagedBybit(1, 1)), ("hyperliquid", HyperRest())):
            def stale(response, *_args):
                if isinstance(response, dict):
                    response["time"] = int(time.time() * 1000) - 120_000
                return response

            rest.change = stale
            with self.assertRaisesRegex(IncompleteCurrentStateError, "provider_snapshot_not_fresh"):
                await read_current_state(rest, exchange, deadline())

    async def test_overlapping_position_pages_accept_market_moves_but_not_changed_exposure(self):
        for change_quantity in (False, True):
            rest = PagedBybit(1, 205)

            def changed(response, source, params):
                rows = response["result"]["list"]
                if source == "positions" and params.get("cursor") == "199" and rows:
                    rows[0]["unrealizedPnl"] = "123"
                    if change_quantity:
                        rows[0]["contracts"] = "2"
                return response

            rest.change = changed
            if change_quantity:
                with self.assertRaisesRegex(IncompleteCurrentStateError, "position_changed"):
                    await read_current_state(rest, "bybit", deadline())
            else:
                _, positions, _ = await read_current_state(rest, "bybit", deadline())
                self.assertEqual(len(positions), 206)

    async def test_bybit_rejects_missing_collections_cursors_cycles_and_wrong_scopes(self):
        def missing_list(response, *_args):
            response["result"].pop("list")
            return response

        def missing_cursor(response, *_args):
            response["result"].pop("nextPageCursor")
            return response

        def cycle(response, *_args):
            response["result"]["nextPageCursor"] = "after-empty"
            return response

        def wrong_category(response, *_args):
            response["result"]["category"] = "spot"
            return response

        for change in (missing_list, missing_cursor, cycle, wrong_category):
            rest = PagedBybit(1, 1)
            rest.change = change
            with self.assertRaises(ExchangeContractError):
                await read_current_state(rest, "bybit", deadline())

    async def test_bybit_does_not_drop_unsupported_positions_or_orders(self):
        for category, source in (("inverse", "positions"), ("option", "positions"), ("spot", "orders")):
            rest = PagedBybit(1, 1)

            def foreign(response, kind, params):
                if kind == source and params["category"] == category:
                    response["result"]["list"] = [{"symbol": "foreign", "size": "1"}]
                return response

            rest.change = foreign
            with self.assertRaisesRegex(ExchangeContractError, "Unmanaged Bybit"):
                await read_current_state(rest, "bybit", deadline())

    async def test_hyperliquid_reads_default_and_discovered_dex_without_colliding_ids(self):
        rest = HyperRest()
        orders, positions, sources = await read_current_state(rest, "hyperliquid", deadline())
        self.assertEqual({row["symbol"] for row in orders}, {"BTC", "xyz:ABC"})
        self.assertEqual(len(positions), 2)
        self.assertEqual(len(rest.calls), 5)
        self.assertTrue(all(row["completeness"] == "complete" for row in sources))
        self.assertTrue(all(row["user"] == "0x" + "1" * 40 for row in rest.calls[1:]))

    async def test_hyperliquid_rejects_wrong_envelope_and_dex_scope(self):
        for wrong in ("envelope", "scope", "discovery", "duplicate"):
            rest = HyperRest()

            def invalid(response, params):
                if params["type"] == "perpDexs":
                    if wrong == "discovery":
                        return []
                    if wrong == "duplicate":
                        return [None, {"name": "xyz"}, {"name": "xyz"}]
                if params["type"] == "clearinghouseState":
                    if wrong == "envelope":
                        return response["assetPositions"]
                    if wrong == "scope" and params["dex"]:
                        response["assetPositions"][0]["position"]["coin"] = "BTC"
                return response

            rest.change = invalid
            with self.assertRaises(ExchangeContractError, msg=wrong):
                await read_current_state(rest, "hyperliquid", deadline())

    async def test_incomplete_current_state_is_structured_503_not_contract_failure(self):
        async def handle(*_args):
            raise IncompleteCurrentStateError("orders", "current_page_budget_exhausted")

        async def payload(**_kwargs):
            return {}

        application = SimpleNamespace(credentials=SimpleNamespace(token=lambda: "fixture"), handle=handle)
        request = SimpleNamespace(app={"application": application, "request_semaphore": asyncio.Semaphore(1)},
                                  headers={"Authorization": "Bearer fixture"}, content_length=2, json=payload, path="/v1/open-state")
        response = await execute(request)
        self.assertEqual(response.status, 503)
        body = json.loads(response.body)
        self.assertEqual(body["code"], "CURRENT_STATE_INCOMPLETE")
        self.assertIs(body["sideEffects"], False)


if __name__ == "__main__":
    unittest.main()
