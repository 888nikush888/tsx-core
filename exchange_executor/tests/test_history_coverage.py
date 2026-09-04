from __future__ import annotations

import unittest
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from test_history_pagination import PagedBybit, budget, state
from common import ExchangeContractError
from history_pagination import DAY, checkpoint, read_history_pages
from history_coverage import fresh_fill_source
from test_kraken_history import KrakenRest, UID
from test_history_reader import HistoryRest
from ccxt_adapter import CcxtAdapter
from common import RequestDeadline


class CoverageBybit(PagedBybit):
    async def privateGetV5ExecutionList(self, params):
        if params['category'] != 'linear':
            self.calls.append(('fills', dict(params)))
            return {'retCode': 0, 'time': params['endTime'], 'result': {
                'category': params['category'], 'list': [], 'nextPageCursor': ''}}
        result = await super().privateGetV5ExecutionList(params)
        result['time'] = params['endTime']
        return result


class RetainedHyperliquid:
    def __init__(self, earliest, saturated=False):
        self.earliest = earliest
        self.saturated = saturated
        self.calls = []

    def handle_public_address(self, *_args):
        return 'fixture-wallet', {}

    async def publicPostInfo(self, params):
        self.calls.append(dict(params))
        if params['type'] == 'userFills':
            return [self.retained_row()] if self.earliest is not None else []
        if params['startTime'] == 0:
            return [] if self.earliest is None else [self.retained_row()]
        if self.saturated:
            return [{'id': str(i), 'time': params['startTime']} for i in range(2000)]
        return []

    def retained_row(self):
        return {'id': 'retained', 'coin': 'BTC', 'tid': 1, 'time': self.earliest, 'oid': 2,
                'px': '10', 'sz': '1', 'side': 'B'}

    def parse_trade(self, row):
        return {**row, 'timestamp': row['time']}


class HistoryCoverageTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_open_state_path_projects_only_new_proven_history(self):
        for exchange in ('krakenfutures', 'hyperliquid'):
            rest = HistoryRest()
            if exchange == 'krakenfutures':
                history = KrakenRest(0)
                rest.historyGetExecutions = history.historyGetExecutions

                async def positions(_params):
                    return {'result': 'success', 'serverTime': datetime.now(timezone.utc).isoformat(), 'openPositions': []}

                async def orders(_params):
                    return {'result': 'success', 'serverTime': datetime.now(timezone.utc).isoformat(), 'openOrders': []}

                rest.privateGetOpenpositions = positions
                rest.privateGetOpenorders = orders
                rest.parse8601 = lambda value: int(datetime.fromisoformat(value).timestamp() * 1000)
                rest.parse_position = rest.parse_order = lambda row: row
            else:
                retention = RetainedHyperliquid(None)

                async def info(params):
                    if params['type'] == 'perpDexs':
                        return [None]
                    if params['type'] == 'clearinghouseState':
                        return {'assetPositions': [], 'time': int(time.time() * 1000)}
                    if params['type'] == 'frontendOpenOrders':
                        return []
                    return await retention.publicPostInfo(params)

                rest.publicPostInfo = info
                rest.handle_public_address = retention.handle_public_address
                rest.parse_trade = retention.parse_trade

            async def account(value):
                return SimpleNamespace(rest=rest, account=value, account_identity=value['id'])

            adapter = CcxtAdapter(SimpleNamespace(account=account))
            request = {'id': 'coverage-fixture', 'exchange': exchange, 'mode': 'testnet'}
            initial = state()
            query = {'since': initial['baselineSince'], 'orders': [], 'history': [initial]}
            snapshot = await adapter.open_state(request, RequestDeadline(int(time.time() * 1000) + 30_000), query)
            sources = snapshot['acquisition']['sources']
            self.assertTrue(all(source['completeness'] == 'complete' for source in sources))
            self.assertGreaterEqual(snapshot['acquisition']['history'][0]['checkpoint']['coverage']['through'], snapshot['acquisition']['startedAt'])
            # Omitting the bound history request may not reuse that earlier success.
            unproven = await adapter.open_state(request, RequestDeadline(int(time.time() * 1000) + 30_000), {'since': initial['baselineSince'], 'orders': []})
            self.assertEqual(next(row for row in unproven['acquisition']['sources'] if row['source'] == 'fills')['completeness'], 'unknown')

    async def test_bybit_linear_coverage_does_not_claim_unproved_accountwide_option_history(self):
        rest = CoverageBybit(0)
        rest.empty_page = False
        original = state()
        _, _, updates = await read_history_pages(rest, 'bybit', [original], budget())
        final = checkpoint(updates[0]['checkpoint'])
        self.assertIsNotNone(final.get('coverage'), 'A proven interval must survive checkpoint serialization.')
        self.assertEqual(final['coverage']['since'], original['baselineSince'])
        self.assertEqual(final['coverage']['through'], final['scannedThrough'])
        self.assertEqual(final['coverage']['profile'], 'bybit_v5_linear_endpoint_v1')
        self.assertEqual(final['completeness'], 'unknown')
        self.assertEqual(final['reason'], 'option_history_scope_unproved')
        self.assertEqual({params['category'] for _, params in rest.calls}, {'linear', 'inverse', 'spot', 'option'})
        self.assertTrue(all('execType' not in params for _, params in rest.calls), 'ADL/settlement events must not be filtered away.')
        self.assertEqual(updates[0]['pages'], 4, 'Every additional provider request consumes the shared five-call budget.')

    async def test_kraken_terminal_execution_cursor_proves_coverage_not_order_ownership(self):
        rest = KrakenRest(0)
        original = state()
        _, _, updates = await read_history_pages(rest, 'krakenfutures', [original], budget())
        final = checkpoint(updates[0]['checkpoint'])
        self.assertEqual(final.get('coverage', {}).get('profile'), 'kraken_v3_executions_v1')
        self.assertEqual(final['providerAccountUid'], UID)
        self.assertEqual(final['coverage']['since'], original['baselineSince'])
        source = {'source': 'fills', 'completeness': 'unknown', 'reason': 'history_pagination_not_proven', 'since': original['baselineSince']}
        promoted = fresh_fill_source(source, updates, 'krakenfutures', original['baselineSince'], final['coverage']['through'])
        self.assertEqual(promoted['completeness'], 'complete')
        self.assertEqual(source['completeness'], 'unknown', 'Projection must not mutate the raw incomplete source.')
        self.assertEqual(fresh_fill_source(source, updates, 'krakenfutures', original['baselineSince'] - 1, 1), source)
        self.assertEqual(fresh_fill_source(source, updates, 'hyperliquid', original['baselineSince'], 1), source)
        self.assertEqual(fresh_fill_source(source, updates, 'krakenfutures', original['baselineSince'], final['coverage']['through'] + 1), source)

    async def test_hyperliquid_retention_is_checked_after_traversal(self):
        original = state()
        rest = RetainedHyperliquid(original['baselineSince'] - 1)
        _, _, updates = await read_history_pages(rest, 'hyperliquid', [original], budget())
        final = checkpoint(updates[0]['checkpoint'])
        self.assertEqual(final.get('coverage', {}).get('profile'), 'hyperliquid_retained_fills_v1')
        self.assertEqual(rest.calls[-1]['startTime'], 0, 'Post-traversal witness must not hide a retention gap with a since filter.')
        self.assertEqual(updates[0]['pages'], 2)
        for earliest in (original['baselineSince'], original['baselineSince'] + 1):
            _, _, result = await read_history_pages(RetainedHyperliquid(earliest), 'hyperliquid', [original], budget(2))
            self.assertIsNone(result[0]['checkpoint'].get('coverage'))
            self.assertEqual(result[0]['checkpoint']['completeness'], 'unknown')

    async def test_hyperliquid_empty_full_retained_collection_is_not_a_filtered_empty_page(self):
        original = state()
        rest = RetainedHyperliquid(None)
        _, _, updates = await read_history_pages(rest, 'hyperliquid', [original], budget())
        self.assertIsNotNone(updates[0]['checkpoint'].get('coverage'))
        self.assertEqual(len(rest.calls), 2)

    async def test_ten_thousand_retained_fills_can_hide_one_at_the_same_start_millisecond(self):
        original = state()
        stamp = original['baselineSince']
        dataset = [{'id': str(index), 'time': stamp + max(0, index - 1), 'coin': 'BTC', 'tid': index,
                    'oid': index + 1, 'px': '10', 'sz': '1', 'side': 'B'} for index in range(10_001)]
        retained = dataset[1:]
        rest = RetainedHyperliquid(stamp)

        async def page(params):
            rest.calls.append(dict(params))
            if params['type'] == 'userFills':
                return retained[-2000:]
            return [row for row in retained if params['startTime'] <= row['time'] <= params.get('endTime', stamp + DAY)][:2000]

        rest.publicPostInfo = page
        saved = original
        seen = set()
        for _ in range(5):
            before = len(rest.calls)
            _, fills, updates = await read_history_pages(rest, 'hyperliquid', [saved], budget())
            self.assertLessEqual(len(rest.calls) - before, 5)
            seen.update(row['id'] for row in fills)
            saved = checkpoint(updates[0]['checkpoint'])
            if saved['scannedThrough'] is not None:
                break
        self.assertEqual(len(seen), 10_000)
        self.assertNotIn('0', seen)
        self.assertIsNotNone(saved['scannedThrough'])
        self.assertIsNone(saved['coverage'], 'Complete traversal of all retained rows is not proof of the truncated boundary.')
        self.assertEqual(saved['completeness'], 'unknown')

    async def test_missing_guard_budget_cannot_acknowledge_the_window(self):
        original = state()
        for provider, rest in [('hyperliquid', RetainedHyperliquid(None)), ('bybit', CoverageBybit(0))]:
            rest.empty_page = False
            _, _, updates = await read_history_pages(rest, provider, [original], budget(1))
            self.assertIsNone(updates[0]['checkpoint'].get('coverage'))
            self.assertIsNone(updates[0]['checkpoint']['scannedThrough'])

    async def test_retention_gap_cannot_be_healed_by_a_newer_successful_window(self):
        rest = CoverageBybit(0)
        rest.empty_page = False
        original = state()
        original.update(baselineSince=1, windowSince=1, windowUntil=7 * DAY)
        _, _, updates = await read_history_pages(rest, 'bybit', [original], budget())
        saved = updates[0]['checkpoint']
        self.assertIsNone(saved.get('coverage'))
        # A previously traversed old gap is not proof that everything preceding a recent window is present.
        saved.update(windowSince=state()['windowSince'], windowUntil=None, cursor=None, nextReadAt=0)
        _, _, updates = await read_history_pages(rest, 'bybit', [checkpoint(saved)], budget())
        self.assertIsNone(updates[0]['checkpoint'].get('coverage'))

    async def test_saturated_hyperliquid_boundary_cannot_be_complete(self):
        original = state()
        _, _, updates = await read_history_pages(RetainedHyperliquid(None, True), 'hyperliquid', [original], budget())
        self.assertIsNone(updates[0]['checkpoint'].get('coverage'))
        self.assertEqual(updates[0]['checkpoint']['reason'], 'timestamp_page_saturated')

    async def test_bybit_foreign_category_activity_is_not_certified_as_empty(self):
        rest = CoverageBybit(0)
        rest.empty_page = False
        original = rest.privateGetV5ExecutionList

        async def foreign(params):
            result = await original(params)
            if params['category'] == 'spot':
                result['result']['list'] = [{'execId': 'foreign', 'execTime': str(params['startTime'])}]
            return result

        rest.privateGetV5ExecutionList = foreign
        with self.assertRaisesRegex(ExchangeContractError, 'Unmanaged Bybit spot'):
            await read_history_pages(rest, 'bybit', [state()], budget())

    async def test_completed_coverage_is_refreshed_instead_of_reused_as_a_new_observation(self):
        rest = RetainedHyperliquid(None)
        original = state()
        _, _, updates = await read_history_pages(rest, 'hyperliquid', [original], budget())
        saved = checkpoint(updates[0]['checkpoint'])
        end = saved['scannedThrough']
        with patch('history_pagination.now_ms', return_value=end + 500), patch('history_reader.now_ms', return_value=end + 500):
            _, _, second = await read_history_pages(rest, 'hyperliquid', [saved], budget())
        self.assertGreater(second[0]['checkpoint']['coverage']['through'], end)
        self.assertEqual(second[0]['pages'], 2)


if __name__ == '__main__':
    unittest.main()
