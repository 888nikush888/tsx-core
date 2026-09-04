"""Pinned SDK wire-payload fixtures, with all real transport forbidden."""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import CcxtAdapter
from ccxt_profiles import profile_for
from ccxt_sdk_policy import client_class
from ccxt_client import CcxtClientRegistry
from test_contracts import FakeRegistry, bound_test_account, test_secret
from test_entry_price_constraints import bounded_orders, deadline, rest_fixture


async def specs(exchange, side):
    registry = FakeRegistry(rest_fixture(), exchange)
    adapter = CcxtAdapter(registry)
    return [item[0] for item in [await adapter._order_spec(registry.clients, order, deadline())
                               for order in bounded_orders(side, exchange)]]


def sdk(exchange):
    rest = client_class(exchange, getattr(ccxt_async, exchange))({'walletAddress': '0x' + '2' * 40, 'privateKey': '0x' + '1' * 64,
                                        'options': profile_for(exchange).client_options()})
    rest.set_markets([{'id': 'BTCUSDT', 'symbol': 'BTC/USDT:USDT', 'base': 'BTC', 'quote': 'USDT', 'settle': 'USDT',
                      'baseId': '0', 'quoteId': 'USDT', 'settleId': 'USDT', 'type': 'swap', 'spot': False,
                      'swap': True, 'contract': True, 'linear': True, 'inverse': False, 'active': True,
                      'contractSize': 1, 'precision': {'amount': 0.001, 'price': 0.1}, 'limits': {}, 'info': {}}])
    rest.fetch = AsyncMock(side_effect=AssertionError('Live provider transport forbidden.'))
    if exchange == 'hyperliquid':
        market = copy.deepcopy(rest.markets['BTC/USDT:USDT'])
        market.update({'symbol': 'BTC/USDC:USDC', 'quote': 'USDC', 'settle': 'USDC'})
        rest.set_markets([market])
    return rest


