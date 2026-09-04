"""Explicit bounded read grants. Scheduling never advances durable source proofs."""
from __future__ import annotations

import copy
import json
import re
from importlib.metadata import version as package_version
from typing import Any

from account_log_scheduler import RecoveryBudgetSlice, propagate_cooldown, read_account_logs, read_account_mode
from ccxt_client import credential_generation
from ccxt_profiles import profile_for
from common import ExchangeContractError, external_account_id
from execution_constraints import profile_hash
from fx_evidence import LEGS, read_fx_evidence
from history_pagination import read_history_pages
from history_reader import now_ms, recover_order_evidence

PROFILE = 'bybit-usd-fx-recovery-v1'
CAPS = {'targeted': {0, 2}, 'mode': {0, 2}, 'logs': {0, 1}, 'history': {0, 4}, 'fx': {0, 1, 2, 3}}
PHASE_LANES = ({'fx', 'targeted'}, {'history', 'logs'}, {'fx', 'targeted'}, {'mode', 'logs', 'targeted'})
DEFERRED = {'phase_deferred', 'not_due', 'not_needed', 'cooldown'}
FIELDS = {'version', 'profile', 'attemptId', 'revision', 'phase', 'binding', 'cooldownUntil', 'grants'}
BINDING_FIELDS = {'accountId', 'accountFingerprint', 'credentialGeneration', 'mode', 'executionProfileHash'}
RAW_READS = frozenset({'privateGetV5ExecutionList', 'privateGetV5OrderHistory', 'privateGetV5UserQueryApi',
                      'privateGetV5AccountInfo', 'privateGetV5AccountTransactionLog', 'publicGetV5MarketTickers'})


def _require(condition, message):
    if not condition:
        raise ExchangeContractError(f'Invalid recovery schedule: {message}.')


def _shape(value, fields):
    _require(type(value) is dict and set(value) == fields, 'unexpected object fields')


def _integer(value):
    _require(type(value) is int and 0 <= value <= 9_007_199_254_740_991, 'unsafe integer')


def _token(value, maximum=256):
    _require(type(value) is str and 0 < len(value) <= maximum and value.strip() == value, 'invalid identifier')
    _require(all(ord(char) >= 32 and not 127 <= ord(char) <= 159 and not 0xD800 <= ord(char) <= 0xDFFF
                 for char in value), 'invalid identifier characters')


def _binding(value, account):
    _shape(value, BINDING_FIELDS)
    _token(value['accountId'])
    for field in ('accountFingerprint', 'credentialGeneration', 'executionProfileHash'):
        _require(type(value[field]) is str and re.fullmatch(r'[a-f0-9]{64}', value[field]) is not None, 'invalid binding hash')
    _require(value['mode'] in ('live', 'testnet') and account.get('exchange') == 'bybit', 'unsupported account scope')
    expected = {'accountId': account.get('id'), 'mode': account.get('mode'),
                'accountFingerprint': account.get('expectedAccountFingerprint'),
                'credentialGeneration': account.get('credentialGeneration')}
    _require(all(value[field] == item for field, item in expected.items()), 'outer account binding differs')
    profile = profile_for('bybit')
    _require(profile is not None and package_version('ccxt') == '4.5.75', 'unreviewed SDK/profile')
    _require(value['executionProfileHash'] == profile_hash(profile), 'installed profile differs')


def _grants(value):
    _require(type(value) is list and len(value) == 5, 'all five lanes are required')
    result = {}
    for row in value:
        _shape(row, {'lane', 'maxCalls', 'deferredReason'})
        lane = row['lane']
        _require(type(lane) is str and lane in CAPS and lane not in result, 'unknown or duplicate lane')
        _integer(row['maxCalls'])
        _require(row['maxCalls'] in CAPS[lane], 'invalid lane grant')
        reason = row['deferredReason']
        _require(reason is None if row['maxCalls'] else type(reason) is str and reason in DEFERRED,
                 'grant and deferral disagree')
        result[lane] = row['maxCalls']
    _require(sum(result.values()) <= 5, 'more than five additional reads')
    return result


def _fx_request(value, maximum):
    _shape(value, {'version', 'legIds'})
    _require(type(value['version']) is int and value['version'] == 1, 'unknown FX request version')
    legs = value['legIds']
    _require(type(legs) is list and len(legs) == maximum and 1 <= maximum <= 3, 'FX grant/leg count differs')
    _require(all(type(leg) is str and leg in LEGS for leg in legs), 'unrequested FX route')
    _require(len(set(legs)) == len(legs), 'duplicate FX leg')


