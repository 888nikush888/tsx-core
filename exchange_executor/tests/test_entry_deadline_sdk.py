"""Pinned CCXT throttle/sign/fetch boundary, with transport intercepted at its base class."""
from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from entry_deadline import EntryDeadline, EntryDeadlineError, entry_deadline_scope
from test_entry_price_sdk import sdk, specs


class PinnedEntryDeadlineSdkTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_signed_batch_checks_original_deadline_after_sdk_throttle(self):
        rest = sdk('bybit')
        del rest.fetch  # Retain our production transport override; intercept only the superclass below it.
        rest.apiKey, rest.secret = 'isolated-key', 'isolated-secret'
        rest.is_unified_enabled = AsyncMock(return_value=[False, True])
        try:
            orders = await specs('bybit', 'buy')
            clock = [time.time()]
            request = {'reduceOnly': False, 'entryExpiresAt': int(clock[0] * 1000) + 100}
            async def delay(_cost):
                clock[0] += .2
            rest.throttle = AsyncMock(side_effect=delay)
            with patch('time.time', side_effect=lambda: clock[0]), patch.object(ccxt_async.bybit, 'fetch', new_callable=AsyncMock) as transport:
                with entry_deadline_scope(EntryDeadline(request)):
                    with self.assertRaisesRegex(EntryDeadlineError, 'ENTRY_INTENT_EXPIRED'):
                        await rest.create_orders(orders)
                rest.throttle.assert_awaited_once()
                transport.assert_not_awaited()

                # A subsequent independent cancel is not subject to that expired Entry context.
                transport.return_value = {'retCode': 0, 'result': {'orderId': 'original-order'}}
                await rest.cancel_order('original-order', 'BTC/USDT:USDT')
                transport.assert_awaited_once()
                self.assertIn('order/cancel', transport.await_args.args[0])
                self.assertEqual(json.loads(transport.await_args.args[3])['orderId'], 'original-order')
        finally:
            await rest.close()

    async def test_valid_signed_batch_carries_price_and_stop_contract_without_sdk_deadline_parameter(self):
        rest = sdk('bybit')
        del rest.fetch
        rest.apiKey, rest.secret = 'isolated-key', 'isolated-secret'
        rest.is_unified_enabled = AsyncMock(return_value=[False, True])
        try:
            orders = await specs('bybit', 'buy')
            with patch.object(ccxt_async.bybit, 'fetch', new_callable=AsyncMock) as transport:
                transport.return_value = {'retCode': 0, 'result': {'list': []}}
                with entry_deadline_scope(EntryDeadline({'reduceOnly': False, 'entryExpiresAt': int(time.time() * 1000) + 5000})):
                    await rest.create_orders(orders)
                transport.assert_awaited_once()
                wire = json.loads(transport.await_args.args[3])
                self.assertEqual(wire['request'][0]['timeInForce'], 'IOC')
                self.assertEqual(wire['request'][0]['price'], '100.5')
                self.assertTrue(wire['request'][1]['reduceOnly'])
                self.assertNotIn('entryExpiresAt', wire['request'][0])
        finally:
            await rest.close()

    async def test_expired_entry_context_does_not_affect_an_independent_task(self):
        rest = sdk('bybit')
        del rest.fetch
        rest.apiKey, rest.secret = 'isolated-key', 'isolated-secret'
        rest.is_unified_enabled = AsyncMock(return_value=[False, True])
        gate = asyncio.Event()
        ready = asyncio.Event()
        clock = [time.time()]
        async def expired_entry():
            with entry_deadline_scope(EntryDeadline({'reduceOnly': False, 'entryExpiresAt': int(clock[0] * 1000) + 100})):
                ready.set()
                await gate.wait()
                with self.assertRaisesRegex(EntryDeadlineError, 'ENTRY_INTENT_EXPIRED'):
                    await rest.fetch('https://unused.invalid/entry')
        try:
            with patch('time.time', side_effect=lambda: clock[0]), patch.object(ccxt_async.bybit, 'fetch', new_callable=AsyncMock) as transport:
                task = asyncio.create_task(expired_entry())
                await ready.wait()
                clock[0] += .2
                transport.return_value = {'retCode': 0, 'result': {'orderId': 'original-order'}}
                await rest.cancel_order('original-order', 'BTC/USDT:USDT')
                gate.set()
                await task
                transport.assert_awaited_once()
        finally:
            await rest.close()


if __name__ == '__main__':
    unittest.main()