class PinnedBoundedEntrySdkTests(unittest.IsolatedAsyncioTestCase):
    async def test_bybit_sdk_serializes_actual_limit_ioc_and_uncapped_stop_market(self):
        for side in ('buy', 'sell'):
            rest = sdk('bybit')
            rest.is_unified_enabled = AsyncMock(return_value=[False, True])
            rest.privatePostV5OrderCreateBatch = AsyncMock(return_value={'result': {'list': []}})
            try:
                orders = await specs('bybit', side)
                await rest.create_orders(copy.deepcopy(orders))
                body = rest.privatePostV5OrderCreateBatch.await_args.args[0]
                entry, stop = body['request']
                self.assertEqual(body['category'], 'linear')
                self.assertEqual((entry['orderType'], entry['timeInForce'], entry['price']), ('Limit', 'IOC', orders[0]['price']))
                self.assertEqual(stop['orderType'], 'Market')
                self.assertNotIn('price', stop)
                self.assertTrue(stop['reduceOnly'])
                self.assertEqual(stop['triggerPrice'], '90')
                rest.fetch.assert_not_called()
            finally:
                await rest.close()

    async def test_hyperliquid_sdk_serializes_exact_cap_without_market_slippage_rebasing(self):
        for side in ('buy', 'sell'):
            rest = sdk('hyperliquid')
            rest.sign_l1_action = Mock(return_value={'r': 'fixture', 's': 'fixture', 'v': 27})
            try:
                orders = await specs('hyperliquid', side)
                body = rest.create_orders_request(copy.deepcopy(orders))
                entry, stop = body['action']['orders']
                self.assertEqual(body['action']['grouping'], 'na')
                self.assertEqual(entry['t'], {'limit': {'tif': 'Ioc'}})
                self.assertEqual(entry['p'], orders[0]['price'])
                self.assertEqual(entry['b'], side == 'buy')
                self.assertTrue(stop['r'])
                self.assertEqual(stop['t'], {'trigger': {'isMarket': True, 'triggerPx': '90', 'tpsl': 'sl'}})
                self.assertNotEqual(stop['p'], entry['p'], 'Entry boundary must not leak into the emergency stop price.')
                rest.fetch.assert_not_called()
            finally:
                await rest.close()

    async def test_full_hyperliquid_sdk_create_orders_has_no_automatic_account_writes(self):
        rest = sdk('hyperliquid')
        rest.sign_l1_action = Mock(return_value={'r': 'fixture', 's': 'fixture', 'v': 27})
        rest.publicPostInfo = AsyncMock(return_value='disabled')
        rest.privatePostExchange = AsyncMock(return_value={'response': {'data': {'statuses': []}}})
        try:
            await rest.create_orders(await specs('hyperliquid', 'buy'))
            actions = [call.args[0]['action'] for call in rest.privatePostExchange.await_args_list]
            self.assertEqual([action['type'] for action in actions], ['order'],
                             'Only the journaled order is authorized, never approveBuilderFee or setReferrer.')
            self.assertNotIn('builder', actions[0])
            self.assertEqual(actions[0]['orders'][0]['t'], {'limit': {'tif': 'Ioc'}})
            self.assertEqual(actions[0]['orders'][0]['p'], '100.5')
            self.assertTrue(actions[0]['orders'][1]['t']['trigger']['isMarket'])
            self.assertTrue(any(call.args[0]['type'] == 'userAbstraction' for call in rest.publicPostInfo.await_args_list),
                            'The read-only SDK initialization functionality must remain intact.')
            rest.fetch.assert_not_called()
        finally:
            await rest.close()

    async def test_registry_rest_and_pro_full_load_markets_never_change_account_setup(self):
        registry = CcxtClientRegistry(SimpleNamespace(), SimpleNamespace())
        clients = await registry._replace_clients(bound_test_account('hyperliquid'), test_secret('hyperliquid'), 'fixture', None)
        responses = {
            'userAbstraction': 'disabled', 'spotMeta': {'tokens': [], 'universe': []},
            'spotMetaAndAssetCtxs': [{'tokens': [], 'universe': []}, []], 'perpDexs': [None],
            'metaAndAssetCtxs': [{'universe': [{'name': 'BTC', 'szDecimals': 3, 'maxLeverage': 50}]}, [{'markPx': '100'}]],
        }
        try:
            for client in (clients.rest, clients.pro):
                client.publicPostInfo = AsyncMock(side_effect=lambda params: copy.deepcopy(responses[params['type']]))
                client.privatePostExchange = AsyncMock(return_value={})
                client.fetch = AsyncMock(side_effect=AssertionError('Provider transport forbidden.'))
                markets = await client.load_markets()
                self.assertTrue(markets, 'Full SDK bootstrap must still load and parse the public market metadata.')
                self.assertTrue(any(call.args[0]['type'] == 'userAbstraction' for call in client.publicPostInfo.await_args_list))
                client.privatePostExchange.assert_not_called()
                client.fetch.assert_not_called()
                self.assertFalse(client.options['approvedBuilderFee'])
                self.assertFalse(client.options.get('refSet', False))
        finally:
            await clients.close()

    async def test_kraken_sdk_lowercase_ioc_encoding_is_known_but_not_a_protected_capability_grant(self):
        rest = sdk('krakenfutures')
        rest.privatePostBatchorder = AsyncMock(return_value={'batchStatus': []})
        try:
            orders = await specs('bybit', 'buy')
            orders[0]['params'] = {'timeInForce': 'ioc', 'clientOrderId': 'entry-client', 'reduceOnly': False}
            await rest.create_orders(orders)
            entry, stop = rest.privatePostBatchorder.await_args.args[0]['batchOrder']
            self.assertEqual((entry['orderType'], entry['limitPrice']), ('ioc', '100.5'))
            self.assertEqual(stop['orderType'], 'stp')
            self.assertNotIn('limitPrice', stop, 'SDK emits a stop-market form whose batch documentation conflicts.')
            rest.fetch.assert_not_called()
        finally:
            await rest.close()


if __name__ == '__main__':
    unittest.main()