def _requested_sources(recovery, query, grants):
    _require(not grants['mode'] or query.get('readAccountMode') is True, 'mode grant requires a mode request')
    _require(bool(grants['logs']) == ('accountLogs' in recovery), 'log request and grant differ')
    _require(not grants['logs'] or query.get('accountLogs') is not None, 'missing log checkpoint')
    _require(len(query.get('history', [])) == (1 if grants['history'] else 0), 'select exactly one granted history stream')
    _require(bool(grants['fx']) == ('fxEvidence' in recovery), 'FX request and grant differ')
    if grants['fx']:
        _fx_request(recovery['fxEvidence'], grants['fx'])


def recovery_schedule_request(recovery: Any, query: dict, account: dict) -> dict:
    """Only new fields are strict; a legacy request retains its existing path."""
    if not isinstance(recovery, dict) or 'recoverySchedule' not in recovery:
        _require(not isinstance(recovery, dict) or 'fxEvidence' not in recovery, 'FX requires an explicit schedule')
        return {}
    _require(set(recovery) <= {'since', 'orders', 'history', 'accountLogs', 'readAccountMode', 'recoverySchedule', 'fxEvidence'},
             'unexpected recovery request fields')
    value = recovery['recoverySchedule']
    _shape(value, FIELDS)
    _require(type(value['version']) is int and value['version'] == 1 and value['profile'] == PROFILE, 'unknown profile/version')
    _token(value['attemptId'], 36)
    _require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['attemptId']) is not None, 'invalid attempt UUID')
    for field in ('revision', 'phase', 'cooldownUntil'):
        _integer(value[field])
    _require(value['phase'] <= 3, 'invalid phase')
    _binding(value['binding'], account)
    grants = _grants(value['grants'])
    _require(all(not calls or lane in PHASE_LANES[value['phase']] for lane, calls in grants.items()), 'lane is outside its phase')
    _requested_sources(recovery, query, grants)
    _require(len(json.dumps(value, ensure_ascii=False).encode('utf-8')) < 8192, 'oversized schedule')
    return copy.deepcopy({'recoverySchedule': value, **({'fxEvidence': recovery['fxEvidence']} if 'fxEvidence' in recovery else {})})


def assert_schedule_binding(schedule, account, clients):
    if schedule is None:
        return
    binding = schedule['binding']
    _binding(binding, account)
    profile = getattr(clients, 'profile', None)
    _require(profile is not None and profile_hash(profile) == binding['executionProfileHash'], 'actual client profile differs')
    _require(getattr(clients.rest, 'id', None) == 'bybit', 'actual client provider differs')
    _require(all(clients.account.get(field) == account.get(field) for field in ('id', 'exchange', 'mode')), 'cached account scope differs')
    actual = external_account_id('bybit', account['mode'], clients.account_identity)
    _require(actual == binding['accountFingerprint'] and credential_generation(clients) == binding['credentialGeneration'],
             'actual credential binding differs')


async def _read_lane(lane, context, budget):
    query, rest, parts = context['query'], context['rest'], context['parts']
    if lane == 'targeted':
        orders, parts['checked'] = await recover_order_evidence(rest, 'bybit', query['orders'], context['listed'], context['resolve'], budget)
        parts['orders'].extend(orders)
        return {'statuses': [row['status'] for row in parts['checked']]}
    if lane == 'mode':
        bound = query['recoverySchedule']['binding']
        return await read_account_mode(rest, 'bybit', query, budget,
                                       (bound['accountFingerprint'], bound['credentialGeneration']), scheduled=True)
    if lane == 'logs':
        return await read_account_logs(rest, 'bybit', query, budget, context['user'], scheduled=True)
    if lane == 'fx':
        request = query.get('fxEvidence')
        return await read_fx_evidence(rest, context['mode'], request['legIds'], budget) if request else None
    orders, fills, progress = await read_history_pages(rest, 'bybit', query['history'], budget, parts['events'])
    parts['orders'].extend(orders)
    parts['fills'].extend(fills)
    parts['history'] = progress
    return {'statuses': [row['checkpoint']['reason'] for row in progress]}


