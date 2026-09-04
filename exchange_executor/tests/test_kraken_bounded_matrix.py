"""Kraken wire/parser matrix, not a grant of its unproved protected-IOC capability.

The full adapter must reject that capability. Separately, diagnostic specimens
exercise the existing base-spec, boundary, native tag, signer and result consumers.
No profile flag is replaced and every SDK transport is intercepted locally.
"""
from __future__ import annotations

import copy
import json
import sys
import time
import unittest
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import CcxtAdapter, _base_order_spec, _normalized_open_order, _normalized_position, _protected_order_results
from ccxt_profiles import profile_for
from ccxt_sdk_policy import client_class
from common import UnresolvedOrderOutcome
from entry_deadline import EntryDeadline, entry_deadline_scope
from entry_price_constraints import IOC, EntryPriceConstraintError, assert_boundary, assert_final_entry_spec
from test_contracts import FakeRegistry, bound_test_account
from test_entry_price_constraints import bounded_orders, deadline, rest_fixture


EXCHANGE = 'krakenfutures'
SYMBOL = 'BTC/USD:USD'
MARKET_ID = 'PF_XBTUSD'
ENTRY = '0x' + '1' * 32
STOP = '0x' + '2' * 32
STAMP = '2026-09-02T12:00:00.000Z'


def original_requests(side='buy'):
    entry, stop = bounded_orders(side, EXCHANGE)
    entry.update({'clientOrderId': ENTRY, 'entryExpiresAt': int(time.time() * 1000) + 30_000})
    stop.update({'clientOrderId': STOP, 'triggerPrice': '90' if side == 'buy' else '110'})
    for request in (entry, stop):
        request['providerBatchTag'] = {'version': 1, 'tag': request['clientOrderId']}
    return entry, stop


def native_order(client, side='buy', *, filled='0', quantity='2'):
    stop = client == STOP
    return {'orderId': f'remote-{client}', 'cliOrdId': None, 'type': 'stp' if stop else 'ioc',
            'symbol': MARKET_ID, 'side': ('sell' if side == 'buy' else 'buy') if stop else side,
            'quantity': quantity, 'filled': filled, 'reduceOnly': stop,
            'stopPrice': ('90' if side == 'buy' else '110') if stop else None,
            'timestamp': STAMP, 'lastUpdateTimestamp': STAMP}


def native_ack(client, side='buy', *, status='placed', filled='0'):
    details = native_order(client, side, filled=filled)
    return {'order_id': details['orderId'], 'order_tag': client, 'status': status, 'receivedTime': STAMP,
            'orderEvents': [{'type': 'CANCEL' if status == 'cancelled' else 'PLACE', 'order': details}]}


def executed_entry(side='buy'):
    details = native_order(ENTRY, side)
    return {'order_id': details['orderId'], 'order_tag': ENTRY, 'status': 'placed', 'receivedTime': STAMP,
            'orderEvents': [{'type': 'EXECUTION', 'executionId': 'actual-execution-fixture', 'price': '100', 'amount': '2',
                             'orderPriorEdit': None, 'orderPriorExecution': details}]}


def diagnostic_specs(rest, requests):
    """Known syntax below the still-closed admission gate; never replace a profile capability."""
    entry, stop = requests
    assert_boundary(entry, '0.1')
    specs = tuple(_base_order_spec(rest, request, SYMBOL, request['quantity'], EXCHANGE) for request in (entry, stop))
    specs[0]['params']['timeInForce'] = IOC[EXCHANGE]
    assert_final_entry_spec(profile_for(EXCHANGE), entry, specs[0], '0.1')
    return specs


