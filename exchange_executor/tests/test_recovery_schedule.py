"""Scheduled recovery through the real SDK transport with exclusively local fakes."""
from __future__ import annotations

import copy
import json
import sys
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

from ccxt.async_support import bybit
from ccxt.base.errors import RateLimitExceeded, RequestTimeout

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_log_sources import source_spec
from ccxt_adapter import CcxtAdapter
from ccxt_client import credential_generation
from ccxt_profiles import profile_for
from common import ExchangeContractError, RequestDeadline, external_account_id
from execution_constraints import profile_hash
from history_reader import source_evidence
from recovery_schedule import recovery_schedule_request

LEGS = ['bybit:btc-usd-index:v1', 'bybit:btc-usdt-index:v1', 'bybit:usdc-usd-index:v1']
LANES = ['targeted', 'mode', 'logs', 'history', 'fx']
SYMBOL = 'BTC/USDT:USDT'


def now():
    return int(time.time() * 1000)


class RecoveryScheduleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rest = bybit({'enableRateLimit': False, 'apiKey': 'isolated-fake-key', 'secret': 'isolated-fake-secret'})
        self.account = {'id': 'scheduled-fixture', 'exchange': 'bybit', 'mode': 'live'}
        self.clients = SimpleNamespace(rest=self.rest, account=dict(self.account), profile=profile_for('bybit'),
            account_identity='isolated-identity', credential_fingerprint='isolated-credential')
        self.account.update(expectedAccountFingerprint=external_account_id('bybit', 'live', self.clients.account_identity),
                            credentialGeneration=credential_generation(self.clients))
        self.registry = SimpleNamespace(account=AsyncMock(return_value=self.clients), assert_binding=lambda *_args: None)
        self.adapter = CcxtAdapter(self.registry)
        self.adapter._recent_historical_orders = AsyncMock(return_value=[])
        self.adapter._recent_trades = AsyncMock(return_value=[])
        self.market = {'symbol': SYMBOL, 'id': 'BTCUSDT', 'base': 'BTC', 'contract': True, 'linear': True,
            'contractSize': 1, 'type': 'swap', 'swap': True, 'spot': False, 'future': False, 'option': False, 'inverse': False}
        self.rest.market = lambda _symbol: self.market
        self.rest.markets = {SYMBOL: self.market}
        self.http = []
        self.transform = lambda _path, _params, raw: raw

        async def fetch(url, method='GET', headers=None, body=None):
            parsed = urlsplit(url)
            params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
            self.http.append((parsed.path, params))
            self.assertEqual((parsed.netloc, method, body), ('api.bybit.com', 'GET', None))
            raw = self.transform(parsed.path, params, self.envelope(parsed.path, params))
            return self.rest.parse_json(json.dumps(raw))

        self.rest.fetch = fetch

        async def current(*_args):
            return [], [], [source_evidence(name, now(), 'complete') for name in ('orders', 'positions')]

        self.current = AsyncMock(side_effect=current)
        self.current_patch = patch('ccxt_adapter.read_current_state', new=self.current)
        self.current_patch.start()

    async def asyncTearDown(self):
        self.current_patch.stop()
        await self.rest.close()

    def envelope(self, path, params):
        result = {'category': params.get('category', 'linear'), 'list': [], 'nextPageCursor': ''}
        if path == '/v5/market/tickers':
            field = 'usdIndexPrice' if params['symbol'] == 'USDCUSDT' else 'indexPrice'
            result['list'] = [{'symbol': params['symbol'], field: '1.00250'}]
        elif path == '/v5/user/query-api':
            result = {'userID': '21', 'parentUid': '0', 'isMaster': True, 'uta': 1}
        elif path == '/v5/account/info':
            result = {'unifiedMarginStatus': 5, 'updatedTime': str(now())}
        return {'retCode': 0, 'retMsg': 'OK', 'time': now(), 'result': result}

    def query(self, phase=0):
        counts = [{'fx': 3, 'targeted': 2}, {'history': 4, 'logs': 1},
                  {'targeted': 2, 'fx': 3}, {'mode': 2, 'logs': 1, 'targeted': 2}][phase]
        order = list(counts) + [lane for lane in LANES if lane not in counts]
        binding = {'accountId': self.account['id'], 'accountFingerprint': self.account['expectedAccountFingerprint'],
            'credentialGeneration': self.account['credentialGeneration'], 'mode': 'live',
            'executionProfileHash': profile_hash(self.clients.profile)}
        since = now() - 10000
        query = {'since': since, 'orders': [{'clientOrderId': 'client-1', 'exchangeOrderId': 'order-1',
            'providerSymbol': SYMBOL, 'symbol': 'BTCUSDT', 'role': 'entry'}], 'history': [], 'readAccountMode': True,
            'recoverySchedule': {'version': 1, 'profile': 'bybit-usd-fx-recovery-v1',
                'attemptId': '00000000-0000-4000-8000-000000000001', 'revision': 0, 'phase': phase,
                'binding': binding, 'cooldownUntil': 0,
                'grants': [{'lane': lane, 'maxCalls': counts.get(lane, 0),
                    'deferredReason': None if lane in counts else 'phase_deferred'} for lane in order]}}
        if 'fx' in counts:
            query['fxEvidence'] = {'version': 1, 'legIds': list(LEGS)}
        if 'history' in counts:
            query['history'] = [{'source': 'fills', 'providerSymbol': None, 'revision': 0, 'baselineSince': since,
                'windowSince': since, 'windowUntil': now(), 'cursor': None, 'scannedThrough': None, 'nextReadAt': 0,
                'completeness': 'unknown', 'reason': 'history_pending', 'coverage': None, 'retention': None}]
        if 'logs' in counts:
            namespace, filter_hash = source_spec('bybit')
            query['accountLogs'] = {'version': 1, 'namespace': namespace, 'filterHash': filter_hash,
                'accountFingerprint': binding['accountFingerprint'], 'credentialGeneration': binding['credentialGeneration'],
                'revision': 1, 'requiredSince': since, 'windowSince': since, 'windowUntil': now(), 'cursor': None,
                'scannedThrough': None, 'nextReadAt': 0, 'lastServedAt': 0, 'providerAccountUid': None, 'reason': None}
        return query

    async def read(self, query, deadline=None):
        return await self.adapter.open_state(self.account, deadline or RequestDeadline(now() + 30000), query)

    async def test_four_call_history_has_its_full_grant_and_defers_targeted_and_mode(self):
        query = self.query(1)
        original = copy.deepcopy(query)
        result = (await self.read(query))['acquisition']
        self.assertEqual([params['category'] for path, params in self.http if path == '/v5/execution/list'],
                         ['linear', 'inverse', 'spot', 'option'])
        self.assertEqual((len(self.http), result['recoverySchedule']['calls'], result['history'][0]['pages']), (5, 5, 4))
        self.assertEqual(result['targetedCalls'], 0)
        self.assertEqual(result['checkedOrders'][0]['status'], 'budget_exhausted')
        self.assertEqual(result['accountMode'], {'calls': 0, 'observation': None, 'reason': 'budget_exhausted'})
        self.assertEqual(result['accountLogs']['calls'], 1)
        self.assertEqual(query, original, 'Scheduling never changes original caller checkpoints.')
        self.assertEqual(next(row for row in result['sources'] if row['source'] == 'fills')['completeness'], 'unknown')

    async def test_fx_and_targeted_order_follow_grants_and_actual_calls_are_deltas(self):
        for phase in (0, 2):
            with self.subTest(phase=phase):
                self.http.clear()
                result = (await self.read(self.query(phase)))['acquisition']
                self.assertEqual((result['fxEvidence']['calls'], result['targetedCalls'], len(self.http)), (3, 2, 5))
                self.assertEqual(result['recoverySchedule']['calls'], 5)
                self.assertEqual(self.http[0][0], '/v5/market/tickers' if phase == 0 else '/v5/order/realtime')
                self.assertEqual(result['checkedOrders'][0]['status'], 'not_found')
                self.assertNotIn('accountLogs', result)
                self.assertEqual(result['history'], [])

    async def test_partial_fx_preserves_original_prefix_without_donating_unused_calls(self):
        def invalid_second(path, params, raw):
            if path == '/v5/market/tickers' and params['symbol'] == 'BTCUSDT':
                raw['result']['list'][0]['indexPrice'] = None
            return raw
        self.transform = invalid_second
        result = (await self.read(self.query()))['acquisition']
        self.assertEqual((result['fxEvidence']['calls'], result['fxEvidence']['reason']), (2, 'invalid_evidence'))
        self.assertEqual([row['legId'] for row in result['fxEvidence']['receipts']], LEGS[:1])
        self.assertEqual((result['targetedCalls'], result['recoverySchedule']['calls'], len(self.http)), (2, 4, 4))
        self.assertIsNone(result['fxEvidence']['receipts'][0]['providerQuoteAt'])

    async def test_mode_grant_bypasses_legacy_odd_log_revision_without_mutating_it(self):
        query = self.query(3)
        result = (await self.read(query))['acquisition']
        self.assertEqual(result['accountMode']['calls'], 2)
        self.assertEqual(result['accountMode']['observation']['unifiedMarginStatus'], 5)
        self.assertEqual((query['accountLogs']['revision'], result['accountLogs']['baseRevision']), (1, 1))
        self.assertEqual(result['recoverySchedule']['calls'], 5)
        self.assertNotIn('fxEvidence', result)

    async def test_positive_lane_outside_its_phase_is_rejected_before_reads(self):
        query = self.query(1)
        query['recoverySchedule']['phase'] = 0
        with self.assertRaises(ExchangeContractError):
            await self.read(query)
        self.assertEqual(self.http, [])

    async def test_actual_sdk_retries_cannot_escape_the_scheduled_five_call_budget(self):
        self.rest.options['maxRetriesOnFailure'] = 1
        self.rest.options['maxRetriesOnFailureDelay'] = 0
        def failed(path, _params, raw):
            if path == '/v5/order/realtime':
                raise RequestTimeout('Only the local transport fixture fails')
            return raw
        self.transform = failed
        with self.assertRaises(RequestTimeout):
            await self.rest.privateGetV5OrderRealtime({'orderId': 'order-1'})
        self.assertEqual(len(self.http), 2, 'The real SDK retries one logical call internally.')
        self.http.clear()
        result = (await self.read(self.query(2)))['acquisition']
        self.assertEqual((len(self.http), result['targetedCalls'], result['recoverySchedule']['calls']), (1, 1, 1))
        self.assertEqual(result['checkedOrders'][0]['status'], 'transient')
        self.assertEqual(self.rest.options['maxRetriesOnFailure'], 1, 'Never mutate the shared SDK configuration.')
        self.current.assert_awaited_once()

    async def test_actual_sdk_autopagination_cannot_escape_a_targeted_grant(self):
        def pages(path, _params, raw):
            if path == '/v5/order/realtime':
                raw['result'].update(nextPageCursor=f'cursor-{len(self.http)}', list=[{
                    'symbol': 'BTCUSDT', 'orderId': 'order-1', 'orderLinkId': 'client-1', 'side': 'Buy',
                    'orderType': 'Limit', 'orderStatus': 'New', 'qty': '1', 'price': '100', 'cumExecQty': '0',
                    'cumExecValue': '0', 'avgPrice': '0', 'createdTime': str(now() - 100), 'updatedTime': str(now()),
                    'reduceOnly': False}])
            return raw
        self.transform = pages
        await self.rest.fetch_open_orders(SYMBOL, now() - 1000, 50,
                                         {'orderId': 'order-1', 'paginate': True, 'paginationCalls': 3})
        self.assertEqual(len(self.http), 3, 'The real collection helper follows provider cursors internally.')
        self.http.clear()
        self.rest.options.update(paginate=True, paginationCalls=3)
        result = (await self.read(self.query()))['acquisition']
        self.assertEqual((len(self.http), result['targetedCalls'], result['recoverySchedule']['calls']), (4, 1, 4))
        self.assertEqual(result['checkedOrders'][0]['status'], 'observed')
        self.assertIs(self.rest.options['paginate'], True)
        self.assertTrue(all('paginate' not in params and 'maxRetriesOnFailure' not in params for _path, params in self.http),
                        'The actual SDK consumes internal options before the signed transport.')

    async def test_all_scheduled_raw_paths_pin_method_specific_retry_options(self):
        cases = [(2, '/v5/order/realtime'), (2, '/v5/order/history'), (3, '/v5/user/query-api'),
                 (3, '/v5/account/info'), (3, '/v5/account/transaction-log'),
                 (1, '/v5/execution/list'), (0, '/v5/market/tickers')]
        for phase, endpoint in cases:
            with self.subTest(endpoint=endpoint):
                self.http.clear()
                self.rest.options[endpoint[1:]] = {'defaultMaxRetriesOnFailure': 2}
                def failure(path, _params, raw):
                    if path == endpoint:
                        raise RequestTimeout('Local method-specific retry fixture')
                    return raw
                self.transform = failure
                result = (await self.read(self.query(phase)))['acquisition']
                self.assertEqual(sum(path == endpoint for path, _params in self.http), 1)
                self.assertEqual(len(self.http), result['recoverySchedule']['calls'])
                self.assertLessEqual(len(self.http), 5)
                self.assertEqual(self.rest.options[endpoint[1:]], {'defaultMaxRetriesOnFailure': 2})

    async def test_method_specific_autopagination_is_pinned_for_both_targeted_helpers(self):
        self.rest.options['fetchOpenOrders'] = {'defaultPaginate': True, 'paginationCalls': 4}
        self.rest.options['fetchCanceledAndClosedOrders'] = {'paginate': True, 'paginationCalls': 4}
        result = (await self.read(self.query(2)))['acquisition']
        self.assertEqual([path for path, _params in self.http[:2]], ['/v5/order/realtime', '/v5/order/history'])
        self.assertEqual((len(self.http), result['targetedCalls'], result['recoverySchedule']['calls']), (5, 2, 5))

    async def test_sdk_option_drift_during_throttle_cannot_enable_an_extra_http_attempt(self):
        self.rest.enableRateLimit = True
        async def throttle(_cost):
            self.rest.options['maxRetriesOnFailure'] = 2
        self.rest.throttle = throttle
        def failure(path, _params, raw):
            if path == '/v5/order/realtime':
                raise RequestTimeout('Only the local transport fails after throttle')
            return raw
        self.transform = failure
        result = (await self.read(self.query(2)))['acquisition']
        self.assertEqual((len(self.http), result['targetedCalls'], result['recoverySchedule']['calls']), (1, 1, 1))
        self.assertEqual(result['checkedOrders'][0]['status'], 'transient')

    async def test_targeted_sdk_cannot_start_an_unbudgeted_market_bootstrap(self):
        self.rest.markets = None
        with self.assertRaisesRegex(ExchangeContractError, 'SDK markets'):
            await self.read(self.query(2))
        self.assertEqual(self.http, [])

    async def test_all_zero_not_due_without_modeflag_does_not_enter_legacy_reads(self):
        query = self.query()
        query.pop('fxEvidence')
        query.pop('readAccountMode')
        for grant in query['recoverySchedule']['grants']:
            grant.update(maxCalls=0, deferredReason='not_due')
        result = (await self.read(query))['acquisition']
        self.assertEqual((self.http, result['targetedCalls'], result['history']), ([], 0, []))
        self.assertNotIn('accountMode', result)
        self.assertTrue(all(row['reason'] == 'not_due' for row in result['recoverySchedule']['lanes']))

    async def test_rotating_fx_legs_retains_valid_originals_after_a_persistent_other_leg_failure(self):
        def invalid_first_asset(path, params, raw):
            if path == '/v5/market/tickers' and params['symbol'] == 'BTCUSD':
                raw['result']['list'][0]['indexPrice'] = None
            return raw
        self.transform = invalid_first_asset
        received = set()
        for ordering in ([0, 1, 2], [2, 0, 1], [1, 0, 2], [2, 1, 0]):
            query = self.query()
            query['fxEvidence']['legIds'] = [LEGS[index] for index in ordering]
            result = (await self.read(query))['acquisition']['fxEvidence']
            prefix = [row['legId'] for row in result['receipts']]
            self.assertEqual(prefix, query['fxEvidence']['legIds'][:len(prefix)])
            received.update(prefix)
        self.assertEqual(received, {LEGS[1], LEGS[2]})

    async def test_hard_history_contract_error_has_no_fabricated_progress_or_phase_advance(self):
        query = self.query(1)
        original = copy.deepcopy(query)
        def foreign_history(path, params, raw):
            if path == '/v5/execution/list' and params['category'] == 'inverse':
                raw['result']['list'] = [{'execId': 'foreign-original'}]
            return raw
        self.transform = foreign_history
        with self.assertRaisesRegex(ExchangeContractError, 'Unmanaged Bybit inverse'):
            await self.read(query)
        self.assertEqual(query, original)
        self.assertEqual(len(self.http), 2)

    async def test_actual_binding_drift_during_current_read_stops_scheduled_http(self):
        async def changed(*_args):
            self.clients.credential_fingerprint = 'rotated-while-reading'
            return [], [], [source_evidence(name, now(), 'complete') for name in ('orders', 'positions')]
        self.current.side_effect = changed
        with self.assertRaises(ExchangeContractError):
            await self.read(self.query())
        self.assertEqual(self.http, [])

    async def test_binding_drift_between_fx_legs_stops_the_next_http_and_discards_response(self):
        def changed(path, _params, raw):
            if path == '/v5/market/tickers':
                self.clients.profile = replace(self.clients.profile, profile_version=2)
            return raw
        self.transform = changed
        with self.assertRaises(ExchangeContractError):
            await self.read(self.query())
        self.assertEqual(len(self.http), 1)

    async def test_current_positive_order_is_still_observed_without_spending_targeted_grant(self):
        order = {'id': 'order-1', 'clientOrderId': 'client-1', 'symbol': SYMBOL, 'side': 'buy', 'type': 'limit',
                 'status': 'open', 'amount': '1', 'filled': '0', 'price': '100', 'average': None, 'reduceOnly': False}
        async def current(*_args):
            return [order], [], [source_evidence(name, now(), 'complete') for name in ('orders', 'positions')]
        self.current.side_effect = current
        result = (await self.read(self.query()))['acquisition']
        self.assertEqual(result['checkedOrders'], [{'clientOrderId': 'client-1', 'status': 'observed'}])
        self.assertEqual((result['targetedCalls'], result['recoverySchedule']['calls']), (0, 3))

    async def test_skipped_log_turns_preserve_actual_forward_audit_rotation(self):
        query = self.query(1)
        log = query['accountLogs']
        log.update(requiredSince=now() - 2 * 86400000, scannedThrough=now())
        first = (await self.read(query))['acquisition']['accountLogs']
        self.assertEqual(first['receipts'][0]['lane'], 'audit')
        for phase in (2, 0):
            self.assertNotIn('accountLogs', (await self.read(self.query(phase)))['acquisition'])
        next_query = self.query(3)
        next_query['accountLogs'] = first['checkpoint']
        # Root may rotate the leading domains without creating new grants.
        grants = next_query['recoverySchedule']['grants']
        grants[0], grants[1] = grants[1], grants[0]
        count = len(self.http)
        following = (await self.read(next_query))['acquisition']['accountLogs']
        self.assertEqual(self.http[count][0], '/v5/account/transaction-log')
        self.assertEqual(following['receipts'][0]['lane'], 'forward')
        self.assertEqual(following['baseRevision'], first['checkpoint']['revision'])

    async def test_deadline_deferred_positive_log_grant_does_not_rotate_unread_log_revision(self):
        query = self.query(1)
        query['accountLogs']['reason'] = 'invalid_source_evidence'
        original = copy.deepcopy(query['accountLogs'])
        http = self.http
        class AfterHistoryDeadline(RequestDeadline):
            def remaining_ms(self):
                return 1000 if len(http) >= 4 else super().remaining_ms()
        result = (await self.read(query, AfterHistoryDeadline(now() + 30000)))['acquisition']
        self.assertEqual((len(self.http), result['history'][0]['pages'], result['accountLogs']['calls']), (4, 4, 0))
        self.assertEqual(result['accountLogs']['receipts'], [])
        self.assertEqual(result['accountLogs']['readSkipped'], 'budget_exhausted')
        self.assertEqual(next(row for row in result['recoverySchedule']['lanes'] if row['lane'] == 'logs')['reason'], 'budget_exhausted')
        self.assertEqual(result['accountLogs']['checkpoint'], original,
                         'A budget-deferred attempt is not a served forward/audit log turn.')

    async def test_deadline_zero_then_paid_log_turns_keep_both_audit_and_forward_live(self):
        def continuing_logs(path, _params, raw):
            if path == '/v5/account/transaction-log':
                raw['result']['nextPageCursor'] = f'cursor-{len(self.http)}'
            return raw
        self.transform = continuing_logs
        log = self.query(1)['accountLogs']
        log.update(requiredSince=now() - 2 * 86400000, scannedThrough=now())
        receipts = []
        for _ in range(4):
            query = self.query(1)
            query['accountLogs'] = log
            http, before = self.http, len(self.http)
            class AfterHistoryDeadline(RequestDeadline):
                def remaining_ms(self):
                    return 1000 if len(http) - before >= 4 else super().remaining_ms()
            unpaid = (await self.read(query, AfterHistoryDeadline(now() + 30000)))['acquisition']['accountLogs']
            self.assertEqual(unpaid['checkpoint'], log)
            self.assertEqual(unpaid['readSkipped'], 'budget_exhausted')
            paid_query = self.query(3)
            paid_query['accountLogs'] = log
            paid = (await self.read(paid_query))['acquisition']['accountLogs']
            self.assertNotIn('readSkipped', paid)
            self.assertEqual(paid['calls'], 1)
            receipts.append(paid['receipts'][0]['lane'])
            log = paid['checkpoint']
        self.assertEqual(receipts, ['audit', 'forward', 'audit', 'forward'])

    async def test_zero_grants_never_manufacture_absence_or_unread_producer_progress(self):
        query = self.query()
        query.pop('fxEvidence')
        for grant in query['recoverySchedule']['grants']:
            grant.update(maxCalls=0, deferredReason='phase_deferred')
        result = (await self.read(query))['acquisition']
        self.assertEqual(self.http, [])
        self.assertEqual(result['checkedOrders'][0]['status'], 'budget_exhausted')
        self.assertEqual(result['recoverySchedule']['calls'], 0)
        self.assertTrue(all(row['calls'] == 0 and row['reason'] == 'phase_deferred' for row in result['recoverySchedule']['lanes']))
        self.assertNotIn('accountLogs', result)
        self.assertNotIn('fxEvidence', result)
        self.current.assert_awaited_once()

    async def test_shared_cooldown_and_original_deadline_stop_every_additional_lane(self):
        for cooldown, remaining in ((now() + 60000, 30000), (0, 1000)):
            with self.subTest(cooldown=cooldown):
                self.http.clear()
                query = self.query()
                query['recoverySchedule']['cooldownUntil'] = cooldown
                result = (await self.read(query, RequestDeadline(now() + remaining)))['acquisition']
                self.assertEqual((len(self.http), result['recoverySchedule']['calls']), (0, 0))
                self.assertEqual(result['fxEvidence']['reason'], 'budget_exhausted')
                self.assertGreaterEqual(result['recoverySchedule']['cooldownUntil'], cooldown)

    async def test_partial_rate_limit_preserves_receipt_and_suspends_remaining_lanes(self):
        def limited(path, params, raw):
            if path == '/v5/market/tickers' and params['symbol'] == 'BTCUSDT':
                raise RateLimitExceeded('Local fixture only')
            return raw
        self.transform = limited
        result = (await self.read(self.query()))['acquisition']
        self.assertEqual((len(self.http), result['recoverySchedule']['calls']), (2, 2))
        self.assertEqual(result['fxEvidence']['reason'], 'transient')
        self.assertEqual(len(result['fxEvidence']['receipts']), 1)
        self.assertEqual(result['targetedCalls'], 0)
        self.assertGreater(result['recoverySchedule']['cooldownUntil'], now())

    async def test_bound_profile_and_account_fields_are_not_self_asserted_receipt_authority(self):
        for field in ('accountId', 'accountFingerprint', 'credentialGeneration', 'mode', 'executionProfileHash'):
            query = self.query()
            query['recoverySchedule']['binding'][field] = 'testnet' if field == 'mode' else ('f' * 64)
            with self.subTest(field=field), self.assertRaises(ExchangeContractError):
                await self.read(query)
        self.assertEqual(self.http, [])
        query = self.query()
        self.clients.profile = replace(self.clients.profile, profile_version=2)
        with self.assertRaises(ExchangeContractError):
            await self.read(query)
        self.assertEqual(self.http, [])

    async def test_contract_rejects_missing_duplicate_excessive_or_request_only_fields(self):
        mutations = [lambda q: q['recoverySchedule']['grants'].pop(),
            lambda q: q['recoverySchedule']['grants'].__setitem__(4, copy.deepcopy(q['recoverySchedule']['grants'][0])),
            lambda q: q['recoverySchedule']['grants'][0].update(maxCalls=True),
            lambda q: q['recoverySchedule']['grants'][0].update(maxCalls=6),
            lambda q: q['recoverySchedule'].update(version=2),
            lambda q: q['recoverySchedule'].update(phase=4),
            lambda q: q['recoverySchedule'].update(nextPhase=1),
            lambda q: q['fxEvidence'].update(receipts=[]),
            lambda q: q['fxEvidence'].update(legIds=[LEGS[0], LEGS[0], LEGS[2]]),
            lambda q: q.update(accountLogs=None),
            lambda q: q.pop('recoverySchedule')]
        for mutate in mutations:
            query = self.query()
            mutate(query)
            with self.subTest(mutation=mutate), self.assertRaises(ExchangeContractError):
                await self.read(query)
        self.assertEqual(self.http, [])

    def test_legacy_query_has_no_synthetic_schedule(self):
        self.assertEqual(recovery_schedule_request({'since': 1, 'orders': [], 'history': []},
                                                   {'history': [], 'orders': []}, self.account), {})


if __name__ == '__main__':
    unittest.main()
