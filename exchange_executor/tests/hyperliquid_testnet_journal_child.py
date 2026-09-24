"""Hard-kill fixture: never imports a provider or performs a network request."""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

from hyperliquid_testnet_journal import HyperliquidTestnetJournal
from test_hyperliquid_testnet_journal import binding, request, slots


def checkpoint(directory):
    descriptor = os.open(directory / "ready", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, b"ready")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    threading.Event().wait()


if __name__ == "__main__":
    target, phase = Path(sys.argv[1]), sys.argv[2]
    with HyperliquidTestnetJournal(target / "run.sqlite", binding(), clock=lambda: 100) as journal:
        journal.reserve_slots(slots())
        if phase == "reserved":
            checkpoint(target)
        journal.begin_protected_batch(request("entry"), request("stop"))
        if phase == "dispatching":
            checkpoint(target)
