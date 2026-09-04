from __future__ import annotations

import copy
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_fixtures import (
    PROFILE_HASH, SHA, account_evidence, order_evidence, plan, position_evidence, request,
)
from acceptance_journal import AcceptanceJournal, JournalRefused
from provider_acceptance_runner import AcceptanceGuard, AcceptanceRefused, journal_binding


class AcceptanceJournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="acceptance-journal-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "run.sqlite"
        self.now = 100.0

    def opened(self, proposed=None, origins=None):
        original = proposed or plan()
        journal = AcceptanceJournal(self.path, journal_binding(original, origins), clock=lambda: self.now)
        self.addCleanup(journal.close)
        guard = AcceptanceGuard(original, SHA, PROFILE_HASH, journal=journal, profile_origins=origins)
        return journal, guard

    def verified(self):
        journal, guard = self.opened()
        guard.confirm_account(account_evidence(guard, self.now))
        return journal, guard

    def test_full_original_replay_and_absolute_deadline(self):
        journal, guard = self.verified()
        original = request()
        guard.reserve_order("own-1", "2", original)
        original["priceBoundary"]["maximum"] = "999"
        self.assertEqual(guard.mark_dispatching("own-1")["priceBoundary"]["maximum"], "2")
        guard.record_order("own-1", "remote-1", order_evidence(guard, request()))
        records = journal.records
        journal.close()
        self.now = 120
        reopened, replay = self.opened()
        self.assertEqual(reopened.records, records)
        self.assertEqual(replay.require_owned("remote-1"), "own-1")
        self.assertEqual(replay.reservations, {"own-1": "2"})
        self.assertEqual(reopened.deadline, 130)
        self.now = 130
        with self.assertRaisesRegex((AcceptanceRefused, JournalRefused), "time budget"):
            replay.mark_dispatching("own-1")
        reopened.close()
        self.now = 99
        with self.assertRaisesRegex(JournalRefused, "clock"):
            self.opened()

    def test_plan_account_version_and_registry_cannot_be_rebound(self):
        journal, _ = self.opened()
        journal.close()
        variants = [("accountReferenceHash", "c" * 64), ("sourceSha", "c" * 40),
                    ("profileHash", "c" * 64), ("ccxtVersion", "4.5.76")]
        for field, value in variants:
            changed = plan()
            changed[field] = value
            with self.subTest(field=field), self.assertRaises((JournalRefused, AcceptanceRefused)):
                self.opened(changed)
        with self.assertRaises(JournalRefused):
            self.opened(origins={"bybit": plan()["host"]})

    def test_dispatch_unknown_no_replay_and_conflicts_survive_exception(self):
        journal, guard = self.verified()
        guard.reserve_order("own-1", "2", request())
        guard.reserve_order("own-1", "2", request())
        self.assertEqual(len(guard.reservations), 1)
        guard.mark_dispatching("own-1")
        journal.close()
        journal, guard = self.opened()
        guard.confirm_account(account_evidence(guard))
        self.assertEqual(guard.unresolved, ["own-1"])
        with self.assertRaises(AcceptanceRefused):
            guard.mark_dispatching("own-1")
        with self.assertRaises(AcceptanceRefused):
            guard.reserve_order("own-1", "2", request(price="1"))
        journal.close()
        journal, guard = self.opened()
        self.assertIn("conflict", [row["kind"] for row in journal.records])
        with self.assertRaises(AcceptanceRefused):
            guard.record_order("own-1", "remote-1", order_evidence(guard, request()))

    def test_real_fsync_failure_prevents_grant_and_poisons_owner(self):
        journal, guard = self.verified()
        guard.reserve_order("own-1", "2", request())
        descriptors = []

        def disk_error(fd):
            descriptors.append(os.fstat(fd).st_size)
            raise OSError("secret-must-never-appear")

        with patch("acceptance_journal.os.fsync", side_effect=disk_error):
            with self.assertRaisesRegex(JournalRefused, "durability") as error:
                guard.mark_dispatching("own-1")
        self.assertNotIn("secret-must-never-appear", str(error.exception))
        self.assertTrue(descriptors and min(descriptors) > 0)
        with self.assertRaises(JournalRefused):
            guard.mark_dispatching("own-1")
        journal.close()
        _, guard = self.opened()
        self.assertEqual(guard.unresolved, ["own-1"])
        with self.assertRaises(AcceptanceRefused):
            guard.mark_dispatching("own-1")

    def test_exclusive_owner_and_tampered_chain_fail_closed(self):
        journal, _ = self.opened()
        with self.assertRaises(JournalRefused):
            self.opened()
        journal.close()
        connection = sqlite3.connect(self.path)
        try:
            connection.execute("DROP TRIGGER immutable_update")
            connection.execute("UPDATE events SET checksum = ? WHERE sequence = 1", ("0" * 64,))
            connection.commit()
        finally:
            connection.close()
        with self.assertRaisesRegex(JournalRefused, "integrity"):
            self.opened()

    def test_unknown_secret_fields_are_rejected_and_never_stored(self):
        journal, guard = self.verified()
        secret_request = request()
        secret_request["apiKey"] = "ambient-secret-fixture"
        with self.assertRaises(AcceptanceRefused):
            guard.reserve_order("own-1", "2", secret_request)
        self.assertNotIn(b"ambient-secret-fixture", self.path.read_bytes())
        self.assertEqual(guard.reservations, {})
        self.assertIn("invalid", [row["kind"] for row in journal.records])

    def test_expired_or_stale_final_fsync_cannot_return_a_send_permit(self):
        journal, guard = self.verified()
        guard.reserve_order("own-1", "2", request())
        original_sync = os.fsync

        def delayed_sync(fd):
            original_sync(fd)
            self.now = 130

        with patch("acceptance_journal.os.fsync", side_effect=delayed_sync):
            with self.assertRaisesRegex(JournalRefused, "time budget"):
                guard.mark_dispatching("own-1")
        journal.close()
        _, replay = self.opened()
        self.assertEqual(replay.unresolved, ["own-1"])

    def test_ack_conflict_and_fsync_failure_survive_restart(self):
        journal, guard = self.verified()
        guard.reserve_order("own-1", "2", request())
        guard.mark_dispatching("own-1")
        with patch("acceptance_journal.os.fsync", side_effect=OSError("private-error")):
            with self.assertRaises(JournalRefused):
                guard.record_order("own-1", "remote-1", order_evidence(guard, request()))
        journal.close()
        journal, guard = self.opened()
        # COMMIT happened before the injected fsync failure. Its exact ACK is replayed,
        # never interpreted as permission to repeat the economic write.
        self.assertEqual(guard.require_owned("remote-1"), "own-1")
        guard.record_order("own-1", "remote-1", order_evidence(guard, request()))
        with self.assertRaises(AcceptanceRefused):
            guard.record_order("own-1", "remote-other", order_evidence(guard, request(), "remote-other"))
        journal.close()
        _, guard = self.opened()
        with self.assertRaisesRegex(AcceptanceRefused, "conflicting"):
            guard.require_owned("remote-1")

    def test_original_request_contract_and_ack_binding_failures_are_durable(self):
        journal, guard = self.verified()
        for mutation in [
            {"price": "3"}, {"quantity": "NaN"}, {"postOnly": True}, {"leverage": 51},
            {"source": "authenticated"}, {"type": "market"},
        ]:
            invalid = request()
            invalid.update(mutation)
            with self.assertRaises(AcceptanceRefused):
                guard.reserve_order("own-1", "2", invalid)
        self.assertEqual(guard.reservations, {})
        guard.reserve_order("own-1", "2", request())
        guard.mark_dispatching("own-1")
        invalid = order_evidence(guard, request())
        invalid["original"]["accountReferenceHash"] = "c" * 64
        with self.assertRaises(AcceptanceRefused):
            guard.record_order("own-1", "remote-1", invalid)
        journal.close()
        journal, guard = self.opened()
        self.assertEqual(guard.unresolved, ["own-1"])
        self.assertEqual(sum(row["kind"] == "invalid" for row in journal.records), 7)

    def test_caller_notional_cannot_understate_the_bound_request(self):
        _, guard = self.verified()
        with self.assertRaisesRegex(AcceptanceRefused, "notional"):
            guard.reserve_order("own-1", "1", request())
        self.assertEqual(guard.reservations, {})

    def test_real_advancing_wall_clock_keeps_original_started_deadline(self):
        def advancing():
            self.now += 0.001
            return self.now

        with AcceptanceJournal(self.path, journal_binding(plan()), clock=advancing) as journal:
            self.assertLess(journal.deadline, self.now + 30)
            self.assertEqual(journal.deadline, journal.records[0]["body"]["startedAt"] + 30)

    def test_public_bindings_deadline_and_original_copies_cannot_be_rewritten(self):
        journal, guard = self.verified()
        for target, name, value in [(journal, "deadline", 999), (journal, "binding_hash", "c" * 64),
                                    (guard, "binding_hash", "c" * 64)]:
            with self.assertRaises(AttributeError):
                setattr(target, name, value)
        snapshot = journal.records
        snapshot[0]["body"]["binding"]["plan"]["limits"]["maxOrderCount"] = 999
        self.assertEqual(journal.records[0]["body"]["binding"]["plan"], plan())

    def test_evidence_from_a_different_journal_with_identical_plan_is_not_owned(self):
        first, first_guard = self.verified()
        prior = order_evidence(first_guard, request())
        other_path = self.path.with_name("different-run.sqlite")
        with AcceptanceJournal(other_path, journal_binding(plan()), clock=lambda: 100) as other:
            guard = AcceptanceGuard(plan(), SHA, PROFILE_HASH, journal=other)
            guard.confirm_account(account_evidence(guard))
            guard.reserve_order("own-1", "2", request())
            guard.mark_dispatching("own-1")
            with self.assertRaises(AcceptanceRefused):
                guard.record_order("own-1", "remote-1", prior)
            self.assertEqual(guard.unresolved, ["own-1"])
        first.close()

    def test_actual_sqlite_write_error_returns_no_reservation(self):
        journal, guard = self.verified()
        self.assertEqual(journal._connection.execute("PRAGMA synchronous").fetchone()[0], 2)
        journal._connection.execute("PRAGMA query_only=ON")
        with self.assertRaises(JournalRefused):
            guard.reserve_order("own-1", "2", request())
        self.assertEqual(guard.reservations, {})
        journal.close()
        _, guard = self.opened()
        self.assertEqual(guard.reservations, {})
        self.assertEqual(guard.unresolved, [])

    def test_resume_requires_new_account_observation_and_notional_is_not_released(self):
        journal, guard = self.verified()
        guard.reserve_order("own-1", "2", request())
        journal.close()
        _, guard = self.opened()
        with self.assertRaisesRegex(AcceptanceRefused, "freshly verified"):
            guard.mark_dispatching("own-1")
        self.now = 111
        with self.assertRaises(AcceptanceRefused):
            guard.confirm_account(account_evidence(guard))
        guard.confirm_account(account_evidence(guard, 111))
        guard.mark_dispatching("own-1")
        guard.record_order("own-1", "remote-1", order_evidence(guard, request(), now=111, status="canceled"))
        guard.reserve_order("own-2", "2", request("own-2"))
        with self.assertRaises(AcceptanceRefused):
            guard.reserve_order("own-3", "2", request("own-3"))

    def test_partial_fills_need_complete_originals_and_later_zero_position_read(self):
        _, guard = self.verified()
        terminal = []
        for index, side in [(1, "buy"), (2, "sell")]:
            original = request(f"own-{index}", side=side)
            guard.reserve_order(original["clientOrderId"], "2", original)
            guard.mark_dispatching(original["clientOrderId"])
            guard.record_order(original["clientOrderId"], f"remote-{index}", order_evidence(guard, original, f"remote-{index}"))
            evidence = order_evidence(guard, original, f"remote-{index}", now=101, status="canceled")
            evidence["original"].update(filledQuantity="0.25", remainingQuantity="0.75",
                                        fills=[{"fillId": f"fill-{index}", "quantity": "0.25"}])
            terminal.append(evidence)
        self.now = 101
        with self.assertRaises(AcceptanceRefused):
            guard.cleanup_proof(terminal, position_evidence(guard, 100))
        self.assertEqual(guard.cleanup_proof(terminal, position_evidence(guard, 101))["residualExposure"], "0")

    def test_explicit_reviewed_extra_profile_and_not_a_new_three_profile_gate(self):
        custom = plan()
        custom.update(exchange="future_profile", host="https://future-testnet.invalid",
                      allowedTestnetOrigins=["https://future-testnet.invalid"])
        _, guard = self.opened(custom, {"future_profile": custom["host"]})
        guard.confirm_account(account_evidence(guard))
        guard.reserve_order("own-1", "2", request())
        self.assertEqual(guard.plan["exchange"], "future_profile")

    def test_real_hardlink_and_directory_aliases_are_refused(self):
        journal, _ = self.opened()
        journal.close()
        alias = self.path.with_name("hardlinked.sqlite")
        os.link(self.path, alias)
        with self.assertRaises(JournalRefused):
            self.opened()
        # The alias is solely this fixture's extra link; no journal data is deleted.
        alias.unlink()
        alias_directory = self.path.parent / "directory-alias"
        target_directory = self.path.parent / "actual-directory"
        target_directory.mkdir()
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(alias_directory), str(target_directory)],
                           check=True, capture_output=True, timeout=10,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            alias_directory.symlink_to(target_directory, target_is_directory=True)
        with self.assertRaises(JournalRefused):
            AcceptanceJournal(alias_directory / "alias.sqlite", journal_binding(plan()), clock=lambda: 100)
        self.assertFalse((target_directory / "alias.sqlite").exists())

    def test_live_owner_file_cannot_be_replaced_to_steal_a_permit(self):
        journal, guard = self.verified()
        owner = self.path.with_name(self.path.name + ".owner")
        moved = owner.with_name("replaced.owner")
        try:
            owner.rename(moved)
        except PermissionError:
            # Windows denies replacement while the actual OS handle is held.
            self.assertTrue(owner.exists())
        else:
            with self.assertRaises((JournalRefused, OSError)):
                guard.reserve_order("own-1", "2", request())
        journal.close()

    def test_no_plain_status_or_absence_cleanup_and_no_foreign_ownership(self):
        journal, guard = self.verified()
        requests = [request(), request("own-2", side="sell")]
        for index, original in enumerate(requests, 1):
            client, remote = original["clientOrderId"], f"remote-{index}"
            guard.reserve_order(client, "2", original)
            guard.mark_dispatching(client)
            guard.record_order(client, remote, order_evidence(guard, original, remote))
        with self.assertRaises(AcceptanceRefused):
            guard.require_owned("foreign")
        for orders, positions in [({}, "0"), ({"complete": True}, {"complete": True}),
                                  ([], position_evidence(guard))]:
            with self.assertRaises(AcceptanceRefused):
                guard.cleanup_proof(orders, positions)
        terminal = [order_evidence(guard, original, f"remote-{index}", status="filled", filled="1")
                    for index, original in enumerate(requests, 1)]
        missing_fills = copy.deepcopy(terminal)
        missing_fills[0]["original"]["fills"] = []
        with self.assertRaises(AcceptanceRefused):
            guard.cleanup_proof(missing_fills, position_evidence(guard))
        proof = guard.cleanup_proof(terminal, position_evidence(guard))
        self.assertFalse(proof["providerAcceptanceVerified"])
        self.assertEqual(proof["terminalOrderIds"], ["remote-1", "remote-2"])
        self.assertEqual(journal.records[-1]["kind"], "cleanup")


if __name__ == "__main__":
    unittest.main()