def _reason(grant, result, calls, budget):
    if grant['maxCalls'] == 0:
        return grant['deferredReason']
    statuses = result.get('statuses', []) if result else []
    if result:
        statuses += [result.get('reason'), result.get('readSkipped', result.get('checkpoint', {}).get('reason'))]
    aliases = {'history_transient': 'transient', 'source_unsupported': 'unsupported', 'history_profile_unsupported': 'unsupported',
               'invalid_source_evidence': 'invalid_evidence', 'history_budget_exhausted': 'budget_exhausted'}
    statuses = [aliases.get(reason, reason) for reason in statuses]
    if 'transient' in statuses:
        return 'transient'
    if calls == 0 and budget.resume_at > now_ms():
        return 'cooldown'
    return next((reason for reason in ('invalid_evidence', 'unsupported', 'budget_exhausted') if reason in statuses), None)


class ScheduledBudgetSlice(RecoveryBudgetSlice):
    """Recheck the held binding around every actual read, including between FX legs."""
    def __init__(self, budget, limit, guard):
        super().__init__(budget, limit)
        self.guard = guard

    async def call(self, operation):
        self.guard()
        value = await super().call(operation)
        self.guard()
        return value


class ScheduledReadClient:
    """Per-call SDK options, scoped to the reviewed Bybit schedule only.

    CCXT 4.5.75 resolves params before method/global options in fetch2 and the
    two collection helpers. Pinning survives option drift during SDK throttle;
    neither the shared client options nor the legacy readers are modified.
    """
    def __init__(self, rest):
        self.rest = rest

    def __getattr__(self, name):
        method = getattr(self.rest, name)
        if name not in RAW_READS:
            return method

        async def single_read(params):
            return await method({**params, 'maxRetriesOnFailure': 0})
        return single_read

    async def _targeted(self, method, symbol, since, limit, params):
        # Both reviewed methods otherwise load markets (extra HTTP) implicitly.
        _require(type(self.rest.markets) is dict and bool(self.rest.markets), 'SDK markets must already be loaded')
        return await getattr(self.rest, method)(symbol, since, limit,
                                               {**params, 'paginate': False, 'maxRetriesOnFailure': 0})

    async def fetch_open_orders(self, symbol, since, limit, params):
        return await self._targeted('fetch_open_orders', symbol, since, limit, params)

    async def fetch_canceled_and_closed_orders(self, symbol, since, limit, params):
        return await self._targeted('fetch_canceled_and_closed_orders', symbol, since, limit, params)


async def read_scheduled_recovery(rest, mode, query, listed, resolve_symbol, budget, user, guard):
    """Uses the supplied single budget; hard contract errors propagate without a fake response."""
    _require(budget.calls == 0 and 0 <= budget.remaining <= 5, 'budget already consumed or enlarged')
    schedule = query['recoverySchedule']
    budget.resume_at = max(budget.resume_at, schedule['cooldownUntil'])
    parts = {'orders': [], 'fills': [], 'checked': [], 'events': [], 'history': [], 'extras': {}}
    context = {'rest': ScheduledReadClient(rest), 'mode': mode, 'query': query, 'listed': listed,
               'resolve': resolve_symbol, 'user': user, 'parts': parts}
    lanes = []
    names = {'mode': 'accountMode', 'logs': 'accountLogs', 'fx': 'fxEvidence'}
    for grant in schedule['grants']:
        guard()
        before = budget.calls
        result = await _read_lane(grant['lane'], context, ScheduledBudgetSlice(budget, grant['maxCalls'], guard))
        guard()
        calls = budget.calls - before
        _require(calls <= grant['maxCalls'], 'read exceeded its grant')
        lanes.append({'lane': grant['lane'], 'calls': calls, 'reason': _reason(grant, result, calls, budget)})
        if grant['lane'] == 'targeted':
            parts['extras']['targetedCalls'] = calls
        elif grant['lane'] in names and result is not None:
            parts['extras'][names[grant['lane']]] = result
    propagate_cooldown(parts['extras'].get('accountLogs'), budget)
    _require(sum(lane['calls'] for lane in lanes) == budget.calls <= 5, 'shared call accounting differs')
    parts['extras']['recoverySchedule'] = {'version': 1, 'profile': PROFILE, 'attemptId': schedule['attemptId'],
        'baseRevision': schedule['revision'], 'phase': schedule['phase'], 'binding': copy.deepcopy(schedule['binding']),
        'calls': budget.calls, 'cooldownUntil': budget.resume_at, 'lanes': lanes}
    return parts
