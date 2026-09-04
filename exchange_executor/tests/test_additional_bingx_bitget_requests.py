"""Offline SDK characterization, not provider acceptance or profile certification."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import ccxt
import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import ExchangeContractError, UnresolvedOrderOutcome
from order_identity import correlate_batch, write_order_identity


def candidate_client(exchange):
    client = getattr(ccxt_async, exchange)({'options': {'defaultType': 'swap', 'defaultSubType': 'linear'}})
    client.set_markets([{
        'id': 'BTC-USDT' if exchange == 'bingx' else 'BTCUSDT', 'symbol': 'BTC/USDT:USDT',
        'base': 'BTC', 'quote': 'USDT', 'settle': 'USDT', 'baseId': 'BTC', 'quoteId': 'USDT',
        'settleId': 'USDT', 'type': 'swap', 'spot': False, 'swap': True, 'future': False,
        'contract': True, 'linear': True, 'inverse': False, 'active': True, 'contractSize': 1,
        'precision': {'amount': 0.001, 'price': 0.1}, 'limits': {}, 'info': {},
    }])
    client.fetch = AsyncMock(side_effect=AssertionError('Real provider transport is forbidden.'))
    client.request = AsyncMock(side_effect=AssertionError('Unexpected SDK endpoint is forbidden.'))
    return client


def requested_pair():
    entry = {'symbol': 'BTC/USDT:USDT', 'type': 'limit', 'side': 'buy', 'amount': '0.01',
             'price': '100.5', 'params': {'clientOrderId': 'tsx-entry', 'timeInForce': 'IOC', 'marginMode': 'cross'}}
    stop = {'symbol': entry['symbol'], 'type': 'market', 'side': 'sell', 'amount': '0.01',
            'price': None, 'params': {'clientOrderId': 'tsx-stop', 'stopLossPrice': '90', 'reduceOnly': True,
                                    'marginMode': 'cross'}}
    return entry, stop


class AdditionalSdkRequestTests(unittest.IsolatedAsyncioTestCase):
    def test_characterization_is_bound_to_the_installed_sdk_version(self):
        self.assertEqual(ccxt.__version__, '4.5.75')

    async def test_bitget_normal_batch_does_not_switch_to_the_tpsl_endpoint(self):
        client = candidate_client('bitget')
        client.privateMixPostV2MixOrderBatchPlaceOrder = AsyncMock(return_value={
            'code': '00000', 'data': {'successList': [], 'failureList': []}})
        try:
            await client.create_orders(copy.deepcopy(requested_pair()))
            body = client.privateMixPostV2MixOrderBatchPlaceOrder.await_args.args[0]
            self.assertEqual(body['productType'], 'USDT-FUTURES')
            self.assertEqual(body['marginMode'], 'crossed')
            entry, stop = body['orderList']
            # The pinned SDK forwards the caller's original case to force;
            # the provider documents lowercase. A future profile must map it.
            self.assertEqual((entry['orderType'], entry['force'], entry['price']), ('limit', 'IOC', '100.5'))
            # The pinned SDK serializes the standalone SL shape into the normal
            # batch endpoint. That does NOT prove the provider accepts it there.
            self.assertEqual((stop['planType'], stop['triggerPrice']), ('pos_loss', '90'))
            self.assertEqual(stop['clientOid'], 'tsx-stop')
            client.privateMixPostV2MixOrderBatchPlaceOrder.assert_awaited_once()
            client.request.assert_not_called()
            client.fetch.assert_not_called()
        finally:
            await client.close()

    async def test_bitget_attached_preset_is_not_an_acknowledged_child_order(self):
        client = candidate_client('bitget')
        client.privateMixPostV2MixOrderBatchPlaceOrder = AsyncMock(return_value={
            'code': '00000', 'data': {'successList': [{'orderId': 'parent-1', 'clientOid': 'tsx-entry'}],
                                    'failureList': []}})
        try:
            entry, stop = requested_pair()
            entry['params']['stopLoss'] = {'triggerPrice': stop['params']['stopLossPrice']}
            returned = await client.create_orders([copy.deepcopy(entry)])
            wire_entry = client.privateMixPostV2MixOrderBatchPlaceOrder.await_args.args[0]['orderList'][0]
            self.assertEqual(wire_entry['presetStopLossPrice'], '90')
            self.assertEqual(len(returned), 1)
            self.assertEqual(returned[0]['id'], 'parent-1')
            self.assertEqual(returned[0]['clientOrderId'], 'tsx-entry')
            with self.assertRaises(UnresolvedOrderOutcome):
                correlate_batch(returned, (entry, stop), lambda order, _: order, 'bitget')
            client.request.assert_not_called()
            client.fetch.assert_not_called()
        finally:
            await client.close()

    async def test_bingx_batch_preserves_ioc_and_separate_reduce_only_stop(self):
        client = candidate_client('bingx')
        client.swapV2PrivatePostTradeBatchOrders = AsyncMock(return_value={
            'code': 0, 'data': {'orders': [], 'errors': []}})
        try:
            await client.create_orders(copy.deepcopy(requested_pair()))
            body = client.swapV2PrivatePostTradeBatchOrders.await_args.args[0]
            entry, stop = json.loads(body['batchOrders'])
            self.assertEqual((entry['type'], entry['timeInForce'], entry['price']), ('LIMIT', 'IOC', 100.5))
            self.assertEqual((stop['type'], stop['stopPrice']), ('STOP_MARKET', 90))
            self.assertTrue(stop['reduceOnly'])
            self.assertEqual(stop['positionSide'], 'BOTH')
            self.assertEqual(stop['clientOrderID'], 'tsx-stop')
            self.assertNotIn('price', stop)
            client.swapV2PrivatePostTradeBatchOrders.assert_awaited_once()
            client.request.assert_not_called()
            client.fetch.assert_not_called()
        finally:
            await client.close()

    async def test_bingx_missing_stop_client_identity_remains_unresolved(self):
        client = candidate_client('bingx')
        raw_entry = {'orderId': '90071992547409931', 'symbol': 'BTC-USDT', 'clientOrderID': 'tsx-entry',
                     'side': 'BUY', 'type': 'LIMIT', 'origQty': '0.01', 'executedQty': '0', 'status': 'NEW'}
        raw_stop = {'orderId': '90071992547409932', 'symbol': 'BTC-USDT', 'clientOrderID': '',
                    'side': 'SELL', 'type': 'STOP_MARKET', 'origQty': '0.01', 'executedQty': '0', 'status': 'NEW'}
        client.swapV2PrivatePostTradeBatchOrders = AsyncMock(return_value={
            'code': 0, 'data': {'orders': [raw_entry, raw_stop], 'errors': []}})
        try:
            pair = requested_pair()
            returned = await client.create_orders(copy.deepcopy(pair))
            self.assertEqual([order['id'] for order in returned], [raw_entry['orderId'], raw_stop['orderId']])
            self.assertFalse(returned[1]['clientOrderId'])
            with self.assertRaises(ExchangeContractError):
                write_order_identity(returned[1], 'tsx-stop')
            with self.assertRaises(UnresolvedOrderOutcome) as raised:
                correlate_batch(returned, pair, lambda order, _: order, 'bingx')
            self.assertIn('unresolved', str(raised.exception).lower())
            client.request.assert_not_called()
            client.fetch.assert_not_called()
        finally:
            await client.close()
