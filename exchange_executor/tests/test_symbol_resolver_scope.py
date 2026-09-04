"""Execution-only normalized market scope; no native-source or profile grant."""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import ccxt
import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, SymbolUnavailableError
from symbol_resolver import SymbolResolutionError, linear_swap_markets, resolve_symbol


PREFERENCE = ('USDT', 'USDC', 'USD')


def market(**changes):
    row = {'id': 'BTCUSDT', 'symbol': 'BTC/USDT:USDT', 'base': 'BTC', 'quote': 'USDT', 'settle': 'USDT',
           'type': 'swap', 'contract': True, 'spot': False, 'swap': True, 'future': False, 'option': False,
           'linear': True, 'inverse': False, 'active': True, 'expiry': None, 'contractSize': 1}
    row.update(changes)
    return row


class SymbolScopeTests(unittest.TestCase):
    def reject(self, rows, code='SYMBOL_METADATA_UNPROVEN', preference=PREFERENCE):
        with self.assertRaises(SymbolResolutionError) as failure:
            resolve_symbol(rows, 'BTCUSDT', preference)
        self.assertEqual(failure.exception.code, code)

    def test_preference_ranks_only_the_explicit_whitelist_and_keeps_original(self):
        usdt = market()
        usdc = market(id='BTCUSDC', quote='USDC', settle='USDC', symbol='BTC/USDC:USDC')
        usd = market(id='BTCUSD', quote='USD', settle='USD', symbol='BTC/USD:USD')
        original = copy.deepcopy([usdt, usdc, usd])
        self.assertIs(resolve_symbol([usdt, usdc, usd], 'BTCUSDT', ('USDC', 'USDT')), usdc)
        self.assertIs(resolve_symbol([usdt, usdc, usd], 'BTCUSDT', ('USD',)), usd)
        self.assertEqual([usdt, usdc, usd], original)
        self.reject([usdt], 'SYMBOL_UNAVAILABLE', ('USDC',))
        self.reject([market(settle='ALT', symbol='BTC/USDT:ALT')], 'SYMBOL_UNAVAILABLE')
        self.reject([market(quote='EUR', symbol='BTC/EUR:USDT')], 'SYMBOL_UNAVAILABLE')

    def test_each_required_positive_field_is_explicit_not_a_default(self):
        for field in market():
            with self.subTest(field=field):
                row = market()
                del row[field]
                self.reject([row])
        for field in ('settle', 'quote', 'active', 'expiry', 'contractSize'):
            if field != 'expiry':
                with self.subTest(field=field):
                    self.reject([market(**{field: None})])

    def test_quote_cannot_replace_missing_settlement(self):
        for settle in (None, '', ' ', 'usdt', True):
            with self.subTest(settle=settle):
                self.reject([market(settle=settle)])

    def test_known_non_executable_products_are_unavailable_not_unknown(self):
        spot = market(type='spot', symbol='BTC/USDT', spot=True, contract=False, swap=False,
                      linear=None, inverse=None, settle=None, contractSize=None)
        future = market(type='future', swap=False, future=True, expiry=1_800_000_000_000,
                        symbol='BTC/USDT:USDT-270115')
        inverse = market(linear=False, inverse=True, quote='USD', settle='BTC', symbol='BTC/USD:BTC')
        self.reject([spot, future, inverse, market(active=False)], 'SYMBOL_UNAVAILABLE')
        self.assertEqual(resolve_symbol([spot, future, inverse, market()], 'BTCUSDT', PREFERENCE)['id'], 'BTCUSDT')

    def test_contradictory_flags_expiry_and_units_never_become_absence(self):
        changes = ({'inverse': True}, {'future': True}, {'spot': True}, {'option': True}, {'contract': False},
                   {'swap': False}, {'type': 'spot'}, {'expiry': 1_800_000_000_000}, {'expiry': 0},
                   {'expiry': True}, {'linear': 1}, {'inverse': 0}, {'active': 'true'}, {'active': 1},
                   {'linear': False, 'inverse': False}, {'quanto': True}, {'quanto': 0}, {'symbol': 'BTC/USDT:USDC'})
        for change in changes:
            with self.subTest(change=change):
                self.reject([market(**change)])
                if 'active' not in change:
                    self.reject([market(**{**change, 'active': False})])

    def test_contract_multiplier_must_be_positive_finite_bounded_normalized_number(self):
        for value in (None, True, 0, -1, '-0.001', 'NaN', float('nan'), float('inf'), '1e99999999999999999999',
                      '1e-19', '1e36', 'bad', {}, '9' * 1000):
            with self.subTest(value=value):
                self.reject([market(contractSize=value)])
        for value in (1, 1.0, '0.001', 0.001):
            with self.subTest(value=value):
                self.assertEqual(resolve_symbol([market(contractSize=value)], 'BTCUSDT', PREFERENCE)['contractSize'], value)

    def test_unknown_same_base_blocks_selection_even_with_other_valid_candidate(self):
        for unknown in (market(active=None), market(settle=None), market(type=None), market(inverse=True)):
            with self.subTest(unknown=unknown):
                self.reject([market(), unknown])
                self.reject([unknown, market()])
        unrelated = {'base': 'ETH', 'active': None}
        good = market()
        self.assertIs(resolve_symbol([unrelated, good], 'BTCUSDT', PREFERENCE), good)
        self.assertIs(resolve_symbol([{'base': 'xyz-XYZ100'}, {'base': 'USDC.e'}, good], 'BTCUSDT', PREFERENCE), good)
        self.reject([market(), {'symbol': 'UNKNOWN', 'base': None}])

    def test_same_rank_is_ambiguous_even_when_metadata_is_complete(self):
        self.reject([market(id='one'), market(id='two')], 'SYMBOL_AMBIGUOUS')
        self.reject([market(), market()], 'SYMBOL_AMBIGUOUS')

    def test_absence_requires_a_readable_collection_and_valid_scope_policy(self):
        for rows in ({}, []):
            self.reject(rows, 'SYMBOL_UNAVAILABLE')
        for rows in (None, 'wrong collection', [None], [{'base': ''}], [{'base': True}]):
            with self.subTest(rows=rows):
                self.reject(rows)
        for preference in ((), None, ('BTC',), ('USDT', 'USDT'), ('USDT', 'eur')):
            with self.subTest(preference=preference):
                self.reject([market()], preference=preference)

        def interrupted_inventory():
            yield market()
            raise RuntimeError('incomplete fixture iterator')

        self.reject(interrupted_inventory())
        with patch('symbol_resolver._MAX_MARKETS', 2):
            self.reject([market(), {'base': 'ETH'}, {'base': 'SOL'}])

    def test_adapter_metadata_failure_is_not_fallback_capable_symbol_unavailable(self):
        for raw in (market(active=None), market(settle=None), market(inverse=True)):
            clients = SimpleNamespace(account={'id': 'isolated', 'exchange': 'bybit'}, rest=SimpleNamespace(markets={'row': raw}))
            with self.subTest(raw=raw):
                with self.assertRaises(ExchangeContractError) as failure:
                    CcxtAdapter._market(clients, 'BTCUSDT')
                self.assertNotIsInstance(failure.exception, SymbolUnavailableError)
                self.assertIn('SYMBOL_METADATA_UNPROVEN', str(failure.exception))
        clients.rest.markets = {}
        with self.assertRaises(SymbolUnavailableError):
            CcxtAdapter._market(clients, 'BTCUSDT')

    def test_discovery_prefilter_is_not_reclassified_as_execution_scope(self):
        row = {'base': 'BTC', 'contract': True, 'swap': True, 'linear': True, 'active': None}
        self.assertEqual(linear_swap_markets([row]), [row], 'Registry discovery contract is intentionally unchanged.')
        self.reject([row])


