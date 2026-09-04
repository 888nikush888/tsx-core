"""Offline retained-history fixtures: the first retained fill is not an older witness."""
from __future__ import annotations

import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from test_history_pagination import budget, state
from test_history_reader import HistoryRest
from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, RequestDeadline
from history_pagination import checkpoint, read_history_pages
from history_coverage import fresh_fill_source


def fill(tid, stamp):
    return {'coin': 'BTC', 'tid': tid, 'time': stamp, 'oid': tid + 1, 'px': '10', 'sz': '1',
            'side': 'B', 'fee': '0.1', 'feeToken': 'USDC', 'closedPnl': '0',
            'startPosition': '0', 'dir': 'Open Long', 'crossed': True}


class RetentionRest:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
        self.page_limit = 2000

    def handle_public_address(self, *_args):
        return 'offline-wallet', {}

    def parse_trade(self, row):
        return {**row, 'id': str(row['tid']), 'timestamp': row['time']}

    async def publicPostInfo(self, params):
        self.calls.append(dict(params))
        if params['type'] == 'userFills':
            return list(reversed(self.rows[-2000:]))
        self.assert_unaggregated(params)
        return [row for row in self.rows[-10000:]
                if params['startTime'] <= row['time'] <= params.get('endTime', 2**53 - 1)][:self.page_limit]

    @staticmethod
    def assert_unaggregated(params):
        assert params['aggregateByTime'] is False


class TotalRetentionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = int(time.time() * 1000)
        self.clock = patch('time.time', return_value=self.now / 1000)
        self.now_mock = self.clock.start()
        self.addCleanup(self.clock.stop)

    async def read(self, rest, saved, remaining=5):
        before = len(rest.calls)
        _, rows, updates = await read_history_pages(rest, 'hyperliquid', [saved], budget(remaining))
        self.assertLessEqual(len(rest.calls) - before, remaining)
        self.assertEqual(updates[0]['pages'], len(rest.calls) - before)
        serialized = json.dumps(updates[0]['checkpoint'])
        self.assertLess(len(serialized.encode()), 8192)
        return checkpoint(json.loads(serialized)), rows, updates

    async def phase(self, rest, saved, phase):
        for _ in range(40):
            saved, _, _ = await self.read(rest, saved, 1)
            if (saved.get('retention') or {}).get('phase') == phase:
                return saved
        self.fail(f'Retention never reached persisted {phase}.')

    async def test_first_fill_after_proven_empty_baseline_eventually_has_coverage(self):
        original = state()
        original['windowSince'] = original['baselineSince'] = self.now - 5000
        rest = RetentionRest([])
        empty, _, _ = await self.read(rest, original)
        self.assertIsNotNone(empty.get('coverage'))
        self.now_mock.return_value = (self.now + 1000) / 1000
        rest.rows = [fill(1, self.now + 500)]
        saved = empty
        for _ in range(15):
            saved, _, _ = await self.read(rest, saved)
            if (saved.get('retention') or {}).get('phase') == 'proved':
                break
        self.assertEqual(saved['completeness'], 'complete')
        self.assertEqual(saved['retention']['phase'], 'proved')
        self.assertEqual(saved['retention']['count'], 2, 'The first page and its inclusive overlap both count.')

    async def test_restart_scan_and_verify_preserve_count_anchor_and_fixed_horizon(self):
        original = state()
        rest = RetentionRest([fill(i, original['baselineSince'] + i) for i in range(4500)])
        scan = await self.phase(rest, original, 'scan')
        self.assertEqual(scan['retention']['count'], 2000)
        before = len(rest.calls)
        verify = await self.phase(rest, scan, 'verify')
        self.assertNotIn('userFills', [row['type'] for row in rest.calls[before:]])
        self.assertEqual(verify['retention']['anchor'], scan['retention']['anchor'])
        self.assertEqual(verify['retention']['fixedUntil'], scan['retention']['fixedUntil'])
        paused, _, _ = await self.read(rest, verify, 0)
        self.assertEqual(paused['retention'], verify['retention'])
        self.assertIsNone(paused.get('coverage'))
        final, _, _ = await self.read(rest, paused, 1)
        self.assertEqual(final['retention']['phase'], 'proved')
        self.assertIsNotNone(final['coverage'])

    async def test_exact_ten_thousand_and_same_timestamp_eviction_never_prove_coverage(self):
        for count in (10000, 10001):
            original = state()
            rest = RetentionRest([fill(i, original['baselineSince'] + max(0, i - 1)) for i in range(count)])
            saved = original
            for _ in range(10):
                saved, _, _ = await self.read(rest, saved)
            self.assertIsNone(saved.get('coverage'))
            self.assertNotEqual(saved['completeness'], 'complete')

    async def test_concurrent_eviction_same_time_id_loss_or_payload_change_discards_probe(self):
        for change in ('eviction', 'same_time', 'payload'):
            original = state()
            rest = RetentionRest([fill(i, original['baselineSince'] + i) for i in range(3)])
            verify = await self.phase(rest, original, 'verify')
            if change == 'payload':
                rest.rows[0]['sz'] = '2'
            elif change == 'same_time':
                rest.rows[0] = fill(999, rest.rows[0]['time'])
            else:
                rest.rows.pop(0)
            final, _, _ = await self.read(rest, verify, 1)
            self.assertIsNone(final.get('coverage'))
            self.assertIsNone(final.get('retention'))
            self.assertEqual(final['reason'], 'retention_anchor_changed')
            self.assertEqual(final['windowSince'], original['windowSince'])

    async def test_new_fill_after_fixed_horizon_does_not_extend_old_proof(self):
        original = state()
        rest = RetentionRest([fill(1, original['baselineSince'] + 1)])
        verify = await self.phase(rest, original, 'verify')
        fixed = verify['retention']['fixedUntil']
        self.now_mock.return_value = (self.now + 5000) / 1000
        rest.rows.append(fill(2, fixed + 1000))
        final, _, updates = await self.read(rest, verify, 1)
        self.assertLessEqual(final['coverage']['through'], fixed)
        self.assertLess(final['coverage']['through'], self.now + 5000)
        source = {'source': 'fills', 'completeness': 'unknown', 'reason': 'pending'}
        self.assertEqual(fresh_fill_source(source, updates, 'hyperliquid', original['baselineSince'], self.now + 5000), source)

    async def test_old_original_window_does_not_hide_ten_thousand_newer_retained_fills(self):
        original = state()
        original['windowUntil'] = original['baselineSince'] + 100
        rest = RetentionRest([fill(i, self.now - 20000 + i) for i in range(10000)])
        scan = await self.phase(rest, original, 'scan')
        self.assertGreaterEqual(scan['retention']['fixedUntil'], rest.rows[-1]['time'])
        saved = scan
        for _ in range(6):
            saved, _, _ = await self.read(rest, saved)
        self.assertIsNone(saved.get('coverage'))

    async def test_deadline_before_verify_preserves_probe_without_new_http(self):
        original = state()
        rest = RetentionRest([fill(1, original['baselineSince'] + 1)])
        verify = await self.phase(rest, original, 'verify')
        limited = budget()
        limited.deadline = RequestDeadline(self.now + 1000)
        before = len(rest.calls)
        _, _, updates = await read_history_pages(rest, 'hyperliquid', [verify], limited)
        self.assertEqual(len(rest.calls), before)
        self.assertEqual(updates[0]['pages'], 0)
        self.assertEqual(updates[0]['checkpoint']['retention'], verify['retention'])
        self.assertIsNone(updates[0]['checkpoint'].get('coverage'))

    async def test_probe_saturation_and_provider_clock_skew_remain_unresolved(self):
        original = state()
        original['windowUntil'] = original['baselineSince'] + 1
        rest = RetentionRest([fill(i, self.now - 1000) for i in range(2000)])
        saved, _, _ = await self.read(rest, original)
        self.assertEqual(saved['reason'], 'timestamp_page_saturated')
        self.assertIsNone(saved.get('coverage'))
        rest = RetentionRest([fill(1, self.now + 60001)])
        with self.assertRaisesRegex(ExchangeContractError, 'clock'):
            await self.read(rest, original)

    async def test_serialized_probe_rejects_unbounded_or_contradictory_fields(self):
        original = state()
        rest = RetentionRest([fill(1, original['baselineSince'] + 1)])
        scan = await self.phase(rest, original, 'scan')
        for change in ({'version': True}, {'count': 10000}, {'fixedUntil': 0}, {'validatedAt': self.now},
                       {'secret': 'not-allowlisted'}, {'anchor': None}, {'cursor': self.now + 2}):
            with self.assertRaises(ExchangeContractError):
                checkpoint({**scan, 'retention': {**scan['retention'], **change}})

    async def test_new_adapter_per_request_recovers_first_fill_from_serialized_empty_baseline(self):
        history = RetentionRest([])
        rest = HistoryRest()
        rest.handle_public_address = history.handle_public_address
        rest.parse_trade = history.parse_trade

        async def info(params):
            if params['type'] == 'perpDexs':
                return [None]
            if params['type'] == 'clearinghouseState':
                return {'assetPositions': [], 'time': int(time.time() * 1000)}
            if params['type'] == 'frontendOpenOrders':
                return []
            return await history.publicPostInfo(params)

        rest.publicPostInfo = info

        async def account(value):
            return SimpleNamespace(rest=rest, account=value, account_identity=value['id'])

        async def snapshot(saved):
            adapter = CcxtAdapter(SimpleNamespace(account=account))
            result = await adapter.open_state({'id': 'offline-retention', 'exchange': 'hyperliquid', 'mode': 'testnet'},
                RequestDeadline(int(time.time() * 1000) + 30000),
                {'since': saved['baselineSince'], 'orders': [], 'history': [json.loads(json.dumps(saved))]})
            self.assertLessEqual(result['acquisition']['history'][0]['pages'], 5)
            return result, checkpoint(json.loads(json.dumps(result['acquisition']['history'][0]['checkpoint'])))

        first, saved = await snapshot(state())
        self.assertTrue(all(source['completeness'] == 'complete' for source in first['acquisition']['sources']))
        self.now_mock.return_value = (self.now + 1000) / 1000
        history.rows = [fill(1, self.now + 500)]
        phases, unresolved = set(), []
        for _ in range(10):
            result, saved = await snapshot(saved)
            phases.add((saved.get('retention') or {}).get('phase'))
            unresolved.extend(result['unresolvedEvents'])
            source = next(source for source in result['acquisition']['sources'] if source['source'] == 'fills')
            if source['completeness'] == 'complete':
                break
        self.assertIn('scan', phases)
        self.assertEqual(source['completeness'], 'complete')
        self.assertEqual(saved['retention']['phase'], 'proved')
        self.assertGreaterEqual(saved['retention']['validatedAt'], result['acquisition']['startedAt'])
        self.assertLessEqual(saved['coverage']['through'], saved['retention']['fixedUntil'])
        self.assertTrue(unresolved, 'Complete source retention must not invent order ownership for unbound fills.')

    async def test_advancing_request_times_catch_up_without_reusing_an_old_proof(self):
        rest = RetentionRest([])
        saved, _, _ = await self.read(rest, state())
        rest.rows = [fill(1, self.now + 500)]
        source = {'source': 'fills', 'completeness': 'unknown', 'reason': 'pending'}
        for attempt in range(8):
            started = self.now + 1000 + attempt * 2000
            self.now_mock.return_value = started / 1000
            saved, _, updates = await self.read(rest, saved)
            projected = fresh_fill_source(source, updates, 'hyperliquid', saved['baselineSince'], started)
            if projected['completeness'] == 'complete':
                self.assertGreaterEqual(saved['coverage']['through'], started)
                break
            self.assertLess(saved.get('coverage', {}).get('through', 0), started)
        self.assertEqual(projected['completeness'], 'complete')


if __name__ == '__main__':
    unittest.main()
