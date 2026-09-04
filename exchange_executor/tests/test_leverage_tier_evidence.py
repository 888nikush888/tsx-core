from __future__ import annotations

import copy
import sys
import time
import unittest
import ccxt.async_support as ccxt_async
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import RequestDeadline
from leverage_tier_evidence import assert_tier_entry, evidence_hash, read_tier_evidence
from leverage_tiers import TierEvidenceError
from test_contracts import FakeProtectedRest, FakeRegistry, protected_requests
from ccxt_adapter import CcxtAdapter


def deadline():
    return RequestDeadline(int(time.time() * 1000) + 30000)


class TierRest:
    def __init__(self):
        self.markets = {'BTC/USDT:USDT': {'symbol': 'BTC/USDT:USDT', 'id': 'BTCUSDT', 'base': 'BTC',
            'quote': 'USDT', 'settle': 'USDT', 'contractSize': '0.001', 'contract': True, 'linear': True}}
        self.calls, self.mark, self.cursor = [], '100', ''
        self.orders, self.positions = [], []

    async def publicGetV5MarketRiskLimit(self, params):
        self.calls.append(('tiers', dict(params)))
        return {'retCode': 0, 'time': int(time.time() * 1000), 'result': {'category': 'linear',
            'nextPageCursor': self.cursor, 'list': [
                {'id': 1, 'symbol': 'BTCUSDT', 'riskLimitValue': '1000', 'maxLeverage': '50', 'isLowestRisk': 1},
                {'id': 2, 'symbol': 'BTCUSDT', 'riskLimitValue': '5000', 'maxLeverage': '10', 'isLowestRisk': 0}]}}

    async def publicGetV5MarketTickers(self, params):
        self.calls.append(('mark', dict(params)))
        return {'retCode': 0, 'time': int(time.time() * 1000), 'result': {'category': 'linear',
            'list': [{'symbol': 'BTCUSDT', 'markPrice': self.mark}]}}

    async def privateGetV5OrderRealtime(self, params):
        self.calls.append(('orders', dict(params)))
        rows = self.orders if params.get('settleCoin') == 'USDT' else []
        return self.page(params, rows)

    async def privateGetV5PositionList(self, params):
        self.calls.append(('positions', dict(params)))
        rows = self.positions if params.get('settleCoin') == 'USDT' else []
        return self.page(params, rows)

    @staticmethod
    def page(params, rows):
        return {'retCode': 0, 'time': int(time.time() * 1000), 'result': {
            'category': params['category'], 'list': rows, 'nextPageCursor': ''}}

    def safe_market(self, *_args):
        return self.markets['BTC/USDT:USDT']

    @staticmethod
    def parse_order(raw, market):
        return {**raw, 'symbol': market['symbol']}

    parse_position = parse_order


def decision(value, quantity='5', leverage=20):
    return {'version': 1, 'evidenceHash': evidence_hash(value), 'providerSymbol': value['providerSymbol'],
            'contractSize': value['contractSize'], 'tierIndex': 0, 'quantity': quantity, 'leverage': leverage, 'maximumNotional': '600'}


class TierEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_complete_scope_precedes_setter_and_final_dispatch(self):
        for blocked_read in (1, 2):
            rest = FakeProtectedRest([[]])
            rest.configured_leverage = 5
            original_read = rest.privateGetV5OrderRealtime
            reads = 0
            async def order_read(params):
                nonlocal reads
                result = await original_read(params)
                if params.get('settleCoin') == 'USDT':
                    reads += 1
                    if reads == blocked_read:
                        result['result']['list'] = [{'id': 'other-entry', 'symbol': 'BTCUSDT', 'status': 'open',
                            'side': 'buy', 'amount': '1', 'filled': '0', 'reduceOnly': False}]
                return result
            rest.privateGetV5OrderRealtime = order_read
            registry = FakeRegistry(rest)
            with self.subTest(blocked_read=blocked_read), self.assertRaisesRegex(TierEvidenceError, 'scale-in'):
                await CcxtAdapter(registry).submit_protected_entry(registry.clients.account, *protected_requests(), deadline())
            self.assertEqual(len(rest.leverage), blocked_read - 1)
            self.assertEqual(rest.created_batches, [])

    async def test_bybit_tier_cursor_is_fully_consumed_not_first_page_only(self):
        rest = TierRest()
        original = rest.publicGetV5MarketRiskLimit
        async def page(params):
            result = await original(params)
            rows = result['result']['list']
            result['result']['list'] = rows[1:] if params.get('cursor') == 'next' else rows[:1]
            result['result']['nextPageCursor'] = '' if params.get('cursor') == 'next' else 'next'
            return result
        rest.publicGetV5MarketRiskLimit = page
        clients = FakeRegistry(rest).clients
        value = await read_tier_evidence(clients, rest.markets['BTC/USDT:USDT'], deadline())
        self.assertEqual([row['maxLeverage'] for row in value['tiers']], [50, 10])
        self.assertEqual([call[1].get('cursor') for call in rest.calls if call[0] == 'tiers'], [None, 'next'])

    async def test_hyperliquid_actual_public_scope_is_bound_not_an_address_option(self):
        rest = FakeProtectedRest([[]])
        clients = FakeRegistry(rest, 'hyperliquid').clients
        market = next(iter(rest.markets.values()))
        evidence = await read_tier_evidence(clients, market, deadline())
        self.assertEqual(evidence['currency'], 'USDC')
        self.assertEqual(evidence['tiers'][0]['maxLeverage'], 50)
        rest.handle_public_address = lambda *_args: ('0x' + '3' * 40, {})
        with self.assertRaisesRegex(TierEvidenceError, 'address'):
            await read_tier_evidence(clients, market, deadline())

    async def test_kraken_real_sdk_signs_only_reviewed_read_route(self):
        rest = ccxt_async.krakenfutures({'apiKey': 'public-fixture-key', 'secret': 'cHVibGljLWZpeHR1cmUtc2VjcmV0'})  # gitleaks:allow
        rest.fetch = AsyncMock(return_value={'result': 'success', 'instruments': []})
        try:
            await rest.request('trading/instruments', 'private', 'GET', {'contractType': 'flexible_futures'})
            url, method, headers = rest.fetch.await_args.args[:3]
            self.assertEqual(method, 'GET')
            self.assertEqual(url, 'https://futures.kraken.com/derivatives/api/v3/trading/instruments?contractType=flexible_futures')
            self.assertEqual(headers['APIKey'], 'public-fixture-key')
            self.assertTrue(headers['Authent'])
            self.assertEqual(rest.fetch.await_count, 1)
        finally:
            await rest.close()

    async def test_same_tier_mark_increase_cannot_increase_original_margin(self):
        rest = TierRest()
        clients = FakeRegistry(rest).clients
        market = rest.markets['BTC/USDT:USDT']
        evidence = await read_tier_evidence(clients, market, deadline())
        request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': decision(evidence)}
        with self.assertRaisesRegex(TierEvidenceError, 'budget'):
            assert_tier_entry(clients, market, request, {'amount': '5000', 'price': '100'}, {**evidence, 'markPrice': '121'})

    async def test_legacy_entry_without_tier_decision_never_changes_leverage(self):
        rest = FakeProtectedRest([[]])
        registry = FakeRegistry(rest)
        entry, _stop = protected_requests()
        entry.pop('leverageTierDecision')
        with self.assertRaises(TierEvidenceError):
            await CcxtAdapter(registry)._order_spec(registry.clients, entry, deadline())
        self.assertEqual(rest.leverage, [])

    async def test_bound_actual_complete_scope_and_contract_conversion(self):
        rest = TierRest()
        clients = FakeRegistry(rest).clients
        market = rest.markets['BTC/USDT:USDT']
        value = await read_tier_evidence(clients, market, deadline())
        request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': decision(value)}
        assert_tier_entry(clients, market, request, {'amount': '5000', 'price': '100'}, value)
        self.assertEqual(value['scope'], {'complete': True, 'positionQuantity': '0', 'openOrderCount': 0})
        self.assertEqual(len([call for call in rest.calls if call[0] == 'orders']), 5)
        with self.assertRaisesRegex(TierEvidenceError, 'rounding'):
            assert_tier_entry(clients, market, request, {'amount': '4999'}, value)

    async def test_changed_mark_tier_table_binding_and_age_block(self):
        rest = TierRest()
        clients = FakeRegistry(rest).clients
        market = rest.markets['BTC/USDT:USDT']
        value = await read_tier_evidence(clients, market, deadline())
        request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': decision(value)}
        for field, changed in [('markPrice', '200'), ('credentialGeneration', 'f' * 64), ('contractSize', '1'),
                               ('observedAt', value['observedAt'] - 10000)]:
            with self.subTest(field=field), self.assertRaises(TierEvidenceError):
                assert_tier_entry(clients, market, request, {'amount': '5000'}, {**value, field: changed})

    async def test_unknown_wrapper_scope_never_becomes_zero(self):
        rest = TierRest()
        clients = FakeRegistry(rest).clients
        async def incomplete(*_args):
            return [], [], [{'source': key, 'completeness': 'unknown'} for key in ('orders', 'positions')]
        with patch('leverage_tier_evidence.read_current_state', incomplete), self.assertRaisesRegex(TierEvidenceError, 'scope'):
            await read_tier_evidence(clients, rest.markets['BTC/USDT:USDT'], deadline())

    async def test_repeated_cursor_and_existing_position_block(self):
        rest = TierRest()
        clients = FakeRegistry(rest).clients
        market = rest.markets['BTC/USDT:USDT']
        rest.cursor = 'again'
        with self.assertRaisesRegex(TierEvidenceError, 'repeated'):
            await read_tier_evidence(clients, market, deadline())
        rest.cursor = ''
        rest.positions = [{'symbol': 'BTCUSDT', 'positionIdx': 0, 'contracts': '2', 'side': 'long', 'size': '2'}]
        value = await read_tier_evidence(clients, market, deadline())
        self.assertEqual(value['scope']['positionQuantity'], '0.002')
        request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': decision(value)}
        with self.assertRaisesRegex(TierEvidenceError, 'scale-in'):
            assert_tier_entry(clients, market, request, {'amount': '5000'}, value)
        changed = copy.deepcopy(value)
        changed['scope']['positionQuantity'] = '0'
        changed['scope']['openOrderCount'] = 1
        with self.assertRaisesRegex(TierEvidenceError, 'scale-in'):
            assert_tier_entry(clients, market, request, {'amount': '5000'}, changed)
