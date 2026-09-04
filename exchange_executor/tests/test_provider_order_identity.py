from __future__ import annotations

import copy
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs

import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import _base_order_spec, _normalized_open_order, _protected_order_results
from common import ExchangeContractError, RequestDeadline, UnresolvedOrderOutcome
from history_reader import RecoveryReadBudget, recover_order_evidence


SYMBOL = "BTC/USD:USD"
MARKET = {"id": "PF_XBTUSD", "symbol": SYMBOL, "base": "BTC", "contractSize": "1"}


def batch_specs():
    return tuple({"symbol": SYMBOL, "params": {"clientOrderId": leg, "order_tag": leg}}
                 for leg in ("own-entry", "own-stop"))


def batch_order(leg):
    return {"id": f"remote-{leg}", "clientOrderId": None, "symbol": SYMBOL, "status": "open", "filled": "0",
            "info": {"order_id": f"remote-{leg}", "order_tag": leg, "status": "placed"}}


class ProviderBatchIdentityTests(unittest.TestCase):
    def test_bybit_parent_link_is_observation_only_without_original_attached_request(self):
        market = {**MARKET, "id": "BTCUSDT", "symbol": "BTC/USDT:USDT"}
        order = {"id": "child", "clientOrderId": None, "symbol": market["symbol"], "side": "sell", "amount": "1", "filled": "0",
                 "status": "open", "reduceOnly": True, "triggerPrice": "90", "info": {"orderId": "child", "symbol": "BTCUSDT",
                 "parentOrderLinkId": "real-parent-link", "stopOrderType": "StopLoss"}}
        normalized = _normalized_open_order(SimpleNamespace(market=lambda _symbol: market), order, "bybit")
        self.assertEqual(normalized["providerParentOrderLinkId"], "real-parent-link")
        self.assertIsNone(normalized["clientOrderId"])
        self.assertNotIn("identityEvidence", normalized)

    def test_explicit_kraken_tags_correlate_reordered_responses_without_rewriting_originals(self):
        entry, stop = [batch_order(leg) for leg in ("own-entry", "own-stop")]
        originals = copy.deepcopy([stop, entry])
        result = _protected_order_results([stop, entry], MARKET, batch_specs(), "krakenfutures")
        self.assertEqual([row["clientOrderId"] for row in result], ["own-entry", "own-stop"])
        self.assertEqual([row["exchangeOrderId"] for row in result], ["remote-own-entry", "remote-own-stop"])
        self.assertEqual(result[0]["identityEvidence"]["profile"], "kraken_batch_tag_v1")
        self.assertEqual(result[0]["identityEvidence"]["tag"], "own-entry")
        self.assertEqual(result[0]["raw"], entry)
        self.assertIsNone(result[0]["raw"]["clientOrderId"])
        self.assertEqual([stop, entry], originals)

    def test_unjournaled_tags_foreign_profile_duplicate_and_conflicting_native_ids_are_unresolved(self):
        entry, stop = [batch_order(leg) for leg in ("own-entry", "own-stop")]
        bad = [({**stop, "clientOrderId": "foreign"}),
               ({**stop, "clientOrderId": "own-stop", "info": {**stop["info"], "order_tag": "foreign"}}),
               ({**stop, "info": {**stop["info"], "order_tag": "own-entry"}}),
               ({**stop, "info": {**stop["info"], "order_id": "different"}}),
               ({**stop, "id": entry["id"]})]
        for changed in bad:
            with self.subTest(changed=changed), self.assertRaises(UnresolvedOrderOutcome):
                _protected_order_results([entry, changed], MARKET, batch_specs(), "krakenfutures")
        for profile in ("bybit", "hyperliquid", ""):
            with self.subTest(profile=profile), self.assertRaises(UnresolvedOrderOutcome):
                _protected_order_results([entry, stop], MARKET, batch_specs(), profile)
        tagless = tuple({"params": {"clientOrderId": leg}} for leg in ("own-entry", "own-stop"))
        with self.assertRaises(UnresolvedOrderOutcome):
            _protected_order_results([entry, stop], MARKET, tagless, "krakenfutures")

    def test_only_explicit_exact_request_tag_reaches_kraken(self):
        request = {"side": "buy", "orderType": "market", "clientOrderId": "own-entry", "reduceOnly": False,
                   "providerBatchTag": {"version": 1, "tag": "own-entry"}}
        spec = _base_order_spec(SimpleNamespace(), request, SYMBOL, "1", "krakenfutures")
        self.assertEqual(spec["params"]["order_tag"], "own-entry")
        for profile, tag in (("bybit", request["providerBatchTag"]), ("krakenfutures", {"version": 1, "tag": "1"})):
            with self.subTest(profile=profile, tag=tag), self.assertRaises(ExchangeContractError):
                _base_order_spec(SimpleNamespace(), {**request, "providerBatchTag": tag}, SYMBOL, "1", profile)


class CloidIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_kraken_sdk_signs_explicit_string_tags_and_default_tags_are_not_original_evidence(self):
        from test_entry_price_sdk import sdk
        rest = sdk('krakenfutures')
        rest.apiKey, rest.secret = 'isolated-api-key', 'aXNvbGF0ZWQtc2VjcmV0'  # gitleaks:allow
        bodies = []

        async def intercepted(_url, method='GET', headers=None, body=None):
            self.assertEqual(method, 'POST')
            self.assertIn('Authent', headers)
            bodies.append(json.loads(parse_qs(body)['json'][0])['batchOrder'])
            return {'result': 'success', 'batchStatus': []}

        rest.fetch = intercepted
        orders = [{'symbol': 'BTC/USDT:USDT', 'type': 'limit', 'side': 'buy', 'amount': '1', 'price': '100',
                   'params': {'clientOrderId': leg, 'order_tag': leg}} for leg in ('own-entry', 'own-stop')]
        try:
            await rest.create_orders(copy.deepcopy(orders))
            self.assertEqual([item['order_tag'] for item in bodies[0]], ['own-entry', 'own-stop'])
            for order in orders:
                del order['params']['order_tag']
            await rest.create_orders(orders)
            self.assertTrue(all(type(item['order_tag']) is int for item in bodies[1]))
        finally:
            await rest.close()

    async def test_positive_cloid_lookup_is_scope_bound_bounded_and_preserves_null_provider_client(self):
        user = "0x" + "a" * 40
        cloid = "0x" + "b" * 32
        sdk = ccxt_async.hyperliquid()
        self.addAsyncCleanup(sdk.close)
        native_market = sdk.parse_market({"name": "BTC", "baseId": 0, "szDecimals": 3, "markPx": "100", "maxLeverage": 50})
        symbol = native_market["symbol"]
        self.assertEqual(native_market["id"], "0", "The actual SDK asset index is not the native coin name.")
        reference = {"clientOrderId": cloid, "exchangeOrderId": None, "providerSymbol": symbol,
                     "symbol": "BTCUSDT", "role": "stop_loss"}
        raw = {"id": "1234", "clientOrderId": None, "symbol": symbol, "side": "sell", "type": "market",
               "amount": "1", "filled": "0", "price": None, "average": None, "status": "open", "reduceOnly": True,
               "triggerPrice": "90", "info": {"order": {"oid": 1234, "coin": "BTC", "cloid": None}}}
        calls = []

        async def fetch_order(identifier, symbol, params):
            calls.append((identifier, symbol, params))
            return copy.deepcopy(raw)

        rest = SimpleNamespace(walletAddress=user, fetch_order=fetch_order,
                               market=lambda _symbol: native_market)
        budget = RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000))
        rows, checked = await recover_order_evidence(rest, "hyperliquid", [reference], [], lambda _ref: symbol, budget)
        self.assertEqual(checked[0]["status"], "observed")
        self.assertEqual(calls, [(cloid, symbol, {"clientOrderId": cloid, "user": user})])
        self.assertEqual(budget.calls, 1)
        result = _normalized_open_order(rest, rows[0])
        self.assertIsNone(result["clientOrderId"], "Only Node's original journal may create the local ownership binding.")
        self.assertEqual(result["identityEvidence"]["clientOrderId"], cloid)
        self.assertEqual(result["identityEvidence"]["user"], user)
        self.assertEqual(result["raw"], raw)
        for change in ({"id": "other"}, {"info": {"order": {"oid": 1234, "coin": "ETH"}}},
                       {"clientOrderId": "other"}):
            original = copy.deepcopy(raw)
            raw.update(change)
            with self.subTest(change=change), self.assertRaises(ExchangeContractError):
                await recover_order_evidence(rest, "hyperliquid", [reference], [], lambda _ref: symbol, budget)
            raw.clear()
            raw.update(original)
        self.assertEqual(budget.calls, 4)


if __name__ == "__main__":
    unittest.main()
