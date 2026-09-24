"""Offline-only, durable intent ledger for a future Hyperliquid testnet transport.

This module has no exchange client, socket, credential loader or send callback. A
recorded observation is a caller assertion, NOT provider acceptance evidence.
The future transport must independently verify and preserve redacted originals.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import sqlite3
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

from acceptance_journal import _identity, _lock, _open_exact


ORIGIN = "https://api.hyperliquid-testnet.xyz"
ROLES = ("entry", "stop", "emergency-close")
TERMINAL = frozenset({"filled", "canceled", "rejected", "expired"})


class TestnetJournalRefused(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise TestnetJournalRefused(message)


def _fields(value, names):
    require(type(value) is dict and set(value) == set(names.split()), "closed nonsecret schema required")


def _hex(value, length):
    require(type(value) is str and re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", value) is not None,
            "invalid digest or identity")


def _id(value):
    require(type(value) is str and re.fullmatch(r"[A-Za-z0-9_./:-]{1,160}", value) is not None,
            "invalid nonsecret identity")


def _number(value, *, positive=True):
    require(type(value) is str and re.fullmatch(r"\d+(?:\.\d+)?", value) is not None
            and len(value) <= 64, "invalid decimal")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise TestnetJournalRefused("invalid decimal") from error
    require(result.is_finite() and (result > 0 if positive else result >= 0), "invalid quantity")
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate_binding(binding):
    _fields(binding, "version transport runId sourceSha profileHash ccxtVersion sdkReceiptHash "
            "accountReferenceHash approvalDigest exchange environment origin walletKind market entry limits")
    require(binding["version"] == 2 and binding["transport"] == "hyperliquid-testnet-real-v1"
            and binding["exchange"] == "hyperliquid" and binding["environment"] == "testnet"
            and binding["origin"] == ORIGIN and binding["walletKind"] == "master"
            and binding["ccxtVersion"] == "4.5.75", "unsupported real-testnet binding")
    _hex(binding["runId"], 32)
    _hex(binding["sourceSha"], 40)
    for key in ("profileHash", "sdkReceiptHash", "accountReferenceHash", "approvalDigest"):
        _hex(binding[key], 64)
    _fields(binding["market"], "symbol providerSymbol type settlement linear marginMode positionMode")
    market = binding["market"]
    _id(market["symbol"])
    _id(market["providerSymbol"])
    require(market["type"] == "swap" and market["settlement"] == "USDC"
            and market["linear"] is True and market["marginMode"] == "cross"
            and market["positionMode"] == "oneway" and market["symbol"].endswith("/USDC:USDC"),
            "unsupported perpetual market scope")
    _fields(binding["entry"], "side quantity maxPriceUsd")
    entry = binding["entry"]
    require(entry["side"] in ("buy", "sell"), "unsupported entry side")
    quantity = _number(entry["quantity"])
    price = _number(entry["maxPriceUsd"])
    _fields(binding["limits"], "maxNotionalUsd maxOrderCount timeBudgetSeconds")
    limits = binding["limits"]
    operator_cap = _number(limits["maxNotionalUsd"])
    require(type(limits["maxOrderCount"]) is int and limits["maxOrderCount"] == 3
            and type(limits["timeBudgetSeconds"]) is int and 0 < limits["timeBudgetSeconds"] <= 3600,
            "exact three-order and bounded time budget required")
    require(quantity * price <= min(operator_cap, Decimal(25)), "entry exceeds effective 25 USD ceiling")


def _validate_slots(slots):
    require(type(slots) is list and len(slots) == 3, "exactly three pre-reserved slots required")
    clients = set()
    for index, slot in enumerate(slots):
        _fields(slot, "role clientOrderId")
        require(slot["role"] == ROLES[index], "fixed slot sequence required")
        _id(slot["clientOrderId"])
        require(slot["clientOrderId"] not in clients, "duplicate client order identity")
        clients.add(slot["clientOrderId"])


def _validate_request(role, request, binding, client, own_fill, *, protected_batch=False):
    _fields(request, "clientOrderId providerSymbol side quantity limitPriceUsd triggerPriceUsd "
            "timeInForce reduceOnly")
    require(request["clientOrderId"] == client
            and request["providerSymbol"] == binding["market"]["providerSymbol"],
            "request differs from pre-reserved slot")
    qty = _number(request["quantity"])
    price = _number(request["limitPriceUsd"]) if request["limitPriceUsd"] is not None else None
    trigger = request["triggerPriceUsd"]
    if trigger is not None:
        _number(trigger)
    if role == "entry":
        require(request["side"] == binding["entry"]["side"]
                and qty == _number(binding["entry"]["quantity"])
                and price is not None and price <= _number(binding["entry"]["maxPriceUsd"])
                and qty * price <= min(_number(binding["limits"]["maxNotionalUsd"]), Decimal(25))
                and trigger is None and request["timeInForce"] == "IOC"
                and request["reduceOnly"] is False, "unbounded or mismatched entry")
    else:
        reverse = "sell" if binding["entry"]["side"] == "buy" else "buy"
        require(request["side"] == reverse and request["reduceOnly"] is True,
                "exit must oppose entry and be reduce-only")
        if role == "stop" and protected_batch:
            # The certified adapter sends both in one create_orders call. The
            # future transport must independently prove provider reduce-only
            # semantics before it may use this offline intent record.
            require(qty == _number(binding["entry"]["quantity"]), "batch stop must match entry quantity")
        else:
            require(own_fill is not None and qty <= own_fill, "unproved reduce-only size")
        require((role == "stop" and trigger is not None and price is None
                 and request["timeInForce"] == "GTC")
                or (role == "emergency-close" and trigger is None and price is not None
                    and request["timeInForce"] == "IOC"),
                "invalid reserved exit strategy")


def _validate_observation(observation, binding, *, client, request_hash):
    _fields(observation, "bindingHash accountReferenceHash origin providerSymbol clientOrderId requestHash "
            "providerOrderId status quantity filledQuantity originalDigest observedAt")
    require(observation["bindingHash"] == digest(binding)
            and observation["accountReferenceHash"] == binding["accountReferenceHash"]
            and observation["origin"] == ORIGIN
            and observation["providerSymbol"] == binding["market"]["providerSymbol"]
            and observation["clientOrderId"] == client and observation["requestHash"] == request_hash,
            "original correlation differs")
    _id(observation["providerOrderId"])
    _hex(observation["originalDigest"], 64)
    require(observation["status"] in (*TERMINAL, "open"), "invalid observed order status")
    quantity = _number(observation["quantity"])
    filled = _number(observation["filledQuantity"], positive=False)
    require(filled <= quantity, "overfilled observation")
    require(observation["status"] != "filled" or filled == quantity,
            "incomplete filled observation")
    require(type(observation["observedAt"]) in (int, float)
            and math.isfinite(observation["observedAt"]) and observation["observedAt"] >= 0,
            "invalid observation time")
    return filled


class HyperliquidTestnetJournal:
    """One-process owner for offline intent and normalized caller observations.

    begin_dispatch is the last durable checkpoint before a *future* transport
    send. It never sends, authorizes a send, or proves provider ownership.
    """

    def __init__(self, path, binding, *, clock=time.time):
        validate_binding(binding)
        self._binding = copy.deepcopy(binding)
        self._clock = clock
        self._connection = None
        self._descriptors = []
        self._records = []
        self._poisoned = False
        self._last_time = 0.0
        try:
            self._open(Path(path))
            self._read()
            if not self._records:
                self._append("created", {"binding": binding, "locationHash": self._location_hash,
                                         "startedAt": self.now()})
            first = self._records[0]
            require(first["kind"] == "created" and first["body"]["binding"] == binding
                    and first["body"]["locationHash"] == self._location_hash, "journal binding differs")
            self._deadline = first["body"]["startedAt"] + binding["limits"]["timeBudgetSeconds"]
            self._replay()
            self.now()
        except BaseException as error:
            self.close()
            if isinstance(error, TestnetJournalRefused):
                raise
            raise TestnetJournalRefused("real-testnet journal open refused") from error

    def _open(self, path):
        require(path.is_absolute() and ".." not in path.parts and path.parent.is_dir(),
                "existing absolute journal location required")
        _identity(path.parent, owned=True)
        self._location_hash = digest(os.path.normcase(os.path.abspath(path)))
        self._paths = {parent: _identity(parent) for parent in path.parents}
        owner = path.with_name(path.name + ".owner")
        self._descriptors.append(_open_exact(owner))
        _lock(self._descriptors[-1])
        self._paths[owner] = _identity(owner)
        self._descriptors.append(_open_exact(path))
        self._paths[path] = _identity(path)
        self._check_paths()
        self._connection = sqlite3.connect(path, timeout=0, isolation_level=None)
        for pragma in ("PRAGMA trusted_schema=OFF", "PRAGMA journal_mode=DELETE",
                       "PRAGMA synchronous=FULL", "PRAGMA locking_mode=EXCLUSIVE"):
            self._connection.execute(pragma)
        self._connection.execute("BEGIN EXCLUSIVE")
        self._connection.execute("CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, "
                                 "payload TEXT NOT NULL, checksum TEXT NOT NULL)")
        self._connection.execute("CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON events "
                                 "BEGIN SELECT RAISE(ABORT, 'immutable'); END")
        self._connection.execute("CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON events "
                                 "BEGIN SELECT RAISE(ABORT, 'immutable'); END")
        self._connection.execute("COMMIT")
        self._check_paths()

    def _check_paths(self):
        try:
            for path, identity in self._paths.items():
                require(_identity(path) == identity, "journal path changed")
        except (OSError, ValueError) as error:
            self._poisoned = True
            raise TestnetJournalRefused("journal path ownership changed") from error

    def _usable(self):
        require(self._connection is not None and not self._poisoned, "journal unavailable after failure")
        self._check_paths()

    def now(self):
        self._usable()
        value = self._clock()
        require(type(value) in (int, float) and math.isfinite(value)
                and value >= self._last_time, "journal clock moved backwards")
        self._last_time = value
        return value

    def _read(self):
        previous = "0" * 64
        for index, (sequence, payload, checksum) in enumerate(
            self._connection.execute("SELECT sequence,payload,checksum FROM events ORDER BY sequence"), 1
        ):
            event = json.loads(payload)
            require(type(event) is dict and set(event) == {"version", "sequence", "kind", "at", "body", "previous"}
                    and event["version"] == 2 and event["sequence"] == sequence == index
                    and event["previous"] == previous and digest(event) == checksum,
                    "journal chain integrity refused")
            require(type(event["at"]) in (int, float) and math.isfinite(event["at"])
                    and event["at"] >= self._last_time, "journal clock integrity refused")
            self._last_time = event["at"]
            self._records.append(event)
            previous = checksum

    def _append(self, kind, body):
        self._usable()
        event = {"version": 2, "sequence": len(self._records) + 1, "kind": kind,
                 "at": self.now(), "body": copy.deepcopy(body),
                 "previous": digest(self._records[-1]) if self._records else "0" * 64}
        payload = canonical(event)
        require(len(payload) <= 16384, "journal record too large")
        try:
            self._connection.execute("BEGIN EXCLUSIVE")
            self._connection.execute("INSERT INTO events VALUES(?,?,?)",
                                     (event["sequence"], payload, digest(event)))
            self._connection.execute("COMMIT")
            os.fsync(self._descriptors[-1])
            self._check_paths()
        except BaseException as error:
            self._poisoned = True
            raise TestnetJournalRefused("journal durability failed; replay required") from error
        self._records.append(event)

    def _replay(self):
        self._slots = None
        self._dispatch = {}
        self._observed = {}
        self._position = None
        provider_ids = {}
        for index, event in enumerate(self._records):
            kind, body = event["kind"], event["body"]
            if index == 0:
                require(kind == "created", "missing journal origin")
                _fields(body, "binding locationHash startedAt")
                validate_binding(body["binding"])
                require(type(body["startedAt"]) in (int, float) and math.isfinite(body["startedAt"])
                        and body["startedAt"] <= event["at"], "invalid journal start")
            elif kind == "reserved":
                _fields(body, "slots")
                _validate_slots(body["slots"])
                require(self._slots is None and not self._dispatch, "duplicate slot reservation")
                self._slots = copy.deepcopy(body["slots"])
            elif kind == "dispatching-batch":
                _fields(body, "entry stop")
                require(self._slots is not None and not self._dispatch, "protected batch already attempted")
                for role in ("entry", "stop"):
                    part = body[role]
                    _fields(part, "request requestHash")
                    client = self._slots[ROLES.index(role)]["clientOrderId"]
                    _validate_request(role, part["request"], self._binding, client, None,
                                      protected_batch=True)
                    require(part["requestHash"] == digest(part["request"]), "request hash differs")
                    self._dispatch[role] = copy.deepcopy(part)
            elif kind == "dispatching":
                _fields(body, "role request requestHash")
                role = body["role"]
                require(role == "emergency-close" and self._slots is not None
                        and role not in self._dispatch, "unreserved or unsupported single dispatch")
                slot = self._slots[ROLES.index(role)]
                fill = self._own_entry_fill()
                _validate_request(role, body["request"], self._binding, slot["clientOrderId"], fill)
                require(body["requestHash"] == digest(body["request"]), "request hash differs")
                if role == "emergency-close":
                    self._require_emergency_preconditions(body["request"], at=event["at"])
                self._dispatch[role] = copy.deepcopy(body)
            elif kind == "observed":
                _fields(body, "role original")
                role = body["role"]
                require(role in self._dispatch, "observation without dispatch")
                slot = self._slots[ROLES.index(role)]
                observed = body["original"]
                filled = _validate_observation(observed, self._binding, client=slot["clientOrderId"],
                                               request_hash=self._dispatch[role]["requestHash"])
                require(observed["observedAt"] <= event["at"], "future provider observation refused")
                require(_number(observed["quantity"]) == _number(self._dispatch[role]["request"]["quantity"]),
                        "observed quantity differs")
                prior = self._observed.get(role)
                require(prior is None or (observed["providerOrderId"] == prior["providerOrderId"]
                        and filled >= _number(prior["filledQuantity"], positive=False)
                        and observed["observedAt"] >= prior["observedAt"]
                        and (prior["status"] not in TERMINAL or observed["status"] == prior["status"])),
                        "conflicting provider observation")
                owner = provider_ids.get(observed["providerOrderId"])
                require(owner is None or owner == role, "duplicate provider order identity")
                provider_ids[observed["providerOrderId"]] = role
                self._observed[role] = copy.deepcopy(observed)
            elif kind == "position":
                _fields(body, "bindingHash accountReferenceHash origin providerSymbol side quantity "
                        "originalDigest observedAt")
                require(body["bindingHash"] == digest(self._binding)
                        and body["accountReferenceHash"] == self._binding["accountReferenceHash"]
                        and body["origin"] == ORIGIN
                        and body["providerSymbol"] == self._binding["market"]["providerSymbol"]
                        and body["side"] == self._binding["entry"]["side"],
                        "position scope differs")
                _number(body["quantity"], positive=False)
                _hex(body["originalDigest"], 64)
                require(type(body["observedAt"]) in (int, float) and math.isfinite(body["observedAt"])
                        and 0 <= body["observedAt"] <= event["at"], "invalid position observation")
                self._position = copy.deepcopy(body)
            else:
                raise TestnetJournalRefused("unknown real-testnet journal event")

    def _own_entry_fill(self):
        original = self._observed.get("entry")
        if original is None:
            return None
        filled = _number(original["filledQuantity"], positive=False)
        return filled if filled > 0 else None

    def _require_emergency_preconditions(self, request, *, at):
        entry = self._observed.get("entry")
        stop = self._observed.get("stop")
        position = getattr(self, "_position", None)
        require(entry is not None and entry["status"] in TERMINAL and stop is not None
                and stop["status"] == "open" and position is not None,
                "terminal own entry, active own stop and position required")
        require(position["observedAt"] >= max(entry["observedAt"], stop["observedAt"])
                and 0 <= at - position["observedAt"] <= 10
                and 0 <= at - stop["observedAt"] <= 10
                and _number(position["quantity"]) == _number(entry["filledQuantity"])
                and _number(request["quantity"]) == _number(position["quantity"]),
                "unproved owned residual position")

    def reserve_slots(self, slots):
        self._usable()
        require(self._slots is None and self.now() < self._deadline, "reservation unavailable")
        _validate_slots(slots)
        self._append("reserved", {"slots": slots})
        self._replay()

    def begin_protected_batch(self, entry, stop):
        self._usable()
        require(self.now() < self._deadline and self._slots is not None
                and not self._dispatch, "protected batch unavailable or already attempted")
        for role, request in (("entry", entry), ("stop", stop)):
            slot = self._slots[ROLES.index(role)]
            _validate_request(role, request, self._binding, slot["clientOrderId"], None,
                              protected_batch=True)
        self._append("dispatching-batch", {
            "entry": {"request": entry, "requestHash": digest(entry)},
            "stop": {"request": stop, "requestHash": digest(stop)},
        })
        self._replay()

    def begin_emergency_close(self, request):
        self._usable()
        role = "emergency-close"
        require(self.now() < self._deadline and self._slots is not None
                and role not in self._dispatch, "emergency close unavailable or already attempted")
        slot = self._slots[ROLES.index(role)]
        _validate_request(role, request, self._binding, slot["clientOrderId"], self._own_entry_fill())
        self._require_emergency_preconditions(request, at=self.now())
        self._append("dispatching", {"role": role, "request": request, "requestHash": digest(request)})
        self._replay()

    def record_order_observation(self, role, original):
        self._usable()
        require(role in self._dispatch, "no dispatch to correlate")
        body = {"role": role, "original": original}
        self._preflight("observed", body)
        self._append("observed", body)
        self._replay()

    def record_position_observation(self, original):
        self._usable()
        self._preflight("position", original)
        self._append("position", original)
        self._replay()

    def _preflight(self, kind, body):
        """Reject bad caller assertions without durably poisoning an otherwise valid run."""
        self._records.append({"kind": kind, "body": copy.deepcopy(body), "at": self.now()})
        try:
            self._replay()
        finally:
            self._records.pop()
            self._replay()

    @property
    def states(self):
        self._usable()
        return {role: ("observed" if role in self._observed else "UNKNOWN" if role in self._dispatch
                       else "reserved" if self._slots is not None else "unreserved") for role in ROLES}

    @property
    def records(self):
        self._usable()
        return copy.deepcopy(self._records)

    @property
    def deadline(self):
        return self._deadline

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
