"""Offline boundary probes for Aster, BingX, Bitget, and DeepCoin.

These tests characterize the pinned SDK only. They do not certify a profile or
claim that a provider accepted any request.
"""
from __future__ import annotations

import copy
import json
import unittest
from unittest.mock import AsyncMock, Mock

import ccxt
import ccxt.async_support as sdk
import ccxt.pro as sdk_pro


def _client(exchange: str):
    client = getattr(sdk, exchange)({
        'options': {'defaultType': 'swap', 'defaultSubType': 'linear',
                    'adjustForTimeDifference': False,
                    'fetchOpenOrders': {'warnIfNoSymbol': False}},
    })
    market_id = {
        'aster': 'BTCUSDT',
        'bingx': 'BTC-USDT',
        'bitget': 'BTCUSDT',
        'deepcoin': 'BTC-USDT-SWAP',
    }[exchange]
    client.set_markets([{
        'id': market_id,
        'symbol': 'BTC/USDT:USDT',
        'base': 'BTC',
        'quote': 'USDT',
        'settle': 'USDT',
        'baseId': 'BTC',
        'quoteId': 'USDT',
        'settleId': 'USDT',
        'type': 'swap',
        'spot': False,
        'swap': True,
        'future': False,
        'contract': True,
        'linear': True,
        'inverse': False,
        'active': True,
        'contractSize': 1,
        'precision': {'amount': 0.001, 'price': 0.1},
        'limits': {},
        'info': {},
    }])
    client.fetch = AsyncMock(side_effect=AssertionError('Provider transport is forbidden.'))
    client.request = AsyncMock(side_effect=AssertionError('Unexpected SDK endpoint is forbidden.'))
    return client


def _protected_pair() -> tuple[dict, dict]:
    entry = {
        'symbol': 'BTC/USDT:USDT',
        'type': 'limit',
        'side': 'buy',
        'amount': '0.01',
        'price': '100.5',
        'params': {
            'clientOrderId': 'tsx-entry',
            'timeInForce': 'IOC',
            'marginMode': 'cross',
        },
    }
    stop = {
        'symbol': entry['symbol'],
        'type': 'market',
        'side': 'sell',
        'amount': '0.01',
        'price': None,
        'params': {
            'clientOrderId': 'tsx-stop',
            'stopLossPrice': '90',
            'reduceOnly': True,
            'marginMode': 'cross',
        },
    }
    return entry, stop


