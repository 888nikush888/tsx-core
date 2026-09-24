"""Offline safety and restart tests; no provider credentials, network or orders."""
from __future__ import annotations

import subprocess
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hyperliquid_testnet_journal import (HyperliquidTestnetJournal, TestnetJournalRefused,
                                          digest, validate_binding)


def binding():
    return {
        "version": 2, "transport": "hyperliquid-testnet-real-v1", "runId": "1" * 32,
        "sourceSha": "a" * 40, "profileHash": "b" * 64, "ccxtVersion": "4.5.75",
        "sdkReceiptHash": "c" * 64, "accountReferenceHash": "d" * 64,
        "approvalDigest": "e" * 64, "exchange": "hyperliquid", "environment": "testnet",
        "origin": "https://api.hyperliquid-testnet.xyz", "walletKind": "master",
        "market": {"symbol": "BTC/USDC:USDC", "providerSymbol": "BTC", "type": "swap",
                   "settlement": "USDC", "linear": True, "marginMode": "cross", "positionMode": "oneway"},
        "entry": {"side": "buy", "quantity": "0.001", "maxPriceUsd": "20000"},
        "limits": {"maxNotionalUsd": "22", "maxOrderCount": 3, "timeBudgetSeconds": 30},
    }


def slots():
    return [{"role": role, "clientOrderId": "run-1-" + role} for role in
            ("entry", "stop", "emergency-close")]


def request(role, *, quantity="0.001"):
    return {"clientOrderId": "run-1-" + role, "providerSymbol": "BTC",
            "side": "buy" if role == "entry" else "sell", "quantity": quantity,
            "limitPriceUsd": None if role == "stop" else "20000" if role == "entry" else "19000",
            "triggerPriceUsd": "19000" if role == "stop" else None,
            "timeInForce": "GTC" if role == "stop" else "IOC", "reduceOnly": role != "entry"}


def original(role, *, status="open", filled="0", observed_at=100, provider_id=None):
    return {"bindingHash": digest(binding()), "accountReferenceHash": "d" * 64,
            "origin": "https://api.hyperliquid-testnet.xyz",
            "providerSymbol": "BTC", "clientOrderId": "run-1-" + role,
            "requestHash": digest(request(role)), "providerOrderId": provider_id or "remote-" + role,
            "status": status, "quantity": "0.001", "filledQuantity": filled,
            "originalDigest": "f" * 64, "observedAt": observed_at}


