from __future__ import annotations

import copy
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_profiles import profile_for
from common import RequestDeadline
from execution_constraints import read_entry_constraints, assert_entry_constraints, read_account_mode_observation
from ccxt_adapter import CcxtAdapter
from test_contracts import FakeProtectedRest, FakeRegistry, bound_test_account, protected_requests


def deadline():
    return RequestDeadline(int(time.time() * 1000) + 30_000)


def clients(exchange='bybit'):
    market = {'symbol': 'BTC/USDT:USDT', 'id': 'BTCUSDT', 'base': 'BTC', 'swap': True, 'linear': True}
    rest = SimpleNamespace(
        privateGetV5AccountInfo=AsyncMock(return_value={'retCode': 0, 'result': {
            'unifiedMarginStatus': 5, 'marginMode': 'REGULAR_MARGIN'}}),
        privateGetV5PositionList=AsyncMock(return_value={'retCode': 0, 'result': {
            'category': 'linear', 'nextPageCursor': '', 'list': [
                {'symbol': 'BTCUSDT', 'positionIdx': 0, 'leverage': '20', 'size': '0'}]}}),
        privateGetLeveragepreferences=AsyncMock(return_value={'result': 'success', 'leveragePreferences': []}),
        privateGetOpenpositions=AsyncMock(return_value={'result': 'success', 'openPositions': []}),
        publicPostInfo=AsyncMock(return_value={'user': '0x' + '2' * 40, 'coin': 'BTC',
                                              'leverage': {'type': 'cross', 'value': 20}}),
        walletAddress='0x' + '2' * 40,
        set_leverage=AsyncMock(), set_margin_mode=AsyncMock(), set_position_mode=AsyncMock(),
    )
    if exchange == 'krakenfutures':
        market.update({'symbol': 'BTC/USD:USD', 'id': 'pf_xbtusd'})
    if exchange == 'hyperliquid':
        market.update({'symbol': 'BTC/USDC:USDC', 'id': 'BTC', 'info': {'name': 'BTC'}})
        rest.clearinghouse_state = {'assetPositions': []}
        rest.abstraction = 'disabled'
        rest.publicPostInfo.side_effect = lambda params: (
            rest.abstraction if params['type'] == 'userAbstraction' else
            rest.clearinghouse_state if params['type'] == 'clearinghouseState' else rest.publicPostInfo.return_value)
    return SimpleNamespace(account={'id': 'account-1', 'exchange': exchange, 'mode': 'testnet'},
                           profile=profile_for(exchange), rest=rest, account_identity=rest.walletAddress if exchange == 'hyperliquid' else 'fixture-key',
                           credential_fingerprint='fixture-generation'), market


