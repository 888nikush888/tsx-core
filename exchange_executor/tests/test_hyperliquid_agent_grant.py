"""Offline negative cases for the Testnet API-wallet candidate. No real keys or I/O."""
from __future__ import annotations

import json
import ssl
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import ccxt_client
import hyperliquid_agent_grant as grant
from common import ExchangeContractError, RequestDeadline, external_account_id


MASTER = "0x" + "2" * 40
SIGNER = "0x" + "1" * 40
KEY = "0x" + "1" * 64  # Published deterministic test vector only.
NOW = 1_700_000_000_000


def role():
    return {"role": "agent", "data": {"user": MASTER}}


def rows(*, valid_until=NOW + 100_000, name="test-agent"):
    return [{"name": name, "address": SIGNER, "validUntil": valid_until}]


def requester(role_result=None, grants_result=None):
    answers = [role() if role_result is None else role_result,
               rows() if grants_result is None else grants_result]
    sent = []

    def request(payload):
        sent.append(payload)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return request, sent


class AgentGrantContractTests(unittest.TestCase):
    def test_exact_fresh_role_and_grant_bind_one_signer_without_secrets(self):
        request, sent = requester()
        result = grant.read_testnet_agent_grant(MASTER, SIGNER, requester=request, now_ms=NOW)
        self.assertEqual(result.valid_until, NOW + 100_000)
        self.assertRegex(result.fingerprint, r"^[a-f0-9]{64}$")
        self.assertEqual(sent, [
            {"type": "userRole", "user": SIGNER},
            {"type": "extraAgents", "user": MASTER},
        ])
        self.assertNotIn(KEY, json.dumps(result.__dict__))

    def test_role_must_name_the_exact_master(self):
        for invalid in (
            {"role": "agent", "data": {"user": "0x" + "3" * 40}},
            {"role": "user"},
            {"role": "missing"},
            {"role": "agent", "data": {"user": MASTER, "extra": 1}},
            {"role": "agent", "data": {"user": MASTER}, "extra": 1},
            [],
        ):
            request, sent = requester(role_result=invalid)
            with self.subTest(invalid=invalid), self.assertRaises(grant.AgentGrantRefused):
                grant.read_testnet_agent_grant(MASTER, SIGNER, requester=request, now_ms=NOW)
            self.assertEqual(len(sent), 1)

    def test_revoked_expired_ambiguous_and_malformed_grants_fail_closed(self):
        invalid_rows = (
            [],
            rows(valid_until=NOW + grant.MIN_REMAINING_MS),
            rows(valid_until=NOW - 1),
            rows() + rows(),
            [{"name": "other", "address": "0x" + "3" * 40, "validUntil": NOW + 100_000}],
            [{"name": "bad", "address": SIGNER, "validUntil": True}],
            [{"name": "bad", "address": SIGNER, "validUntil": "9999999999999"}],
            [{"name": "bad", "address": SIGNER, "validUntil": NOW + 100_000, "scope": "all"}],
            rows() + [{"name": "bad", "address": "not-an-address", "validUntil": NOW + 100_000}],
            rows() * (grant.MAX_AGENTS + 1),
            {"agents": rows()},
        )
        for invalid in invalid_rows:
            request, _ = requester(grants_result=invalid)
            with self.subTest(invalid=invalid), self.assertRaises(grant.AgentGrantRefused):
                grant.read_testnet_agent_grant(MASTER, SIGNER, requester=request, now_ms=NOW)

    def test_timeout_and_rotation(self):
        request, _ = requester(grants_result=TimeoutError("sensitive upstream text"))
        with self.assertRaisesRegex(grant.AgentGrantRefused, "unproved") as raised:
            grant.read_testnet_agent_grant(MASTER, SIGNER, requester=request, now_ms=NOW)
        self.assertNotIn("sensitive upstream", str(raised.exception))
        first, _ = requester()
        rotated, _ = requester(grants_result=rows(valid_until=NOW + 200_000))
        original = grant.read_testnet_agent_grant(MASTER, SIGNER, requester=first, now_ms=NOW)
        next_grant = grant.read_testnet_agent_grant(MASTER, SIGNER, requester=rotated, now_ms=NOW)
        self.assertNotEqual(original.fingerprint, next_grant.fingerprint)

    def test_request_transport_is_exactly_testnet_info_and_rejects_redirect(self):
        observed = {}

        class Response:
            status = 302

            @staticmethod
            def getheader(_name, default):
                return default

        class Connection:
            def __init__(self, host, **kwargs):
                observed["host"] = host
                observed["timeout"] = kwargs["timeout"]
                observed["context"] = kwargs["context"]

            @staticmethod
            def request(method, path, *, body, headers):
                observed.update(method=method, path=path, body=json.loads(body), headers=headers)

            @staticmethod
            def getresponse():
                return Response()

            @staticmethod
            def close():
                observed["closed"] = True

        with (
            patch.object(grant.http.client, "HTTPSConnection", Connection),
            self.assertRaises(grant.AgentGrantRefused),
        ):
            grant._post_info({"type": "userRole", "user": SIGNER})
        self.assertEqual(observed["host"], grant.TESTNET_HOST)
        self.assertEqual(observed["path"], "/info")
        self.assertEqual(observed["method"], "POST")
        self.assertEqual(observed["body"], {"type": "userRole", "user": SIGNER})
        self.assertEqual(observed["timeout"], 4)
        self.assertEqual(observed["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(observed["context"].check_hostname)
        self.assertTrue(observed["closed"])


class FakeSdk:
    instances = []
    drift = False

    def __init__(self, configuration):
        self.config = configuration
        self.aiohttp_trust_env = configuration.get("aiohttp_trust_env")
        self.urls = {"api": {"public": "https://api.hyperliquid.xyz",
                             "private": "https://api.hyperliquid.xyz"}}
        self.has = dict.fromkeys(ccxt_client.REQUIRED_REST_CAPABILITIES
                                 + ccxt_client.REQUIRED_PRO_CAPABILITIES, True)
        self.closed = False
        FakeSdk.instances.append(self)

    def set_sandbox_mode(self, _enabled):
        if not self.drift:
            self.urls["api"] = {
                "public": grant.TESTNET_ORIGIN, "private": grant.TESTNET_ORIGIN,
                "ws": {"public": "wss://api.hyperliquid-testnet.xyz/ws"},
            }

    @staticmethod
    async def load_markets():
        return None

    @staticmethod
    async def fetch(url, *_args, **_kwargs):
        return {"acceptedUrl": url}

    @staticmethod
    async def watch(url, *_args, **_kwargs):
        return {"acceptedUrl": url}

    async def close(self):
        self.closed = True


class AgentRegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeSdk.instances = []
        FakeSdk.drift = False
        self.secret = {"privateKey": KEY, "walletAddress": MASTER}
        credentials = SimpleNamespace(account=lambda *_args: {"credentials": dict(self.secret)})
        catalog = SimpleNamespace(descriptor=lambda _exchange: {
            "id": "hyperliquid", "status": "certified", "modes": ["testnet", "live"],
        })
        self.registry = ccxt_client.CcxtClientRegistry(credentials, catalog)
        self.proof = grant.AgentGrant("a" * 64, int(time.time() * 1000) + 120_000)
        self.account = {"id": "test-agent", "exchange": "hyperliquid", "mode": "testnet",
                        "expectedAccountFingerprint": external_account_id("hyperliquid", "testnet", MASTER)}
        fingerprint = ccxt_client._credential_fingerprint(self.secret, "hyperliquid", "testnet")
        self.account["credentialGeneration"] = ccxt_client.credential_generation_from_parts(
            fingerprint, self.proof.fingerprint,
        )

    async def asyncTearDown(self):
        await self.registry.close()

    async def _run_forbidden_mutation(self, deadline):
        async with self.registry.mutation(self.account, deadline):
            self.fail("Refused mutation reached the mutation body.")

    async def test_revalidates_under_mutation_lock_and_refuses_revoked_grant(self):
        calls = []

        def verify(master, signer):
            calls.append((master, signer))
            if len(calls) == 3:
                raise grant.AgentGrantRefused("revoked")
            return self.proof

        with (patch.object(ccxt_client, "read_testnet_agent_grant", verify),
              patch.object(ccxt_client.ccxt_async, "hyperliquid", FakeSdk),
              patch.object(ccxt_client.ccxt_pro, "hyperliquid", FakeSdk)):
            clients = await self.registry.account(self.account)
            self.assertEqual(clients.account_identity, MASTER)
            self.assertEqual(ccxt_client.credential_generation(clients), self.account["credentialGeneration"])
            self.assertEqual(len(FakeSdk.instances), 2)
            async with self.registry.mutation(self.account, RequestDeadline(int(time.time() * 1000) + 30_000)):
                pass
            revoked_deadline = RequestDeadline(int(time.time() * 1000) + 30_000)
            with self.assertRaisesRegex(ExchangeContractError, "agent grant is unproved"):
                await self._run_forbidden_mutation(revoked_deadline)
            self.assertEqual(len(calls), 3)
            self.assertEqual(len(FakeSdk.instances), 2)

    async def test_reapproval_changes_generation_and_requires_account_rebind(self):
        calls = 0

        def verify(_master, _signer):
            nonlocal calls
            calls += 1
            return self.proof if calls == 1 else grant.AgentGrant("b" * 64, self.proof.valid_until + 10_000)

        with (patch.object(ccxt_client, "read_testnet_agent_grant", verify),
              patch.object(ccxt_client.ccxt_async, "hyperliquid", FakeSdk),
              patch.object(ccxt_client.ccxt_pro, "hyperliquid", FakeSdk)):
            await self.registry.account(self.account)
            changed_grant_deadline = RequestDeadline(int(time.time() * 1000) + 30_000)
            with self.assertRaisesRegex(ExchangeContractError, "fingerprint or credential generation"):
                await self._run_forbidden_mutation(changed_grant_deadline)
            self.assertEqual(len(FakeSdk.instances), 4)
            self.assertTrue(all(client.closed for client in FakeSdk.instances[:2]))

    async def test_live_agent_and_sdk_origin_drift_fail_before_mutation(self):
        with (
            patch.object(ccxt_client, "read_testnet_agent_grant", return_value=self.proof) as verify,
            patch.object(ccxt_client.ccxt_async, "hyperliquid", FakeSdk),
            patch.object(ccxt_client.ccxt_pro, "hyperliquid", FakeSdk),
            self.assertRaisesRegex(ExchangeContractError, "restricted to Testnet"),
        ):
            await self.registry.account({**self.account, "mode": "live"})
        verify.assert_not_called()
        self.assertEqual(FakeSdk.instances, [])
        FakeSdk.drift = True
        with (
            patch.object(ccxt_client, "read_testnet_agent_grant", return_value=self.proof),
            patch.object(ccxt_client.ccxt_async, "hyperliquid", FakeSdk),
            patch.object(ccxt_client.ccxt_pro, "hyperliquid", FakeSdk),
            self.assertRaisesRegex(ExchangeContractError, "SDK origin is unproved"),
        ):
            await self.registry.account(self.account)
        self.assertTrue(all(client.closed for client in FakeSdk.instances))

    async def test_grant_must_outlive_mutation_deadline(self):
        soon = grant.AgentGrant("a" * 64, int(time.time() * 1000) + 20_000)
        with (
            patch.object(ccxt_client, "read_testnet_agent_grant", return_value=soon),
            patch.object(ccxt_client.ccxt_async, "hyperliquid", FakeSdk),
            patch.object(ccxt_client.ccxt_pro, "hyperliquid", FakeSdk),
            self.assertRaisesRegex(ExchangeContractError, "expires within"),
        ):
            expiring_deadline = RequestDeadline(int(time.time() * 1000) + 30_000)
            await self._run_forbidden_mutation(expiring_deadline)

    async def test_agent_sdk_routes_fail_closed_on_mainnet_proxy_and_late_url_drift(self):
        with (patch.object(ccxt_client, "read_testnet_agent_grant", return_value=self.proof),
              patch.object(ccxt_client.ccxt_async, "hyperliquid", FakeSdk),
              patch.object(ccxt_client.ccxt_pro, "hyperliquid", FakeSdk)):
            clients = await self.registry.account(self.account)
            self.assertEqual((await clients.rest.fetch(grant.TESTNET_ORIGIN + "/info", "POST"))["acceptedUrl"],
                             grant.TESTNET_ORIGIN + "/info")
            self.assertEqual((await clients.pro.watch("wss://api.hyperliquid-testnet.xyz/ws"))["acceptedUrl"],
                             "wss://api.hyperliquid-testnet.xyz/ws")
            allowed = json.dumps({"action": {"type": "order", "orders": [{"a": 1}]},
                                  "nonce": 1, "signature": {}})
            self.assertEqual((await clients.rest.fetch(grant.TESTNET_ORIGIN + "/exchange", "POST",
                                                       body=allowed))["acceptedUrl"],
                             grant.TESTNET_ORIGIN + "/exchange")
            with self.assertRaisesRegex(ExchangeContractError, "REST-only"):
                await clients.pro.fetch(grant.TESTNET_ORIGIN + "/exchange", "POST", body=allowed)
            for url in ("https://api.hyperliquid.xyz/info", grant.TESTNET_ORIGIN + "/info?x=1",
                        grant.TESTNET_ORIGIN + "/withdraw", "http://api.hyperliquid-testnet.xyz/info"):
                with self.subTest(url=url), self.assertRaises(ExchangeContractError):
                    await clients.rest.fetch(url, "POST")
            for action in (
                {"type": "withdraw3"}, {"type": "order", "orders": [{"a": 10_000}]},
                {"type": "order", "orders": [{"a": 1}], "builder": {"f": 1}},
                {"type": "cancel", "cancels": [{"a": 100_000}]},
            ):
                body = json.dumps({"action": action, "nonce": 1, "signature": {}})
                with self.subTest(action=action), self.assertRaises(ExchangeContractError):
                    await clients.rest.fetch(grant.TESTNET_ORIGIN + "/exchange", "POST", body=body)
            foreign_vault_body = json.dumps({
                "action": {"type": "order", "orders": [{"a": 1}]},
                "nonce": 1, "signature": {}, "vaultAddress": MASTER,
            })
            with self.assertRaises(ExchangeContractError):
                await clients.rest.fetch(grant.TESTNET_ORIGIN + "/exchange", "POST", body=foreign_vault_body)
            clients.rest.proxy = "http://local-proxy"
            with self.assertRaises(ExchangeContractError):
                await clients.rest.fetch(grant.TESTNET_ORIGIN + "/info", "POST")
            clients.rest.proxy = None
            clients.pro.urls["api"]["ws"]["public"] = "wss://api.hyperliquid.xyz/ws"
            with self.assertRaises(ExchangeContractError):
                await clients.pro.watch("wss://api.hyperliquid-testnet.xyz/ws")
