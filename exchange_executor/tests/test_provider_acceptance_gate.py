import asyncio
import base64
import hashlib
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, RequestDeadline
from provider_acceptance_gate import assert_provider_acceptance, canonical_provider_grant, market_product, signed_grant_valid


ACCOUNT = {
    "id": "account-1", "exchange": "hyperliquid", "mode": "live",
    "expectedAccountFingerprint": "a" * 64, "credentialGeneration": "b" * 64,
}
MARKET = {"contract": True, "swap": True, "linear": True, "inverse": False,
          "spot": False, "option": False}


class ProviderAcceptanceGateTests(unittest.TestCase):
    @staticmethod
    def checked(account, market, **options):
        # Only tests can replace this in-process function; no executor payload
        # carries a provenance override.
        with patch("provider_acceptance_gate.live_provenance_verified", return_value=True):
            assert_provider_acceptance(account, market, **options)

    def test_cross_language_canonical_grant_vector(self):
        grant = {
            "accountId": "account-1", "credentialGeneration": "b" * 64,
            "exchange": "hyperliquid", "externalAccountId": "a" * 64,
            "mode": "live", "product": "swap:linear", "reviewId": "review-1",
            "validFrom": 1_700_000_000_000, "validUntil": 1_700_000_060_000, "version": 1,
        }
        self.assertEqual(hashlib.sha256(canonical_provider_grant(grant)).hexdigest(),
                         "ea49c3dc78413a146c70a337c59f6a1f1b0ad8b193aa59a612983a007541e46f")
        fixture_path = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "provider_acceptance_signature.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        public = serialization.load_pem_public_key(fixture["reviewerPublicKeyPem"].encode("ascii"))
        self.assertTrue(signed_grant_valid({"grant": fixture["grant"], "signature": fixture["signature"]},
                                           public, ACCOUNT, "swap:linear", 1_700_000_001_000))

    def test_missing_trust_anchor_fails_closed(self):
        with self.assertRaisesRegex(ExchangeContractError, "provenance"):
            assert_provider_acceptance(ACCOUNT, MARKET)
        with self.assertRaisesRegex(ExchangeContractError, "provider acceptance"):
            self.checked(ACCOUNT, MARKET)

    def test_signed_grant_is_bound_to_account_mode_product_generation_and_time(self):
        private = Ed25519PrivateKey.generate()
        public = private.public_key()
        pem = public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        der = public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        digest = hashlib.sha256(der).hexdigest()
        now = int(time.time() * 1000)
        grant = {
            "version": 1, "reviewId": "independent-test-review", "exchange": "hyperliquid",
            "product": "swap:linear", "mode": "live", "accountId": ACCOUNT["id"],
            "externalAccountId": ACCOUNT["expectedAccountFingerprint"],
            "credentialGeneration": ACCOUNT["credentialGeneration"],
            "validFrom": now - 1000, "validUntil": now + 60_000,
        }
        signature = private.sign(json.dumps(grant, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii"))
        with tempfile.TemporaryDirectory() as directory:
            key_path, grants_path = Path(directory) / "reviewer.pem", Path(directory) / "grants.json"
            key_path.write_bytes(pem)
            document = {"grant": grant, "signature": base64.b64encode(signature).decode("ascii")}
            grants_path.write_text(json.dumps([document]), encoding="utf-8")
            options = {"pinned_digest": digest, "key_path": str(key_path), "grants_path": str(grants_path), "now_ms": now}
            self.checked(ACCOUNT, MARKET, **options)
            for changed in ({**ACCOUNT, "mode": "testnet"}, {**ACCOUNT, "credentialGeneration": "c" * 64},
                            {**ACCOUNT, "id": "other"}):
                with self.subTest(changed=changed), self.assertRaises(ExchangeContractError):
                    self.checked(changed, MARKET, **options)
            with self.assertRaises(ExchangeContractError):
                self.checked(ACCOUNT, {**MARKET, "linear": False, "inverse": True}, **options)
            with self.assertRaises(ExchangeContractError):
                self.checked(ACCOUNT, MARKET, **{**options, "now_ms": now + 60_000})
            with self.assertRaises(ExchangeContractError):
                self.checked(ACCOUNT, MARKET, **{**options, "pinned_digest": "0" * 64})
            document["grant"]["validUntil"] += 1
            grants_path.write_text(json.dumps([document]), encoding="utf-8")
            with self.assertRaises(ExchangeContractError):
                self.checked(ACCOUNT, MARKET, **options)

    def test_ambiguous_or_spot_market_is_not_accepted(self):
        for changed in ({**MARKET, "contract": False}, {**MARKET, "spot": True},
                        {**MARKET, "linear": True, "inverse": True}, {**MARKET, "swap": False}):
            with self.subTest(changed=changed), self.assertRaises(ExchangeContractError):
                market_product(changed)

    def test_live_order_blocks_before_any_sdk_effect_and_testnet_and_reducing_survive(self):
        adapter = CcxtAdapter(SimpleNamespace())
        adapter._base_order_request = lambda _clients, _request: (MARKET, {"params": {"reduceOnly": False}})
        adapter._apply_market_slippage = AsyncMock()
        adapter._fence_order_entry = AsyncMock()
        deadline = RequestDeadline(int(time.time() * 1000) + 10_000)
        request = {"entryExpiresAt": int(time.time() * 1000) + 10_000}

        async def checks():
            with self.assertRaises(ExchangeContractError):
                await adapter._order_spec(SimpleNamespace(account=ACCOUNT), request, deadline)
            adapter._apply_market_slippage.assert_not_awaited()
            await adapter._order_spec(SimpleNamespace(account={**ACCOUNT, "mode": "testnet"}), request, deadline)
            adapter._base_order_request = lambda _clients, _request: (MARKET, {"params": {"reduceOnly": True}})
            await adapter._order_spec(SimpleNamespace(account=ACCOUNT), {"reduceOnly": True}, deadline)

        asyncio.run(checks())

    def test_final_order_write_rechecks_and_reducing_still_reaches_sdk(self):
        registry = SimpleNamespace(assert_binding=MagicMock())
        adapter = CcxtAdapter(registry)
        rest = SimpleNamespace(create_order=AsyncMock(return_value={}), set_leverage=AsyncMock())
        clients = SimpleNamespace(account=ACCOUNT, rest=rest)
        market = {**MARKET, "symbol": "BTC/USDT:USDT"}
        spec = {"params": {"reduceOnly": False, "clientOrderId": "entry-1"}}
        adapter._order_spec = AsyncMock(return_value=(spec, market))
        adapter._entry_mode_fence = AsyncMock(return_value={})
        adapter._entry_tier_fence = AsyncMock()
        deadline = RequestDeadline(int(time.time() * 1000) + 10_000)
        entry = {"entryExpiresAt": int(time.time() * 1000) + 10_000, "leverage": 2}

        async def checks():
            with patch("ccxt_adapter.assert_entry_constraints"), self.assertRaisesRegex(ExchangeContractError, "provenance"):
                await adapter._submit_order_owned(clients, ACCOUNT, entry, deadline)
            rest.create_order.assert_not_awaited()
            rest.set_leverage.assert_not_awaited()
            adapter._order_spec.return_value = ({"params": {"reduceOnly": True, "clientOrderId": "exit-1"}}, market)
            with patch("ccxt_adapter._market_order_result", return_value={"status": "open"}):
                result = await adapter._submit_order_owned(clients, ACCOUNT, {"reduceOnly": True}, deadline)
            self.assertEqual(result, {"status": "open"})
            rest.create_order.assert_awaited_once()

        asyncio.run(checks())

    def test_final_protected_batch_write_rechecks_without_touching_sdk(self):
        registry = SimpleNamespace(assert_binding=MagicMock())
        adapter = CcxtAdapter(registry)
        rest = SimpleNamespace(create_orders=AsyncMock(), set_leverage=AsyncMock())
        clients = SimpleNamespace(account=ACCOUNT, rest=rest)
        market = {**MARKET, "symbol": "BTC/USDT:USDT"}
        specs = ({"params": {"clientOrderId": "entry-1"}}, {"params": {"clientOrderId": "stop-1"}})
        adapter._entry_mode_fence = AsyncMock(return_value={})
        adapter._entry_tier_fence = AsyncMock()
        deadline = RequestDeadline(int(time.time() * 1000) + 10_000)
        entry = {"entryExpiresAt": int(time.time() * 1000) + 10_000}

        async def checks():
            with patch("ccxt_adapter.assert_entry_constraints"), self.assertRaisesRegex(ExchangeContractError, "provenance"):
                await adapter._create_protected_orders(clients, market, specs, deadline, 2, entry)
            rest.create_orders.assert_not_awaited()

        asyncio.run(checks())

    def test_testnet_registry_enters_sandbox_on_both_sdk_clients(self):
        class FakeSdk:
            def __init__(self):
                self.sandbox = False

            def set_sandbox_mode(self, enabled):
                self.sandbox = enabled

        rest, pro = FakeSdk(), FakeSdk()
        from ccxt_client import CcxtClientRegistry

        async def checks():
            await CcxtClientRegistry._enable_sandbox(rest, pro)

        asyncio.run(checks())
        self.assertTrue(rest.sandbox)
        self.assertTrue(pro.sandbox)


if __name__ == "__main__":
    unittest.main()
