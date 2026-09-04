"""Pure Classic contract checks and pinned SDK wire fakes, not a profile grant.

The fixture uses the native fields documented by KuCoin's Get Symbol page on
2026-09-03, with synthetic limits/prices. No public or private host is contacted.
"""
from __future__ import annotations

import copy
import json
import socket
import sys
import unittest
from dataclasses import FrozenInstanceError
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import ccxt
import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kucoin_contracts import KucoinContractError, kucoin_sdk_amount, normalize_kucoin_contract


NATIVE_SYMBOL = 'XBTUSDTM'
SYMBOL = 'BTC/USDT:USDT'


def raw_contract(**changes):
    # parse_float=Decimal preserves the original numerical tokens; CCXT's
    # default float-decoded info is deliberately not an exact original source.
    raw = json.loads('''{
        "symbol":"XBTUSDTM", "rootSymbol":"USDT", "type":"FFWCSX",
        "baseCurrency":"XBT", "quoteCurrency":"USDT", "settleCurrency":"USDT",
        "expireDate":null, "settleDate":null, "settlementSymbol":"",
        "isInverse":false, "isQuanto":true, "status":"Open", "marketStage":"NORMAL",
        "fairMethod":"FundingRate", "fundingRateGranularity":28800000,
        "nextFundingRateTime":3929820, "multiplier":0.001, "lotSize":1,
        "tickSize":0.1, "maxOrderQty":10, "marketMaxOrderQty":6,
        "maxPrice":1000000, "supportCross":true
    }''', parse_float=Decimal)
    raw.update(changes)
    return raw


def sdk_amount(raw=None, amount='2', **changes):
    arguments = {'expected_symbol': NATIVE_SYMBOL, 'expected_contract_size': '0.001',
                 'base_quantity': '0.002', 'order_type': 'limit'}
    arguments.update(changes)
    return kucoin_sdk_amount(raw_contract() if raw is None else raw, amount, **arguments)


