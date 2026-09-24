"""Offline fakes for the bound read-only Testnet diagnostic; no real keys or I/O."""
from __future__ import annotations

import json
import sys
import traceback
import unittest
from pathlib import Path
from unittest.mock import patch

import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro
from ccxt.async_support.base.exchange import Exchange as CcxtExchange

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "exchange_executor"))

from ccxt_client import _credential_fingerprint  # noqa: E402
from common import external_account_cache_key, external_account_id  # noqa: E402
import hyperliquid_bound_preflight as bound  # noqa: E402
from hyperliquid_bound_preflight import (  # noqa: E402
    ORIGIN, BoundPreflightRefused, _inspect_bound_testnet_account_for_test, _sdk_client,
    inspect_bound_testnet_account,
)

PRIVATE_KEY = "0x" + "1" * 64  # Fixed, public test vector; never an operational credential.
WALLET = CcxtExchange.eth_get_address_from_private_key(PRIVATE_KEY).lower()
SECRET = {"privateKey": PRIVATE_KEY, "walletAddress": WALLET}
FINGERPRINT = _credential_fingerprint(SECRET, "hyperliquid", "testnet")
ACCOUNT = {
    "id": "synthetic-testnet-account", "exchange": "hyperliquid", "mode": "testnet",
    "expectedAccountFingerprint": external_account_id("hyperliquid", "testnet", WALLET),
    "credentialGeneration": external_account_cache_key("credential-generation", "v1", FINGERPRINT),
}
MARKET = {
    "symbol": "BTC/USDC:USDC", "base": "BTC", "settle": "USDC", "info": {"name": "BTC"},
    "contract": True, "swap": True, "linear": True, "inverse": False,
    "spot": False, "option": False, "future": False, "active": True, "expiry": None,
}


class FakeSdk:
    bootstrap_url = ORIGIN + "/info"
    bootstrap_body = {"type": "metaAndAssetCtxs"}
    product = MARKET
    drift_after_bootstrap = False
    constructed = 0
    closed = 0
    instances: list[FakeSdk] = []

    def __init__(self, config):
        FakeSdk.constructed += 1
        self.config = config
        self.was_closed = False
        FakeSdk.instances.append(self)
        self.urls = {"api": {"public": "https://api.hyperliquid.xyz", "private": "https://api.hyperliquid.xyz"}}
        self.aiohttp_trust_env = config["aiohttp_trust_env"]
        self.market_data = dict(type(self).product)

    def set_sandbox_mode(self, enabled):
        if enabled:
            self.urls["api"] = {"public": ORIGIN, "private": ORIGIN}

    async def load_markets(self):
        await self.fetch(type(self).bootstrap_url, "POST", body=json.dumps(type(self).bootstrap_body))
        if type(self).drift_after_bootstrap:
            self.urls["api"]["public"] = "https://api.hyperliquid.xyz"

    def market(self, symbol):
        return self.market_data if symbol == self.market_data["symbol"] else None

    async def publicPostInfo(self, payload):
        return await self.fetch(self.urls["api"]["public"] + "/info", "POST", body=json.dumps(payload))

    async def close(self):
        self.was_closed = True
        FakeSdk.closed += 1


class BoundHyperliquidPreflightTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeSdk.constructed = FakeSdk.closed = 0
        FakeSdk.instances = []
        FakeSdk.bootstrap_url = ORIGIN + "/info"
        FakeSdk.bootstrap_body = {"type": "metaAndAssetCtxs"}
        FakeSdk.product = MARKET
        FakeSdk.drift_after_bootstrap = False
        self.sent: list[tuple[dict[str, str], str]] = []
        self.responses = {
            "metaAndAssetCtxs": [{"universe": [{"name": "BTC"}]}, []],
            "userRole": {"role": "user"},
            "userAbstraction": "disabled",
            "activeAssetData": {"user": WALLET, "coin": "BTC", "leverage": {"type": "cross", "value": 2}},
            "clearinghouseState": {"assetPositions": [], "marginSummary": {"totalNtlPos": "0"}},
            "openOrders": [],
        }

    async def transport(self, payload, url):
        self.sent.append((payload, url))
        return self.responses[payload["type"]]

    async def inspect(self, account=None, secret=None, symbol="BTC/USDC:USDC"):
        return await _inspect_bound_testnet_account_for_test(
            account or ACCOUNT, secret or SECRET, symbol, transport=self.transport,
            rest_class=FakeSdk, pro_class=FakeSdk,
        )

    async def test_operational_entrypoint_pins_direct_transport_and_sdk_classes(self):
        captured = {}

        async def fake_private(*args, **kwargs):
            captured.update(kwargs)
            return {"scope": "synthetic-test-only"}

        with patch.object(bound, "_inspect_bound_testnet_account_for_test", fake_private):
            result = await inspect_bound_testnet_account(ACCOUNT, SECRET, "BTC/USDC:USDC")
        self.assertEqual(result["scope"], "synthetic-test-only")
        self.assertIs(captured["transport"], bound.direct_testnet_info)
        self.assertIs(captured["rest_class"], ccxt_async.hyperliquid)
        self.assertIs(captured["pro_class"], ccxt_pro.hyperliquid)
        self.assertEqual(self.sent, [])

    async def test_bound_snapshot_is_redacted_and_never_grants_acceptance(self):
        result = await self.inspect()
        self.assertTrue(result["flat"])
        self.assertEqual(result["product"], "swap:linear:USDC:first-dex")
        self.assertIn("no open position readback", result["positionModeEvidence"])
        self.assertEqual(result["scope"], "diagnostic-only")
        self.assertFalse(result["providerAcceptanceVerified"])
        self.assertEqual(result["requestCount"], len(self.sent))
        self.assertEqual(FakeSdk.closed, 2)
        self.assertEqual(len(FakeSdk.instances), 2)
        self.assertTrue(all(client.was_closed for client in FakeSdk.instances))
        self.assertTrue(all(url == ORIGIN + "/info" for _, url in self.sent))
        rendered = json.dumps(result)
        self.assertNotIn(WALLET, rendered)
        self.assertNotIn(PRIVATE_KEY, rendered)
        self.assertNotIn("totalNtlPos", rendered)
        self.assertEqual({p["type"] for p, _ in self.sent}, set(self.responses))
        self.assertEqual([p["type"] for p, _ in self.sent], [
            "metaAndAssetCtxs", "userRole", "userAbstraction", "clearinghouseState", "openOrders",
            "activeAssetData", "clearinghouseState", "openOrders",
        ], "Role, abstraction and two flat-state observations must retain their exact request order.")

    async def test_bad_master_key_or_account_generation_never_constructs_sdk(self):
        for account, secret in [
            (ACCOUNT, {**SECRET, "privateKey": "0x" + "2" * 64}),
            ({**ACCOUNT, "expectedAccountFingerprint": "a" * 64}, SECRET),
            ({**ACCOUNT, "credentialGeneration": "b" * 64}, SECRET),
            ({**ACCOUNT, "mode": "live"}, SECRET),
        ]:
            with self.subTest(account=account["mode"]), self.assertRaises(BoundPreflightRefused):
                await self.inspect(account, secret)
        self.assertEqual(FakeSdk.constructed, 0)
        self.assertEqual(self.sent, [])

    async def test_market_product_and_account_state_fail_closed(self):
        for changed_market in [
            {"inverse": True, "linear": False}, {"settle": "USDT"}, {"active": False},
            {"info": {"name": "xyz:BTC"}}, {"spot": True},
        ]:
            with self.subTest(changed_market=changed_market):
                FakeSdk.product = {**MARKET, **changed_market}
                with self.assertRaises(BoundPreflightRefused):
                    await self.inspect()
        FakeSdk.product = MARKET
        for kind, invalid in [
            ("userRole", {"role": "agent"}), ("userAbstraction", "unifiedAccount"),
            ("activeAssetData", {"user": WALLET, "coin": "BTC", "leverage": {"type": "isolated", "value": 2}}),
            ("clearinghouseState", {"assetPositions": [], "marginSummary": {"totalNtlPos": "0.01"}}),
            ("clearinghouseState", {"assetPositions": [{"type": "oneWay", "position": {"szi": "1"}}],
                                    "marginSummary": {"totalNtlPos": "0"}}),
            ("openOrders", [{"coin": "BTC"}]),
            ("openOrders", {"unknown": True}),
        ]:
            with self.subTest(kind=kind, invalid=invalid):
                self.responses[kind] = invalid
                with self.assertRaises(BoundPreflightRefused):
                    await self.inspect()
                self.setUp()
        self.assertEqual(FakeSdk.constructed, FakeSdk.closed)
        self.assertTrue(all(client.was_closed for client in FakeSdk.instances))

    def test_market_scope_requires_exact_flags_and_text_coin(self):
        for field in ("contract", "swap", "linear", "inverse", "spot", "option", "future", "active"):
            for value in (None, int(MARKET[field]), not MARKET[field]):
                invalid = {**MARKET, field: value}
                with self.subTest(field=field, value=value), self.assertRaises(BoundPreflightRefused):
                    bound._market_scope(invalid, "BTC/USDC:USDC")
        for info in (None, {}, {"name": None}, {"name": 17}, {"name": []}, {"name": "xyz:BTC"}):
            invalid = {**MARKET, "info": info}
            with self.subTest(info=info), self.assertRaises(BoundPreflightRefused):
                bound._market_scope(invalid, "BTC/USDC:USDC")

    async def test_sdk_url_drift_and_mutating_or_ambiguous_requests_never_reach_transport(self):
        for url, payload in [
            ("https://api.hyperliquid.xyz/info", {"type": "metaAndAssetCtxs"}),
            (ORIGIN + ".attacker.invalid/info", {"type": "metaAndAssetCtxs"}),
            (ORIGIN + ":443/info", {"type": "metaAndAssetCtxs"}),
            (ORIGIN + "/exchange", {"type": "order"}),
            (ORIGIN + "/info", {"type": "exchange"}),
            (ORIGIN + "/info", {"type": "metaAndAssetCtxs", "dex": "xyz"}),
        ]:
            with self.subTest(url=url, payload=payload):
                FakeSdk.bootstrap_url = url
                FakeSdk.bootstrap_body = payload
                with self.assertRaises(BoundPreflightRefused):
                    await self.inspect()
                self.assertEqual(self.sent, [])
        self.assertEqual(FakeSdk.constructed, FakeSdk.closed)
        self.assertTrue(all(client.was_closed for client in FakeSdk.instances))

    async def test_guard_installed_on_actual_pinned_sdk_before_any_request(self):
        async def never_sent(_payload, _url):
            self.fail("network transport invoked")

        client = await _sdk_client(ccxt_async.hyperliquid, SECRET, WALLET, never_sent)
        try:
            with self.assertRaises(BoundPreflightRefused):
                await client.fetch(ORIGIN + "/exchange", "POST", body='{"type":"order"}')
            with self.assertRaises(BoundPreflightRefused):
                await client.fetch("https://api.hyperliquid.xyz/info", "POST", body='{"type":"metaAndAssetCtxs"}')
            self.assertEqual(client.preflight_request_count(), 0)
        finally:
            await client.close()

    async def test_post_bootstrap_sdk_url_or_proxy_drift_is_refused(self):
        FakeSdk.drift_after_bootstrap = True
        with self.assertRaises(BoundPreflightRefused):
            await self.inspect()
        self.assertEqual([payload["type"] for payload, _ in self.sent], ["metaAndAssetCtxs"])
        self.sent.clear()
        client = await _sdk_client(FakeSdk, SECRET, WALLET, self.transport)
        try:
            client.httpProxy = "http://127.0.0.1:9999"
            with self.assertRaises(BoundPreflightRefused):
                await client.fetch(ORIGIN + "/info", "POST", body='{"type":"metaAndAssetCtxs"}')
            self.assertEqual(self.sent, [])
        finally:
            await client.close()

    async def test_actual_pinned_sdk_bootstrap_uses_only_guarded_info_requests(self):
        self.responses["spotMeta"] = {"tokens": [], "universe": []}
        self.responses["metaAndAssetCtxs"] = [
            {"universe": [{"name": "BTC", "szDecimals": 3, "maxLeverage": 50}]},
            [{"markPx": "100"}],
        ]
        result = await _inspect_bound_testnet_account_for_test(
            ACCOUNT, SECRET, "BTC/USDC:USDC", transport=self.transport,
            rest_class=ccxt_async.hyperliquid, pro_class=ccxt_pro.hyperliquid,
        )
        self.assertEqual(result["symbol"], "BTC/USDC:USDC")
        self.assertTrue(all(url == ORIGIN + "/info" for _, url in self.sent))
        self.assertFalse(any(payload.get("type") == "exchange" for payload, _ in self.sent))

    async def test_provider_numeric_leverage_and_bad_values(self):
        for value in (1, 2, 3.0, 50):
            with self.subTest(valid=value):
                self.responses["activeAssetData"]["leverage"]["value"] = value
                result = await self.inspect()
                self.assertFalse(result["providerAcceptanceVerified"])
        for value in (True, False, 0, -1, 2.5, 51, 10**100, float("nan"),
                      float("inf"), float("-inf"), "3", None, {}, []):
            with self.subTest(invalid=value):
                self.responses["activeAssetData"]["leverage"]["value"] = value
                with self.assertRaises(BoundPreflightRefused):
                    await self.inspect()
        self.assertEqual(FakeSdk.constructed, FakeSdk.closed)
        self.assertTrue(all(client.was_closed for client in FakeSdk.instances))

    async def test_error_traceback_suppresses_sensitive_cause(self):
        marker = "synthetic-private-error-marker"
        with (
            patch.object(bound, "_assert_hyperliquid_master_key_binding", side_effect=ValueError(marker)),
            self.assertRaises(BoundPreflightRefused) as raised,
        ):
            await self.inspect()
        rendered = "".join(traceback.format_exception(raised.exception))
        self.assertNotIn(marker, rendered)
        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
