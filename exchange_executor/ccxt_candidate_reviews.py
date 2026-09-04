"""Fixed local review policy for the complete pinned derivative inventory.

The manifest cannot approve itself.  These commitments are changed only after
the complete assessment and every referenced repository file have been reviewed.
Provider/account acceptance is deliberately outside this local verifier.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ccxt_certification import CertificationResult, certification_result
from ccxt_certification_evidence import file_bytes
from ccxt_profiles import PROFILES

APPROVED_INVENTORY_HASH = "1cfe505c9e5b989769d24e74e4ff59d097571f6cf880b2a0a185918870e81315"
APPROVED_ASSESSMENTS_HASH = "eea8582102dfd7c4c0f2adb02e9cbe102b3c2bd984911e1dd097660107fd5163"
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


class CandidateReviewError(ValueError):
    """The checked-in candidate decision review is absent or has drifted."""


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _evidence_bytes(reference: dict[str, Any]) -> bytes:
    relative = reference["path"]
    candidate = REPOSITORY_ROOT.joinpath(*relative.split("/"))
    try:
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(REPOSITORY_ROOT.resolve(strict=True)):
            raise CandidateReviewError("Candidate evidence escaped the repository.")
        data = file_bytes(resolved)
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise CandidateReviewError("Candidate evidence is missing or unsafe.") from error
    if hashlib.sha256(data).hexdigest() != reference["sha256"]:
        raise CandidateReviewError("Candidate evidence changed after review.")
    return data


def trusted_completion_verifier(
    document: dict[str, Any],
    verdict_type: Callable[[str, str, bool, bool], Any],
) -> Callable[[dict[str, Any], dict[str, Any]], Any]:
    """Bind the whole decision set before returning the per-row capability."""
    if document.get("inventoryHash") != APPROVED_INVENTORY_HASH:
        raise CandidateReviewError("Candidate inventory has no fixed review commitment.")
    assessments = document.get("assessments")
    if not isinstance(assessments, list) or _digest(assessments) != APPROVED_ASSESSMENTS_HASH:
        raise CandidateReviewError("Candidate decisions have no fixed review commitment.")
    approved: dict[str, bytes] = {}
    for assessment in assessments:
        identifier = assessment.get("id") if isinstance(assessment, dict) else None
        if not isinstance(identifier, str) or identifier in approved:
            raise CandidateReviewError("Candidate review identities are invalid.")
        for reference in assessment.get("evidence", []):
            _evidence_bytes(reference)
        approved[identifier] = _canonical(assessment)

    def verify(assessment: dict[str, Any], context: dict[str, Any]) -> Any:
        identifier = assessment.get("id")
        if (
            context.get("inventoryHash") != APPROVED_INVENTORY_HASH
            or identifier not in approved
            or _canonical(assessment) != approved[identifier]
            or context.get("exchange", {}).get("id") != identifier
        ):
            raise CandidateReviewError("Candidate verdict is not bound to the approved row.")
        decision = assessment.get("decision")
        if decision == "not_easy":
            return verdict_type(APPROVED_INVENTORY_HASH, identifier, True, False)
        if decision != "existing" or identifier not in PROFILES:
            raise CandidateReviewError("Candidate decision is not locally completable.")
        result = certification_result(
            Path(__file__).resolve().parent / "certifications",
            identifier,
            "4.5.75",
            PROFILES[identifier],
        )
        if not isinstance(result, CertificationResult) or result.valid is not True or result.reason is not None:
            raise CandidateReviewError("Existing profile implementation review is incomplete.")
        return verdict_type(APPROVED_INVENTORY_HASH, identifier, True, True)

    return verify
