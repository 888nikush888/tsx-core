from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_log_reader import read_account_log_page, source_spec, validate_log_checkpoint
from common import RequestDeadline
from history_reader import RecoveryReadBudget
from account_log_scheduler import read_account_logs, read_account_mode, target_budget
from ccxt.base.errors import RateLimitExceeded
from test_kraken_response_capture import LocalResponse, captured_kraken_client


def state(exchange='bybit', since=None, until=None):
    now = int(time.time() * 1000)
    namespace, filter_hash = source_spec(exchange)
    return {'version': 1, 'namespace': namespace, 'filterHash': filter_hash,
            'accountFingerprint': 'a' * 64, 'credentialGeneration': 'b' * 64,
            'revision': 0, 'requiredSince': since or now - 10000, 'windowSince': since or now - 10000,
            'windowUntil': until or now, 'cursor': None, 'scannedThrough': None,
            'nextReadAt': 0, 'lastServedAt': 0, 'providerAccountUid': None, 'reason': None}


class AccountLogReaderTests(unittest.IsolatedAsyncioTestCase):
    def budget(self, remaining=5):
        return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30000), remaining=remaining)

    async def test_bybit_unfiltered_resume_empty_page_and_raw_occurrences(self):
        checkpoint = state()
        row = {'id': 'same', 'transactionTime': str(checkpoint['windowSince']), 'type': 'SETTLEMENT',
               'category': 'linear', 'symbol': 'BTCUSDT', 'currency': 'USDT', 'funding': '-1.25', 'cashFlow': '9'}
        method = AsyncMock(side_effect=[{'retCode': 0, 'time': checkpoint['windowUntil'],
            'result': {'list': [row, {**row, 'funding': '2'}], 'nextPageCursor': 'next'}},
            {'retCode': 0, 'time': checkpoint['windowUntil'], 'result': {'list': [], 'nextPageCursor': 'last'}}])
        rest = SimpleNamespace(privateGetV5AccountTransactionLog=method)
        receipt, next_state = await read_account_log_page(rest, 'bybit', checkpoint, self.budget())
        self.assertEqual(len(receipt['records']), 2, 'Conflicting identical IDs are not collapsed.')
        self.assertEqual(next_state['cursor'], 'next')
        self.assertIsNone(next_state['scannedThrough'])
        receipt, next_state = await read_account_log_page(rest, 'bybit', next_state, self.budget())
        self.assertEqual(next_state['cursor'], 'last')
        self.assertFalse(receipt['exhausted'])
        self.assertEqual(method.call_args.args[0]['cursor'], 'next')
        self.assertEqual(set(method.call_args.args[0]), {'accountType', 'startTime', 'endTime', 'limit', 'cursor'})

    async def test_shared_budget_never_grows_another_five_calls(self):
        checkpoint = state()
        method = AsyncMock(return_value={'retCode': 0, 'result': {'list': [], 'nextPageCursor': 'next'}})
        receipt, next_state = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                          'bybit', checkpoint, self.budget(0))
        self.assertIsNone(receipt)
        self.assertEqual(next_state['reason'], 'budget_exhausted')
        self.assertEqual(next_state['cursor'], checkpoint['cursor'])
        method.assert_not_called()

    async def test_hyperliquid_short_page_requires_following_boundary(self):
        checkpoint = state('hyperliquid')
        stamp = checkpoint['windowSince'] + 100
        row = {'hash': '0x' + '0' * 64, 'time': stamp,
               'delta': {'type': 'funding', 'coin': 'BTC', 'usdc': '0.001'}}
        method = AsyncMock(side_effect=[[row], [row], []])
        rest = SimpleNamespace(publicPostInfo=method)
        receipt, current = await read_account_log_page(rest, 'hyperliquid', checkpoint, self.budget(), '0x' + 'c' * 40)
        self.assertFalse(receipt['exhausted'])
        self.assertEqual(current['cursor'], str(stamp))
        receipt, current = await read_account_log_page(rest, 'hyperliquid', current, self.budget(), '0x' + 'c' * 40)
        self.assertEqual(current['cursor'], str(stamp + 1))
        receipt, current = await read_account_log_page(rest, 'hyperliquid', current, self.budget(), '0x' + 'c' * 40)
        self.assertTrue(receipt['exhausted'])
        self.assertEqual(current['scannedThrough'], checkpoint['windowUntil'])

    async def test_hyperliquid_saturated_timestamp_is_not_skipped(self):
        checkpoint = state('hyperliquid')
        row = {'hash': 'hash', 'time': checkpoint['windowSince'],
               'delta': {'type': 'funding', 'coin': 'BTC', 'usdc': '1'}}
        rest = SimpleNamespace(publicPostInfo=AsyncMock(return_value=[row] * 500))
        receipt, current = await read_account_log_page(rest, 'hyperliquid', checkpoint, self.budget(), '0x' + 'c' * 40)
        self.assertFalse(receipt['exhausted'])
        self.assertEqual(current['reason'], 'timestamp_saturated')
        self.assertIsNone(current['cursor'])

    async def test_kraken_exact_decimal_raw_json_and_id_pagination(self):
        checkpoint = state('krakenfutures')
        payload = '{"accountUid":"uid","logs":[{"id":9007199254740993,"date":"2026-09-02T00:00:00Z","asset":"usd","realized_funding":0.123456789123456789,"info":"funding rate change"}]}'
        checkpoint.update(requiredSince=1788307200000, windowSince=1788307200000, windowUntil=1788307201000)
        rest, session = captured_kraken_client([LocalResponse(payload)])
        self.addAsyncCleanup(rest.close)
        receipt, current = await read_account_log_page(rest, 'krakenfutures', checkpoint, self.budget())
        self.assertEqual(receipt['records'][0]['realized_funding'], '0.123456789123456789')
        self.assertEqual(receipt['records'][0]['id'], '9007199254740993')
        self.assertEqual(current['cursor'], '9007199254740994')
        self.assertIn('/api/history/v3/account-log?', session.calls[0][0])

    def test_checkpoint_identity_and_opaque_filter_are_not_caller_choices(self):
        checkpoint = state()
        self.assertEqual(validate_log_checkpoint(checkpoint, 'bybit'), checkpoint)
        with self.assertRaises(ValueError):
            validate_log_checkpoint({**checkpoint, 'filterHash': 'f' * 64}, 'bybit')

    async def test_unavailable_bybit_retention_does_not_turn_empty_into_coverage(self):
        old = int(time.time() * 1000) - 800 * 86400000
        checkpoint = state(since=old, until=old + 1000)
        method = AsyncMock(return_value={'retCode': 0, 'result': {'list': [], 'nextPageCursor': ''}})
        receipt, current = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                       'bybit', checkpoint, self.budget())
        self.assertIsNone(receipt)
        self.assertEqual(current['reason'], 'source_retention_unproven')
        self.assertIsNone(current['scannedThrough'])
        method.assert_not_called()

    async def test_utc_change_preserves_old_pinned_window_then_advances(self):
        current = int(time.time() * 1000)
        midnight = current // 86400000 * 86400000
        checkpoint = state(since=midnight - 10000, until=midnight - 1)
        checkpoint['cursor'] = 'yesterday-page'
        method = AsyncMock(return_value={'retCode': 0, 'result': {'list': [], 'nextPageCursor': ''}})
        with patch('account_log_reader.now_ms', return_value=midnight + 10000):
            receipt, next_state = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                              'bybit', checkpoint, self.budget())
        self.assertEqual(receipt['until'], midnight - 1)
        self.assertEqual(method.call_args.args[0]['cursor'], 'yesterday-page')
        self.assertEqual(next_state['scannedThrough'], midnight - 1)
        self.assertLess(next_state['windowSince'], midnight)

    async def test_old_late_events_rotate_without_starving_current_day_after_restart(self):
        current = int(time.time() * 1000)
        midnight = current // 86400000 * 86400000
        checkpoint = state(since=midnight - 20 * 86400000, until=current)
        checkpoint.update(revision=3, scannedThrough=current, windowSince=midnight,
                          windowUntil=None, audit={'windowSince': midnight - 20 * 86400000,
                          'windowUntil': midnight - 13 * 86400000, 'cursor': 'old-page', 'completedAt': 0})
        method = AsyncMock(return_value={'retCode': 0, 'result': {'list': [], 'nextPageCursor': ''}})
        receipt, next_state = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                          'bybit', checkpoint, self.budget())
        self.assertEqual(receipt['lane'], 'audit')
        self.assertEqual(method.call_args.args[0]['cursor'], 'old-page')
        self.assertEqual(next_state['scannedThrough'], current)
        self.assertEqual(next_state['windowSince'], midnight)
        self.assertEqual(next_state['audit']['windowSince'], midnight - 13 * 86400000 - 1000)
        next_state['revision'] += 1
        receipt, final = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                     'bybit', next_state, self.budget())
        self.assertEqual(receipt['lane'], 'forward')
        self.assertEqual(final['windowSince'], midnight - 86400000)

    async def test_rate_limit_persists_cooldown_and_no_restarted_five_pool(self):
        checkpoint = state()
        method = AsyncMock(side_effect=RateLimitExceeded('fake 429'))
        rest = SimpleNamespace(privateGetV5AccountTransactionLog=method, last_response_headers={'Retry-After': '90'})
        budget = self.budget()
        receipt, next_state = await read_account_log_page(rest, 'bybit', checkpoint, budget)
        self.assertIsNone(receipt)
        self.assertEqual(budget.remaining, 0)
        self.assertGreater(next_state['nextReadAt'], int(time.time() * 1000) + 85000)
        self.assertEqual(next_state['cursor'], checkpoint['cursor'])
        await read_account_log_page(rest, 'bybit', next_state, self.budget())
        self.assertEqual(method.call_count, 1, 'Restart does not forget source Retry-After.')

    async def test_target_mode_money_and_history_share_five_with_restart_fairness(self):
        checkpoint = state()
        rest = SimpleNamespace(privateGetV5AccountTransactionLog=AsyncMock(return_value={
            'retCode': 0, 'result': {'list': [], 'nextPageCursor': 'next'}}))
        for revision in (0, 1):
            query = {'accountLogs': {**checkpoint, 'revision': revision}, 'readAccountMode': True}
            budget = self.budget()
            targeted = target_budget(query, budget)
            await targeted.call(AsyncMock(return_value=[]))
            await targeted.call(AsyncMock(return_value=[]))
            async def mode_read(_rest, shared, _fingerprint, _generation):
                await shared.call(AsyncMock(return_value={}))
                await shared.call(AsyncMock(return_value={}))
                return {'source': 'local-two-call-mode-fixture'}
            with patch('account_log_scheduler.read_bybit_account_mode', new=mode_read):
                mode = await read_account_mode(rest, 'bybit', query, budget, ('a' * 64, 'b' * 64))
            log = await read_account_logs(rest, 'bybit', query, budget, None)
            history_calls = budget.remaining
            while budget.remaining:
                await budget.call(AsyncMock(return_value=[]))
            self.assertEqual(budget.calls, 5)
            self.assertEqual(log['calls'], 1)
            self.assertEqual(mode['calls'], 2 if revision == 0 else 0)
            self.assertEqual(history_calls, 0 if revision == 0 else 2,
                             'Persisted odd revision reserves old-history progress even after restart.')

    async def test_balance_snapshot_performs_no_funding_history_calls(self):
        from ccxt_adapter import CcxtAdapter
        rest = SimpleNamespace(fetch_balance=AsyncMock(return_value={'info': {'result': {'list': [{
            'accountType': 'UNIFIED', 'totalEquity': '100', 'totalAvailableBalance': '90',
            'totalPerpUPL': '0', 'totalInitialMargin': '10', 'coin': [{'coin': 'USDT'}]}]}}}),
            fetch_positions=AsyncMock(return_value=[]), privateGetV5AccountTransactionLog=AsyncMock())
        account = {'id': 'a', 'exchange': 'bybit', 'mode': 'testnet'}
        clients = SimpleNamespace(rest=rest, account=account, account_identity='fake-key')
        registry = SimpleNamespace(account=AsyncMock(return_value=clients), assert_binding=lambda *_args: None)
        result = await CcxtAdapter(registry).account_snapshot(account, self.budget().deadline)
        self.assertIsNone(result['fundingPnlToday'])
        self.assertEqual(result['accounting']['funding']['reason'], 'persisted_observation_required')
        rest.privateGetV5AccountTransactionLog.assert_not_called()

    async def test_actual_open_state_resumes_seven_money_pages_with_one_shared_budget(self):
        from ccxt_adapter import CcxtAdapter
        from ccxt_client import credential_generation
        from common import external_account_id
        from exchange_executor.tests.test_history_reader import HistoryRest, reference
        rest = HistoryRest()
        money_calls, history_calls = [], []

        async def money_page(params):
            money_calls.append(params)
            return {'retCode': 0, 'result': {'list': [], 'nextPageCursor': f'money-{len(money_calls)}' if len(money_calls) < 7 else ''}}

        async def history_page(params):
            history_calls.append(params)
            return {'retCode': 0, 'result': {'category': 'linear', 'list': [], 'nextPageCursor': f'history-{len(history_calls)}'}}

        async def mode_read(_rest, budget, fingerprint, generation):
            await budget.call(AsyncMock(return_value={}))
            await budget.call(AsyncMock(return_value={}))
            return {'accountFingerprint': fingerprint, 'credentialGeneration': generation}

        rest.privateGetV5AccountTransactionLog, rest.privateGetV5ExecutionList = money_page, history_page
        rest.parse_trade = lambda row, _market: row
        request = {'id': 'budget', 'exchange': 'bybit', 'mode': 'testnet'}
        clients = SimpleNamespace(rest=rest, account=request, account_identity='fixture-key', credential_fingerprint='fixture-secret-digest')
        registry = SimpleNamespace(account=AsyncMock(return_value=clients), assert_binding=lambda *_args: None)
        checkpoint = state()
        checkpoint.update(accountFingerprint=external_account_id('bybit', 'testnet', clients.account_identity),
                          credentialGeneration=credential_generation(clients))
        history = {'source': 'fills', 'providerSymbol': None, 'revision': 0, 'baselineSince': checkpoint['requiredSince'],
                   'windowSince': checkpoint['requiredSince'], 'windowUntil': None, 'cursor': None, 'scannedThrough': None,
                   'nextReadAt': 0, 'completeness': 'unknown', 'reason': 'history_pending'}
        for revision in range(7):
            with patch('account_log_scheduler.read_bybit_account_mode', new=mode_read):
                result = await CcxtAdapter(registry).open_state(request, self.budget().deadline, {
                    'since': checkpoint['requiredSince'], 'orders': [reference()], 'history': [history],
                    'accountLogs': checkpoint, 'readAccountMode': True})
            proof = result['acquisition']
            spent = proof['targetedCalls'] + proof['accountLogs']['calls'] + proof['accountMode']['calls'] + sum(row['pages'] for row in proof['history'])
            self.assertEqual(spent, 5)
            self.assertEqual(money_calls[-1].get('cursor'), None if revision == 0 else f'money-{revision}')
            self.assertEqual(proof['history'][0]['pages'], 0 if revision % 2 == 0 else 2)
            checkpoint, history = proof['accountLogs']['checkpoint'], proof['history'][0]['checkpoint']
        self.assertEqual(checkpoint['revision'], 7)
        self.assertIsNone(checkpoint['cursor'])
        self.assertIsNotNone(checkpoint['scannedThrough'])


if __name__ == '__main__':
    unittest.main()
