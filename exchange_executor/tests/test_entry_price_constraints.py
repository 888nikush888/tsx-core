from __future__ import annotations

import copy
import sys
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import CcxtAdapter
from ccxt_profiles import profile_for
from common import ExchangeContractError, RequestDeadline, UnresolvedOrderOutcome
from test_contracts import FakeProtectedRest, FakeRegistry, bound_test_account, protected_requests


def deadline():
    return RequestDeadline(int(time.time() * 1000) + 30_000)


def bounded_orders(side='buy', exchange='bybit'):
    entry, stop = protected_requests(exchange)
    entry.update({'side': side, 'price': '100.5' if side == 'buy' else '99.6', 'timeInForce': 'IOC',
                  'maxSlippagePercent': '0.5', 'entryPriceBoundary': {
                      'version': 1, 'referencePrice': '100.05', 'maxSlippagePercent': '0.5',
                      'priceTick': '0.1', 'limitPrice': '100.5' if side == 'buy' else '99.6'}})
    stop.update({'side': 'sell' if side == 'buy' else 'buy', 'triggerPrice': '90', 'maxSlippagePercent': '0.5'})
    return entry, stop


def rest_fixture(*, failure=None, status='closed', filled='2'):
    rest = FakeProtectedRest([[]], orders=[
        {'id': 'entry-real', 'clientOrderId': 'entry-client', 'status': status, 'filled': filled, 'average': '100'},
        {'id': 'stop-real', 'clientOrderId': 'stop-client', 'status': 'open', 'filled': '0'},
    ], failure=failure)
    rest.markets['BTC/USDT:USDT']['precision'] = {'price': 0.1, 'amount': 0.001}
    rest.has['createOrders'] = True
    return rest


class EntryPriceContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_profiles_submit_directional_cap_and_ioc_only_on_entry(self):
        for exchange, tif in [('bybit', 'IOC'), ('hyperliquid', 'Ioc')]:
            for side in ('buy', 'sell'):
                with self.subTest(exchange=exchange, side=side):
                    rest = rest_fixture()
                    entry, stop = bounded_orders(side, exchange)
                    await CcxtAdapter(FakeRegistry(rest, exchange)).submit_protected_entry(
                        bound_test_account(exchange), entry, stop, deadline())
                    sent_entry, sent_stop = rest.created_batches[0]
                    self.assertEqual(sent_entry['type'], 'limit')
                    self.assertEqual(sent_entry['price'], entry['entryPriceBoundary']['limitPrice'])
                    self.assertEqual(sent_entry['params']['timeInForce'], tif)
                    self.assertNotIn('slippage', sent_entry['params'])
                    self.assertNotIn('timeInForce', sent_stop['params'])
                    self.assertTrue(sent_stop['params']['reduceOnly'])

    async def test_missing_or_widened_boundary_never_dispatches(self):
        original, stop = bounded_orders()
        edits = [{'price': '100.6'}, {'orderType': 'market'}, {'timeInForce': None}, {'postOnly': True},
                 {'entryPriceBoundary': None}, {'entryPriceBoundary': {**original['entryPriceBoundary'], 'limitPrice': '100.6'}}]
        for edit in edits:
            rest = rest_fixture()
            with self.subTest(edit=edit), self.assertRaises(ExchangeContractError):
                await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(
                    bound_test_account(), {**copy.deepcopy(original), **edit}, stop, deadline())
            self.assertEqual(rest.created_batches, [])
            self.assertEqual(rest.leverage, [])

    async def test_provider_precision_cannot_widen_original_cap(self):
        rest = rest_fixture()
        rest.price_to_precision = lambda _symbol, _price: '100.6'
        with self.assertRaises(ExchangeContractError):
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), *bounded_orders(), deadline())
        self.assertEqual(rest.created_batches, [])

    async def test_missing_bounded_batch_capability_is_not_a_single_entry_fallback(self):
        rest = rest_fixture()
        registry = FakeRegistry(rest)
        profile = profile_for('bybit')
        registry.clients.profile = replace(profile, execution_capabilities=replace(
            profile.execution_capabilities, protected_bounded_entry='not_proven'))
        with self.assertRaises(ExchangeContractError):
            await CcxtAdapter(registry).submit_protected_entry(bound_test_account(), *bounded_orders(), deadline())
        self.assertEqual(rest.created_batches, [])
        self.assertEqual(rest.cleanup_orders, [])

    async def test_kraken_batch_stop_market_documentation_conflict_blocks_bounded_entry(self):
        rest = rest_fixture()
        with self.assertRaisesRegex(ExchangeContractError, 'batch support is not proven'):
            await CcxtAdapter(FakeRegistry(rest, 'krakenfutures')).submit_protected_entry(
                bound_test_account('krakenfutures'), *bounded_orders(), deadline())
        self.assertEqual(rest.created_batches, [])
        self.assertEqual(rest.leverage, [])

    async def test_sdk_missing_batch_capability_fails_before_any_write(self):
        rest = rest_fixture()
        rest.has['createOrders'] = False
        with self.assertRaisesRegex(ExchangeContractError, 'batch'):
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), *bounded_orders(), deadline())
        self.assertEqual(rest.created_batches, [])
        self.assertEqual(rest.leverage, [])

    async def test_final_mode_await_cannot_enable_widened_sdk_payload(self):
        rest = rest_fixture()
        adapter = CcxtAdapter(FakeRegistry(rest))
        original = adapter._order_spec
        captured = []
        async def capture(*args):
            result = await original(*args)
            captured.append(result[0])
            return result
        adapter._order_spec = capture
        read = rest.privateGetV5PositionList
        async def final_read(params):
            if captured:
                captured[0]['price'] = '101'
            return await read(params)
        rest.privateGetV5PositionList = AsyncMock(side_effect=final_read)
        with self.assertRaisesRegex(ExchangeContractError, 'Final provider dispatch'):
            await adapter.submit_protected_entry(bound_test_account(), *bounded_orders(), deadline())
        self.assertEqual(rest.created_batches, [])

    async def test_sub_attounit_intermediate_rounding_never_widens_short_floor(self):
        entry, stop = bounded_orders('sell')
        tiny = '0.000000000000000003'
        tick = '0.000000000000000001'
        entry.update({'price': tiny, 'entryPriceBoundary': {**entry['entryPriceBoundary'],
                                                          'referencePrice': tiny, 'priceTick': tick, 'limitPrice': tiny}})
        rest = rest_fixture()
        rest.markets['BTC/USDT:USDT']['precision']['price'] = tick
        await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), entry, stop, deadline())
        self.assertEqual(rest.created_batches[0][0]['price'], tiny)

    async def test_ioc_cannot_use_unprotected_submit_order(self):
        rest = rest_fixture()
        with self.assertRaises(ExchangeContractError):
            await CcxtAdapter(FakeRegistry(rest)).submit_order(bound_test_account(), bounded_orders()[0], deadline())
        self.assertEqual(rest.cleanup_orders, [])

    async def test_provider_rejection_does_not_retry_or_flatten_unknown_exposure(self):
        rest = rest_fixture(failure=RuntimeError('provider rejected'))
        with self.assertRaises(UnresolvedOrderOutcome):
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), *bounded_orders(), deadline())
        self.assertEqual(len(rest.created_batches), 1)
        self.assertEqual(rest.cleanup_orders, [])

    async def test_terminal_ioc_preserves_cumulative_fill_and_stop(self):
        for filled in ('0', '0.5'):
            rest = rest_fixture(status='canceled', filled=filled)
            result = await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(
                bound_test_account(), *bounded_orders(), deadline())
            self.assertEqual(result['entry']['status'], 'cancelled')
            self.assertEqual(result['entry']['filledQuantity'], filled)
            self.assertEqual(result['protectiveStop']['status'], 'open')
            self.assertEqual(len(rest.created_batches), 1)
            self.assertEqual(rest.cleanup_orders, [])


if __name__ == '__main__':
    unittest.main()
