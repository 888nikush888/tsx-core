"""Original Kraken cash fields, with SDK transport completely replaced by a local fake."""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

import ccxt

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_log_reader import read_account_log_page
from common import RequestDeadline
from history_reader import RecoveryReadBudget
from test_account_log_reader import state
from test_kraken_response_capture import LocalResponse, captured_kraken_client


PAYLOAD = ('{"accountUid":"11111111-1111-4111-8111-111111111111","logs":[{'
           '"id":9007199254740993,"booking_uid":"66666666-6666-4666-8666-666666666666",'
           '"date":"2026-09-02T00:00:00Z","asset":"usd","collateral":"usd","contract":"pf_xbtusd",'
           '"execution":"22222222-2222-4222-8222-222222222222","info":"futures trade","margin_account":"flex",'
           '"old_balance":100,"new_balance":99.99,"fee":0.01,"realized_pnl":0,"realized_funding":0,'
           '"exchange_rate":1.000123456789123456,"exchange_rate_from":"usdc",'
           '"conversion_fee":0.05,"conversion_spread_percentage":0.050000000000000001}]}')


class KrakenCashlegSourceTests(unittest.IsolatedAsyncioTestCase):
    async def read_original(self):
        self.assertEqual(ccxt.__version__, '4.5.75')
        rest, session = captured_kraken_client([LocalResponse(PAYLOAD)])
        checkpoint = state('krakenfutures', since=1788307200000, until=1788307201000)
        budget = RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30000))
        try:
            receipt, next_state = await read_account_log_page(rest, 'krakenfutures', checkpoint, budget)
            self.assertEqual(len(session.calls), 1)
            request_url, request = session.calls[0]
            self.assertIn('/api/history/v3/account-log?', request_url)
            self.assertIn('Authent', request['headers'])
            self.assertNotIn('conversion_details=', request_url, 'No silently changed producer/filter contract.')
            self.assertEqual(budget.calls, 1)
            self.assertEqual(next_state['cursor'], '9007199254740994')
            return receipt['records'][0]
        finally:
            await rest.close()

    async def test_signed_sdk_read_retains_cash_identity_and_exact_economics(self):
        row = await self.read_original()
        self.assertEqual(row['id'], '9007199254740993')
        self.assertEqual(row['execution'], '22222222-2222-4222-8222-222222222222')
        self.assertNotEqual(row['execution'], row['booking_uid'])
        self.assertEqual((row['asset'], row['collateral'], row['fee']), ('usd', 'usd', '0.01'))
        self.assertEqual(row['exchange_rate'], '1.000123456789123456')
        self.assertEqual(row['conversion_fee'], '0.05', 'A percentage remains a percentage, not an invented cash debit.')

    async def test_nonzero_conversion_spread_cannot_disappear_before_native_cash_gate(self):
        row = await self.read_original()
        self.assertEqual(row.get('conversion_spread_percentage'), '0.050000000000000001',
                         'Discarding a real conversion field could turn an unproved leg into a native-only candidate.')


if __name__ == '__main__':
    unittest.main()
