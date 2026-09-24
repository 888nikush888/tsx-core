"""Independent, default-deny permission for exposure-increasing provider writes.

An implementation certification is intentionally not a provider acceptance grant.
The reviewer public-key digest must be pinned in a separately reviewed source
change before any signed grant can become effective. No operator setting can
create or replace that trust anchor.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from common import ExchangeContractError


# A future, independently reviewed change must pin the SHA-256 of an external
# reviewer's DER public key. Empty is deliberately deny-all for this release.
PINNED_REVIEWER_KEY_SHA256 = ""
GRANT_FIELDS = frozenset({
    "version", "reviewId", "exchange", "product", "mode", "accountId",
    "externalAccountId", "credentialGeneration", "validFrom", "validUntil",
})
HEX_64 = re.compile(r"[a-f0-9]{64}\Z")
REVIEW_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")


def _market_flag(market: dict[str, Any], first: str, second: str) -> str | None:
    if market.get(first) is True:
        return first
    if market.get(second) is True:
        return second
    return None


def market_product(market: dict[str, Any]) -> str:
    if market.get("contract") is not True or market.get("spot") is True or market.get("option") is True:
        raise ExchangeContractError("Provider acceptance requires a futures contract market.")
    kind = _market_flag(market, "swap", "future")
    settlement = _market_flag(market, "linear", "inverse")
    if (kind is None or settlement is None or market.get("linear") is market.get("inverse")
            or market.get("swap") is market.get("future")):
        raise ExchangeContractError("Provider acceptance market product is ambiguous.")
    return f"{kind}:{settlement}"


def _reviewer_key(path: str, pinned_digest: str) -> Ed25519PublicKey:
    if not HEX_64.fullmatch(pinned_digest) or not Path(path).is_absolute():
        raise ValueError("Reviewer trust anchor is not pinned.")
    raw = read_provider_acceptance_file(path, 4096)
    key = serialization.load_pem_public_key(raw)
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("Reviewer key must be Ed25519.")
    encoded = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if hashlib.sha256(encoded).hexdigest() != pinned_digest:
        raise ValueError("Reviewer trust anchor differs from the pinned key.")
    return key


def canonical_provider_grant(grant: dict[str, Any]) -> bytes:
    return json.dumps(grant, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _grant_identity_valid(grant: dict[str, Any], account: dict[str, str], product: str) -> bool:
    if set(grant) != GRANT_FIELDS:
        return False
    string_fields = GRANT_FIELDS - {"version", "validFrom", "validUntil"}
    if any(not isinstance(grant.get(field), str) or not 1 <= len(grant[field]) <= 128
           or re.search(r"[\x00-\x1f\ud800-\udfff]", grant[field]) is not None for field in string_fields):
        return False
    if type(grant.get("version")) is not int or grant["version"] != 1:
        return False
    if not isinstance(grant.get("reviewId"), str) or REVIEW_ID.fullmatch(grant["reviewId"]) is None:
        return False
    if any(grant.get(field) != expected for field, expected in (
        ("exchange", account.get("exchange")), ("product", product), ("mode", account.get("mode")),
        ("accountId", account.get("id")),
        ("externalAccountId", account.get("expectedAccountFingerprint")),
        ("credentialGeneration", account.get("credentialGeneration")),
    )):
        return False
    if any(not isinstance(grant.get(field), str) or HEX_64.fullmatch(grant[field]) is None
           for field in ("externalAccountId", "credentialGeneration")):
        return False
    return True


def _grant_time_valid(grant: dict[str, Any], now_ms: int) -> bool:
    start, end = grant.get("validFrom"), grant.get("validUntil")
    if not isinstance(start, int) or isinstance(start, bool):
        return False
    if not isinstance(end, int) or isinstance(end, bool):
        return False
    return (abs(start) <= 2**53 - 1 and abs(end) <= 2**53 - 1
            and start <= now_ms < end and end - start <= 7 * 86_400_000)


def signed_grant_valid(
    document: Any, key: Ed25519PublicKey, account: dict[str, str], product: str, now_ms: int,
) -> bool:
    if not isinstance(document, dict) or set(document) != {"grant", "signature"}:
        return False
    grant, signature = document["grant"], document["signature"]
    if not isinstance(grant, dict) or not isinstance(signature, str):
        return False
    if not _grant_identity_valid(grant, account, product) or not _grant_time_valid(grant, now_ms):
        return False
    try:
        encoded = canonical_provider_grant(grant)
        key.verify(base64.b64decode(signature, validate=True), encoded)
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def assert_provider_acceptance(
    account: dict[str, str], market: dict[str, Any], *,
    pinned_digest: str = PINNED_REVIEWER_KEY_SHA256,
    key_path: str | None = None,
    grants_path: str | None = None,
    now_ms: int | None = None,
) -> None:
    """Read and verify afresh immediately before an exposure-increasing write."""
    # The signed grant alone is not an exact implementation/SDK/profile review.
    # Keep this separate hard block until that provenance can be verified here.
    if not live_provenance_verified():
        raise ExchangeContractError("Independent live source, SDK, and profile provenance is not verified.")
    product = market_product(market)
    try:
        key_file = key_path or os.environ.get("PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE", "")
        grants_file = grants_path or os.environ.get("PROVIDER_ACCEPTANCE_GRANTS_FILE", "")
        key = _reviewer_key(key_file, pinned_digest)
        if not Path(grants_file).is_absolute():
            raise ValueError("Grant file must be absolute.")
        raw = read_provider_acceptance_file(grants_file, 131_072)
        grants = json.loads(raw.decode("utf-8"))
        if not isinstance(grants, list) or len(grants) > 100:
            raise ValueError("Grant collection is invalid.")
        now = int(time.time() * 1000) if now_ms is None else now_ms
        if any(signed_grant_valid(item, key, account, product, now) for item in grants):
            return
    except (OSError, ValueError, TypeError, UnsupportedAlgorithm):
        pass
    raise ExchangeContractError("Independent provider acceptance is absent or invalid; new exposure is blocked.")


def live_provenance_verified() -> bool:
    return False


def _real_parents(path: Path) -> None:
    if any(not stat.S_ISDIR(parent.lstat().st_mode) for parent in path.parents):
        raise ValueError("Acceptance file parent must be a real directory.")


def _same_acceptance_file(before: os.stat_result, after: os.stat_result) -> None:
    # Windows Python 3.12 lstat/fstat expose different ctime semantics. Compare
    # change time only between descriptor snapshots below; retain identity/size/mtime here.
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_nlink")
    if not stat.S_ISREG(after.st_mode) or any(getattr(before, field) != getattr(after, field) for field in fields):
        raise ValueError("Acceptance evidence changed during reading.")


def read_provider_acceptance_file(path: str, maximum: int) -> bytes:
    """Read bounded bytes without granting signature or reviewer authority."""
    target = Path(path)
    if not target.is_absolute() or type(maximum) is not int or not 1 <= maximum <= 131_072:
        raise ValueError("Invalid acceptance evidence file boundary.")
    _real_parents(target)
    before = target.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 1 <= before.st_size <= maximum:
        raise ValueError("Acceptance evidence must be a bounded regular single-link file.")
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        opened = os.fstat(descriptor)
        _same_acceptance_file(before, opened)
        content = bytearray()
        while len(content) <= maximum:
            received = os.read(descriptor, maximum + 1 - len(content))
            if not received:
                break
            content.extend(received)
        if len(content) != before.st_size:
            raise ValueError("Acceptance evidence size changed during reading.")
        after = os.fstat(descriptor)
        _same_acceptance_file(opened, after)
        if opened.st_ctime_ns != after.st_ctime_ns:
            raise ValueError("Acceptance evidence changed during reading.")
        _same_acceptance_file(before, target.lstat())
        _real_parents(target)
        return bytes(content)
    finally:
        os.close(descriptor)
