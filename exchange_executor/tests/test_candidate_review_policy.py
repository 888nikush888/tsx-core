from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ccxt_candidate_reviews as reviews
from ccxt_certification import CertificationResult
from tools.audit_derivatives_candidates import (
    CompletionVerdict,
    load_inventory,
    validate_complete,
)


class CandidateReviewPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.document = load_inventory(ROOT.parent / "docs/testing/ccxt-expansion-matrix.json")

    def test_fixed_review_accepts_exact_decisions_only_with_valid_existing_receipt(self) -> None:
        with patch.object(
            reviews,
            "certification_result",
            return_value=CertificationResult(True, None),
        ):
            verifier = reviews.trusted_completion_verifier(self.document, CompletionVerdict)
            validate_complete(self.document, completion_verifier=verifier)

    def test_assessment_or_inventory_drift_cannot_reuse_review_capability(self) -> None:
        for mutation in ("inventory", "decision", "reason"):
            changed = copy.deepcopy(self.document)
            if mutation == "inventory":
                changed["inventoryHash"] = "0" * 64
            elif mutation == "decision":
                changed["assessments"][0]["decision"] = "pending"
            else:
                changed["assessments"][0]["reasonCodes"] = ["different_review"]
            with self.subTest(mutation=mutation), self.assertRaises(reviews.CandidateReviewError):
                reviews.trusted_completion_verifier(changed, CompletionVerdict)

    def test_evidence_drift_and_invalid_existing_receipt_remain_no_go(self) -> None:
        with patch.object(reviews, "file_bytes", return_value=b"changed"):
            with self.assertRaises(reviews.CandidateReviewError):
                reviews.trusted_completion_verifier(self.document, CompletionVerdict)
        verifier = reviews.trusted_completion_verifier(self.document, CompletionVerdict)
        with patch.object(
            reviews,
            "certification_result",
            return_value=CertificationResult(False, "invalid"),
        ):
            with self.assertRaises(reviews.CandidateReviewError):
                validate_complete(self.document, completion_verifier=verifier)


if __name__ == "__main__":
    unittest.main()
