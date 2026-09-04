"""Pinned CCXT 4.5.75 originals -> actual Python fill identity producer.

All transport is intercepted. Market fixtures retain SDK output, notably HL's
numeric market.id versus native coin name; no fixture rewrites that distinction.
"""
from __future__ import annotations

import copy
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import ccxt
import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import _normalized_fill
from common import ExchangeContractError, RequestDeadline
from fill_identity import hyperliquid_market_coin, native_fill_identity
from history_reader import RecoveryReadBudget, recover_order_evidence
from kraken_history import _execution
from provider_order_identity import cloid_lookup_identity
from remote_evidence import normalize_trades


STAMP = 1704262888911
ACCOUNT = "f055040f-091c-4e7c-8e1b-8215e79f2932"


def market(namespace="linear"):
    spot, option, inverse = namespace == "spot", namespace == "option", namespace == "inverse"
    symbol = "ETH/USDT" if spot else "ETH/USD:ETH" if inverse else "ETH/USDT:USDT"
    if option:
        symbol += "-270101-3000-C"
    return {"id": "ETHUSD" if inverse else "ETHUSDT", "symbol": symbol, "base": "ETH",
            "quote": "USD" if inverse else "USDT", "settle": None if spot else "ETH" if inverse else "USDT",
            "type": "spot" if spot else "option" if option else "swap", "spot": spot, "option": option,
            "swap": not spot and not option, "future": False, "contract": not spot,
            "linear": not spot and not inverse, "inverse": inverse, "contractSize": None if spot else 1,
            "precision": {"amount": 0.001, "price": 0.1}, "limits": {}, "info": {}}


def bybit_original(native_market):
    # CCXT async_support/bybit.py:3048-3092, 3166-3180: execId -> id;
    # category, execTime and orderId remain exact native originals in trade.info.
    return {"execId": "2210000000101610464", "symbol": native_market["id"], "orderId": "original-order",
            "execTime": str(STAMP), "side": "Buy", "orderType": "Limit", "execPrice": "100",
            "execQty": "1", "execFee": "0.01", "feeCoin": "USDT", "isMaker": True}


def hl_original(coin="ETH"):
    # CCXT async_support/hyperliquid.py:3381-3444: integer native tid/time.
    return {"coin": coin, "tid": 128423918764978, "oid": 3929354691, "time": STAMP,
            "px": "100", "sz": "1", "fee": "0.01", "feeToken": "USDC", "side": "B",
            "crossed": True, "closedPnl": "0", "startPosition": "0", "dir": "Open Long"}


def kraken_event():
    original_order = {"uid": "original-order", "accountUid": ACCOUNT, "tradeable": "PF_ETHUSD",
                      "direction": "Buy", "clientId": "original-client"}
    return {"uid": "history-event-not-the-fill-id", "timestamp": STAMP,
            "event": {"execution": {"execution": {"uid": "execution-uid", "order": original_order,
                       "timestamp": STAMP, "price": "100", "quantity": "1", "orderData": {"fee": "0.01"}}}}}


def hl_order_original(coin="ETH", oid=1234):
    return {"order": {"coin": coin, "oid": oid, "cloid": None, "side": "B", "sz": "1", "origSz": "1",
                      "limitPx": "100", "orderType": "Limit", "reduceOnly": False, "isTrigger": False,
                      "timestamp": STAMP, "triggerPx": "0", "tif": "Gtc"},
            "status": "open", "statusTimestamp": STAMP}


