"""Listed recovery evidence must retain full traversal after an early match."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history_reader


class ListedRecoveryIterationTests(unittest.IsolatedAsyncioTestCase):
    async def test_matching_order_does_not_hide_later_malformed_identity(self):
        reference = {'exchangeOrderId': None, 'clientOrderId': 'owned-client'}
        first = {'id': 'first', 'symbol': 'BTC/USDT:USDT', 'clientOrderId': 'owned-client',
                 'status': 'open', 'filled': '0'}
        later = {'id': 'later', 'symbol': 'BTC/USDT:USDT', 'clientOrderId': 'other-client',
                 'identityEvidence': None}
        subject = history_reader._recover_reference
        arguments = (None, 'hyperliquid', reference, [first, later],
                     lambda _reference: 'BTC/USDT:USDT', SimpleNamespace(), [])
        with patch.object(history_reader, 'lookup_order_evidence', new_callable=AsyncMock) as lookup:
            with self.assertRaises(AttributeError):
                await subject(*arguments)
            lookup.assert_not_awaited()

    async def test_valid_match_and_absence_keep_lookup_budget_and_result(self):
        reference = {'exchangeOrderId': None, 'clientOrderId': 'owned-client'}
        matching = {'id': 'first', 'symbol': 'BTC/USDT:USDT', 'clientOrderId': 'owned-client',
                    'status': 'open', 'filled': '0'}
        other = {'id': 'later', 'symbol': 'BTC/USDT:USDT', 'clientOrderId': 'other-client',
                 'identityEvidence': {}}
        with patch.object(history_reader, 'lookup_order_evidence', new_callable=AsyncMock,
                          return_value=[]) as lookup:
            for listed, expected, reads in [([matching, other], 'observed', 0),
                                            ([other], 'not_found', 1), ([], 'not_found', 1)]:
                with self.subTest(expected=expected, length=len(listed)):
                    lookup.reset_mock()
                    result = await history_reader._recover_reference(
                        None, 'hyperliquid', reference, listed,
                        lambda _reference: 'BTC/USDT:USDT', SimpleNamespace(), [])
                    self.assertEqual(result, expected)
                    self.assertEqual(lookup.await_count, reads)


if __name__ == '__main__':
    unittest.main()