class ExecutionConstraintTests(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_sdk_routes_real_method_names_to_correct_transport_scope(self):
        expected = {
            'bybit': [('v5/account/info', 'private', 'GET'), ('v5/position/list', 'private', 'GET')],
            'krakenfutures': [('leveragepreferences', 'private', 'GET'), ('openpositions', 'private', 'GET')],
            'hyperliquid': [('info', 'public', 'POST'), ('info', 'public', 'POST'), ('info', 'public', 'POST')],
        }
        for exchange, routes in expected.items():
            client, market = clients(exchange)
            fixture = client.rest
            rest = getattr(ccxt_async, exchange)()
            rest.walletAddress = fixture.walletAddress
            async def response(path, _scope, _method, params, **_kwargs):
                if path == 'info':
                    if params['type'] == 'userAbstraction':
                        return fixture.abstraction
                    return fixture.clearinghouse_state if params['type'] == 'clearinghouseState' else fixture.publicPostInfo.return_value
                method = {'v5/account/info': fixture.privateGetV5AccountInfo, 'v5/position/list': fixture.privateGetV5PositionList,
                          'leveragepreferences': fixture.privateGetLeveragepreferences, 'openpositions': fixture.privateGetOpenpositions}[path]
                return method.return_value
            rest.request = AsyncMock(side_effect=response)
            rest.fetch = AsyncMock(side_effect=AssertionError('Provider transport must never run in this fixture.'))
            client.rest = rest
            try:
                result = await read_entry_constraints(client, market, deadline())
                self.assertTrue(result['entryAllowed'], result)
                self.assertEqual([call.args[:3] for call in rest.request.await_args_list], routes)
                rest.fetch.assert_not_called()
            finally:
                await rest.close()

    async def test_all_profiles_read_real_mode_fields_without_writes(self):
        for exchange in ('bybit', 'krakenfutures', 'hyperliquid'):
            with self.subTest(exchange=exchange):
                client, market = clients(exchange)
                result = await read_entry_constraints(client, market, deadline())
                self.assertTrue(result['entryAllowed'], result)
                self.assertEqual(result['positionMode'], 'oneway')
                self.assertEqual(result['marginMode'], 'cross')
                self.assertEqual(result['origin'], 'public_bound_account' if exchange == 'hyperliquid' else 'authenticated')
                assert_entry_constraints(client, market, result)
                for method in ('set_leverage', 'set_margin_mode', 'set_position_mode'):
                    getattr(client.rest, method).assert_not_called()

    async def test_bybit_hedge_isolated_portfolio_and_incomplete_fail_closed(self):
        cases = [
            ('hedge', {'positionIdx': 1}, 'REGULAR_MARGIN'),
            ('isolated', {}, 'ISOLATED_MARGIN'),
            ('portfolio', {}, 'PORTFOLIO_MARGIN'),
            ('missing-mode', {'positionIdx': None}, 'REGULAR_MARGIN'),
            ('missing-leverage', {'leverage': ''}, 'REGULAR_MARGIN'),
        ]
        for label, fields, margin in cases:
            with self.subTest(label=label):
                client, market = clients()
                client.rest.privateGetV5AccountInfo.return_value['result']['marginMode'] = margin
                client.rest.privateGetV5PositionList.return_value['result']['list'][0].update(fields)
                self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])

    async def test_bybit_empty_or_wrong_symbol_is_not_oneway(self):
        for rows in ([], [{'symbol': 'ETHUSDT', 'positionIdx': 0, 'leverage': '20', 'size': '0'}]):
            client, market = clients()
            client.rest.privateGetV5PositionList.return_value['result']['list'] = rows
            self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])
        client, market = clients()
        client.rest.privateGetV5PositionList.return_value['result']['nextPageCursor'] = 'unread'
        self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])

    async def test_kraken_isolated_preference_or_position_blocks_cross(self):
        client, market = clients('krakenfutures')
        client.rest.privateGetLeveragepreferences.return_value['leveragePreferences'] = [{'symbol': 'PF_XBTUSD', 'maxLeverage': 20}]
        self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])
        client, market = clients('krakenfutures')
        client.rest.privateGetOpenpositions.return_value['openPositions'] = [
            {'symbol': 'pf_xbtusd', 'side': 'long', 'size': '1', 'maxFixedLeverage': '20'}]
        self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])

    async def test_kraken_missing_response_never_means_cross(self):
        client, market = clients('krakenfutures')
        client.rest.privateGetLeveragepreferences.return_value = {'result': 'success'}
        self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])

    async def test_hyperliquid_exact_bound_wallet_coin_and_margin(self):
        for field, value in [('user', '0x' + '3' * 40), ('coin', 'ETH'), ('leverage', {'type': 'isolated', 'value': 20})]:
            client, market = clients('hyperliquid')
            client.rest.publicPostInfo.return_value[field] = value
            self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])
        client, market = clients('hyperliquid')
        client.rest.walletAddress = '0x' + '3' * 40
        self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])

    async def test_hyperliquid_contradictory_position_or_leverage_blocks(self):
        for position in [
            {'type': 'twoWay', 'position': {'coin': 'BTC', 'leverage': {'type': 'cross', 'value': 20}}},
            {'type': 'oneWay', 'position': {'coin': 'BTC', 'leverage': {'type': 'isolated', 'value': 20}}},
            {'type': 'oneWay', 'position': {'coin': 'BTC', 'leverage': {'type': 'cross', 'value': 10}}},
        ]:
            client, market = clients('hyperliquid')
            client.rest.clearinghouse_state['assetPositions'] = [position]
            self.assertFalse((await read_entry_constraints(client, market, deadline()))['entryAllowed'])

    async def test_hyperliquid_abstraction_is_observed_not_assumed_disabled(self):
        for value in ('portfolioMargin', 'unifiedAccount', 'dexAbstraction', 'default', None, {}):
            client, market = clients('hyperliquid')
            client.rest.abstraction = value
            result = await read_entry_constraints(client, market, deadline())
            self.assertFalse(result['entryAllowed'], value)

    async def test_fence_rejects_stale_changed_binding_and_profile(self):
        client, market = clients()
        result = await read_entry_constraints(client, market, deadline())
        for field, value in [('expiresAt', 1), ('accountFingerprint', 'a' * 64), ('credentialGeneration', 'b' * 64),
                             ('profileHash', 'c' * 64), ('ccxtVersion', '0.0.0'), ('providerSymbol', 'ETH/USDT:USDT')]:
            invalid = {**result, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                assert_entry_constraints(client, market, invalid)

    async def test_read_failure_does_not_leak_provider_error(self):
        client, market = clients()
        client.rest.privateGetV5PositionList.side_effect = RuntimeError('secret-token https://private.invalid/')
        result = await read_entry_constraints(client, market, deadline())
        self.assertFalse(result['entryAllowed'])
        self.assertNotIn('secret-token', str(result))
        self.assertNotIn('private.invalid', str(result))

    async def test_changed_mode_is_observed_by_second_read(self):
        client, market = clients()
        first = await read_entry_constraints(client, market, deadline())
        self.assertTrue(first['entryAllowed'])
        changed = copy.deepcopy(client.rest.privateGetV5PositionList.return_value)
        changed['result']['list'][0]['positionIdx'] = 2
        client.rest.privateGetV5PositionList.return_value = changed
        second = await read_entry_constraints(client, market, deadline())
        self.assertFalse(second['entryAllowed'])

    async def test_dispatch_mode_change_blocks_before_order_and_exits_remain_available(self):
        entry, stop = protected_requests()
        rest = FakeProtectedRest([[]])
        fixture, market = clients()
        rest.markets[market['symbol']].update({'id': market['id']})
        rest.privateGetV5AccountInfo = fixture.rest.privateGetV5AccountInfo
        initial = fixture.rest.privateGetV5PositionList.return_value
        changed = copy.deepcopy(initial)
        changed['result']['list'][0]['positionIdx'] = 1
        original_read = rest.privateGetV5PositionList
        symbol_reads = iter([initial, changed])
        async def position_read(params):
            return next(symbol_reads) if 'symbol' in params else await original_read(params)
        rest.privateGetV5PositionList = position_read
        adapter = CcxtAdapter(FakeRegistry(rest))
        with self.assertRaisesRegex(ValueError, 'MODE_NOT_PROVEN'):
            await adapter.submit_protected_entry(bound_test_account(), entry, stop, deadline())
        self.assertEqual(rest.created_batches, [])
        self.assertEqual(rest.leverage, [])
        # A reduce-only spec must not depend on the now unavailable entry-mode readback.
        rest.privateGetV5AccountInfo.side_effect = RuntimeError('mode endpoint unavailable')
        _, _ = await adapter._order_spec(adapter.registry.clients, stop, deadline())

    async def test_kraken_cross_never_invokes_isolated_leverage_setter(self):
        entry, _ = protected_requests('krakenfutures')
        rest = FakeProtectedRest([[]])
        fixture, market = clients('krakenfutures')
        rest.markets['BTC/USDT:USDT']['id'] = market['id']
        rest.privateGetLeveragepreferences = fixture.rest.privateGetLeveragepreferences
        rest.privateGetOpenpositions = fixture.rest.privateGetOpenpositions
        rest.privateGetOpenpositions.return_value['serverTime'] = str(int(time.time() * 1000))
        adapter = CcxtAdapter(FakeRegistry(rest, 'krakenfutures'))
        await adapter._order_spec(adapter.registry.clients, entry, deadline())
        self.assertEqual(rest.leverage, [], 'CCXT Kraken set_leverage means isolated, not cross leverage.')

    async def test_verify_is_readonly_account_observation_not_entry_permission(self):
        rest = FakeProtectedRest([[]])
        rest.fetch_balance = AsyncMock(return_value={'info': {'result': {'list': [{
            'accountType': 'UNIFIED', 'totalEquity': '1000', 'totalAvailableBalance': '900',
            'totalPerpUPL': '0', 'totalInitialMargin': '100', 'coin': [{'coin': 'USDT'}]}]}}})
        adapter = CcxtAdapter(FakeRegistry(rest))
        result = await adapter.verify(bound_test_account(), deadline())
        self.assertTrue(result['verified'])
        self.assertFalse(result['entryAllowed'])
        self.assertTrue(result['capabilities']['executionModeObservation']['requiresSymbolRead'])
        self.assertEqual(rest.leverage, [])
        self.assertEqual(rest.created_batches, [])
        rest.privateGetV5AccountInfo = AsyncMock(return_value={'retCode': 0, 'result': {'unifiedMarginStatus': 5}})
        failed = await adapter.verify(bound_test_account(), deadline())
        self.assertFalse(failed['verified'])
        self.assertEqual(failed['reason'], 'MARGIN_MODE_READBACK_MISSING')

    async def test_all_account_observations_are_readonly_and_symbol_scoped(self):
        for exchange in ('bybit', 'krakenfutures', 'hyperliquid'):
            client, _ = clients(exchange)
            result = await read_account_mode_observation(client, deadline())
            self.assertTrue(result['verified'], result)
            self.assertFalse(result['entryAllowed'])
            self.assertTrue(result['requiresSymbolRead'])
            client.rest.set_leverage.assert_not_called()
            client.rest.set_position_mode.assert_not_called()
            client.rest.set_margin_mode.assert_not_called()

    async def test_slow_account_observation_is_not_verified(self):
        client, _ = clients()
        with patch('execution_constraints._now', side_effect=[1000, 11_000]):
            result = await read_account_mode_observation(client, deadline())
        self.assertFalse(result['verified'])
        self.assertEqual(result['reason'], 'MODE_READBACK_EXPIRED')

    async def test_ignored_leverage_setter_cannot_submit(self):
        entry, stop = protected_requests()
        rest = FakeProtectedRest([[]])
        rest.configured_leverage = 5
        rest.set_leverage = AsyncMock()  # Acknowledgement alone is not actual state.
        adapter = CcxtAdapter(FakeRegistry(rest))
        with self.assertRaisesRegex(ValueError, 'leverage readback'):
            await adapter.submit_protected_entry(bound_test_account(), entry, stop, deadline())
        rest.set_leverage.assert_awaited_once()
        self.assertEqual(rest.created_batches, [])


if __name__ == '__main__':
    unittest.main()