class FillIdentityProducerTests(unittest.IsolatedAsyncioTestCase):
    def client(self, profile, markets=()):
        self.assertEqual(ccxt.__version__, "4.5.75")
        client = getattr(ccxt_async, profile)()
        client.fetch = AsyncMock(side_effect=AssertionError("Provider network forbidden"))
        if markets:
            client.set_markets(list(markets))
        self.addAsyncCleanup(client.close)
        self.addCleanup(client.fetch.assert_not_called)
        return client

    async def hl_markets(self, *, spot=False):
        client = self.client("hyperliquid")
        if spot:
            # Actual fetch_spot_markets parser, including contractSize=None.
            response = [{"tokens": [{"name": "USDC", "szDecimals": 8}, {"name": "PURR", "szDecimals": 0}],
                         "universe": [{"name": "PURR/USDC", "tokens": [1, 0], "index": 0}]}, [{"midPx": "0.2"}]]
        else:
            # Actual fetch_swap_markets: baseId is universe index (0), not "ETH".
            response = [{"universe": [{"name": "ETH", "szDecimals": 4, "maxLeverage": 50}]}, [{"markPx": "100"}]]
        client.publicPostInfo = AsyncMock(return_value=response)
        parsed = await (client.fetch_spot_markets() if spot else client.fetch_swap_markets())
        self.assertEqual(client.publicPostInfo.await_args.args[0]["type"], "spotMetaAndAssetCtxs" if spot else "metaAndAssetCtxs")
        client.set_markets(parsed)
        return client, parsed[0]

    def kraken_trade(self):
        native_market = {**market(), "id": "PF_ETHUSD", "symbol": "ETH/USD:USD", "quote": "USD", "settle": "USD"}
        client = self.client("krakenfutures", [native_market])
        return client, native_market, _execution(client, kraken_event(), ACCOUNT, native_market["symbol"])

    async def test_bybit_sdk_preserves_all_four_distinct_native_namespaces(self):
        for namespace in ("linear", "inverse", "spot", "option"):
            with self.subTest(namespace=namespace):
                native_market = market(namespace)
                client = self.client("bybit", [native_market])
                raw = bybit_original(native_market)
                parsed = client.parse_trade(raw, native_market)
                identity = native_fill_identity("bybit", native_market, parsed)
                self.assertEqual(identity, {"version": 1, "profile": "bybit_execution_v1", "marketNamespace": namespace,
                                           "providerMarketId": native_market["id"], "providerSymbol": native_market["symbol"],
                                           "providerFillId": raw["execId"], "scopeTimestamp": None})
                self.assertEqual(parsed["info"], raw)
                self.assertEqual(parsed["timestamp"], STAMP)
                if namespace == "option":
                    self.assertTrue(native_market["linear"], "The SDK's linear option must not become the linear namespace.")

    async def test_bybit_normalizer_retains_native_request_fields_without_input_mutation(self):
        native_market = market()
        client = self.client("bybit", [native_market])
        parsed = client.parse_trade(bybit_original(native_market), native_market)
        before = copy.deepcopy(parsed)
        normalized = _normalized_fill(client, {}, parsed, "bybit")
        self.assertEqual(normalized["identity"]["providerFillId"], "2210000000101610464")
        self.assertEqual(normalized["identity"]["providerSymbol"], parsed["symbol"])
        self.assertEqual(normalized["raw"], before)
        self.assertEqual(parsed, before)

    async def test_bybit_native_id_market_and_unknown_category_are_not_guessed(self):
        native_market = market()
        client = self.client("bybit", [native_market])
        raw = bybit_original(native_market)
        for changed in ({**raw, "execId": 123}, {**raw, "symbol": "FOREIGNUSDT"},
                        {key: value for key, value in raw.items() if key != "execId"}):
            with self.subTest(native=changed):
                parsed = client.parse_trade(changed, native_market)
                self.assertIsNone(native_fill_identity("bybit", native_market, parsed))
        parsed = client.parse_trade(raw, native_market)
        no_namespace = {**native_market, "linear": False, "inverse": False, "spot": False, "option": False}
        self.assertIsNone(native_fill_identity("bybit", no_namespace, parsed))

    async def test_bybit_legacy_tradeid_is_not_silently_an_execid_alias(self):
        native_market = market()
        client = self.client("bybit", [native_market])
        raw = bybit_original(native_market)
        raw["tradeId"] = raw.pop("execId")
        parsed = client.parse_trade(raw, native_market)
        self.assertEqual(parsed["id"], raw["tradeId"], "The real SDK supports this legacy display ID.")
        self.assertIsNone(native_fill_identity("bybit", native_market, parsed), "It is not the native execId contract.")

    async def test_real_hl_swap_market_index_must_not_erase_native_coin_identity(self):
        client, native_market = await self.hl_markets()
        self.assertEqual(native_market["id"], "0")
        self.assertEqual(native_market["baseName"], "ETH")
        raw = hl_original()
        parsed = client.parse_trade(raw)
        self.assertEqual(parsed["symbol"], "ETH/USDC:USDC")
        normalized = _normalized_fill(client, {}, parsed, "hyperliquid")
        self.assertIn("identity", normalized, "An actual SDK swap fill needs a provable native coin identity, not an asset-index equality guess.")
        self.assertEqual(normalized["identity"]["providerMarketId"], raw["coin"])
        self.assertEqual(normalized["identity"]["scopeTimestamp"], STAMP)

    async def test_real_hl_spot_market_cannot_be_labeled_perpetual(self):
        client, native_market = await self.hl_markets(spot=True)
        self.assertTrue(native_market["spot"])
        self.assertFalse(native_market["contract"])
        self.assertIsNone(native_market["contractSize"])
        parsed = client.parse_trade(hl_original("PURR/USDC"))
        self.assertEqual(parsed["symbol"], "PURR/USDC")
        # Existing adapter contract-size gate already blocks this SDK spot row;
        # do not overwrite it with a made-up contractSize to force a pipeline pass.
        with self.assertRaises(ExchangeContractError):
            _normalized_fill(client, {}, parsed, "hyperliquid")
        self.assertIsNone(native_fill_identity("hyperliquid", native_market, parsed),
                          "The producer itself must not attach a false perpetual namespace to actual SDK spot evidence.")

    async def test_hl_unified_id_conversion_does_not_mutate_native_tid_or_time(self):
        client, native_market = await self.hl_markets()
        parsed = client.parse_trade(hl_original())
        self.assertEqual(parsed["id"], "128423918764978")
        self.assertIs(type(parsed["info"]["tid"]), int)
        self.assertIs(type(parsed["info"]["time"]), int)
        for key, value in (("tid", 999), ("coin", "BTC")):
            changed = copy.deepcopy(parsed)
            changed["info"][key] = value
            self.assertIsNone(native_fill_identity("hyperliquid", native_market, changed))

    async def test_hl_native_timestamp_is_not_coerced_or_replaced_by_unified_time(self):
        client, native_market = await self.hl_markets()
        for stamp in (None, True, str(STAMP), -1, 1.5):
            with self.subTest(native_time=stamp):
                parsed = client.parse_trade({**hl_original(), "time": stamp})
                self.assertIsNone(native_fill_identity("hyperliquid", native_market, parsed))
        parsed = client.parse_trade(hl_original())
        changed = {**parsed, "timestamp": STAMP + 1}
        self.assertIsNone(native_fill_identity("hyperliquid", native_market, changed),
                          "A unified time contradicting the native time cannot form the same original identity.")

    async def test_real_hl_cloid_lookup_binds_native_coin_not_numeric_asset_index(self):
        client, native_market = await self.hl_markets()
        client.walletAddress = "0x" + "a" * 40
        cloid = "0x" + "b" * 32
        reference = {"clientOrderId": cloid, "exchangeOrderId": None, "providerSymbol": native_market["symbol"],
                     "symbol": "ETHUSDT", "role": "entry"}
        raw = hl_order_original()
        client.publicPostInfo = AsyncMock(return_value={"status": "order", "order": raw})
        budget = RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000))
        rows, checked = await recover_order_evidence(client, "hyperliquid", [reference], [],
                                                     lambda _reference: native_market["symbol"], budget)
        self.assertEqual(checked[0]["status"], "observed")
        self.assertEqual(rows[0]["identityEvidence"]["providerMarketId"], "ETH")
        self.assertEqual(rows[0]["info"], raw)
        self.assertIsNone(rows[0]["clientOrderId"])
        self.assertEqual(client.publicPostInfo.await_args.args[0],
                         {"type": "orderStatus", "user": client.walletAddress, "oid": cloid})
        self.assertEqual(budget.calls, 1)
        for coin in ("BTC", native_market["id"]):
            foreign = copy.deepcopy(raw)
            foreign["order"]["coin"] = coin
            client.publicPostInfo.return_value = {"status": "order", "order": foreign}
            with self.subTest(coin=coin), self.assertRaises(ExchangeContractError):
                await recover_order_evidence(client, "hyperliquid", [reference], [],
                                             lambda _reference: native_market["symbol"], budget)

    async def test_hl_cloid_lookup_does_not_prove_missing_or_malformed_native_ids(self):
        client, native_market = await self.hl_markets()
        for oid in (None, True, -1, "", "not-an-oid"):
            original = client.parse_order(hl_order_original(oid=oid))
            with self.subTest(oid=oid), self.assertRaises(ExchangeContractError):
                cloid_lookup_identity(client, original, "0x" + "b" * 32, native_market["symbol"],
                                      "0x" + "a" * 40, STAMP, STAMP + 1)

    async def test_hl_nonnegative_ids_remain_exact_including_zero_and_decimal_spelling(self):
        client, native_market = await self.hl_markets()
        for tid, oid in ((0, 0), ("0001", "0002")):
            with self.subTest(tid=tid, oid=oid):
                parsed = client.parse_trade({**hl_original(), "tid": tid, "oid": oid})
                identity = native_fill_identity("hyperliquid", native_market, parsed)
                self.assertIsNotNone(identity)
                self.assertEqual(identity["providerFillId"], str(tid), "Never alias a differently spelled native string.")
                original = client.parse_order(hl_order_original(oid=oid))
                proof = cloid_lookup_identity(client, original, "0x" + "b" * 32, native_market["symbol"],
                                              "0x" + "a" * 40, STAMP, STAMP + 1)
                self.assertEqual(proof["identityEvidence"]["exchangeOrderId"], str(oid))

    async def test_exact_universe_names_have_no_new_numeric_or_character_allowlist(self):
        client = self.client("hyperliquid")
        for coin in ("123", "A/B", "A@B", "dex:ASSET"):
            native_market = client.parse_market({"name": coin, "baseId": 0, "szDecimals": 3, "markPx": "100"})
            self.assertEqual(hyperliquid_market_coin(native_market), coin)

    async def test_actual_hip3_sdk_parser_preserves_dex_coin_namespace(self):
        client = self.client("hyperliquid")
        client.options["cachedCurrenciesById"] = {}
        client.parse_currency({"index": 0, "name": "USDC", "weiDecimals": 8})
        coin = "xyz:XYZ100"
        client.publicPostInfo = AsyncMock(side_effect=[
            [None, {"name": "xyz"}],
            [{"collateralToken": 0, "universe": [{"name": coin, "szDecimals": 3, "maxLeverage": 20}]},
             [{"markPx": "100"}]],
        ])
        markets = await client.fetch_hip3_markets()
        self.assertEqual(client.publicPostInfo.await_count, 2)
        client.set_markets(markets)
        native_market = markets[0]
        self.assertEqual(native_market["id"], "110000")
        self.assertEqual(native_market["baseName"], coin)
        self.assertEqual(native_market["info"]["name"], coin)
        parsed = client.parse_trade(hl_original(coin))
        identity = native_fill_identity("hyperliquid", native_market, parsed)
        self.assertEqual(identity["providerMarketId"], coin)
        self.assertEqual(identity["providerSymbol"], native_market["symbol"])
        raw = client.parse_order(hl_order_original(coin))
        proof = cloid_lookup_identity(client, raw, "0x" + "b" * 32, native_market["symbol"],
                                      "0x" + "a" * 40, STAMP, STAMP + 1)
        self.assertEqual(proof["identityEvidence"]["providerMarketId"], coin)
        foreign = {**parsed, "info": {**parsed["info"], "coin": "XYZ100"}}
        self.assertIsNone(native_fill_identity("hyperliquid", native_market, foreign), "DEX namespace is never stripped.")

    async def test_hl_cloid_lookup_rejects_actual_sdk_spot_scope(self):
        client, native_market = await self.hl_markets(spot=True)
        original = client.parse_order(hl_order_original("PURR/USDC"))
        with self.assertRaisesRegex(ExchangeContractError, "native market"):
            cloid_lookup_identity(client, original, "0x" + "b" * 32, native_market["symbol"],
                                  "0x" + "a" * 40, STAMP, STAMP + 1)

    async def test_hl_missing_or_conflicting_original_coin_metadata_cannot_be_guessed(self):
        client, native_market = await self.hl_markets()
        parsed = client.parse_trade(hl_original())
        for mutation in ({"baseName": None}, {"baseName": "BTC"}, {"info": {}},
                         {"info": {**native_market["info"], "name": "BTC"}}, {"baseName": native_market["id"]}):
            with self.subTest(mutation=mutation):
                self.assertIsNone(native_fill_identity("hyperliquid", {**native_market, **mutation}, parsed))

    async def test_hl_invalid_native_ids_never_receive_a_perpetual_identity(self):
        client, native_market = await self.hl_markets()
        for native_id in (None, True, -1, "", "not-a-number"):
            with self.subTest(native_id=native_id):
                parsed = client.parse_trade({**hl_original(), "tid": native_id})
                self.assertIsNone(native_fill_identity("hyperliquid", native_market, parsed))

    async def test_bybit_timestamp_changes_are_payload_changes_not_new_fill_ids(self):
        native_market = market()
        client = self.client("bybit", [native_market])
        raw = bybit_original(native_market)
        first = client.parse_trade(raw, native_market)
        later = client.parse_trade({**raw, "execTime": str(STAMP + 1)}, native_market)
        self.assertNotEqual(first["timestamp"], later["timestamp"])
        self.assertEqual(native_fill_identity("bybit", native_market, first),
                         native_fill_identity("bybit", native_market, later))

    async def test_kraken_v3_execution_not_event_uid_is_the_fill_identity(self):
        client, native_market, parsed = self.kraken_trade()
        normalized = _normalized_fill(client, {}, parsed, "krakenfutures")
        self.assertEqual(normalized["identity"], {
            "version": 1, "profile": "kraken_history_execution_v3", "marketNamespace": "futures",
            "providerMarketId": "PF_ETHUSD", "providerSymbol": "ETH/USD:USD",
            "providerFillId": "execution-uid", "scopeTimestamp": None,
        })
        self.assertEqual(normalized["raw"]["info"]["providerEventId"], "history-event-not-the-fill-id")
        self.assertEqual(normalized["raw"]["info"]["accountUid"], ACCOUNT)
        self.assertEqual(native_fill_identity("krakenfutures", native_market, parsed)["providerFillId"], parsed["id"])

    async def test_actual_kraken_sdk_recent_fill_id_is_not_a_v3_execution_alias(self):
        client, native_market, _ = self.kraken_trade()
        raw = {"fillTime": "2024-01-03T04:21:28.911Z", "order_id": "original-order", "fill_id": "recent-fill-id",
               "symbol": "PF_ETHUSD", "side": "buy", "size": 1, "price": 100, "fillType": "maker"}
        parsed = client.parse_trade(raw, native_market)
        self.assertEqual(parsed["id"], "recent-fill-id")
        self.assertIsNone(native_fill_identity("krakenfutures", native_market, parsed))
        with self.assertRaisesRegex(ExchangeContractError, "Recent Kraken"):
            _normalized_fill(client, {}, parsed, "krakenfutures")

    async def test_kraken_original_execution_ids_times_and_accounts_fail_closed_before_identity(self):
        client, native_market, _ = self.kraken_trade()
        for field, values in (("uid", [None, "", True, 123, "bad\n"]),
                              ("timestamp", [None, True, str(STAMP), -1, 1.5])):
            for value in values:
                row = kraken_event()
                row["event"]["execution"]["execution"][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ExchangeContractError):
                    _execution(client, row, ACCOUNT, native_market["symbol"])
        row = kraken_event()
        row["event"]["execution"]["execution"]["order"]["accountUid"] = "foreign-account"
        with self.assertRaisesRegex(ExchangeContractError, "different account"):
            _execution(client, row, ACCOUNT, native_market["symbol"])

    async def test_missing_ids_and_invalid_unified_times_are_unresolved_not_dropped(self):
        client, _, parsed = self.kraken_trade()
        for field, values in [("id", [None, "", True, 123, "x\n"]), ("order", [None, ""]),
                              ("timestamp", [None, True, "1704262888911", -1, 1.5])]:
            for value in values:
                with self.subTest(field=field, value=value):
                    changed = {**parsed, field: value}
                    fills, unresolved = normalize_trades([changed], lambda row: _normalized_fill(client, {}, row, "krakenfutures"))
                    self.assertEqual(fills, [])
                    self.assertEqual(len(unresolved), 1)
                    self.assertEqual(unresolved[0]["reason"], "incomplete_fill_identity_or_economics")

    async def test_nonscalar_unified_evidence_is_rejected_not_coerced_into_quarantine(self):
        client, _, parsed = self.kraken_trade()
        changed = {**parsed, "order": []}
        with self.assertRaisesRegex(ExchangeContractError, "safe evidence boundary"):
            normalize_trades([changed], lambda row: _normalized_fill(client, {}, row, "krakenfutures"))

    async def test_absent_raw_market_and_unknown_profile_never_create_identity(self):
        native_market = market()
        client = self.client("bybit", [native_market])
        parsed = client.parse_trade(bybit_original(native_market), native_market)
        for info in (None, [], "opaque"):
            self.assertIsNone(native_fill_identity("bybit", native_market, {**parsed, "info": info}))
        for field in ("id", "symbol"):
            self.assertIsNone(native_fill_identity("bybit", {**native_market, field: None}, parsed))
        for profile in ("", "paper", "unknown"):
            self.assertIsNone(native_fill_identity(profile, native_market, parsed))


if __name__ == "__main__":
    unittest.main()