def position(*, quantity="0.001", observed_at=102):
    return {"bindingHash": digest(binding()), "accountReferenceHash": "d" * 64,
            "origin": "https://api.hyperliquid-testnet.xyz",
            "providerSymbol": "BTC", "side": "buy",
            "quantity": quantity, "originalDigest": "f" * 64, "observedAt": observed_at}


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hl-journal-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "run.sqlite"

    def opened(self, plan=None, now=100):
        journal = HyperliquidTestnetJournal(self.path, plan or binding(), clock=lambda: now)
        self.addCleanup(journal.close)
        return journal

    def test_incompatible_binding_and_entry_ceiling(self):
        for key, value in (("transport", "local-fake-only"), ("origin", "https://api.hyperliquid.xyz"),
                           ("walletKind", "agent"), ("ccxtVersion", "4.5.76")):
            with self.subTest(key=key):
                plan = binding()
                plan[key] = value
                with self.assertRaises(TestnetJournalRefused):
                    validate_binding(plan)
        plan = binding()
        plan["entry"]["quantity"] = "0.002"
        with self.assertRaises(TestnetJournalRefused):
            validate_binding(plan)
        plan = binding()
        plan["limits"]["maxOrderCount"] = 2
        with self.assertRaises(TestnetJournalRefused):
            validate_binding(plan)

    def test_three_slots_are_atomic_and_unknown_survives_reopen(self):
        journal = self.opened()
        with self.assertRaises(TestnetJournalRefused):
            journal.reserve_slots(slots()[:2])
        self.assertEqual(journal.states, {role: "unreserved" for role in
                                          ("entry", "stop", "emergency-close")})
        journal.reserve_slots(slots())
        journal.begin_protected_batch(request("entry"), request("stop"))
        self.assertEqual(journal.states["entry"], "UNKNOWN")
        self.assertEqual(journal.states["stop"], "UNKNOWN")
        journal.close()
        replay = self.opened()
        self.assertEqual(replay.states["entry"], "UNKNOWN")
        self.assertEqual(replay.states["stop"], "UNKNOWN")
        with self.assertRaises(TestnetJournalRefused):
            replay.begin_protected_batch(request("entry"), request("stop"))
        with self.assertRaises(TestnetJournalRefused):
            replay.reserve_slots(slots())

    def test_failure_before_durable_dispatch_never_grants_outbound(self):
        journal = self.opened()
        journal.reserve_slots(slots())
        with patch("hyperliquid_testnet_journal.os.fsync", side_effect=OSError("SECRET-CAUSE")):
            with self.assertRaisesRegex(TestnetJournalRefused, "durability failed") as caught:
                journal.begin_protected_batch(request("entry"), request("stop"))
        self.assertNotIn("SECRET-CAUSE", str(caught.exception))
        with self.assertRaises(TestnetJournalRefused):
            journal.begin_protected_batch(request("entry"), request("stop"))
        journal.close()
        replay = self.opened()
        # COMMIT may precede failed fsync. Conservative replay must keep UNKNOWN.
        self.assertEqual(replay.states["entry"], "UNKNOWN")

    def test_no_exit_without_owned_fill_and_no_emergency_without_full_proof(self):
        journal = self.opened(now=105)
        journal.reserve_slots(slots())
        with self.assertRaises(TestnetJournalRefused):
            journal.begin_protected_batch(request("entry"), request("stop", quantity="0.002"))
        journal.begin_protected_batch(request("entry"), request("stop"))
        journal.record_order_observation("entry", original("entry", status="filled", filled="0.001"))
        with self.assertRaises(TestnetJournalRefused):
            journal.begin_emergency_close(request("emergency-close"))
        journal.record_order_observation("stop", original("stop", observed_at=101))
        with self.assertRaises(TestnetJournalRefused):
            journal.begin_emergency_close(request("emergency-close"))
        journal.record_position_observation(position(quantity="0"))
        with self.assertRaises(TestnetJournalRefused):
            journal.begin_emergency_close(request("emergency-close"))
        journal.record_position_observation(position())
        journal.begin_emergency_close(request("emergency-close"))
        self.assertEqual(journal.states["emergency-close"], "UNKNOWN")
        with self.assertRaises(TestnetJournalRefused):
            journal.begin_emergency_close(request("emergency-close"))

    def test_invalid_observations_do_not_poison_clean_history(self):
        journal = self.opened()
        journal.reserve_slots(slots())
        journal.begin_protected_batch(request("entry"), request("stop"))
        for field, wrong in (("bindingHash", "0" * 64), ("accountReferenceHash", "0" * 64),
                             ("origin", "https://api.hyperliquid.xyz"),
                             ("requestHash", "0" * 64), ("filledQuantity", "0.002")):
            with self.subTest(field=field):
                evidence = original("entry")
                evidence[field] = wrong
                with self.assertRaises(TestnetJournalRefused):
                    journal.record_order_observation("entry", evidence)
                self.assertEqual(journal.states["entry"], "UNKNOWN")
        journal.record_order_observation("entry", original("entry", filled="0.001"))
        with self.assertRaises(TestnetJournalRefused):
            journal.record_order_observation("entry", original("entry", provider_id="other"))
        with self.assertRaises(TestnetJournalRefused):
            journal.record_order_observation("entry", original("entry", filled="0"))
        journal.close()
        self.assertEqual(self.opened().states["entry"], "observed")

    def test_binding_path_and_deadline_cannot_be_replayed_differently(self):
        journal = self.opened()
        journal.reserve_slots(slots())
        journal.close()
        plan = binding()
        plan["sdkReceiptHash"] = "0" * 64
        with self.assertRaises(TestnetJournalRefused):
            self.opened(plan)
        # Expired journals remain readable for reconciliation, but cannot start sends.
        expired = self.opened(now=131)
        with self.assertRaises(TestnetJournalRefused):
            expired.begin_protected_batch(request("entry"), request("stop"))
        expired.close()
        with self.assertRaises(TestnetJournalRefused):
            self.opened().begin_protected_batch(request("entry", quantity="0.002"), request("stop"))

    def test_provider_identity_cannot_be_reused_across_roles(self):
        journal = self.opened()
        journal.reserve_slots(slots())
        journal.begin_protected_batch(request("entry"), request("stop"))
        journal.record_order_observation("entry", original("entry", filled="0.001"))
        with self.assertRaises(TestnetJournalRefused):
            journal.record_order_observation("stop", original("stop", provider_id="remote-entry"))

    def test_partial_batch_ack_leaves_other_leg_unknown_after_restart(self):
        journal = self.opened()
        journal.reserve_slots(slots())
        journal.begin_protected_batch(request("entry"), request("stop"))
        journal.record_order_observation("entry", original("entry", status="filled", filled="0.001"))
        journal.close()
        replay = self.opened()
        self.assertEqual(replay.states["entry"], "observed")
        self.assertEqual(replay.states["stop"], "UNKNOWN")
        with self.assertRaises(TestnetJournalRefused):
            replay.begin_protected_batch(request("entry"), request("stop"))
        replay.record_position_observation(position(observed_at=100))
        with self.assertRaises(TestnetJournalRefused):
            replay.begin_emergency_close(request("emergency-close"))

    def test_corrupted_event_chain_refuses_replay(self):
        journal = self.opened()
        journal.reserve_slots(slots())
        journal.close()
        connection = sqlite3.connect(self.path)
        connection.execute("DROP TRIGGER immutable_update")
        connection.execute("UPDATE events SET checksum = ? WHERE sequence = 2", ("0" * 64,))
        connection.commit()
        connection.close()
        with self.assertRaises(TestnetJournalRefused):
            self.opened()


class HardKillTests(unittest.TestCase):
    def test_kill_at_checkpoints_never_replays_a_dispatch(self):
        child = Path(__file__).with_name("hyperliquid_testnet_journal_child.py")
        for phase, expected in (("reserved", "reserved"), ("dispatching", "UNKNOWN")):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="hl-kill-") as location:
                directory = Path(location)
                process = subprocess.Popen([sys.executable, "-B", str(child), str(directory), phase],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                try:
                    deadline = time.monotonic() + 10
                    while not (directory / "ready").exists():
                        self.assertIsNone(process.poll(), "child exited before checkpoint")
                        self.assertLess(time.monotonic(), deadline, "child checkpoint timeout")
                        time.sleep(0.01)
                finally:
                    process.kill()
                    process.communicate(timeout=10)
                with HyperliquidTestnetJournal(directory / "run.sqlite", binding(), clock=lambda: 100) as replay:
                    self.assertEqual(replay.states["entry"], expected)
                    if expected == "UNKNOWN":
                        with self.assertRaises(TestnetJournalRefused):
                            replay.begin_protected_batch(request("entry"), request("stop"))


if __name__ == "__main__":
    unittest.main()