class PinnedMarketParserScopeTests(unittest.IsolatedAsyncioTestCase):
    def sdk(self, exchange):
        self.assertEqual(ccxt.__version__, '4.5.75')
        rest = getattr(ccxt_async, exchange)({'enableRateLimit': False})
        rest.fetch = AsyncMock(side_effect=AssertionError('No provider transport allowed.'))
        self.addAsyncCleanup(rest.close)
        return rest

    async def bybit_market(self):
        rest = self.sdk('bybit')
        raw = {'symbol': 'BTCUSDT', 'baseCoin': 'BTC', 'quoteCoin': 'USDT', 'settleCoin': 'USDT',
               'contractType': 'LinearPerpetual', 'status': 'Trading', 'deliveryTime': '0',
               'lotSizeFilter': {'qtyStep': '0.001', 'minOrderQty': '0.001'}, 'priceFilter': {'tickSize': '0.1'},
               'leverageFilter': {'minLeverage': '1', 'maxLeverage': '50'}}
        rest.publicGetV5MarketInstrumentsInfo = AsyncMock(return_value={'retCode': 0,
            'result': {'category': 'linear', 'list': [raw], 'nextPageCursor': ''}})
        rows = await rest.fetch_future_markets({'category': 'linear'})
        rest.fetch.assert_not_called()
        return rows[0]

    async def kraken_market(self, *, include_tradeable=True):
        rest = self.sdk('krakenfutures')
        raw = {'symbol': 'PF_XBTUSD', 'type': 'flexible_futures', 'contractSize': 1,
               'tickSize': 0.1, 'contractValueTradePrecision': 3}
        if include_tradeable:
            raw['tradeable'] = True
        rest.publicGetInstruments = AsyncMock(return_value={'result': 'success', 'instruments': [raw]})
        rows = await rest.fetch_markets()
        rest.fetch.assert_not_called()
        return rows[0]

    async def test_actual_pinned_positive_market_parsers_keep_their_known_scope(self):
        rest = self.sdk('hyperliquid')
        hl = rest.parse_market({'name': 'BTC', 'baseId': '0', 'szDecimals': 5, 'markPx': '100',
                                'maxLeverage': '50', 'isDelisted': False})
        for row, preference in ((hl, ('USDC',)), (await self.bybit_market(), ('USDT',)),
                                (await self.kraken_market(), ('USD',))):
            with self.subTest(symbol=row['symbol']):
                original = copy.deepcopy(row)
                self.assertIs(resolve_symbol([row], 'BTCUSDT', preference), row)
                self.assertEqual(row, original)
        rest.fetch.assert_not_called()

    async def test_actual_kraken_missing_tradeable_is_unknown_not_an_absence(self):
        row = await self.kraken_market(include_tradeable=False)
        self.assertIsNone(row['active'])
        with self.assertRaises(SymbolResolutionError) as failure:
            resolve_symbol([row], 'BTCUSDT', ('USD',))
        self.assertEqual(failure.exception.code, 'SYMBOL_METADATA_UNPROVEN')

    async def test_actual_mixed_hyperliquid_inventory_does_not_quarantine_unrelated_bases(self):
        rest = self.sdk('hyperliquid')
        rows = [rest.parse_market({'name': name, 'baseId': str(index), 'szDecimals': 5, 'markPx': '100',
                                  'maxLeverage': '50', 'isDelisted': False})
                for index, name in enumerate(('BTC', 'xyz:XYZ100', 'USDC.e'))]
        self.assertEqual(rows[1]['baseName'], 'xyz:XYZ100')
        self.assertEqual(rows[1]['base'], 'XYZ-XYZ100')
        self.assertEqual(rows[2]['base'], 'USDC.E')
        originals = copy.deepcopy(rows)
        self.assertIs(resolve_symbol(rows, 'BTCUSDT', ('USDC',)), rows[0])
        self.assertEqual(rows, originals)
        rest.fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
