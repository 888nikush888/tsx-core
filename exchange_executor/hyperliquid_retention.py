"""Restartable last-10,000 retention proof; never execution ownership evidence."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from common import ExchangeContractError
from history_reader import RecoveryReadBudget, now_ms

LIMIT = 2000
RETENTION = 10000
PHASES = {'witness', 'horizon', 'scan', 'verify', 'proved'}
FIELDS = {'version', 'phase', 'originalSince', 'originalUntil', 'startedAt', 'fixedUntil',
          'cursor', 'count', 'anchor', 'validatedAt'}


def _number(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 9_007_199_254_740_991:
        raise ExchangeContractError('Invalid Hyperliquid retention number.')
    return value


def _token(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(char) < 32 for char in value):
        raise ExchangeContractError('Invalid Hyperliquid retention identity.')
    return value


def _anchor(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {'coin', 'tid', 'time', 'payloadHash'}:
        raise ExchangeContractError('Invalid Hyperliquid retention anchor.')
    result = {'coin': _token(value['coin']), 'tid': _token(value['tid']), 'time': _number(value['time']),
              'payloadHash': value['payloadHash']}
    if not isinstance(result['payloadHash'], str) or not re.fullmatch('[0-9a-f]{64}', result['payloadHash']):
        raise ExchangeContractError('Invalid Hyperliquid retention payload hash.')
    return result


def validate_retention(value: Any, state: dict[str, Any]) -> dict[str, Any] | None:
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) != FIELDS or type(value.get('version')) is not int or value.get('version') != 1
            or value.get('phase') not in PHASES or state['source'] != 'fills' or state['providerSymbol'] is not None):
        raise ExchangeContractError('Invalid Hyperliquid retention checkpoint.')
    result = dict(value)
    for field in ('originalSince', 'originalUntil', 'startedAt', 'cursor', 'count'):
        result[field] = _number(value[field])
    for field in ('fixedUntil', 'validatedAt'):
        result[field] = None if value[field] is None else _number(value[field])
    result['anchor'] = None if value['anchor'] is None else _anchor(value['anchor'])
    _validate_phase(result)
    _validate_window(result, state)
    return result


def _validate_window(probe: dict[str, Any], state: dict[str, Any]) -> None:
    if not state['baselineSince'] <= probe['originalSince'] <= probe['originalUntil'] <= probe['startedAt'] <= now_ms() + 60_000:
        raise ExchangeContractError('Invalid Hyperliquid retention original window.')
    if probe['phase'] == 'proved':
        if state['scannedThrough'] is None or state['scannedThrough'] < min(probe['originalUntil'], probe['fixedUntil']):
            raise ExchangeContractError('Hyperliquid retention proof lacks traversal.')
    elif (state['windowSince'], state['windowUntil']) != (probe['originalSince'], probe['originalUntil']):
        raise ExchangeContractError('Hyperliquid retention changed its original window.')


def _validate_retention_anchor(probe: dict[str, Any]) -> None:
    if probe['phase'] == 'witness':
        if (probe['anchor'] is not None or probe['fixedUntil'] is not None
                or probe['count'] != 0 or probe['cursor'] != 0):
            raise ExchangeContractError('Invalid Hyperliquid initial retention phase.')
        return
    anchor = probe['anchor']
    if anchor is None or not 1 <= probe['count'] < RETENTION or anchor['time'] > probe['cursor']:
        raise ExchangeContractError('Invalid Hyperliquid counted retention anchor.')


def _validate_retention_horizon(probe: dict[str, Any]) -> None:
    phase, fixed = probe['phase'], probe['fixedUntil']
    if phase == 'horizon' and fixed is not None:
        raise ExchangeContractError('Hyperliquid horizon was fixed before reading its source.')
    if phase in {'scan', 'verify', 'proved'}:
        if fixed is None or not probe['startedAt'] <= fixed <= now_ms() + 60_000 or probe['cursor'] > fixed + 1:
            raise ExchangeContractError('Invalid Hyperliquid fixed retention horizon.')


def _validate_retention_time(probe: dict[str, Any]) -> None:
    phase = probe['phase']
    if phase == 'proved':
        if probe['validatedAt'] is None or not probe['startedAt'] <= probe['validatedAt'] <= now_ms() + 60_000:
            raise ExchangeContractError('Invalid Hyperliquid retention validation time.')
    elif probe['validatedAt'] is not None:
        raise ExchangeContractError('Unverified Hyperliquid retention has a validation time.')


def _validate_phase(probe: dict[str, Any]) -> None:
    _validate_retention_anchor(probe)
    _validate_retention_horizon(probe)
    _validate_retention_time(probe)


def begin_retention(state: dict[str, Any]) -> dict[str, Any]:
    return {**state, 'completeness': 'unknown', 'reason': 'retention_probe_pending', 'nextReadAt': 0,
            'retention': {'version': 1, 'phase': 'witness', 'originalSince': state['windowSince'],
                          'originalUntil': state['windowUntil'], 'startedAt': now_ms(), 'fixedUntil': None,
                          'cursor': 0, 'count': 0, 'anchor': None, 'validatedAt': None}}


def _rows(response: Any) -> tuple[list[dict[str, Any]], list[int]]:
    if not isinstance(response, list) or len(response) > LIMIT or any(not isinstance(row, dict) for row in response):
        raise ExchangeContractError('Invalid Hyperliquid retention collection.')
    times = [_number(row.get('time')) for row in response]
    if any(stamp > now_ms() + 60_000 for stamp in times):
        raise ExchangeContractError('Hyperliquid retention provider clock exceeds allowed skew.')
    return response, times


def _identity(row: dict[str, Any]) -> dict[str, Any]:
    tid = row.get('tid')
    if type(tid) is int:
        tid = str(_number(tid))
    # Canonical JSON preserves provider economic values exactly (no binary-float
    # conversion). Include all payload fields so an economic amendment invalidates it.
    if any(field not in row for field in ('coin', 'tid', 'time', 'oid', 'px', 'sz', 'side')):
        raise ExchangeContractError('Hyperliquid retention anchor omitted economic identity.')
    try:
        encoded = json.dumps(row, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()
    except (TypeError, ValueError) as error:
        raise ExchangeContractError('Invalid Hyperliquid retention economic payload.') from error
    if len(encoded) > 16384:
        raise ExchangeContractError('Oversized Hyperliquid retention economic payload.')
    return _anchor({'coin': row.get('coin'), 'tid': tid, 'time': row.get('time'),
                    'payloadHash': hashlib.sha256(encoded).hexdigest()})


def _pending(state: dict[str, Any], probe: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    return {**state, 'retention': probe, 'nextReadAt': 0, 'completeness': 'unknown', 'reason': 'retention_probe_pending'}, None


def _discard(state: dict[str, Any], reason: str) -> tuple[dict[str, Any], str | None]:
    return {**state, 'retention': None, 'completeness': 'unknown', 'reason': reason, 'nextReadAt': now_ms() + 60_000}, None


def _retention_params(user: str, probe: dict[str, Any]) -> dict[str, Any]:
    params = {'type': 'userFillsByTime', 'user': user, 'startTime': 0, 'aggregateByTime': False}
    if probe['phase'] == 'horizon':
        return {'type': 'userFills', 'user': user, 'aggregateByTime': False}
    elif probe['phase'] == 'scan':
        params.update(startTime=probe['cursor'], endTime=probe['fixedUntil'])
    return params


def _witness_step(state: dict[str, Any], probe: dict[str, Any], rows: list[dict[str, Any]],
                  times: list[int]) -> tuple[dict[str, Any], str | None]:
    if not times or min(times) < state['windowSince']:
        return {**state, 'retention': None}, 'covered'
    anchor = _identity(rows[times.index(min(times))])
    if len(times) == LIMIT and min(times) == max(times):
        return _discard(state, 'timestamp_page_saturated')
    return _pending(state, {**probe, 'phase': 'horizon', 'count': len(rows), 'cursor': max(times), 'anchor': anchor})


def _horizon_step(state: dict[str, Any], probe: dict[str, Any], times: list[int]) -> tuple[dict[str, Any], str | None]:
    # The latest-fill endpoint supplies only an upper time bound, never a count proof.
    if not times or max(times) < probe['cursor']:
        return _discard(state, 'retention_anchor_changed')
    return _pending(state, {**probe, 'phase': 'scan', 'fixedUntil': max(now_ms(), max(times))})


def _verify_step(state: dict[str, Any], probe: dict[str, Any], rows: list[dict[str, Any]]) -> tuple[dict[str, Any], str | None]:
    matching = [row for row in rows if (row.get('coin'), str(row.get('tid')), row.get('time'))
                == (probe['anchor']['coin'], probe['anchor']['tid'], probe['anchor']['time'])]
    if len(matching) != 1 or _identity(matching[0]) != probe['anchor']:
        return _discard(state, 'retention_anchor_changed')
    return {**state, 'retention': {**probe, 'phase': 'proved', 'validatedAt': now_ms()},
            'windowUntil': min(probe['originalUntil'], probe['fixedUntil'])}, 'covered'


async def retention_step(rest: Any, user: str, state: dict[str, Any], budget: RecoveryReadBudget) -> tuple[dict[str, Any], str | None]:
    """Exactly one HTTP request per step, so every successful phase is resumable."""
    probe = state['retention']
    params = _retention_params(user, probe)
    rows, times = _rows(await budget.call(lambda: rest.publicPostInfo(params)))
    if probe['phase'] == 'witness':
        return _witness_step(state, probe, rows, times)
    if probe['phase'] == 'horizon':
        return _horizon_step(state, probe, times)
    if probe['phase'] == 'scan':
        return _scan(state, probe, times)
    if probe['phase'] != 'verify':
        raise ExchangeContractError('A retained proof cannot be reused as a fresh provider read.')
    return _verify_step(state, probe, rows)


def _scan(state: dict[str, Any], probe: dict[str, Any], times: list[int]) -> tuple[dict[str, Any], str | None]:
    start, end = probe['cursor'], probe['fixedUntil']
    if any(stamp < start or stamp > end for stamp in times):
        raise ExchangeContractError('Hyperliquid retention event outside its fixed scan window.')
    count = probe['count'] + len(times)  # All rows, including every inclusive overlap.
    if count >= RETENTION:
        return {**state, 'retention': None}, 'limit'
    if not times:
        return _pending(state, {**probe, 'phase': 'verify', 'count': count})
    last = max(times)
    if last == start and len(times) == LIMIT:
        return _discard(state, 'timestamp_page_saturated')
    cursor = last if last > start else last + 1
    # A short single-timestamp boundary consumes the inclusive end itself. There
    # is then no further timestamp inside this fixed window to query.
    return _pending(state, {**probe, 'phase': 'verify' if cursor > end else 'scan', 'cursor': cursor, 'count': count})
