"""Bounded public Bybit index receipts, not valuation or historical completeness.

Only explicit fixed legs use the caller's existing recovery budget. Successful
prefixes survive later failures; no cache, cursor, quote pairing, or account grant.
"""
from __future__ import annotations

import copy
import hashlib
import json
from importlib.metadata import version as package_version
from typing import Any

from ccxt.base.errors import BadRequest, InvalidOrder, NetworkError, NotSupported, RateLimitExceeded

from ccxt_profiles import profile_for
from common import DECIMAL_PATTERN, ExchangeContractError
from execution_constraints import profile_hash
from history_reader import RecoveryBudgetExhausted, RecoveryReadBudget, now_ms

SOURCE = 'bybit-v5-rest-index-snapshot-v1'
ENDPOINT = '/v5/market/tickers'
SAFE_INTEGER = 9_007_199_254_740_991
ORIGINS = {'live': 'https://api.bybit.com', 'testnet': 'https://api-testnet.bybit.com'}
LEGS = {
    'bybit:btc-usd-index:v1': ('inverse', 'BTCUSD', 'indexPrice', 'bybit:usdt-usd-index-ratio:v1'),
    'bybit:btc-usdt-index:v1': ('linear', 'BTCUSDT', 'indexPrice', 'bybit:usdt-usd-index-ratio:v1'),
    'bybit:usdc-usd-index:v1': ('spot', 'USDCUSDT', 'usdIndexPrice', 'bybit:usdc-usd-index:v1'),
}


class FxEvidenceError(ExchangeContractError):
    pass


class UnsupportedFxEvidence(ExchangeContractError):
    pass


def _require(condition: bool) -> None:
    if not condition:
        raise FxEvidenceError('FX source omitted or contradicted its bounded original evidence.')


def _json_scalar(value: Any) -> bool:
    if value is None or type(value) is bool:
        return True
    if type(value) is str:
        _require(len(value.encode('utf-8', errors='strict')) < 32_768)
        return True
    if type(value) is int:
        _require(abs(value) <= SAFE_INTEGER)
        return True
    return False


def _json_value(value: Any, depth: int, remaining: list[int]) -> None:
    remaining[0] -= 1
    _require(depth <= 12 and remaining[0] >= 0)
    if _json_scalar(value):
        return
    if type(value) is list:
        for item in value:
            _json_value(item, depth + 1, remaining)
        return
    _require(type(value) is dict and all(type(key) is str for key in value))
    for key, item in value.items():
        _require(len(key) <= 256 and all(ord(char) >= 32 and not 127 <= ord(char) <= 159 for char in key))
        _json_value(key, depth + 1, remaining)
        _json_value(item, depth + 1, remaining)


def _canonical(value: Any, tokens: int = 512) -> str:
    _json_value(value, 0, [tokens])
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def fx_hash(domain: str, value: Any) -> str:
    """Domain-separated Unicode-codepoint JSON, never lossy floating point."""
    return hashlib.sha256((domain + '\n' + _canonical(value)).encode('utf-8')).hexdigest()


def _safe_time(value: Any) -> bool:
    return type(value) is int and 0 <= value <= SAFE_INTEGER


def _validate_times(raw: dict[str, Any], started: int, completed: int) -> None:
    _require(_safe_time(started) and _safe_time(completed) and 0 <= completed - started <= 10_000)
    stamp = raw.get('time')
    _require(_safe_time(stamp) and started - 1_000 <= stamp <= completed + 1_000)
    _require(completed <= now_ms() + 1_000)


def _validate_envelope(raw: Any, leg_id: str, started: int, completed: int) -> str:
    _require(type(raw) is dict and len(_canonical(raw, 256).encode('utf-8')) < 65_536)
    _require(type(raw.get('retCode')) is int and raw['retCode'] == 0)
    _validate_times(raw, started, completed)
    result = raw.get('result')
    category, symbol, field, _route = LEGS[leg_id]
    _require(type(result) is dict and result.get('category') == category)
    rows = result.get('list')
    _require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict and rows[0].get('symbol') == symbol)
    value = rows[0].get(field)
    _require(type(value) is str and DECIMAL_PATTERN.fullmatch(value) is not None)
    _require(any(char not in '0.' for char in value))
    return value  # Preserve all provider decimal digits, including trailing zeroes.


