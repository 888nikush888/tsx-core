"""Offline comparison of every baked profile against its independently pinned receipt.

Run inside the finished non-root image, without source mounts or approval overrides.
This verifies installed executor/SDK bytes, not absent Node/root build inputs and
not provider acceptance. The separate root-build comparison remains mandatory.
No parity suite is executed and no receipt, review pin, or account grant is made.
"""
from __future__ import annotations

import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path

import ccxt

from ccxt_certification import CertificationResult, certification_result
from ccxt_profiles import PROFILES, ExchangeProfile

CCXT_VERSION = '4.5.75'
PENDING_REVIEW = 'Independent implementation review is pending; legacy certification flags are insufficient.'
PROFILE_VERSIONS = {'bybit': 1, 'hyperliquid': 1, 'krakenfutures': 1}


class RuntimeVerificationError(ValueError):
    """The complete installed implementation inventory has not been proven."""


def _profile_inventory() -> list[tuple[str, ExchangeProfile]]:
    if not isinstance(PROFILES, Mapping) or not PROFILES:
        raise RuntimeVerificationError('The built-in profile inventory is missing or empty.')
    if set(PROFILES) != set(PROFILE_VERSIONS):
        raise RuntimeVerificationError('The built-in profile inventory differs from fixed runtime policy.')
    profiles = list(PROFILES.items())
    for exchange, profile in profiles:
        if not isinstance(exchange, str) or not re.fullmatch(r'[a-z][a-z0-9_]{1,63}', exchange):
            raise RuntimeVerificationError('A built-in exchange identifier is invalid.')
        if exchange not in ccxt.exchanges or not isinstance(profile, ExchangeProfile) or profile.id != exchange:
            raise RuntimeVerificationError('A built-in profile is unknown or incorrectly bound.')
        if type(profile.profile_version) is not int or profile.profile_version < 1:
            raise RuntimeVerificationError('A built-in profile version is invalid.')
        if profile.profile_version != PROFILE_VERSIONS[exchange]:
            raise RuntimeVerificationError('A built-in profile version differs from fixed runtime policy.')
    return sorted(profiles)


def verify_implementation_runtime() -> dict:
    """Read fixed built-in policy and all real receipts; callers cannot select a subset."""
    if sys.version_info[:2] != (3, 12) or ccxt.__version__ != CCXT_VERSION:
        raise RuntimeVerificationError('The installed Python or CCXT version is unsupported.')
    profiles = _profile_inventory()
    directory = Path(__file__).resolve().parent / 'certifications'
    verified, quarantined = [], []
    for exchange, profile in profiles:
        result = certification_result(directory, exchange, CCXT_VERSION, profile)
        if isinstance(result, CertificationResult) and result.valid is True and result.reason is None:
            verified.append({'exchange': exchange, 'profileVersion': profile.profile_version,
                             'implementationStatus': 'verified'})
        elif (isinstance(result, CertificationResult) and result.valid is False
              and result.reason == PENDING_REVIEW):
            quarantined.append({'exchange': exchange, 'profileVersion': profile.profile_version,
                                'implementationStatus': 'quarantined'})
        else:
            raise RuntimeVerificationError('An installed implementation receipt is missing, invalid, or unapproved.')
    if not verified:
        raise RuntimeVerificationError('No installed exchange implementation has an approved receipt.')
    return {
        'schemaVersion': 1,
        'kind': 'implementation_runtime_comparison',
        'pythonVersion': '3.12',
        'ccxtVersion': CCXT_VERSION,
        'profiles': sorted([*verified, *quarantined], key=lambda row: row['exchange']),
        'verifiedProfiles': [row['exchange'] for row in verified],
        'quarantinedProfiles': [row['exchange'] for row in quarantined],
        'runtimeReceiptsVerified': True,
        'rootBuildInputsVerified': False,
        'providerAcceptanceVerified': False,
        'performedGateExecution': False,
    }


def main() -> int:
    # Only this fixed CLI is invoked by CI. There are no paths, pins, profile
    # selectors, environment grants, or commands accepted from a receipt/caller.
    try:
        if len(sys.argv) != 1:
            raise RuntimeVerificationError('This runtime check does not accept arguments.')
        result = verify_implementation_runtime()
    except Exception:
        # A malformed result, filesystem error, or unexpected validator failure
        # is NO-GO. Never disclose raw JSON, paths, or exception/cause contents.
        print('NO-GO: installed implementation receipts could not be verified.', file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
