"""Pinned SDK boundary probes; no provider access and no certification claims."""
from __future__ import annotations

import builtins
import unittest
from unittest.mock import AsyncMock, Mock, patch

import ccxt
import ccxt.async_support as sdk


def client_for(exchange: str):
    client = getattr(sdk, exchange)({'options': {'adjustForTimeDifference': False}})
    client.fetch = AsyncMock(side_effect=AssertionError('Provider transport is forbidden.'))
    client.request = AsyncMock(side_effect=AssertionError('Unexpected SDK endpoint is forbidden.'))
    client.set_markets([{
        'id': 'BTC-USDT' if exchange == 'deepcoin' else 'BTCUSDT', 'symbol': 'BTC/USDT:USDT',
        'base': 'BTC', 'quote': 'USDT', 'settle': 'USDT', 'baseId': 'BTC', 'quoteId': 'USDT',
        'settleId': 'USDT', 'type': 'swap', 'spot': False, 'swap': True, 'future': False,
        'contract': True, 'linear': True, 'inverse': False, 'active': True, 'contractSize': 1,
        'precision': {'amount': 0.001, 'price': 0.1}, 'limits': {},
        'info': {'l2Config': {'syntheticId': '1', 'collateralId': '2',
                              'syntheticResolution': 1000, 'collateralResolution': 1000}},
    }])
    return client


class CandidateBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def test_pinned_sdk(self):
        self.assertEqual(ccxt.__version__, '4.5.75')

    async def test_apex_order_signing_requires_external_zklink_sdk(self):
        client = client_for('apex')
        real_import = builtins.__import__

        def without_external_sdk(name, *args, **kwargs):
            if name == 'apexpro.zklink_sdk':
                raise ImportError('Deliberately unavailable external provider SDK.')
            return real_import(name, *args, **kwargs)

        try:
            with patch('builtins.__import__', side_effect=without_external_sdk):
                with self.assertRaisesRegex(Exception, 'zklink_sdk is not installed'):
                    client.get_zk_contract_signature_obj('00' * 32)
        finally:
            client.fetch.assert_not_called()
            client.request.assert_not_called()
            await client.close()

    async def test_bybiteu_inherited_market_loader_is_not_derivatives_authority(self):
        client = client_for('bybiteu')
        client.fetch_spot_markets = AsyncMock(return_value=[])
        client.fetch_future_markets = AsyncMock(return_value=[])
        client.fetch_option_markets = AsyncMock(return_value=[])
        try:
            self.assertIs(client.has['swap'], False)
            self.assertIs(client.has['future'], False)
            await client.fetch_markets()
            client.fetch_spot_markets.assert_awaited_once()
            # Inherited fetching code still schedules derivatives despite the
            # regional product declarations. Never infer product permission from it.
            self.assertEqual(client.fetch_future_markets.await_count, 2)
            self.assertEqual(client.fetch_option_markets.await_count, 6)
            self.assertEqual([call.args[0]['baseCoin'] for call in client.fetch_option_markets.await_args_list],
                             ['BTC', 'ETH', 'SOL', 'XRP', 'MNT', 'DOGE'])
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_gateeu_explicit_loader_scope_is_spot_only(self):
        client = client_for('gateeu')
        client.check_required_credentials = Mock(return_value=False)
        client.fetch_spot_markets = AsyncMock(return_value=[])
        client.fetch_swap_markets = AsyncMock(side_effect=AssertionError('Regional derivative request.'))
        client.fetch_future_markets = AsyncMock(side_effect=AssertionError('Regional derivative request.'))
        client.fetch_option_markets = AsyncMock(side_effect=AssertionError('Regional option request.'))
        try:
            self.assertIs(client.has['swap'], False)
            self.assertIs(client.has['future'], False)
            self.assertEqual(client.options['fetchMarkets']['types'], ['spot'])
            await client.fetch_markets()
            client.fetch_spot_markets.assert_awaited_once()
            client.fetch_swap_markets.assert_not_called()
            client.fetch_future_markets.assert_not_called()
            client.fetch_option_markets.assert_not_called()
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_extended_market_stop_requires_an_execution_price(self):
        client = client_for('extended')
        try:
            with self.assertRaisesRegex(ccxt.ArgumentsRequired, 'requires a price'):
                await client.create_extended_order_request(
                    'BTC/USDT:USDT', 'market', 'sell', '0.01', None,
                    {'stopLossPrice': '90', 'reduceOnly': True})
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_extended_attached_stop_contains_no_independent_child_identity(self):
        client = client_for('extended')
        client.fetch_extended_account = AsyncMock(return_value={'l2Key': '1', 'l2Vault': '1'})
        client.create_order_settlement_data = Mock(return_value={'r': '1', 's': '2'})
        try:
            result = await client.create_extended_order_request(
                'BTC/USDT:USDT', 'limit', 'buy', '0.01', '100',
                {'clientOrderId': 'tsx-entry', 'timeInForce': 'IOC', 'builderFeeRate': '0',
                 'stopLoss': {'triggerPrice': '90', 'price': '88.7', 'type': 'MARKET'}})
            wire = result['request']
            self.assertEqual((wire['id'], wire['timeInForce'], wire['tpSlType']), ('tsx-entry', 'IOC', 'ORDER'))
            self.assertEqual((wire['stopLoss']['triggerPrice'], wire['stopLoss']['price']), ('90', '88.7'))
            self.assertNotIn('id', wire['stopLoss'])
            self.assertNotIn('externalId', wire['stopLoss'])
            self.assertEqual(client.create_order_settlement_data.call_count, 2)
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_weex_stop_is_an_algo_request_not_a_normal_batch_leg(self):
        client = client_for('weex')
        client.contractPrivatePostCapiV3AlgoOrder = AsyncMock(return_value={
            'algoId': '123', 'clientAlgoId': 'tsx-stop', 'symbol': 'BTCUSDT'})
        try:
            await client.create_order('BTC/USDT:USDT', 'market', 'sell', '0.01', None,
                                      {'clientOrderId': 'tsx-stop', 'stopLossPrice': '90', 'reduceOnly': True})
            wire = client.contractPrivatePostCapiV3AlgoOrder.await_args.args[0]
            self.assertEqual((wire['type'], wire['clientAlgoId'], wire['triggerPrice']),
                             ('STOP_MARKET', 'tsx-stop', '90'))
            client.contractPrivatePostCapiV3AlgoOrder.assert_awaited_once()
            with self.assertRaisesRegex(ccxt.NotSupported, 'does not support stop loss'):
                client.create_contract_order_request('BTC/USDT:USDT', 'market', 'sell', '0.01', None,
                                                     {'stopLossPrice': '90', 'callerMethodName': 'createOrders'})
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_deepcoin_trigger_does_not_use_the_regular_order_endpoint(self):
        client = client_for('deepcoin')
        client.privatePostDeepcoinTradeTriggerOrder = AsyncMock(return_value={
            'code': '0', 'data': {'ordId': '123', 'clOrdId': 'tsx-stop'}})
        try:
            await client.create_order('BTC/USDT:USDT', 'market', 'sell', '0.01', None,
                                      {'clientOrderId': 'tsx-stop', 'triggerPrice': '90', 'reduceOnly': True})
            wire = client.privatePostDeepcoinTradeTriggerOrder.await_args.args[0]
            self.assertEqual((wire['triggerPrice'], wire['orderType'], wire['posSide']), ('90', 'market', 'long'))
            client.privatePostDeepcoinTradeTriggerOrder.assert_awaited_once()
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()
