"""Offline preflight and safety guards; real provider transport remains unimplemented.

Nothing in this module loads credentials or opens a network connection. An explicit
execute request is refused until a separately reviewed provider runner is supplied.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ccxt_profiles

from acceptance_journal import AcceptanceJournal, digest


from acceptance_contracts import (
    TESTNET_ORIGINS as TESTNET_ORIGINS,
    AUTHORIZATION as AUTHORIZATION,
    AcceptanceRefused as AcceptanceRefused,
    require as require,
    positive_decimal as positive_decimal,
    validate_origins as validate_origins,
    validate_plan as validate_plan,
    validate_limits as validate_limits,
    journal_binding as journal_binding,
    validate_journal_binding as validate_journal_binding,
    fields as fields,
    identifier as identifier,
    quantity as quantity,
    exact_sum as exact_sum,
    validate_request as validate_request,
    validate_notional as validate_notional,
    validate_original as validate_original,
    validate_order_original as validate_order_original,
    validate_journal_event as validate_journal_event,
)


class AcceptanceGuard:
    """Crash-testable local-fake permits. No real provider adapter is authorized."""

    def __init__(self, plan, source_sha, profile_hash, *, journal=None, profile_origins=None):
        validate_plan(plan, source_sha, profile_hash, profile_origins)
        self._plan = copy.deepcopy(plan)
        self._binding = journal_binding(plan, profile_origins)
        require(journal is None or isinstance(journal, AcceptanceJournal), "durable cleanup journal required")
        self._journal = journal
        self._binding_hash = journal.binding_hash if journal is not None else None
        self._verified_at = None
        self._reservations, self._orders, self._dispatching = {}, {}, set()
        self._conflicted = False
        if journal is not None:
            require(journal.binding == self._binding, "journal binding differs")
            self._replay()

    @property
    def plan(self):
        return copy.deepcopy(self._plan)

    @property
    def binding_hash(self):
        return self._binding_hash

    @property
    def reservations(self):
        return {client: body["notionalUsd"] for client, body in self._reservations.items()}

    @property
    def unresolved(self):
        return sorted(self._dispatching - self._orders.keys())

    def _replay(self):
        for event in self._journal.records:
            kind, body = event["kind"], event["body"]
            validate_journal_event(kind, body)
            if kind == "reserved":
                client = body["request"]["clientOrderId"]
                require(client not in self._reservations, "duplicate journal reservation")
                self._available_budget(body)
                self._reservations[client] = body
            elif kind == "dispatching":
                client = body["clientOrderId"]
                require(client in self._reservations and client not in self._dispatching
                        and body["requestHash"] == digest(self._reservations[client]["request"]), "invalid journal dispatch")
                self._dispatching.add(client)
            elif kind == "acknowledged":
                client = body["original"]["clientOrderId"]
                self._order_matches(body, client, fresh=False)
                require(client in self._dispatching and client not in self._orders, "invalid journal acknowledgement")
                require(body["original"]["orderId"] not in self._remote_ids(), "ambiguous journal ownership")
                self._orders[client] = body
            elif kind == "conflict":
                self._conflicted = True

    def _ready(self, *, fresh_account=False):
        require(self._journal is not None, "durable cleanup journal required")
        self._journal.within_budget()
        require(not self._conflicted, "journal has unresolved conflicting evidence")
        if fresh_account:
            now = self._journal.now()
            require(self._verified_at is not None and 0 <= now - self._verified_at <= 10,
                    "identity and mode must be freshly verified before mutation")

    def _invalid(self, reason, callback):
        try:
            return callback()
        except (AcceptanceRefused, KeyError, TypeError, InvalidOperation) as error:
            self._journal.append("invalid", {"reason": reason})
            raise AcceptanceRefused("invalid " + reason + " evidence; no grant") from error

    def _conflict(self):
        self._journal.append("conflict", {"reason": "repeat"})
        self._conflicted = True
        raise AcceptanceRefused("contradictory repetition remains unresolved")

    def _evidence(self, evidence, contract, *, fresh=True):
        validate_original(evidence)
        require(evidence["contract"] == contract and evidence["bindingHash"] == self.binding_hash
                and evidence["original"]["accountReferenceHash"] == self._plan["accountReferenceHash"], "original account/run binding differs")
        if fresh:
            require(0 <= self._journal.now() - evidence["observedAt"] <= 10, "stale original evidence")

    def confirm_account(self, evidence):
        self._ready()
        evidence = copy.deepcopy(evidence)

        def validate():
            self._evidence(evidence, "local-fake-account-v1")
            original = evidence["original"]
            require(original["positionMode"] == "oneway" and original["marginMode"] == "cross"
                    and original["origin"] == self._plan["host"], "identity and mode are unverified")

        self._invalid("account", validate)
        self._journal.append("account", evidence)
        self._verified_at = evidence["observedAt"]

    def reserve_order(self, client_order_id, notional_usd, request):
        self._ready(fresh_account=True)
        request = copy.deepcopy(request)
        self._invalid("request", lambda: validate_request(request))
        require(request["clientOrderId"] == client_order_id, "request client identity differs")
        body = copy.deepcopy({"request": request, "notionalUsd": str(positive_decimal(notional_usd))})
        validate_notional(request, body["notionalUsd"])
        previous = self._reservations.get(client_order_id)
        if previous is not None:
            if previous != body:
                self._conflict()
            return digest(previous["request"])
        self._available_budget(body)
        self._journal.append("reserved", body)
        self._reservations[client_order_id] = body
        return digest(request)

    def _available_budget(self, body):
        limits = self._plan["limits"]
        require(len(self._reservations) < limits["maxOrderCount"], "order limit exhausted")
        with localcontext() as context:
            context.prec = 512
            total = sum((Decimal(value) for value in self.reservations.values()), Decimal(0))
            require(total + Decimal(body["notionalUsd"]) <= Decimal(limits["maxNotionalUsd"]), "notional limit exhausted")

    def mark_dispatching(self, client_order_id):
        self._ready()
        require(client_order_id in self._reservations and client_order_id not in self._dispatching,
                "unreserved or unresolved submission; send replay refused")
        self._ready(fresh_account=True)
        request = self._reservations[client_order_id]["request"]
        self._journal.append("dispatching", {"clientOrderId": client_order_id, "requestHash": digest(request)})
        self._dispatching.add(client_order_id)
        self._ready(fresh_account=True)
        return copy.deepcopy(request)

    def _remote_ids(self):
        return {evidence["original"]["orderId"] for evidence in self._orders.values()}

    def _order_matches(self, evidence, client, *, fresh=True):
        self._evidence(evidence, "local-fake-order-v1", fresh=fresh)
        require(client in self._reservations, "unreserved order evidence")
        request = self._reservations[client]["request"]
        original = evidence["original"]
        require(evidence["requestHash"] == digest(request) and original["clientOrderId"] == client
                and original["providerSymbol"] == request["providerSymbol"]
                and original["quantity"] == request["quantity"], "original request binding differs")

    def record_order(self, client_order_id, order_id, evidence):
        require(self._journal is not None and not self._conflicted, "journal ownership is unresolved")
        evidence = copy.deepcopy(evidence)

        def validate():
            self._order_matches(evidence, client_order_id)
            require(client_order_id in self._dispatching and evidence["original"]["orderId"] == order_id,
                    "unsent order acknowledgement refused")

        self._invalid("acknowledgement", validate)
        previous = self._orders.get(client_order_id)
        if previous is not None:
            if previous != evidence:
                self._conflict()
            return
        if order_id in self._remote_ids():
            self._conflict()
        self._journal.append("acknowledged", evidence)
        self._orders[client_order_id] = copy.deepcopy(evidence)

    def require_owned(self, order_id):
        self._ready()
        for client, evidence in self._orders.items():
            if evidence["original"]["orderId"] == order_id:
                return client
        raise AcceptanceRefused("foreign or unproven order ownership")

    def _cleanup(self, terminal_orders, positions):
        require(not self._conflicted and len(self._orders) == len(self._reservations)
                and len(self._orders) >= 2, "cleanup has unresolved submissions")
        require(isinstance(terminal_orders, list) and len(terminal_orders) == len(self._orders), "cleanup needs every original order")
        seen, symbols = set(), set()
        for evidence in terminal_orders:
            self._evidence(evidence, "local-fake-order-v1")
            original = evidence["original"]
            client = original["clientOrderId"]
            self._order_matches(evidence, client)
            require(client in self._orders and self._orders[client]["original"]["orderId"] == original["orderId"]
                    and client not in seen and original["status"] != "open", "cleanup terminal ownership is unproven")
            require(quantity(original["filledQuantity"]) >= quantity(self._orders[client]["original"]["filledQuantity"]), "fills regressed")
            seen.add(client)
            symbols.add(original["providerSymbol"])
        self._evidence(positions, "local-fake-positions-v1")
        require(positions["observedAt"] >= max(order["observedAt"] for order in terminal_orders),
                "cleanup position observation predates terminal orders")
        rows = positions["original"]["positions"]
        require(len(rows) == len(symbols) and {row["providerSymbol"] for row in rows} == symbols
                and all(row["quantity"] == "0" for row in rows), "cleanup explicit zero exposure is unproven")

    def cleanup_proof(self, terminal_orders, positions):
        require(self._journal is not None, "durable cleanup journal required")
        terminal_orders, positions = copy.deepcopy(terminal_orders), copy.deepcopy(positions)
        self._invalid("cleanup", lambda: self._cleanup(terminal_orders, positions))
        self._journal.append("cleanup", {"orders": terminal_orders, "positions": positions})
        return {"terminalOrderIds": sorted(self._remote_ids()), "openOrderIds": [], "residualExposure": "0",
                "evidenceKind": "local-fake-only", "providerAcceptanceVerified": False}


def run_acceptance(plan: dict | None = None, *, execute: bool = False, authorization: str | None = None,
                   expected_source_sha: str | None = None, expected_profile_hash: str | None = None) -> dict:
    if execute:
        require(authorization == AUTHORIZATION, "explicit authorization is required")
    if plan is not None:
        validate_plan(plan, expected_source_sha, expected_profile_hash)
    if execute:
        require(plan is not None, "explicit preflight plan is required")
        raise AcceptanceRefused("real provider transport is not implemented; no secrets or network accessed")
    return {
        "status": "DRY_RUN", "implementationVerified": False, "providerAcceptanceVerified": False,
        "networkRequests": 0, "secretReads": 0, "preflightValidated": plan is not None,
        "pending": ["reviewed provider transport", "explicit testnet authorization", "real required-case evidence",
                    "ownership cleanup proof", "independent acceptance review"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--source-sha")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--authorization")
    arguments = parser.parse_args()
    plan = json.loads(arguments.plan.read_text(encoding="utf-8")) if arguments.plan else None
    profile_file = Path(ccxt_profiles.__file__).resolve()
    profile_hash = hashlib.sha256(profile_file.read_bytes()).hexdigest()
    try:
        result = run_acceptance(plan, execute=arguments.execute, authorization=arguments.authorization,
                                expected_source_sha=arguments.source_sha, expected_profile_hash=profile_hash)
    except AcceptanceRefused:
        parser.exit(1, "Provider acceptance refused; no credentials or network were accessed.\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