def _binding(rest: Any, mode: str) -> dict[str, Any]:
    if getattr(rest, 'id', None) != 'bybit' or mode not in ORIGINS or package_version('ccxt') != '4.5.75':
        raise UnsupportedFxEvidence('FX provider, environment, or SDK is unreviewed.')
    profile = profile_for('bybit')
    urls = getattr(rest, 'urls', None)
    api = urls.get('api') if isinstance(urls, dict) else None
    public = api.get('public') if isinstance(api, dict) else None
    expand = getattr(rest, 'implode_hostname', None)
    if not isinstance(public, str) or not callable(expand) or not callable(getattr(rest, 'publicGetV5MarketTickers', None)):
        raise UnsupportedFxEvidence('FX SDK public route is unavailable.')
    origin = expand(public)
    if origin != ORIGINS[mode] or profile is None or profile.profile_version != 1:
        raise UnsupportedFxEvidence('FX origin does not match the actual SDK route.')
    return {'version': 1, 'provider': 'bybit', 'mode': mode, 'origin': origin, 'endpoint': ENDPOINT,
            'source': SOURCE, 'ccxtVersion': '4.5.75', 'profileVersion': profile.profile_version,
            'profileHash': profile_hash(profile)}


def _requested(leg_ids: Any) -> list[str]:
    if (type(leg_ids) is not list or len(leg_ids) > 3 or any(type(leg) is not str or leg not in LEGS for leg in leg_ids)
            or len(set(leg_ids)) != len(leg_ids)):
        raise ExchangeContractError('FX request must contain at most three distinct reviewed Bybit legs.')
    return list(leg_ids)


async def _read_leg(rest: Any, mode: str, leg_id: str, budget: RecoveryReadBudget) -> dict[str, Any]:
    binding = _binding(rest, mode)
    category, symbol, field, route_id = LEGS[leg_id]
    started = now_ms()
    # The pinned SDK consumes this internal option before signing. One budget
    # call must mean at most one actual HTTP attempt, even if global retries drift.
    params = {'category': category, 'symbol': symbol, 'maxRetriesOnFailure': 0}
    raw = await budget.call(lambda: rest.publicGetV5MarketTickers(params))
    completed = now_ms()
    if _binding(rest, mode) != binding:
        raise UnsupportedFxEvidence('FX source binding changed during the read.')
    value = _validate_envelope(raw, leg_id, started, completed)
    receipt = {**binding, 'legId': leg_id, 'routeId': route_id, 'category': category, 'symbol': symbol,
               'field': field, 'value': value, 'providerQuoteAt': None, 'providerResponseAt': raw['time'],
               'timeBasis': 'provider_snapshot_observation', 'startedAt': started, 'completedAt': completed,
               'envelope': copy.deepcopy(raw), 'envelopeHash': fx_hash('bybit-fx-envelope-v1', raw)}
    return {**receipt, 'receiptHash': fx_hash('bybit-fx-receipt-v1', receipt)}


async def read_fx_evidence(rest: Any, mode: str, requested_leg_ids: Any,
                           budget: RecoveryReadBudget) -> dict[str, Any]:
    """The caller chooses due legs; each actual read consumes its existing budget.

    Local receive time is never a provider timestamp. Individual valid receipts
    survive a missing second leg; only the Node consumer decides pair/as-of fit.
    """
    legs = _requested(requested_leg_ids)
    before, receipts, reason = budget.calls, [], None
    try:
        for leg_id in legs:
            receipts.append(await _read_leg(rest, mode, leg_id, budget))
    except RecoveryBudgetExhausted:
        reason = 'budget_exhausted'
    except (NetworkError, RateLimitExceeded, TimeoutError) as error:
        budget.suspend(rest, error)
        reason = 'transient'
    except (UnsupportedFxEvidence, NotImplementedError, NotSupported, BadRequest, InvalidOrder):
        reason = 'unsupported'
    except (FxEvidenceError, ValueError, TypeError, OverflowError):
        reason = 'invalid_evidence'
    return {'version': 1, 'calls': budget.calls - before, 'receipts': receipts,
            'reason': reason, 'nextReadAt': budget.resume_at}
