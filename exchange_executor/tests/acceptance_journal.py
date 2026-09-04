"""Local acceptance-tool storage, not the production trading journal.

SQLite FULL commits plus explicit fsync precede every returned grant. This proves
the tested process-crash boundaries, not arbitrary hardware/power-loss durability.
The persistent owner file is OS-locked and is never unlinked to recover a lock.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import sqlite3
import stat
import time
import uuid
from pathlib import Path


class JournalRefused(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def check(condition, message):
    if not condition:
        raise JournalRefused(message)


def _identity(path, *, owned=False):
    metadata = path.lstat()
    check(not path.is_symlink() and not path.is_junction(), "journal path alias refused")
    if owned and hasattr(os, "getuid"):
        check(metadata.st_uid == os.getuid(), "journal owner differs")
        check(metadata.st_mode & 0o077 == 0, "private journal permissions required")
    return metadata.st_dev, metadata.st_ino


def _open_exact(path):
    exists = path.exists() or path.is_symlink()
    if exists:
        _identity(path, owned=True)
    creation = 0 if exists else os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, os.O_RDWR | creation | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        metadata = os.fstat(descriptor)
        check(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "journal file type refused")
        check(_identity(path, owned=True) == (metadata.st_dev, metadata.st_ino), "journal path changed")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _lock(descriptor):
    if os.name == "nt":
        import msvcrt
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


class AcceptanceJournal:
    """One live owner for one immutable original run; reopening never resends."""

    def __init__(self, path, binding, *, clock=time.time):
        # The runner's closed schema is also enforced for direct storage callers.
        from provider_acceptance_runner import validate_journal_binding
        validate_journal_binding(binding)
        self._binding = copy.deepcopy(binding)
        self._clock = clock
        self._connection = None
        self._descriptors = []
        self._poisoned = False
        self._records = []
        self._last_time = 0.0
        try:
            self._open(Path(path))
            self._read()
            if not self._records:
                now = self.now()
                self.append("created", {"binding": binding, "startedAt": now,
                                        "deadline": now + binding["plan"]["limits"]["timeBudgetSeconds"],
                                        "runId": uuid.uuid4().hex, "locationHash": self._location_hash})
            first = self._records[0]
            check(first["kind"] == "created" and first["body"]["binding"] == binding, "journal binding differs")
            self._deadline = first["body"]["deadline"]
            check(self.deadline == first["body"]["startedAt"] + binding["plan"]["limits"]["timeBudgetSeconds"]
                  and first["at"] >= first["body"]["startedAt"], "journal deadline differs")
            check(first["body"]["locationHash"] == self._location_hash, "journal location differs")
            self._binding_hash = digest({"binding": binding, "runId": first["body"]["runId"]})
            self.now()
        except BaseException as error:
            self.close()
            if isinstance(error, JournalRefused):
                raise
            raise JournalRefused("journal open or ownership refused") from error

    def _open(self, path):
        check(path.is_absolute() and ".." not in path.parts, "absolute journal path required")
        check(path.parent.is_dir(), "existing private journal directory required")
        _identity(path.parent, owned=True)
        self._path = path
        self._location_hash = digest(os.path.normcase(os.path.abspath(path)))
        # Capture every ancestor; detect aliasing/replacement before and after writes.
        self._paths = {parent: _identity(parent) for parent in path.parents}
        owner_path = path.with_name(path.name + ".owner")
        owner = _open_exact(owner_path)
        self._descriptors.append(owner)
        _lock(owner)
        owner_metadata = os.fstat(owner)
        self._paths[owner_path] = (owner_metadata.st_dev, owner_metadata.st_ino)
        descriptor = _open_exact(path)
        self._descriptors.append(descriptor)
        metadata = os.fstat(descriptor)
        self._paths[path] = (metadata.st_dev, metadata.st_ino)
        self._check_paths()
        self._connection = sqlite3.connect(path, timeout=0, isolation_level=None)
        self._connection.execute("PRAGMA trusted_schema=OFF")
        self._connection.execute("PRAGMA journal_mode=DELETE")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute("PRAGMA locking_mode=EXCLUSIVE")
        self._connection.execute("BEGIN EXCLUSIVE")
        self._connection.execute("CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL)")
        self._connection.execute("CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable'); END")
        self._connection.execute("CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable'); END")
        self._connection.execute("COMMIT")
        self._check_paths()

    def _check_paths(self):
        try:
            for path, identity in self._paths.items():
                check(_identity(path) == identity, "journal path changed")
        except (OSError, JournalRefused) as error:
            self._poisoned = True
            raise JournalRefused("journal path ownership changed") from error

    def _read(self):
        previous = "0" * 64
        for index, (sequence, payload, checksum) in enumerate(
            self._connection.execute("SELECT sequence,payload,checksum FROM events ORDER BY sequence"), 1
        ):
            value = json.loads(payload)
            from provider_acceptance_runner import validate_journal_event
            validate_journal_event(value.get("kind"), value.get("body"))
            check(sequence == index and set(value) == {"version", "sequence", "kind", "at", "body", "previous"}
                  and value["version"] == 1 and value["sequence"] == sequence
                  and value["previous"] == previous and checksum == digest(value), "journal integrity refused")
            check(isinstance(value["at"], (int, float)) and math.isfinite(value["at"])
                  and value["at"] >= self._last_time, "journal clock integrity refused")
            self._last_time = value["at"]
            previous = checksum
            self._records.append(value)

    @property
    def records(self):
        self._usable()
        return copy.deepcopy(self._records)

    @property
    def binding(self):
        return copy.deepcopy(self._binding)

    @property
    def deadline(self):
        return self._deadline

    @property
    def binding_hash(self):
        return self._binding_hash

    def _usable(self):
        check(self._connection is not None and not self._poisoned, "journal owner unavailable after durability failure")
        self._check_paths()

    def now(self):
        self._usable()
        now = self._clock()
        check(type(now) in (int, float) and math.isfinite(now) and now >= self._last_time, "journal clock moved backwards")
        self._last_time = now
        return now

    def within_budget(self):
        check(self.now() < self.deadline, "time budget exhausted")

    def append(self, kind, body):
        self._usable()
        from provider_acceptance_runner import validate_journal_event
        body = copy.deepcopy(body)
        validate_journal_event(kind, body)
        value = {"version": 1, "sequence": len(self._records) + 1, "kind": kind,
                 "at": self.now(), "body": copy.deepcopy(body),
                 "previous": digest(self._records[-1]) if self._records else "0" * 64}
        payload = canonical(value)
        check(len(payload) <= 262144, "journal record too large")
        try:
            self._connection.execute("BEGIN EXCLUSIVE")
            self._connection.execute("INSERT INTO events VALUES(?,?,?)", (value["sequence"], payload, digest(value)))
            self._connection.execute("COMMIT")
            os.fsync(self._descriptors[-1])
            self._check_paths()
        except BaseException as error:
            self._poisoned = True
            raise JournalRefused("journal durability failed; outcome must be replayed") from error
        self._records.append(value)

    def close(self):
        if self._connection is not None:
            self._connection.close()
            self._connection = None
        for descriptor in reversed(self._descriptors):
            os.close(descriptor)
        self._descriptors.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
