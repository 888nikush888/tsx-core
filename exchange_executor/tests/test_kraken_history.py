from __future__ import annotations

import json
import unittest

from ccxt.async_support import krakenfutures
from test_history_pagination import budget, state
from ccxt_adapter import _normalized_fill
from common import ExchangeContractError
from history_pagination import checkpoint, read_history_pages
from remote_evidence import normalize_trades

UID = "f055040f-091c-4e7c-8e1b-8215e79f2932"
SYMBOL = "BTC/USD:USD"


def order(index=0):
    return {"uid": f"order-{index}", "accountUid": UID, "tradeable": "PF_XBTUSD", "direction": "Buy", "quantity": "1",
            "filled": "0", "clientId": f"client-{index}", "reduceOnly": False, "limitPrice": "100", "orderType": "Limit"}


def event(index, stamp, endpoint):
    detail = order(index)
    if endpoint == "executions":
        body = {"execution": {"execution": {"uid": f"fill-{index}", "order": detail,
                "timestamp": stamp, "quantity": "1", "price": "100", "executionType": "maker", "orderData": {"fee": "0.1"}}}}
    elif endpoint == "triggers":
        trigger = {**detail, "triggerOptions": {"triggerPrice": "90"}}
        body = {"OrderTriggerUpdated": {"oldOrderTrigger": trigger,
                                       "newOrderTrigger": {**trigger, "triggerOptions": {"triggerPrice": "91"}}}}
    else:
        body = {"OrderPlaced": {"order": detail, "reason": "new_user_order", "reducedQuantity": ""}}
    return {"uid": f"{endpoint}-event-{index}", "timestamp": stamp, "event": body}


class KrakenRest:
    def __init__(self, count=1205):
        self.count = count
        self.calls = []
        self.last_response_headers = {}
        self.uid = UID

    def safe_market(self, _identifier):
        return {"id": "PF_XBTUSD", "symbol": SYMBOL, "contract": True, "linear": True, "contractSize": 1, "base": "BTC"}

    def market(self, identifier):
        return self.safe_market(identifier)

    async def page(self, endpoint, params):
        self.calls.append((endpoint, dict(params)))
        self.last_response_headers = {}
        token = params.get("continuation_token")
        if token is None:
            self.last_response_headers = {"Next-Continuation-Token": "after-empty"}
            return {"accountUid": self.uid, "len": 0, "elements": []}
        index = 0 if token == "after-empty" else int(token)
        count = 1 if endpoint == "triggers" else self.count
        end = min(index + params["count"], count)
        rows = [event(i, params["since"] + 1, endpoint) for i in range(index, end)]
        response = {"accountUid": self.uid, "len": len(rows), "elements": rows}
        if end < count:
            response["continuationToken"] = str(end - 1)
        return response

    async def historyGetOrders(self, params):
        return await self.page("orders", params)

    async def historyGetTriggers(self, params):
        return await self.page("triggers", params)

    async def historyGetExecutions(self, params):
        return await self.page("executions", params)


class KrakenHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_or_invalid_historical_quantity_cannot_become_zero(self):
        for quantity in (None, "", "-1", True):
            rest = KrakenRest(1)

            async def invalid(params):
                row = event(0, params["since"] + 1, "orders")
                row["event"]["OrderPlaced"]["order"]["quantity"] = quantity
                return {"accountUid": UID, "len": 1, "elements": [row]}

            rest.historyGetOrders = invalid
            original = state("orders")
            with self.subTest(quantity=quantity), self.assertRaises(ExchangeContractError):
                await read_history_pages(rest, "krakenfutures", [original], budget(1), [])
            self.assertIsNone(original["cursor"])

    async def test_sources_cannot_report_different_accounts_in_one_snapshot(self):
        rest = KrakenRest(1)
        original = rest.historyGetExecutions

        async def foreign(params):
            response = await original(params)
            response["accountUid"] = "different-account"
            return response

        rest.historyGetExecutions = foreign
        with self.assertRaisesRegex(ExchangeContractError, "provider account identity"):
            await read_history_pages(rest, "krakenfutures", [state("orders"), state("fills")], budget(), [])

    async def test_paginated_execution_order_and_trigger_envelopes_preserve_all_evidence(self):
        rest = KrakenRest()
        states = [state("orders"), state("fills")]
        seen_fills, seen_orders, seen_triggers = set(), set(), set()
        for _ in range(8):
            events = []
            before = len(rest.calls)
            orders, fills, updates = await read_history_pages(rest, "krakenfutures", states, budget(), events)
            self.assertEqual(orders, [], "Historical events must not masquerade as current order snapshots.")
            self.assertLessEqual(len(rest.calls) - before, 5)
            seen_fills.update(row["id"] for row in fills)
            for row in events:
                evidence = row["evidence"]
                (seen_triggers if evidence["eventType"].startswith("OrderTrigger") else seen_orders).add(
                    (evidence["providerEventId"], evidence["eventOrderField"]))
            states = [checkpoint(update["checkpoint"]) for update in updates]
            if all(row["scannedThrough"] is not None for row in states):
                break
        self.assertEqual(len(seen_fills), 1205)
        self.assertEqual(len(seen_orders), 1205)
        self.assertEqual(len(seen_triggers), 2, "Both the old and new trigger must survive, without inventing a fresh active stop.")
        self.assertTrue(all(row["providerAccountUid"] == UID for row in states))
        self.assertTrue(all(row["scannedThrough"] is not None for row in states))
        for _, params in rest.calls:
            self.assertEqual(params["version"], "v3")
            self.assertEqual(params["sort"], "asc")
            self.assertEqual(params["count"], 500)

    async def test_provider_identity_is_bound_across_persisted_cursor_pages(self):
        rest = KrakenRest()
        _, _, updates = await read_history_pages(rest, "krakenfutures", [state()], budget(1))
        saved = checkpoint(updates[0]["checkpoint"])
        rest.uid = "different-account"
        with self.assertRaisesRegex(ExchangeContractError, "account identity"):
            await read_history_pages(rest, "krakenfutures", [saved], budget(1))

    async def test_conflicting_tokens_or_foreign_rows_do_not_advance(self):
        for flaw in ("token", "account", "count", "scope"):
            rest = KrakenRest(1)
            original = state()

            async def invalid(params):
                row = event(0, params["since"] + 1, "executions")
                response = {"accountUid": UID, "len": 1, "elements": [row]}
                if flaw == "token":
                    response["continuationToken"] = "body"
                    rest.last_response_headers = {"Next-Continuation-Token": "header"}
                elif flaw == "account":
                    row["event"]["execution"]["execution"]["order"]["accountUid"] = "foreign"
                elif flaw == "count":
                    response["len"] = 2
                else:
                    row["timestamp"] = params["since"] - 1
                return response

            rest.historyGetExecutions = invalid
            with self.subTest(flaw=flaw), self.assertRaises(ExchangeContractError):
                await read_history_pages(rest, "krakenfutures", [original], budget(1))
            self.assertIsNone(original["cursor"])

    async def test_fees_are_actual_not_sdk_estimates_and_missing_fees_remain_unresolved(self):
        rest = KrakenRest(1)

        async def execution(params):
            row = event(0, params["since"] + 1, "executions")
            if missing:
                row["event"]["execution"]["execution"]["orderData"] = None
            return {"accountUid": UID, "len": 1, "elements": [row]}

        rest.historyGetExecutions = execution
        for missing in (False, True):
            _, rows, _ = await read_history_pages(rest, "krakenfutures", [state()], budget(1))
            fills, unresolved = normalize_trades(rows, lambda trade: _normalized_fill(rest, {}, trade))
            if missing:
                self.assertEqual(fills, [])
                self.assertEqual(unresolved[0]["evidence"]["fee"], None)
            else:
                self.assertEqual(fills[0]["fee"], "0.1")
                self.assertIsNone(fills[0]["feeAsset"], "The history endpoint does not identify the fee currency.")

    async def test_real_ccxt_version_parameter_selects_v3_without_custom_signing(self):
        rest = krakenfutures({"apiKey": "fixture-key", "secret": "Zml4dHVyZS1zZWNyZXQ="})  # gitleaks:allow
        try:
            for endpoint in ("executions", "orders", "triggers"):
                signed = rest.sign(endpoint, "history", "GET", {"version": "v3", "since": 1, "before": 2, "sort": "asc"})
                self.assertIn(f"/api/history/v3/{endpoint}?", signed["url"])
                self.assertNotIn("version=", signed["url"])
                self.assertIn("Authent", signed["headers"])
                self.assertEqual(rest.options["versions"]["history"]["GET"][endpoint], "v2", "No mutable client-global route override.")
        finally:
            await rest.close()

    async def test_order_event_consumer_is_required_before_cursor_can_advance(self):
        rest = KrakenRest(1)
        original = state("orders")
        original.update(cursor=json.dumps({"endpoint": "orders", "token": "after-empty"}), windowUntil=original["windowSince"] + 100_000)
        with self.assertRaisesRegex(ExchangeContractError, "durable evidence consumer"):
            await read_history_pages(rest, "krakenfutures", [original], budget(1))


if __name__ == "__main__":
    unittest.main()
