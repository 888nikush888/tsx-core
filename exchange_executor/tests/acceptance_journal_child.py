"""Local crash fixture: each economic attempt is an fsynced file append, not HTTP."""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_fixtures import PROFILE_HASH, SHA, account_evidence, order_evidence, plan, request
from acceptance_journal import AcceptanceJournal, JournalRefused
from provider_acceptance_runner import AcceptanceGuard, AcceptanceRefused, journal_binding


def durable_line(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, (json.dumps(value) + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def run(directory, phase):
    def checkpoint(current):
        if current == phase:
            durable_line(directory / "ready.jsonl", {"phase": current})
            threading.Event().wait()

    with AcceptanceJournal(directory / "run.sqlite", journal_binding(plan()), clock=lambda: 100) as journal:
        guard = AcceptanceGuard(plan(), SHA, PROFILE_HASH, journal=journal)
        checkpoint("opened")
        guard.confirm_account(account_evidence(guard))
        if "own-1" not in guard.reservations:
            checkpoint("before_reserve")
            guard.reserve_order("own-1", "2", request())
        checkpoint("reserved")
        if guard.unresolved or any(row["kind"] == "acknowledged" for row in journal.records):
            try:
                guard.mark_dispatching("own-1")
            except AcceptanceRefused:
                pass
            else:
                raise AssertionError("send replay allowed")
            print(json.dumps({"unresolved": guard.unresolved, "deadline": journal.deadline}))
            return
        if phase == "fsync_error":
            with patch("acceptance_journal.os.fsync", side_effect=OSError("NEVER-PRINT-THIS-SECRET")):
                guard.mark_dispatching("own-1")
            raise AssertionError("fsync failure returned a send permit")
        outbound = guard.mark_dispatching("own-1")
        checkpoint("dispatching")
        durable_line(directory / "writes.jsonl", {"event": "attempt", "request": outbound})
        checkpoint("before_accept")
        durable_line(directory / "writes.jsonl", {"event": "accepted", "orderId": "remote-1"})
        checkpoint("accepted")
        guard.record_order("own-1", "remote-1", order_evidence(guard, outbound))
        checkpoint("acknowledged")
        print(json.dumps({"owned": guard.require_owned("remote-1"), "deadline": journal.deadline}))


if __name__ == "__main__":
    try:
        run(Path(sys.argv[1]), sys.argv[2])
    except (AcceptanceRefused, JournalRefused):
        sys.exit("Local acceptance journal refused; no provider was accessed.")
