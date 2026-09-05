"""One resumable account-log page using the SAME recovery budget as order/fill history."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from ccxt.base.errors import BadRequest, InvalidOrder, NetworkError, NotSupported, RateLimitExceeded

from account_log_sources import bybit_page, hyperliquid_page, kraken_page, source_spec
from common import ExchangeContractError
from history_reader import RecoveryBudgetExhausted, now_ms

DAY = 86_400_000


class SourceRetentionUnproven(ExchangeContractError):
    pass
CHECKPOINT_FIELDS = {'version', 'namespace', 'filterHash', 'accountFingerprint', 'credentialGeneration', 'revision',
                     'requiredSince', 'windowSince', 'windowUntil', 'cursor', 'scannedThrough', 'nextReadAt',
                     'lastServedAt', 'providerAccountUid', 'reason'}


def validate_log_checkpoint(value: Any, exchange: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {'audit'} != CHECKPOINT_FIELDS or value.get('version') != 1:
        raise ExchangeContractError('Invalid account-log checkpoint contract.')
    namespace, filter_hash = source_spec(exchange)
    if value['namespace'] != namespace or value['filterHash'] != filter_hash:
        raise ExchangeContractError('Account-log source/filter changed.')
    _validate_checkpoint_timestamps(value)
    _validate_checkpoint_bindings(value)
    _validate_checkpoint_tokens(value)
    _window(value)
    _validate_checkpoint_audit(value)
    if (value['scannedThrough'] or 0) > now_ms():
        raise ExchangeContractError('Account-log observation is in the future.')
    if len(json.dumps(value).encode()) >= 8192:
        raise ExchangeContractError('Account-log checkpoint exceeds its storage budget.')
    return dict(value)


def _validate_checkpoint_timestamps(value: dict[str, Any]) -> None:
    for field in ('revision', 'requiredSince', 'windowSince', 'nextReadAt', 'lastServedAt'):
        _integer(value[field])
    for field in ('windowUntil', 'scannedThrough'):
        if value[field] is not None:
            _integer(value[field])


def _validate_checkpoint_bindings(value: dict[str, Any]) -> None:
    for field in ('accountFingerprint', 'credentialGeneration'):
        token = value[field]
        if not isinstance(token, str) or len(token) != 64 or any(char not in '0123456789abcdef' for char in token):
            raise ExchangeContractError('Account-log binding is unverified.')


def _validate_checkpoint_tokens(value: dict[str, Any]) -> None:
    for field in ('cursor', 'providerAccountUid', 'reason'):
        _token(value[field])


def _validate_checkpoint_audit(value: dict[str, Any]) -> None:
    if 'audit' in value:
        _audit(value['audit'], value['requiredSince'])


def _integer(value):
    if type(value) is not int or not 0 <= value <= 9_007_199_254_740_991:
        raise ExchangeContractError('Invalid account-log timestamp/revision.')


def _token(value):
    if value is not None and (not isinstance(value, str) or not value or len(value) > 4096
                              or any(ord(char) < 32 for char in value)):
        raise ExchangeContractError('Invalid account-log cursor/token.')


def _window(value):
    start, end = value['windowSince'], value['windowUntil']
    if start < value['requiredSince'] or start > now_ms():
        raise ExchangeContractError('Invalid account-log baseline.')
    if end is not None and not start <= end <= min(start + 7 * DAY, now_ms()):
        raise ExchangeContractError('Invalid pinned account-log window.')
    if value['cursor'] is not None and end is None:
        raise ExchangeContractError('Account-log cursor lost its original window.')


def _audit(value, required_since):
    if not isinstance(value, dict) or set(value) != {'windowSince', 'windowUntil', 'cursor', 'completedAt'}:
        raise ExchangeContractError('Invalid historical account-log audit.')
    _integer(value['windowSince'])
    _integer(value['completedAt'])
    if value['windowUntil'] is not None:
        _integer(value['windowUntil'])
    _token(value['cursor'])
    _window({**value, 'requiredSince': required_since})


def _select_lane(state, now):
    today = now // DAY * DAY
    if state['revision'] % 2 == 1 and state['requiredSince'] < today and (state['scannedThrough'] or 0) >= today:
        audit = state.get('audit', {'windowSince': state['requiredSince'], 'windowUntil': None,
                                    'cursor': None, 'completedAt': 0})
        end = audit['windowUntil'] if audit['windowUntil'] is not None else min(today, audit['windowSince'] + 7 * DAY)
        return 'audit', {**state, **audit, 'windowUntil': end}
    return 'forward', state


def _finish(state, until, now):
    # Current and previous UTC day are repeatedly scanned; a separate fair audit
    # lane revisits ALL older obligations, including delayed post-midnight records.
    caught_up = until >= now - 1000
    start = max(state['requiredSince'], until // DAY * DAY - DAY) if caught_up else max(state['requiredSince'], until - 1000)
    return {**state, 'cursor': None, 'scannedThrough': max(state['scannedThrough'] or 0, until),
            'windowSince': start, 'windowUntil': None, 'nextReadAt': now + 15000 if caught_up else 0}


async def read_account_log_page(rest, exchange, checkpoint, budget, user=None):
    state = validate_log_checkpoint(checkpoint, exchange)
    if state['nextReadAt'] > now_ms():
        return None, state
    started = now_ms()
    lane, selected = _select_lane(state, started)
    pinned = {**selected, 'windowUntil': selected['windowUntil'] if selected['windowUntil'] is not None else min(started, selected['windowSince'] + 7 * DAY)}
    try:
        receipt, advanced = await _read_page(rest, exchange, pinned, selected, budget, user, started)
        receipt['lane'] = lane
        if lane == 'audit':
            advanced = _merge_audit(state, pinned, advanced, receipt)
        return receipt, advanced
    except SourceRetentionUnproven:
        return None, {**state, 'reason': 'source_retention_unproven', 'nextReadAt': started + 300000, 'lastServedAt': started}
    except RecoveryBudgetExhausted:
        return None, {**state, 'reason': 'budget_exhausted', 'nextReadAt': max(state['nextReadAt'], budget.resume_at)}
    except (NetworkError, RateLimitExceeded, TimeoutError) as error:
        budget.suspend(rest, error)
        return None, {**state, 'reason': 'transient', 'nextReadAt': budget.resume_at, 'lastServedAt': started}
    except (NotSupported, NotImplementedError, AttributeError):
        return None, {**state, 'reason': 'source_unsupported', 'nextReadAt': started + 300000, 'lastServedAt': started}
    except (BadRequest, InvalidOrder, ExchangeContractError, ValueError, KeyError, TypeError):
        return None, {**state, 'reason': 'invalid_source_evidence', 'nextReadAt': started + 60000, 'lastServedAt': started}


def _merge_audit(original, pinned, advanced, receipt):
    completed = receipt['completedAt']
    exhausted = receipt['exhausted']
    start = pinned['windowSince']
    if exhausted:
        start = original['requiredSince'] if pinned['windowUntil'] >= completed // DAY * DAY else max(original['requiredSince'], pinned['windowUntil'] - 1000)
    audit = {'windowSince': start, 'windowUntil': None if exhausted else pinned['windowUntil'],
             'cursor': receipt['nextCursor'], 'completedAt': completed if exhausted else original.get('audit', {}).get('completedAt', 0)}
    return {**original, 'audit': audit, 'lastServedAt': completed, 'providerAccountUid': advanced['providerAccountUid'],
            'reason': advanced['reason'], 'nextReadAt': advanced['nextReadAt'] if advanced['reason'] else 0}


async def _read_page(rest, exchange, pinned, original, budget, user, started):
    if exchange == 'bybit':
        observed = datetime.fromtimestamp(started / 1000, timezone.utc)
        try:
            retained = observed.replace(year=observed.year - 2)
        except ValueError:  # February 29: use the conservative March 1 boundary.
            retained = observed.replace(year=observed.year - 2, month=3, day=1)
        if pinned['windowSince'] < int(retained.timestamp() * 1000):
            raise SourceRetentionUnproven('Bybit log window predates its documented two-year retention.')
        rows, cursor, exhausted, provider_at, extra = await bybit_page(rest, pinned, budget)
    elif exchange == 'hyperliquid':
        rows, cursor, exhausted, provider_at, extra = await hyperliquid_page(rest, pinned, budget, user)
    else:
        rows, cursor, exhausted, provider_at, extra = await kraken_page(rest, pinned, budget)
    completed = now_ms()
    state = {**pinned, 'cursor': cursor, 'lastServedAt': completed, 'reason': None, 'nextReadAt': 0}
    if exchange == 'krakenfutures':
        state['providerAccountUid'] = extra
    elif extra:
        state.update(reason=extra, nextReadAt=completed + 60000)
    if exhausted:
        state = _finish(state, pinned['windowUntil'], completed)
    receipt = {'version': 1, 'namespace': pinned['namespace'], 'filterHash': pinned['filterHash'],
               'accountFingerprint': pinned['accountFingerprint'], 'credentialGeneration': pinned['credentialGeneration'],
               'since': pinned['windowSince'], 'until': pinned['windowUntil'], 'cursor': original['cursor'],
               'nextCursor': cursor, 'startedAt': started, 'completedAt': completed,
               'providerResponseAt': provider_at if type(provider_at) is int else None,
               'providerAccountUid': state['providerAccountUid'], 'exhausted': exhausted, 'records': rows}
    return receipt, state
