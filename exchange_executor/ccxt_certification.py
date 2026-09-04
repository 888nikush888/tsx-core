from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import ccxt

from ccxt_certification_evidence import ReceiptError, read_receipt, validate_receipt
from ccxt_implementation_reviews import APPROVED_IMPLEMENTATION_RECEIPTS
from ccxt_profiles import ExchangeProfile


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
    # No manifest-selected commands, imports, source paths, or automatic approval.
    if not re.fullmatch(r'[a-z][a-z0-9_]{1,63}', exchange) or exchange != profile.id:
        return CertificationResult(False, 'Implementation exchange identifier is invalid.')
    if ccxt_version != '4.5.75' or ccxt.__version__ != ccxt_version:
        return CertificationResult(False, 'Implementation evidence does not match the installed CCXT version.')
    approved = APPROVED_IMPLEMENTATION_RECEIPTS.get((exchange, profile.profile_version), ())
    if not approved:
        return CertificationResult(False, 'Independent implementation review is pending; legacy certification flags are insufficient.')
    try:
        value = read_receipt(directory / f'{exchange}.json', approved)
        validate_receipt(value, exchange, ccxt_version, profile, Path(__file__).resolve().parent,
                         Path(ccxt.__file__).resolve().parent)
    except ReceiptError as error:
        return CertificationResult(False, str(error))
    except (OSError, ValueError, TypeError, KeyError, RecursionError, UnicodeError):
        # Never expose a file path, hostile JSON payload, or raw exception.
        return CertificationResult(False, 'Implementation evidence is missing or invalid.')
    return CertificationResult(True, None)
