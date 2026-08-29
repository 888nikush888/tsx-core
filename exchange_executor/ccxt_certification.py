from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ccxt_profiles import ExchangeProfile

REQUIRED_TEST_FLAGS = (
    "protectedEntry",
    "cancel",
    "reconciliation",
    "stream",
    "credentialRotation",
    "accountIdentity",
    "marketNormalization",
)


@dataclass(frozen=True)
class CertificationResult:
    valid: bool
    reason: str | None


def certification_result(
    directory: Path,
    exchange: str,
    ccxt_version: str,
    profile: ExchangeProfile,
) -> CertificationResult:
    destination = directory / f"{exchange}.json"
    try:
        value: Any = json.loads(destination.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return CertificationResult(False, "Certification evidence is missing or invalid.")
    if not isinstance(value, dict) or set(value) != {
        "exchange", "status", "ccxtVersion", "profileVersion", "tests"
    }:
        return CertificationResult(False, "Certification evidence has an invalid schema.")
    if value.get("exchange") != exchange or value.get("status") != "certified":
        return CertificationResult(False, "Certification evidence does not certify this exchange.")
    if value.get("ccxtVersion") != ccxt_version:
        return CertificationResult(False, "Certification evidence does not match the installed CCXT version.")
    if value.get("profileVersion") != profile.profile_version:
        return CertificationResult(False, "Certification evidence does not match the current profile version.")
    tests = value.get("tests")
    if not isinstance(tests, dict) or set(tests) != set(REQUIRED_TEST_FLAGS):
        return CertificationResult(False, "Certification evidence has an invalid test matrix.")
    if any(tests.get(flag) is not True for flag in REQUIRED_TEST_FLAGS):
        return CertificationResult(False, "Certification evidence contains an unpassed required test.")
    return CertificationResult(True, None)