class CandidateGroupABoundaries(unittest.IsolatedAsyncioTestCase):
    def test_characterization_is_bound_to_ccxt_4_5_75(self):
        self.assertEqual(ccxt.__version__, '4.5.75')

    async def test_aster_unified_open_orders_never_reads_strategy_orders(self):
        client = _client('aster')
        client.fapiPrivateGetV3OpenOrders = AsyncMock(return_value=[])
        client.fapiPrivateGetV3StrategyOpenOrder = AsyncMock(
            side_effect=AssertionError('Identifier-bound strategy lookup must not be treated as a list.'),
        )
        try:
            self.assertTrue(callable(getattr(client, 'fapiPrivateGetV3StrategyOpenOrder', None)))
            self.assertFalse(callable(getattr(client, 'fapiPrivateGetV3StrategyOpenOrders', None)))
            self.assertEqual(await client.fetch_open_orders(), [])
            client.fapiPrivateGetV3OpenOrders.assert_awaited_once()
            client.fapiPrivateGetV3StrategyOpenOrder.assert_not_called()
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_bingx_client_only_lookup_serializes_a_null_exchange_id(self):
        client = _client('bingx')
        client.swapV2PrivateGetTradeOrder = AsyncMock(return_value={
            'code': 0,
            'data': {
                'orderId': '90071992547409931',
                'orderID': '90071992547409931',
                'symbol': 'BTC-USDT',
                'clientOrderId': 'tsx-stop',
                'side': 'SELL',
                'positionSide': 'BOTH',
                'type': 'STOP_MARKET',
                'origQty': '0.01',
                'executedQty': '0',
                'price': '0',
                'stopPrice': '90',
                'status': 'NEW',
            },
        })
        try:
            order = await client.fetch_order(
                None, 'BTC/USDT:USDT', {'clientOrderId': 'tsx-stop'},
            )
            request = client.swapV2PrivateGetTradeOrder.await_args.args[0]
            self.assertIsNone(request['orderId'])
            self.assertEqual(request['clientOrderId'], 'tsx-stop')
            self.assertEqual(request['symbol'], 'BTC-USDT')
            self.assertEqual(order['id'], '90071992547409931')
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_bingx_batch_parser_drops_the_failure_collection(self):
        client = _client('bingx')
        raw_entry = {
            'orderId': '90071992547409931',
            'orderID': '90071992547409931',
            'symbol': 'BTC-USDT',
            'clientOrderID': 'tsx-entry',
            'side': 'BUY',
            'positionSide': 'BOTH',
            'type': 'LIMIT',
            'origQty': '0.01',
            'executedQty': '0',
            'price': '100.5',
            'status': 'NEW',
        }
        client.swapV2PrivatePostTradeBatchOrders = AsyncMock(return_value={
            'code': 0,
            'data': {
                'orders': [raw_entry],
                'errors': [{'clientOrderId': 'tsx-stop', 'code': 101400,
                            'msg': 'stop rejected'}],
            },
        })
        try:
            returned = await client.create_orders(copy.deepcopy(_protected_pair()))
            self.assertEqual(len(returned), 1)
            self.assertEqual(returned[0]['id'], raw_entry['orderID'])
            self.assertNotIn('errors', returned[0]['info'])
            wire = json.loads(
                client.swapV2PrivatePostTradeBatchOrders.await_args.args[0]['batchOrders'],
            )
            self.assertEqual([row['clientOrderID'] for row in wire], ['tsx-entry', 'tsx-stop'])
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_bitget_current_orders_require_separate_normal_and_plan_reads(self):
        client = _client('bitget')
        client.privateMixGetV2MixOrderOrdersPending = AsyncMock(return_value={
            'code': '00000',
            'data': {'entrustedList': [], 'endId': ''},
        })
        client.privateMixGetV2MixOrderOrdersPlanPending = AsyncMock(return_value={
            'code': '00000',
            'data': {'entrustedList': [], 'endId': ''},
        })
        try:
            self.assertEqual(
                await client.fetch_open_orders(None, None, 100, {'type': 'swap'}), [],
            )
            client.privateMixGetV2MixOrderOrdersPending.assert_awaited_once()
            client.privateMixGetV2MixOrderOrdersPlanPending.assert_not_called()

            self.assertEqual(
                await client.fetch_open_orders(
                    None, None, 100,
                    {'type': 'swap', 'trigger': True, 'planType': 'profit_loss'},
                ),
                [],
            )
            plan_request = client.privateMixGetV2MixOrderOrdersPlanPending.await_args.args[0]
            self.assertEqual(plan_request['planType'], 'profit_loss')
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_bitget_attached_stop_acknowledges_only_the_parent(self):
        client = _client('bitget')
        client.privateMixPostV2MixOrderBatchPlaceOrder = AsyncMock(return_value={
            'code': '00000',
            'data': {
                'successList': [{'orderId': 'parent-1', 'clientOid': 'tsx-entry'}],
                'failureList': [],
            },
        })
        try:
            entry, stop = _protected_pair()
            entry['params']['stopLoss'] = {'triggerPrice': stop['params']['stopLossPrice']}
            returned = await client.create_orders([copy.deepcopy(entry)])
            request = client.privateMixPostV2MixOrderBatchPlaceOrder.await_args.args[0]
            self.assertEqual(request['orderList'][0]['presetStopLossPrice'], '90')
            self.assertEqual([(row['id'], row['clientOrderId']) for row in returned],
                             [('parent-1', 'tsx-entry')])
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_deepcoin_has_no_native_create_orders_path(self):
        client = _client('deepcoin')
        try:
            self.assertIs(client.has['createOrders'], False)
            with self.assertRaisesRegex(ccxt.NotSupported, 'createOrders'):
                await client.create_orders(copy.deepcopy(_protected_pair()))
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_deepcoin_attached_stop_acknowledges_only_the_parent(self):
        client = _client('deepcoin')
        client.privatePostDeepcoinTradeOrder = AsyncMock(return_value={
            'code': '0',
            'data': {
                'ordId': 'parent-1',
                'clOrdId': 'tsx-entry',
                'sCode': '0',
                'sMsg': 'Success',
            },
        })
        try:
            order = await client.create_order(
                'BTC/USDT:USDT', 'limit', 'buy', '0.01', '100.5',
                {'clientOrderId': 'tsx-entry', 'timeInForce': 'IOC',
                 'marginMode': 'cross', 'stopLoss': {'triggerPrice': '90'}},
            )
            wire = client.privatePostDeepcoinTradeOrder.await_args.args[0]
            self.assertEqual((wire['ordType'], wire['slTriggerPx']), ('ioc', '90'))
            self.assertEqual((order['id'], order['clientOrderId']), ('parent-1', 'tsx-entry'))
            self.assertNotIn('stopOrderId', order['info'])
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_deepcoin_trigger_snapshot_has_no_client_identity_or_cursor(self):
        client = _client('deepcoin')
        client.privateGetDeepcoinTradeTriggerOrdersPending = AsyncMock(return_value={
            'code': '0',
            'data': [{
                'instType': 'SWAP',
                'instId': 'BTC-USDT-SWAP',
                'ordId': 'trigger-1',
                'triggerPx': '90',
                'ordPx': '0',
                'sz': '0.01',
                'ordType': 'market',
                'side': 'sell',
                'posSide': 'long',
                'tdMode': 'cross',
                'triggerOrderType': 'TPSL',
                'triggerPxType': 'last',
                'cTime': '1760000000000',
                'uTime': '1760000000000',
            }],
        })
        try:
            orders = await client.fetch_open_orders(
                'BTC/USDT:USDT', None, 100, {'trigger': True},
            )
            request = client.privateGetDeepcoinTradeTriggerOrdersPending.await_args.args[0]
            self.assertEqual(request['limit'], 100)
            self.assertNotIn('index', request)
            self.assertNotIn('cursor', request)
            self.assertEqual(orders[0]['id'], 'trigger-1')
            self.assertIsNone(orders[0]['clientOrderId'])
            client.fetch.assert_not_called()
            client.request.assert_not_called()
        finally:
            await client.close()

    async def test_deepcoin_pro_ignores_the_documented_trigger_order_event(self):
        client = sdk_pro.deepcoin()
        socket = Mock()
        try:
            client.handle_message(socket, {
                'action': 'PushTriggerOrder',
                'result': [{
                    'table': 'TriggerOrder',
                    'data': {'OS': 'trigger-1', 'I': 'BTCUSDT', 'TS': '1'},
                }],
            })
            self.assertEqual(socket.mock_calls, [])
        finally:
            await client.close()
