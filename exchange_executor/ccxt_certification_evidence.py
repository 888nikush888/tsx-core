"""Local receipt checks, separate from test execution and provider acceptance."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from ccxt_profiles import ExchangeProfile

HASH = re.compile(r'[a-f0-9]{64}')
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TREE_BYTES = 64 * 1024 * 1024
AUTHORITY_FILE = 'ccxt_implementation_reviews.py'
RECEIPT_KEYS = {'schemaVersion', 'kind', 'exchange', 'ccxtVersion', 'profileVersion', 'profileHash',
                'sourceRevision', 'sourceTreeHash', 'parityEvidenceHash', 'executionReportHash',
                'nodeSourcesHash', 'testSourcesHash', 'fixturesHash', 'executorTreeHash', 'sdkTreeHash',
                'reviewedAt', 'scope', 'providerAcceptanceVerified'}


class ReceiptError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise ReceiptError(reason)


def _plain_regular(path: Path):
    meta = path.lstat()
    require(stat.S_ISREG(meta.st_mode) and not path.is_symlink() and meta.st_nlink == 1,
            'Implementation evidence must be an ordinary unlinked file.')
    require(not getattr(meta, 'st_file_attributes', 0) & 0x400,
            'Implementation evidence cannot use filesystem reparse points.')
    return meta


def file_bytes(path: Path, limit=MAX_FILE_BYTES) -> bytes:
    _directory(path.parent)
    before = _plain_regular(path)
    require(0 <= before.st_size <= limit, 'Implementation evidence exceeds its file budget.')
    with path.open('rb') as handle:
        opened = os.fstat(handle.fileno())
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1
                and (opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
                'Implementation evidence changed before opening.')
        data = handle.read(limit + 1)
    after = _plain_regular(path)
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    require(len(data) == before.st_size and all(getattr(before, key) == getattr(after, key) for key in fields),
            'Implementation evidence changed during verification.')
    return data


def _directory(path: Path):
    meta = path.lstat()
    require(stat.S_ISDIR(meta.st_mode) and not path.is_symlink()
            and not getattr(meta, 'st_file_attributes', 0) & 0x400,
            'Implementation source directory is not canonical.')
    require(path.absolute() == path.resolve(strict=True), 'Implementation source ancestor is not canonical.')


def _python_files(root: Path, recursive: bool):
    _directory(root)
    directories, result = [root], []
    visited = 0
    while directories:
        directory = directories.pop()
        _directory(directory)
        for entry in directory.iterdir():
            visited += 1
            require(visited <= 10_000, 'Implementation source tree exceeds its entry budget.')
            if entry.suffix == '.py':
                result.append(entry)
            elif recursive and entry.name != '__pycache__' and entry.is_dir():
                _directory(entry)
                directories.append(entry)
    require(0 < len(result) <= 2000, 'Implementation source inventory is empty or excessive.')
    return sorted(result, key=lambda item: item.relative_to(root).as_posix())


def python_tree_hash(root: Path, *, sdk: bool = False) -> str:
    """Hash actual bytes; never trust a receipt-selected list of source files."""
    rows, total = [], 0
    for path in _python_files(root, sdk):
        relative = path.relative_to(root).as_posix()
        if not sdk and relative == AUTHORITY_FILE:
            continue
        data = file_bytes(path)
        total += len(data)
        require(total <= MAX_TREE_BYTES, 'Implementation source tree exceeds its byte budget.')
        rows.append([relative, hashlib.sha256(data).hexdigest()])
    require(bool(rows), 'Implementation source inventory has no covered files.')
    return hashlib.sha256(json.dumps(rows, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Implementation receipt contains duplicate keys.')
        result[key] = value
    return result


def _invalid_number(_value):
    raise ReceiptError('Implementation receipt contains a non-finite number.')


def read_receipt(path: Path, approved_hashes: tuple[str, ...]):
    require(type(approved_hashes) is tuple and 0 < len(approved_hashes) <= 16
            and all(isinstance(item, str) and HASH.fullmatch(item) for item in approved_hashes)
            and len(set(approved_hashes)) == len(approved_hashes),
            'Independent repository review pin policy is invalid.')
    data = file_bytes(path, 64 * 1024)
    require(hashlib.sha256(data).hexdigest() in approved_hashes,
            'Implementation receipt has no independent repository review pin.')
    return json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object, parse_constant=_invalid_number)


def expected_profile_hash(profile: ExchangeProfile) -> str:
    return hashlib.sha256(json.dumps(asdict(profile), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _scope(value, profile):
    require(profile.default_type == 'swap' and profile.default_sub_type in (None, 'linear')
            and profile.position_mode == 'oneway' and profile.margin_mode == 'cross',
            'Implementation receipt only supports the reviewed linear perpetual one-way/cross model.')
    require(bool(profile.settlement_preference) and len(set(profile.settlement_preference)) == len(profile.settlement_preference)
            and set(profile.settlement_preference) <= {'USD', 'USDT', 'USDC'}
            and bool(profile.modes) and len(set(profile.modes)) == len(profile.modes)
            and set(profile.modes) <= {'testnet', 'live'}, 'Implementation profile assets or modes are unreviewed.')
    expected = {'product': 'linear_perpetual', 'positionMode': profile.position_mode,
                'marginMode': profile.margin_mode, 'settlementAssets': list(profile.settlement_preference),
                'modes': list(profile.modes), 'contractSizeRule': 'positive_native_base_multiplier'}
    require(value == expected, 'Implementation receipt does not cover the exact declared profile scope.')


def validate_receipt(value, exchange: str, ccxt_version: str, profile: ExchangeProfile,
                     executor_root: Path, sdk_root: Path) -> None:
    require(isinstance(value, dict) and set(value) == RECEIPT_KEYS, 'Implementation receipt schema is invalid.')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 2
            and value['kind'] == 'reviewed_implementation_receipt', 'Legacy flags are not implementation evidence.')
    require(value['exchange'] == exchange == profile.id, 'Implementation receipt exchange differs.')
    require(value['ccxtVersion'] == ccxt_version == '4.5.75', 'Implementation receipt CCXT version differs.')
    require(type(value['profileVersion']) is int and value['profileVersion'] == profile.profile_version,
            'Implementation receipt profile version differs.')
    require(isinstance(value['sourceRevision'], str) and re.fullmatch(r'[a-f0-9]{40}', value['sourceRevision']),
            'Implementation receipt source revision is invalid.')
    for key in (key for key in RECEIPT_KEYS if key.endswith('Hash')):
        require(isinstance(value[key], str) and HASH.fullmatch(value[key]), 'Implementation commitment is invalid.')
    require(value['providerAcceptanceVerified'] is False, 'Implementation evidence cannot grant provider acceptance.')
    _scope(value['scope'], profile)
    require(value['profileHash'] == expected_profile_hash(profile), 'Implementation receipt profile changed.')
    stamp = value['reviewedAt']
    require(isinstance(stamp, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', stamp),
            'Implementation review timestamp is invalid.')
    require(datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc),
            'Implementation review timestamp is in the future.')
    require(value['executorTreeHash'] == python_tree_hash(executor_root), 'Implementation executor source drifted.')
    require(value['sdkTreeHash'] == python_tree_hash(sdk_root, sdk=True), 'Implementation installed SDK source drifted.')