class KrakenBoundedMatrix(unittest.IsolatedAsyncioTestCase):
    def sdk(self, responses):
        rest = client_class(EXCHANGE, ccxt_async.krakenfutures)({
            'enableRateLimit': False, 'apiKey': 'isolated-api-key', 'secret': 'aXNvbGF0ZWQtc2VjcmV0',  # gitleaks:allow
            'options': profile_for(EXCHANGE).client_options()})
        rest.set_markets([{'id': MARKET_ID, 'symbol': SYMBOL, 'base': 'BTC', 'quote': 'USD', 'settle': 'USD',
            'baseId': 'BTC', 'quoteId': 'USD', 'settleId': 'USD', 'type': 'swap', 'spot': False, 'swap': True,
            'contract': True, 'linear': True, 'inverse': False, 'active': True, 'contractSize': 1,
            'future': False, 'option': False, 'expiry': None,
            'precision': {'amount': .001, 'price': .1}, 'limits': {}, 'info': {}}])
        calls = []

        async def intercepted(url, method='GET', headers=None, body=None):
            self.assertIn('Authent', headers)
            path = urlsplit(url).path
            calls.append({'path': path, 'method': method, 'query': parse_qs(urlsplit(url).query), 'body': body})
            self.assertTrue(responses, 'Every transport must have an explicit isolated fixture response.')
            expected_suffix, response = responses.pop(0)
            self.assertTrue(path.endswith(expected_suffix), (path, expected_suffix))
            return copy.deepcopy(response)

        rest.fetch = intercepted
        self.addAsyncCleanup(rest.close)
        return rest, calls

    async def submit_specimen(self, response, side='buy'):
        rest, calls = self.sdk([('/batchorder', {'result': 'success', 'serverTime': STAMP, 'batchStatus': response})])
        requests = original_requests(side)
        original = copy.deepcopy(requests)
        specs = diagnostic_specs(rest, requests)
        with entry_deadline_scope(EntryDeadline(requests[0])):
            parsed = await rest.create_orders(copy.deepcopy(specs))
        self.assertEqual(requests, original, 'Original deadlines, caps, tags and leg requests must not change.')
        self.assertEqual(len(calls), 1)
        return rest, specs, parsed, calls[0]

    async def test_long_short_original_tags_base_spec_to_signed_wire_and_reordered_ack(self):
        for side, cap, trigger in (('buy', '100.5', '90'), ('sell', '99.6', '110')):
            with self.subTest(side=side):
                response = [native_ack(STOP, side), native_ack(ENTRY, side)]
                rest, specs, parsed, call = await self.submit_specimen(response, side)
                self.assertEqual(call['method'], 'POST')
                wire = json.loads(parse_qs(call['body'])['json'][0])['batchOrder']
                entry, stop = wire
                self.assertEqual((entry['order'], entry['orderType'], entry['side'], entry['limitPrice']), ('send', 'ioc', side, cap))
                self.assertEqual((stop['order'], stop['orderType'], stop['stopPrice']), ('send', 'stp', trigger))
                self.assertEqual(stop['side'], 'sell' if side == 'buy' else 'buy')
                self.assertTrue(stop['reduceOnly'])
                self.assertNotIn('limitPrice', stop)
                self.assertEqual([item['symbol'] for item in wire], [MARKET_ID, MARKET_ID])
                self.assertEqual([item['order_tag'] for item in wire], [ENTRY, STOP])
                self.assertEqual([item['cliOrdId'] for item in wire], [ENTRY, STOP])
                self.assertTrue(all(isinstance(item['order_tag'], str) for item in wire))
                result = _protected_order_results(parsed, rest.market(SYMBOL), specs, EXCHANGE)
                self.assertEqual([row['clientOrderId'] for row in result], [ENTRY, STOP])
                for row, raw in zip(result, reversed(response)):
                    self.assertEqual(row['raw']['info'], raw)
                    self.assertIsNone(row['raw']['clientOrderId'])
                    self.assertEqual(row['identityEvidence']['tag'], row['clientOrderId'])

    async def test_real_adapter_still_refuses_both_directions_before_any_mutation(self):
        self.assertEqual(profile_for(EXCHANGE).execution_capabilities.protected_bounded_entry, 'not_proven')
        for side in ('buy', 'sell'):
            rest = rest_fixture()
            registry = FakeRegistry(rest, EXCHANGE)
            with self.subTest(side=side), self.assertRaisesRegex(EntryPriceConstraintError, 'not proven'):
                await CcxtAdapter(registry).submit_protected_entry(bound_test_account(EXCHANGE), *original_requests(side), deadline())
            self.assertEqual((rest.created_batches, rest.cleanup_orders, rest.leverage), ([], [], []))

    async def test_mixed_missing_or_foreign_stop_ack_keeps_only_actual_executed_entry(self):
        failures = [
            [{'status': 'requiredArgumentMissing', 'orderEvents': []}],
            [],
            [{**native_ack(STOP), 'order_tag': 'foreign-client'}],
            [native_ack(STOP), native_ack(STOP)],
        ]
        for stop_rows in failures:
            with self.subTest(stop_rows=stop_rows):
                rest, specs, parsed, _ = await self.submit_specimen([executed_entry(), *stop_rows])
                with self.assertRaises(UnresolvedOrderOutcome) as failure:
                    _protected_order_results(parsed, rest.market(SYMBOL), specs, EXCHANGE)
                self.assertTrue(failure.exception.side_effects)
                confirmed = failure.exception.details['confirmedOrders']
                self.assertEqual([(row['clientOrderId'], row['status'], row['filledQuantity']) for row in confirmed], [(ENTRY, 'filled', '2')])
                self.assertIn(STOP, failure.exception.details['unresolvedClientOrderIds'])

    async def test_bound_mixed_status_still_requires_recovery_without_another_write(self):
        response = [executed_entry(), native_ack(STOP, status='wouldNotReducePosition')]
        rest, specs, parsed, _ = await self.submit_specimen(response)
        entry, stop = _protected_order_results(parsed, rest.market(SYMBOL), specs, EXCHANGE)
        self.assertEqual(stop['status'], 'rejected')
        adapter = CcxtAdapter(FakeRegistry(rest, EXCHANGE))
        with self.assertRaises(UnresolvedOrderOutcome) as failure:
            await adapter._resolve_protected_results(adapter.registry.clients, rest.market(SYMBOL), entry, stop, True)
        self.assertEqual(failure.exception.details['confirmedOrders'], [entry, stop])

    async def test_empty_ioc_rejection_without_real_identity_is_not_absence(self):
        response = [{'status': 'iocWouldNotExecute', 'orderEvents': []}, native_ack(STOP)]
        rest, specs, parsed, _ = await self.submit_specimen(response)
        with self.assertRaises(UnresolvedOrderOutcome) as failure:
            _protected_order_results(parsed, rest.market(SYMBOL), specs, EXCHANGE)
        self.assertEqual([row['clientOrderId'] for row in failure.exception.details['confirmedOrders']], [STOP])
        self.assertEqual(failure.exception.details['unresolvedClientOrderIds'], [ENTRY])

    async def test_bound_empty_ioc_returns_terminal_entry_and_original_live_stop_not_closure(self):
        for side in ('buy', 'sell'):
            response = [native_ack(ENTRY, side, status='cancelled'), native_ack(STOP, side)]
            rest, specs, parsed, _ = await self.submit_specimen(response, side)
            entry, stop = _protected_order_results(parsed, rest.market(SYMBOL), specs, EXCHANGE)
            adapter = CcxtAdapter(FakeRegistry(rest, EXCHANGE))
            result = await adapter._resolve_protected_results(adapter.registry.clients, rest.market(SYMBOL), entry, stop, True)
            self.assertEqual((result['entry']['status'], result['entry']['filledQuantity']), ('cancelled', '0'))
            self.assertEqual(result['protectiveStop']['status'], 'open')
            self.assertEqual(set(result), {'entry', 'protectiveStop'}, 'Adapter result is not account cleanup/closure evidence.')

    async def test_native_partial_stop_then_exact_cancel_preserves_remaining_position(self):
        partial = {'order': {**native_order(STOP, filled='0.4'), 'priceTriggerOptions': {'triggerPrice': '90'}},
                   'status': 'PARTIALLY_FILLED', 'updateReason': None, 'error': None}
        cancelled = native_ack(STOP, status='cancelled', filled='0.4')
        position = {'symbol': MARKET_ID, 'side': 'long', 'size': '1.6', 'price': '100', 'unrealizedPnl': '-16', 'fillTime': STAMP}
        rest, calls = self.sdk([
            ('/orders/status', {'result': 'success', 'orders': [partial]}),
            ('/cancelorder', {'result': 'success', 'cancelStatus': cancelled}),
            ('/openpositions', {'result': 'success', 'serverTime': STAMP, 'openPositions': [position]}),
        ])
        parsed = rest.parse_order(copy.deepcopy(partial), rest.market(SYMBOL))
        observed = _normalized_open_order(rest, parsed, EXCHANGE)
        self.assertEqual((observed['status'], observed['quantity'], observed['filledQuantity']), ('partially_filled', '2', '0.4'))
        self.assertEqual(observed['triggerPrice'], '90')
        adapter = CcxtAdapter(FakeRegistry(rest, EXCHANGE))
        result = await adapter.cancel_order(bound_test_account(EXCHANGE), STOP, 'BTCUSDT', deadline(), f'remote-{STOP}', SYMBOL)
        self.assertEqual((result['status'], result['filledQuantity']), ('cancelled', '0.4'))
        self.assertEqual(result['exchangeOrderId'], f'remote-{STOP}')
        remaining = [_normalized_position(rest, row) for row in await rest.fetch_positions([SYMBOL])]
        self.assertEqual(remaining[0]['quantity'], '1.6', 'Terminal stop cancellation is not a flat account.')
        self.assertEqual(Decimal(observed['quantity']) - Decimal(result['filledQuantity']), Decimal(remaining[0]['quantity']))
        writes = [call for call in calls if call['method'] == 'POST']
        self.assertEqual(len(writes), 1, 'No repeated entry, fallback, replacement or symbol-wide flatten.')
        self.assertEqual(writes[0]['query']['order_id'], [f'remote-{STOP}'])
        self.assertIsNone(writes[0]['body'], 'Pinned Kraken signs non-batch parameters in the query, including POST cancel.')
        self.assertEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
