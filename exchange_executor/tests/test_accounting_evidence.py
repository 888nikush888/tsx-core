from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt.base.errors import BadRequest, InvalidOrder, RequestTimeout
from account_log_reader import read_account_log_page
from account_log_sources import source_spec
from history_reader import RecoveryReadBudget
from common import RequestDeadline


class AccountingEvidenceTests(unittest.IsolatedAsyncioTestCase):
    def deadline(self):
        return RequestDeadline(int(time.time() * 1000) + 30_000)

    def test_bybit_reporting_uses_documented_usd_totals_not_first_stablecoin(self):
        from accounting_evidence import reporting_balance
        balance = {'total': {'USDT': '100', 'USDC': '200'}, 'free': {'USDT': '90'}, 'info': {'result': {'list': [{
            'accountType': 'UNIFIED', 'totalEquity': '302.5', 'totalAvailableBalance': '290.25',
            'totalPerpUPL': '-1.25', 'totalInitialMargin': '10', 'coin': [{'coin': 'USDC'}, {'coin': 'USDT'}],
        }]}}}
        reporting = reporting_balance('bybit', balance)
        self.assertEqual(reporting['reportingCurrency'], 'USD')
        self.assertEqual(reporting['equity'], '302.5')
        self.assertEqual(reporting['availableBalance'], '290.25')
        self.assertEqual(reporting['unrealizedPnl'], '-1.25')
        self.assertEqual(reporting['settlementAssets'], ['USDC', 'USDT'])

    def test_hyperliquid_balance_requires_account_summary_and_native_usdc(self):
        from accounting_evidence import reporting_balance
        from common import ExchangeContractError
        value = reporting_balance('hyperliquid', {'info': {'marginSummary': {'accountValue': '100.01', 'totalMarginUsed': '2.5', 'totalNtlPos': '0'},
                                  'assetPositions': [], 'withdrawable': '97.51'}})
        self.assertEqual(value['reportingCurrency'], 'USDC')
        self.assertEqual(value['equity'], '100.01')
        with self.assertRaises(ExchangeContractError):
            reporting_balance('hyperliquid', {'total': {'USDT': '100'}})

    def test_hyperliquid_price_pnl_is_bound_to_original_position_economics(self):
        from accounting_evidence import reporting_balance
        from common import ExchangeContractError
        summary = {'accountValue': '1000', 'totalMarginUsed': '5', 'totalNtlPos': '100.02765'}
        position = {'coin': 'ETH', 'szi': '0.0335', 'entryPx': '2986.3', 'positionValue': '100.02765',
                    'unrealizedPnl': '-0.0134', 'cumFunding': {'allTime': '514.085417', 'sinceOpen': '9'}}
        def read(patch=None):
            return reporting_balance('hyperliquid', {'info': {'marginSummary': summary, 'withdrawable': '900',
                'assetPositions': [{'type': 'oneWay', 'position': {**position, **(patch or {})}}]}})
        self.assertEqual(read()['unrealizedPnl'], '-0.0134')
        self.assertEqual(read()['unrealizedPnlSemantics'], 'price_only')
        self.assertEqual(read({'szi': '-0.0335', 'unrealizedPnl': '0.0134'})['unrealizedPnl'], '0.0134')
        for patch in ({'unrealizedPnl': '9'}, {'entryPx': None}, {'positionValue': None}, {'coin': 'xyz:ETH'}, {'szi': 0.0335}):
            with self.assertRaises(ExchangeContractError):
                read(patch)

    def checkpoint(self, exchange='bybit'):
        now = int(time.time() * 1000)
        namespace, filter_hash = source_spec(exchange)
        return {'version': 1, 'namespace': namespace, 'filterHash': filter_hash,
                'accountFingerprint': 'a' * 64, 'credentialGeneration': 'b' * 64, 'revision': 0,
                'requiredSince': now - 1000, 'windowSince': now - 1000, 'windowUntil': now,
                'cursor': None, 'scannedThrough': None, 'nextReadAt': 0, 'lastServedAt': 0,
                'providerAccountUid': None, 'reason': None}

    async def test_funding_request_failure_is_not_zero(self):
        for error in (BadRequest('bad request'), InvalidOrder('invalid'), RequestTimeout('timeout')):
            rest = SimpleNamespace(privateGetV5AccountTransactionLog=AsyncMock(side_effect=error))
            receipt, checkpoint = await read_account_log_page(rest, 'bybit', self.checkpoint(), RecoveryReadBudget(self.deadline()))
            self.assertIsNone(receipt)
            self.assertIsNone(checkpoint['scannedThrough'])
            self.assertIsNotNone(checkpoint['reason'])

    async def test_bybit_raw_funding_keeps_other_money_for_independent_consumers(self):
        checkpoint = self.checkpoint()
        row = {'id': 'settlement', 'transactionTime': str(checkpoint['windowUntil']), 'type': 'SETTLEMENT',
               'currency': 'USDC', 'funding': '-0.003676', 'cashFlow': '999', 'fee': '2'}
        method = AsyncMock(return_value={'retCode': 0, 'result': {'list': [row], 'nextPageCursor': ''}})
        receipt, _ = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                  'bybit', checkpoint, RecoveryReadBudget(self.deadline()))
        self.assertEqual(receipt['records'][0], row)
        self.assertNotIn('status', receipt, 'Source traversal cannot claim financial or account finality.')
        self.assertNotIn('currency', method.call_args.args[0])

    async def test_missing_cursor_never_proves_empty_funding(self):
        rest = SimpleNamespace(privateGetV5AccountTransactionLog=AsyncMock(return_value={'retCode': 0, 'result': {'list': []}}))
        receipt, current = await read_account_log_page(rest, 'bybit', self.checkpoint(), RecoveryReadBudget(self.deadline()))
        self.assertIsNone(receipt)
        self.assertIsNone(current['scannedThrough'])

    async def test_funding_budget_retains_cursor_across_more_than_five_pages(self):
        method = AsyncMock(side_effect=[{'retCode': 0, 'result': {'list': [], 'nextPageCursor': f'page-{i}'}} for i in range(6)])
        rest, current, budget = SimpleNamespace(privateGetV5AccountTransactionLog=method), self.checkpoint(), RecoveryReadBudget(self.deadline())
        for _ in range(6):
            _, current = await read_account_log_page(rest, 'bybit', current, budget)
        self.assertEqual(method.await_count, 5)
        self.assertEqual(current['cursor'], 'page-4')
        self.assertEqual(current['reason'], 'budget_exhausted')
        self.assertIsNone(current['scannedThrough'])
        _, current = await read_account_log_page(rest, 'bybit', current, RecoveryReadBudget(self.deadline()))
        self.assertEqual(method.call_args.args[0]['cursor'], 'page-4')
        self.assertEqual(current['cursor'], 'page-5')

    async def test_zero_hash_and_hip3_originals_survive_without_asset_guessing(self):
        checkpoint = self.checkpoint('hyperliquid')
        rows = [{'hash': '0x' + '0' * 64, 'time': checkpoint['windowUntil'] - offset,
                 'delta': {'type': 'funding', 'coin': coin, 'usdc': amount}}
                for offset, coin, amount in [(10, 'BTC', '-0.1'), (10, 'ETH', '0.2'), (5, 'xyz:XYZ100', '-0.3')]]
        receipt, current = await read_account_log_page(SimpleNamespace(publicPostInfo=AsyncMock(return_value=rows)),
            'hyperliquid', checkpoint, RecoveryReadBudget(self.deadline()), '0x' + 'a' * 40)
        self.assertEqual(len(receipt['records']), 3)
        self.assertEqual(receipt['records'][2]['coin'], 'xyz:XYZ100')
        self.assertNotIn('asset', receipt['records'][2])
        self.assertIsNone(current['scannedThrough'], 'Short page requires timestamp-boundary proof.')

    async def test_unsupported_never_infers_no_funding(self):
        receipt, current = await read_account_log_page(SimpleNamespace(), 'krakenfutures', self.checkpoint('krakenfutures'),
                                                       RecoveryReadBudget(self.deadline()))
        self.assertIsNone(receipt)
        self.assertEqual(current['reason'], 'source_unsupported')
        self.assertIsNone(current['scannedThrough'])

    async def test_deadline_response_reserve_permits_no_additional_call(self):
        method = AsyncMock()
        budget = RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 100))
        receipt, current = await read_account_log_page(SimpleNamespace(privateGetV5AccountTransactionLog=method),
                                                       'bybit', self.checkpoint(), budget)
        self.assertIsNone(receipt)
        self.assertEqual(current['reason'], 'budget_exhausted')
        method.assert_not_called()


if __name__ == '__main__':
    unittest.main()
