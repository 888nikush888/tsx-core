from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_fixtures import PROFILE_HASH, SHA, plan
from acceptance_journal import AcceptanceJournal
from provider_acceptance_runner import AcceptanceGuard, journal_binding


CHILD = Path(__file__).with_name("acceptance_journal_child.py")


def arguments(directory, phase):
    return [sys.executable, "-B", str(CHILD), str(directory), phase]


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class AcceptanceHardCrashTests(unittest.TestCase):
    def crash_at(self, directory, phase):
        process = subprocess.Popen(arguments(directory, phase), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            deadline = time.monotonic() + 10
            while not (directory / "ready.jsonl").exists():
                self.assertIsNone(process.poll(), "child exited before the durable checkpoint")
                self.assertLess(time.monotonic(), deadline, "child checkpoint timeout")
                time.sleep(0.01)
            second_owner = subprocess.run(arguments(directory, "replay"), capture_output=True, text=True,
                                          timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertNotEqual(second_owner.returncode, 0)
            self.assertIn("journal refused", second_owner.stderr)
        finally:
            process.kill()
            process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)

    def test_actual_kills_replay_original_phase_and_never_repeat_unknown_send(self):
        phases = {"opened": (0, 0), "before_reserve": (0, 0), "reserved": (0, 0),
                  "dispatching": (0, 0), "before_accept": (1, 0), "accepted": (1, 1), "acknowledged": (1, 1)}
        for phase, (attempts, accepted) in phases.items():
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="acceptance-hardkill-") as location:
                directory = Path(location)
                self.crash_at(directory, phase)
                before = rows(directory / "writes.jsonl")
                self.assertEqual(sum(row["event"] == "attempt" for row in before), attempts)
                self.assertEqual(sum(row["event"] == "accepted" for row in before), accepted)
                resumed = subprocess.run(arguments(directory, "replay"), capture_output=True, text=True,
                                         timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self.assertEqual(resumed.returncode, 0, resumed.stderr)
                self.assertEqual(json.loads(resumed.stdout)["deadline"], 130)
                after = rows(directory / "writes.jsonl")
                expected = 1 if phase in {"opened", "before_reserve", "reserved"} else attempts
                self.assertEqual(sum(row["event"] == "attempt" for row in after), expected)
                with AcceptanceJournal(directory / "run.sqlite", journal_binding(plan()), clock=lambda: 129) as journal:
                    guard = AcceptanceGuard(plan(), SHA, PROFILE_HASH, journal=journal)
                    self.assertEqual(journal.deadline, 130)
                    unknown = phase in {"dispatching", "before_accept", "accepted"}
                    self.assertEqual(guard.unresolved, ["own-1"] if unknown else [])
                    self.assertEqual(journal.binding["plan"], plan())

    def test_child_fsync_error_never_sends_or_exposes_its_original_secret_cause(self):
        with tempfile.TemporaryDirectory(prefix="acceptance-fsync-child-") as location:
            directory = Path(location)
            failed = subprocess.run(arguments(directory, "fsync_error"), capture_output=True, text=True,
                                    timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertNotEqual(failed.returncode, 0)
            self.assertNotIn("NEVER-PRINT-THIS-SECRET", failed.stdout + failed.stderr)
            self.assertEqual(rows(directory / "writes.jsonl"), [])
            self.assertNotIn(b"NEVER-PRINT-THIS-SECRET", (directory / "run.sqlite").read_bytes())
            resumed = subprocess.run(arguments(directory, "replay"), capture_output=True, text=True,
                                     timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertEqual(json.loads(resumed.stdout)["unresolved"], ["own-1"])
            self.assertEqual(rows(directory / "writes.jsonl"), [])


if __name__ == "__main__":
    unittest.main()