class KucoinContractTests(unittest.TestCase):
    def test_native_units_are_exact_immutable_and_do_not_rewrite_originals(self):
        raw = raw_contract()
        original = copy.deepcopy(raw)
        contract = normalize_kucoin_contract(raw, expected_symbol=NATIVE_SYMBOL)
        self.assertEqual(contract.native_symbol, NATIVE_SYMBOL)
        self.assertEqual(contract.base_currency, 'XBT', 'Never invent the BTC/XBT currency alias here.')
        self.assertEqual((contract.quote_currency, contract.settlement_currency), ('USDT', 'USDT'))
        self.assertIs(contract.provider_is_quanto, True, 'Native isQuanto must not be silently rewritten.')
        self.assertEqual(contract.contract_size, Decimal('0.001'))
        self.assertEqual(contract.price_tick, Decimal('0.1'))
        self.assertEqual((contract.lot_size, contract.max_order_quantity, contract.market_max_order_quantity), (1, 10, 6))
        self.assertEqual(raw, original)
        self.assertIsInstance(raw['multiplier'], Decimal)
        with self.assertRaises(FrozenInstanceError):
            contract.lot_size = 2

    def test_every_required_raw_field_is_required_without_sdk_defaults(self):
        required = ('symbol', 'rootSymbol', 'type', 'baseCurrency', 'quoteCurrency', 'settleCurrency',
                    'expireDate', 'settleDate', 'settlementSymbol', 'isInverse', 'isQuanto', 'status',
                    'marketStage', 'fairMethod', 'fundingRateGranularity', 'nextFundingRateTime',
                    'multiplier', 'lotSize', 'tickSize', 'maxOrderQty', 'marketMaxOrderQty')
        for field in required:
            with self.subTest(field=field):
                raw = raw_contract()
                del raw[field]
                with self.assertRaises(KucoinContractError):
                    normalize_kucoin_contract(raw, expected_symbol=NATIVE_SYMBOL)

    def test_non_reviewed_product_modes_and_conflicting_native_flags_fail_closed(self):
        changes = [('symbol', 'BTCUSDTM'), ('rootSymbol', 'BTC'), ('type', 'FFICSX'),
                   ('baseCurrency', ''), ('baseCurrency', 'BTC/USDT'), ('baseCurrency', 'USDT'),
                   ('quoteCurrency', 'USD'), ('settleCurrency', 'USDC'), ('isInverse', True),
                   ('isInverse', 0), ('isInverse', 'false'), ('isQuanto', False), ('isQuanto', 1),
                   ('isQuanto', None), ('status', 'Closed'), ('status', 'Settled'), ('status', None),
                   ('marketStage', 'PRE_MARKET'), ('marketStage', None), ('fairMethod', 'BasisRate'),
                   ('expireDate', 0), ('expireDate', 1), ('settleDate', 1), ('settlementSymbol', '.SETTLE')]
        for field, value in changes:
            with self.subTest(field=field, value=value), self.assertRaises(KucoinContractError):
                normalize_kucoin_contract(raw_contract(**{field: value}), expected_symbol=NATIVE_SYMBOL)
        for value in (None, [], {'contract': True, 'swap': True, 'linear': True}, raw_contract(symbol='XBTUSDTM ')):
            with self.subTest(value=value), self.assertRaises(KucoinContractError):
                normalize_kucoin_contract(value, expected_symbol=NATIVE_SYMBOL)

    def test_unknown_or_malformed_units_and_limits_are_not_coerced(self):
        for field in ('multiplier', 'tickSize', 'lotSize', 'maxOrderQty', 'marketMaxOrderQty'):
            for value in (None, True, False, 0, '-1', 1.0, float('nan'), 'NaN', 'Infinity', '1_0', ' 1',
                          Decimal('sNaN'), Decimal('1E-1000000000'), '1e1000000000', '1e' + '9' * 60, '9' * 1000):
                with self.subTest(field=field, value=repr(value)), self.assertRaises(KucoinContractError):
                    normalize_kucoin_contract(raw_contract(**{field: value}), expected_symbol=NATIVE_SYMBOL)
        for field in ('lotSize', 'maxOrderQty', 'marketMaxOrderQty'):
            for value in ('0.5', '9007199254740992'):
                with self.subTest(field=field, value=value), self.assertRaises(KucoinContractError):
                    normalize_kucoin_contract(raw_contract(**{field: value}), expected_symbol=NATIVE_SYMBOL)
        for field in ('fundingRateGranularity', 'nextFundingRateTime'):
            for value in (None, True, -1, 1.5, '1', 9_007_199_254_740_992):
                with self.subTest(field=field, value=value), self.assertRaises(KucoinContractError):
                    normalize_kucoin_contract(raw_contract(**{field: value}), expected_symbol=NATIVE_SYMBOL)
        for raw in (raw_contract(lotSize=7), raw_contract(fundingRateGranularity=0)):
            with self.assertRaises(KucoinContractError):
                normalize_kucoin_contract(raw, expected_symbol=NATIVE_SYMBOL)

    def test_string_integer_and_decimal_contract_amounts_return_exact_python_integer(self):
        for amount in ('2', '2.0', 2, Decimal('2.000')):
            with self.subTest(amount=amount):
                result = sdk_amount(amount=amount)
                self.assertIs(type(result), int)
                self.assertEqual(result, 2)
        self.assertEqual(sdk_amount(amount='1', base_quantity='0.001'), 1)
        self.assertEqual(sdk_amount(amount='10', base_quantity='0.01'), 10)
        self.assertEqual(sdk_amount(amount='6', base_quantity='0.006', order_type='market'), 6)
        self.assertEqual(sdk_amount(raw_contract(nextFundingRateTime=0)), 2,
                         'A zero funding countdown is not an expired contract timestamp.')

    def test_exact_product_and_original_contract_size_are_mandatory(self):
        invalid = ({'expected_symbol': 'BTCUSDTM'}, {'expected_contract_size': '0.01'},
                   {'expected_contract_size': None}, {'expected_contract_size': 0.001},
                   {'base_quantity': '0.002000000000000001'}, {'base_quantity': '0.001999999999999999'},
                   {'base_quantity': 0.002}, {'base_quantity': None}, {'order_type': 'stop_market'},
                   {'order_type': 'LIMIT'}, {'order_type': None})
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(KucoinContractError):
                sdk_amount(**changes)

    def test_fractional_steps_and_order_specific_limits_cannot_be_truncated(self):
        for amount in ('2.000000000000000001', '1.999999999999999999', '0.9', '0', '-2', True, 2.0,
                       '9007199254740992', 'NaN', Decimal('Infinity')):
            with self.subTest(amount=amount), self.assertRaises(KucoinContractError):
                sdk_amount(amount=amount)
        self.assertEqual(sdk_amount(raw_contract(lotSize=2)), 2)
        for raw, amount, quantity, kind in ((raw_contract(lotSize=2), '3', '0.003', 'limit'),
                                          (raw_contract(), '11', '0.011', 'limit'),
                                          (raw_contract(), '7', '0.007', 'market'),
                                          (raw_contract(marketMaxOrderQty=20), '11', '0.011', 'market')):
            with self.subTest(amount=amount, kind=kind), self.assertRaises(KucoinContractError):
                sdk_amount(raw, amount, base_quantity=quantity, order_type=kind)

    def test_arithmetic_is_independent_of_decimal_context_and_never_rounds_to_fit(self):
        raw = raw_contract(multiplier=Decimal('0.123456789123456789'))
        with localcontext() as context:
            context.prec = 2
            self.assertEqual(sdk_amount(raw, '2', expected_contract_size='0.123456789123456789',
                                        base_quantity='0.246913578246913578'), 2)
            with self.assertRaises(KucoinContractError):
                sdk_amount(raw, '2', expected_contract_size='0.123456789123456789',
                           base_quantity='0.246913578246913579')
        tiny = raw_contract(multiplier=Decimal('1E-18'), tickSize=Decimal('1E-18'))
        self.assertEqual(sdk_amount(tiny, '2', expected_contract_size='0.000000000000000001',
                                    base_quantity='0.000000000000000002'), 2)
        for value in (Decimal('1E-19'), Decimal('1E36')):
            with self.subTest(value=value), self.assertRaises(KucoinContractError):
                normalize_kucoin_contract(raw_contract(multiplier=value), expected_symbol=NATIVE_SYMBOL)

    def test_raw_decimal_spellings_preserve_values_and_do_not_create_scope_authority(self):
        raw = raw_contract(multiplier='1.000E-3', tickSize='0.10000', lotSize='2.000',
                           maxOrderQty='1E1', marketMaxOrderQty='6.0')
        original = copy.deepcopy(raw)
        self.assertEqual(sdk_amount(raw), 2)
        self.assertEqual(raw, original, 'Never canonicalize the caller-owned original fields in place.')
        for symbol in (None, '', 'XBTUSDTM ', 'xbtusdtm', 'X' * 65):
            with self.subTest(symbol=symbol), self.assertRaises(KucoinContractError):
                normalize_kucoin_contract(raw, expected_symbol=symbol)


class KucoinContractSdkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, '4.5.75')
        # Install after IsolatedAsyncioTestCase has created Windows' local
        # event-loop socketpair, but before any SDK instance can open transport.
        for target in ((socket.socket, 'connect'), (socket.socket, 'connect_ex'),
                       (socket, 'getaddrinfo'), (socket, 'create_connection')):
            blocker = patch.object(*target, side_effect=AssertionError('Live transport forbidden.'))
            blocker.start()
            self.addCleanup(blocker.stop)

    async def sdk(self, exchange, raw):
        rest = getattr(ccxt_async, exchange)({'enableRateLimit': False, 'apiKey': 'local-fixture-key',
                    'secret': 'local-fixture-secret', 'password': 'local-fixture-passphrase',
                    'options': {'uta': False, 'defaultType': 'swap'}})
        self.addAsyncCleanup(rest.close)
        calls = []
        # The SDK's own standard JSON path sees floats, independently of the
        # retained exact original used by our helper. Injecting Decimal into
        # CCXT safe_number would produce None rather than its real market parse.
        sdk_raw = json.loads(json.dumps(raw, default=float))

        async def intercepted(url, method='GET', headers=None, body=None):
            path = urlsplit(url).path
            calls.append((path, method, json.loads(body) if body else None))
            if path == '/api/v1/contracts/active' and method == 'GET':
                return {'code': '200000', 'data': [copy.deepcopy(sdk_raw)]}
            self.assertEqual((path, method), ('/api/v1/orders/multi', 'POST'))
            self.assertTrue(headers.get('KC-API-SIGN'), 'Use the actual pinned signer; do not expose the signature.')
            return {'code': '200000', 'data': [{'orderId': f"id-{row['clientOid']}", 'clientOid': row['clientOid'],
                     'symbol': NATIVE_SYMBOL, 'code': '200000', 'msg': 'success'} for row in json.loads(body)]}

        rest.fetch = intercepted
        rest.set_markets(await rest.fetch_contract_markets())
        return rest, calls

    async def test_helper_amount_reaches_signed_batch_unchanged_for_both_classes_and_sides(self):
        for exchange in ('kucoin', 'kucoinfutures'):
            for side in ('buy', 'sell'):
                with self.subTest(exchange=exchange, side=side):
                    raw = raw_contract(lotSize=2)
                    original = copy.deepcopy(raw)
                    rest, calls = await self.sdk(exchange, raw)
                    entry_amount = sdk_amount(raw)
                    stop_amount = sdk_amount(raw, order_type='market')
                    parameters = {'marginMode': 'cross', 'positionSide': 'BOTH', 'leverage': 2}
                    orders = [{'symbol': SYMBOL, 'type': 'limit', 'side': side, 'amount': entry_amount, 'price': '100',
                               'params': {**parameters, 'clientOrderId': 'own-entry', 'timeInForce': 'IOC'}},
                              {'symbol': SYMBOL, 'type': 'market', 'side': 'sell' if side == 'buy' else 'buy',
                               'amount': stop_amount, 'params': {**parameters, 'clientOrderId': 'own-stop',
                               'reduceOnly': True, 'stopLossPrice': '90' if side == 'buy' else '110'}}]
                    parsed = await rest.create_orders(copy.deepcopy(orders))
                    self.assertEqual(len(calls), 2, 'One explicit market fixture and one batch; no hidden mode/network reads.')
                    wire_entry, wire_stop = calls[-1][2]
                    self.assertEqual([row['id'] for row in parsed], ['id-own-entry', 'id-own-stop'])
                    self.assertEqual((wire_entry['size'], wire_stop['size']), (2, 2))
                    self.assertIs(type(wire_entry['size']), int)
                    self.assertEqual(Fraction(wire_entry['size']) * Fraction(raw['multiplier']), Fraction('0.002'))
                    self.assertEqual(wire_entry['symbol'], NATIVE_SYMBOL)
                    self.assertEqual((wire_entry['price'], wire_entry['timeInForce']), ('100', 'IOC'))
                    self.assertEqual(wire_stop['stop'], 'down' if side == 'buy' else 'up')
                    self.assertTrue(wire_stop['reduceOnly'])
                    self.assertEqual(raw, original, 'The pure helper and SDK specimen must preserve originals.')

    async def test_raw_string_sdk_amount_is_a_real_zero_write_counterexample(self):
        rest, calls = await self.sdk('kucoinfutures', raw_contract())
        with self.assertRaises(TypeError):
            await rest.create_orders([{'symbol': SYMBOL, 'type': 'limit', 'side': 'buy',
                                      'amount': '2', 'price': '100', 'params': {'clientOrderId': 'own'}}])
        self.assertEqual(len(calls), 1, 'Unconverted string cannot reach the signer/transport.')

    async def test_safe_integer_serialization_boundary_stays_exact_on_actual_sdk_wire(self):
        maximum = 9_007_199_254_740_991
        raw = raw_contract(maxOrderQty=maximum, marketMaxOrderQty=maximum)
        rest, calls = await self.sdk('kucoinfutures', raw)
        converted = sdk_amount(raw, str(maximum), base_quantity='9007199254740.991')
        await rest.create_orders([{'symbol': SYMBOL, 'type': 'limit', 'side': 'buy', 'amount': converted,
                                   'price': '100', 'params': {'clientOrderId': 'own-large-fixture'}}])
        self.assertEqual(calls[-1][2][0]['size'], maximum)
        self.assertIs(type(calls[-1][2][0]['size']), int)
        self.assertEqual(len(calls), 2)

    async def test_fraction_or_market_limit_failure_happens_before_batch(self):
        rest, calls = await self.sdk('kucoinfutures', raw_contract())
        for amount, quantity in (('2.5', '0.0025'), ('7', '0.007')):
            with self.subTest(amount=amount), self.assertRaises(KucoinContractError):
                converted = sdk_amount(amount=amount, base_quantity=quantity, order_type='market')
                await rest.create_orders([{'symbol': SYMBOL, 'type': 'market', 'side': 'sell', 'amount': converted}])
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
