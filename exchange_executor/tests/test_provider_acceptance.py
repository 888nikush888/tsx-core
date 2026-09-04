from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_fixtures import (
    HOSTS, PROFILE_HASH, SHA, account_evidence, order_evidence, plan, position_evidence, request,
)
from acceptance_journal import AcceptanceJournal, JournalRefused
from provider_acceptance_runner import AcceptanceGuard, AcceptanceRefused, journal_binding, run_acceptance


class ProviderAcceptanceSafetyTests(unittest.TestCase):
    def opened(self, original, clock):
        directory = tempfile.TemporaryDirectory(prefix="provider-preflight-")
        self.addCleanup(directory.cleanup)
        journal = AcceptanceJournal(Path(directory.name) / "run.sqlite", journal_binding(original), clock=lambda: clock[0])
        self.addCleanup(journal.close)
        return AcceptanceGuard(original, SHA, PROFILE_HASH, journal=journal)

    def test_cli_is_offline_by_default_and_execute_fails(self):
        script = Path(__file__).with_name("provider_acceptance_runner.py")
        for arguments, expected_status in [([], 0), (["--execute"], 1)]:
            result = subprocess.run(
                [sys.executable, "-B", str(script), *arguments], check=False,
                text=True, capture_output=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.assertEqual(result.returncode, expected_status)
            if expected_status == 0:
                self.assertEqual(json.loads(result.stdout)["status"], "DRY_RUN")
            else:
                self.assertIn("Provider acceptance refused", result.stderr)

    def test_default_dry_run_has_no_network_or_secret_access(self):
        with patch("socket.socket", side_effect=AssertionError("network access")), patch.dict(
            "os.environ", {"API_KEY": "ambient-must-not-be-read", "PROVIDER_ACCEPTANCE_EXECUTE": "true"}
        ), patch("provider_acceptance_runner.AcceptanceJournal", side_effect=AssertionError("journal access")):
            result = run_acceptance()
        self.assertEqual(result["status"], "DRY_RUN")
        self.assertFalse(result["providerAcceptanceVerified"])
        self.assertEqual(result["networkRequests"], 0)

    def test_execution_refuses_without_authorization_or_implemented_transport(self):
        with self.assertRaisesRegex(AcceptanceRefused, "explicit authorization"):
            run_acceptance(plan(), execute=True, expected_source_sha=SHA, expected_profile_hash=PROFILE_HASH)
        with self.assertRaisesRegex(AcceptanceRefused, "transport is not implemented"):
            run_acceptance(plan(), execute=True, authorization="RUN APPROVED TESTNET ACCEPTANCE",
                           expected_source_sha=SHA, expected_profile_hash=PROFILE_HASH)

    def test_preflight_rejects_missing_limits_mainnet_and_revision_drift(self):
        for exchange in HOSTS:
            for field, value in [
                ("limits", {}), ("host", "https://api.bybit.com"), ("environment", "mainnet"),
                ("sourceSha", "c" * 40), ("profileHash", "c" * 64), ("ccxtVersion", "4.5.76"),
                ("allowedTestnetOrigins", []), ("host", HOSTS[exchange] + ".attacker.invalid"),
            ]:
                invalid = plan(exchange)
                invalid[field] = value
                with self.subTest(exchange=exchange, field=field), self.assertRaises(AcceptanceRefused):
                    AcceptanceGuard(invalid, SHA, PROFILE_HASH)
            for field, value in [("maxNotionalUsd", "NaN"), ("maxOrderCount", True), ("timeBudgetSeconds", 0)]:
                invalid = plan(exchange)
                invalid["limits"][field] = value
                with self.assertRaises(AcceptanceRefused):
                    AcceptanceGuard(invalid, SHA, PROFILE_HASH)

    def test_identity_mode_limits_ownership_and_durable_journal(self):
        for exchange in HOSTS:
            clock = [100.0]
            guard = self.opened(plan(exchange), clock)
            with self.assertRaisesRegex(AcceptanceRefused, "identity and mode"):
                guard.reserve_order("own-1", "2", request())
            for field, value in [("accountReferenceHash", "c" * 64), ("positionMode", "hedge"),
                                 ("marginMode", "isolated"), ("origin", "https://mainnet.invalid")]:
                evidence = account_evidence(guard)
                evidence["original"][field] = value
                with self.assertRaises(AcceptanceRefused):
                    guard.confirm_account(evidence)
            guard.confirm_account(account_evidence(guard))
            guard.reserve_order("own-1", "2", request())
            guard.reserve_order("own-2", "2", request("own-2", side="sell"))
            self.assertEqual(guard.reservations, {"own-1": "2", "own-2": "2"})
            with self.assertRaises(AcceptanceRefused):
                guard.reserve_order("own-3", "1", request("own-3"))
            with self.assertRaises(AcceptanceRefused):
                guard.require_owned("foreign")
            guard.mark_dispatching("own-1")
            guard.record_order("own-1", "remote-1", order_evidence(guard, request()))
            self.assertEqual(guard.require_owned("remote-1"), "own-1")
            with self.assertRaisesRegex(AcceptanceRefused, "cleanup"):
                guard.cleanup_proof({}, "0")
            guard.mark_dispatching("own-2")
            guard.record_order("own-2", "remote-2", order_evidence(guard, request("own-2", side="sell"), "remote-2"))
            proof = guard.cleanup_proof([
                order_evidence(guard, request(), status="canceled"),
                order_evidence(guard, request("own-2", side="sell"), "remote-2", status="canceled"),
            ], position_evidence(guard))
            self.assertEqual(proof["terminalOrderIds"], ["remote-1", "remote-2"])
            clock[0] = 130
            with self.assertRaisesRegex(JournalRefused, "time budget"):
                guard.require_owned("remote-1")

    def test_plan_is_snapshotted_and_journal_failure_grants_nothing(self):
        original = plan()
        guard = self.opened(original, [100])
        original["limits"]["maxOrderCount"] = 999
        self.assertEqual(guard.plan["limits"]["maxOrderCount"], 2)
        guard.confirm_account(account_evidence(guard))
        with patch("acceptance_journal.os.fsync", side_effect=OSError("disk full")):
            with self.assertRaises(JournalRefused):
                guard.reserve_order("unsubmitted", "2", request("unsubmitted"))
        self.assertEqual(guard.reservations, {})
        small = copy.deepcopy(plan())
        small["limits"]["maxNotionalUsd"] = "1"
        guard = self.opened(small, [100])
        guard.confirm_account(account_evidence(guard))
        with self.assertRaisesRegex(AcceptanceRefused, "notional"):
            guard.reserve_order("too-large", "2", request("too-large"))


if __name__ == "__main__":
    unittest.main()
