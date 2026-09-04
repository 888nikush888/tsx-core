from __future__ import annotations

import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from test_contracts import (
    DelayedMarketClient, FakeProtectedRest, FakeRegistry, bound_test_account,
    protected_requests, test_secret,
)
import ccxt_client
from ccxt_adapter import CcxtAdapter
from ccxt_client import CcxtClientRegistry
from common import ExchangeContractError, RequestDeadline, UnresolvedOrderOutcome
from order_identity import cancel_target


def deadline():
    return RequestDeadline(int(time.time() * 1_000) + 30_000)


class MutationIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_profiles_reject_wrong_or_unbound_write_before_side_effects(self):
        for exchange in ("hyperliquid", "bybit", "krakenfutures"):
            for field in ("expectedAccountFingerprint", "credentialGeneration"):
                for value in (None, "f" * 64):
                    with self.subTest(exchange=exchange, field=field, value=value):
                        rest = FakeProtectedRest([[]])
                        registry = FakeRegistry(rest, exchange)
                        account = {**bound_test_account(exchange), field: value}
                        entry, stop = protected_requests()
                        with self.assertRaises(ExchangeContractError):
                            await CcxtAdapter(registry).submit_protected_entry(account, entry, stop, deadline())
                        self.assertEqual(rest.leverage, [])
                        self.assertEqual(rest.created_batches, [])
                        with self.assertRaises(ExchangeContractError):
                            await CcxtAdapter(registry).cancel_order(account, "entry-client", "BTCUSDT", deadline())

    async def test_rotation_during_prepare_prevents_set_leverage_and_create(self):
        rest = FakeProtectedRest([[]])
        registry = FakeRegistry(rest)
        adapter = CcxtAdapter(registry)

        async def changed_generation(*_args):
            registry.credentials.account = lambda *_args: {"credentials": {**test_secret(), "secret": "rotated-secret"}}
            return None

        adapter._entry_tier_fence = changed_generation
        with self.assertRaisesRegex(ExchangeContractError, "Credentials changed"):
            await adapter.submit_protected_entry(bound_test_account(), *protected_requests(), deadline())
        self.assertEqual(rest.leverage, [])
        self.assertEqual(rest.created_batches, [])

    async def test_rotation_after_leverage_prevents_create(self):
        rest = FakeProtectedRest([[]])
        rest.configured_leverage = 5  # Exercise the actual setter; matching leverage is now read-only.
        registry = FakeRegistry(rest)

        async def set_then_rotate(leverage, symbol):
            rest.leverage.append((leverage, symbol))
            registry.credentials.account = lambda *_args: {"credentials": {**test_secret(), "secret": "rotated-secret"}}

        rest.set_leverage = set_then_rotate
        with self.assertRaisesRegex(ExchangeContractError, "Credentials changed"):
            await CcxtAdapter(registry).submit_protected_entry(bound_test_account(), *protected_requests(), deadline())
        self.assertEqual(len(rest.leverage), 1)
        self.assertEqual(rest.created_batches, [])

    async def test_incomplete_batch_preserves_known_leg_without_cleanup_or_retry(self):
        entry = {"id": "entry-remote", "clientOrderId": "entry-client", "status": "open", "filled": "0"}
        rest = FakeProtectedRest([[], [{"contracts": "99", "side": "long"}]], orders=[entry])
        with self.assertRaises(UnresolvedOrderOutcome) as raised:
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), *protected_requests(), deadline())
        self.assertEqual(raised.exception.details["confirmedOrders"][0]["exchangeOrderId"], "entry-remote")
        self.assertEqual(len(rest.created_batches), 1)
        self.assertEqual(rest.cleanup_orders, [])

    async def test_mutation_lease_defers_client_replacement_but_not_other_accounts(self):
        state = {"loads": 0, "closes": 0, "started": asyncio.Event(), "release": asyncio.Event()}
        state["release"].set()
        secret = test_secret("hyperliquid")
        secret["walletAddress"] = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"
        credentials = SimpleNamespace(account=lambda *_args: {"credentials": dict(secret)})
        catalog = SimpleNamespace(descriptor=lambda exchange: {"id": exchange, "status": "certified", "modes": ["testnet"]})
        registry = CcxtClientRegistry(credentials, catalog)
        account = {
            **bound_test_account("hyperliquid"),
            "expectedAccountFingerprint": ccxt_client.external_account_id(
                "hyperliquid", "testnet", secret["walletAddress"].lower(),
            ),
            "credentialGeneration": ccxt_client.credential_generation(SimpleNamespace(
                credential_fingerprint=ccxt_client._credential_fingerprint(secret, "hyperliquid", "testnet"),
            )),
        }

        class factory(DelayedMarketClient):
            def __init__(self, configuration):
                super().__init__(configuration, state)

        with patch.object(ccxt_client.ccxt_async, "hyperliquid", factory), patch.object(ccxt_client.ccxt_pro, "hyperliquid", factory):
            original = await registry.account(account)
            async with registry.mutation(account, deadline()) as leased:
                secret["privateKey"] = "0x" + "3" * 64
                secret["walletAddress"] = "0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB"
                rotating = asyncio.create_task(registry.account(account))
                other = await asyncio.wait_for(registry.account({**account, "id": "account-2"}), timeout=1)
                self.assertIsNot(other.rest, original.rest)
                self.assertFalse(rotating.done())
                self.assertEqual(state["closes"], 0)
                self.assertIs(leased.rest, original.rest)
                with self.assertRaisesRegex(ExchangeContractError, "Credentials changed"):
                    registry.assert_binding(account, leased)
            replaced = await asyncio.wait_for(rotating, timeout=1)
            self.assertIsNot(replaced.rest, original.rest)
            self.assertEqual(state["closes"], 2)
            await registry.close()

    async def test_hyperliquid_master_key_binding_precedes_client_construction(self):
        constructed = 0

        class ForbiddenClient:
            def __init__(self, _configuration):
                nonlocal constructed
                constructed += 1
                raise AssertionError("No CCXT client may exist before identity binding.")

        credentials = SimpleNamespace(account=lambda *_args: {"credentials": {
            "privateKey": "0x" + "1" * 64,
            "walletAddress": "0x" + "2" * 40,
        }})
        catalog = SimpleNamespace(descriptor=lambda exchange: {
            "id": exchange, "status": "certified", "modes": ["testnet"],
        })
        registry = CcxtClientRegistry(credentials, catalog)
        with patch.object(ccxt_client.ccxt_async, "hyperliquid", ForbiddenClient), \
             patch.object(ccxt_client.ccxt_pro, "hyperliquid", ForbiddenClient):
            with self.assertRaisesRegex(ExchangeContractError, "master wallet"):
                await registry.account({"id": "foreign", "exchange": "hyperliquid", "mode": "testnet"})
        self.assertEqual(constructed, 0)

    def test_hyperliquid_master_key_binding_accepts_exact_address_case_insensitively(self):
        ccxt_client._assert_hyperliquid_master_key_binding({
            "privateKey": "0x" + "1" * 64,
            "walletAddress": "0x19E7E376E7C213B7E7e7E46CC70A5DD086DAFF2A",
        }, "hyperliquid")
        for secret in (
            {"privateKey": "0x" + "1" * 64, "walletAddress": "0x" + "2" * 40},
            {"privateKey": "not-a-key", "walletAddress": "0x" + "2" * 40},
            {"privateKey": "0x" + "0" * 64, "walletAddress": "0x" + "0" * 40},
        ):
            with self.subTest(secret=secret["walletAddress"]), self.assertRaisesRegex(
                ExchangeContractError, "master wallet",
            ):
                ccxt_client._assert_hyperliquid_master_key_binding(secret, "hyperliquid")


class CancelIdentityTests(unittest.TestCase):
    def test_cancel_requires_exact_symbol_and_consistent_both_identifiers(self):
        order = {"id": "remote", "clientOrderId": None, "symbol": "BTC/USDT:USDT"}
        self.assertEqual(cancel_target([order], order["symbol"], "local", "remote")["clientOrderId"], "local")
        for orders in (
            [{**order, "symbol": "ETH/USDT:USDT"}],
            [{**order, "clientOrderId": "foreign"}],
            [order, order],
            [order, {**order, "id": "different", "clientOrderId": "local"}],
        ):
            with self.subTest(orders=orders), self.assertRaises(ExchangeContractError):
                cancel_target(orders, order["symbol"], "local", "remote")


if __name__ == "__main__":
    unittest.main()
