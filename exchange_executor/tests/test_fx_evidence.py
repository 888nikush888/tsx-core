"""Fixed Bybit FX routes through the real pinned SDK; every HTTP call is fake."""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import ccxt
from ccxt.async_support import bybit
from ccxt.base.errors import RateLimitExceeded, RequestTimeout

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ExchangeContractError, RequestDeadline
from fx_evidence import read_fx_evidence, fx_hash
from history_reader import RecoveryReadBudget

BTC_USD = 'bybit:btc-usd-index:v1'
BTC_USDT = 'bybit:btc-usdt-index:v1'
USDC_USD = 'bybit:usdc-usd-index:v1'
REQUESTS = {BTC_USD: ('inverse', 'BTCUSD', 'indexPrice', '60000.000'),
            BTC_USDT: ('linear', 'BTCUSDT', 'indexPrice', '60150.000'),
            USDC_USD: ('spot', 'USDCUSDT', 'usdIndexPrice', '1.000300')}


def response(leg, stamp):
    category, symbol, field, value = REQUESTS[leg]
    return {'retCode': 0, 'retMsg': 'OK', 'result': {'category': category,
            'list': [{'symbol': symbol, field: value, 'lastPrice': '999', 'markPrice': '998'}]},
            'retExtInfo': {}, 'time': stamp}


class FxEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(ccxt.__version__, '4.5.75')
        self.rest = bybit({'enableRateLimit': False})
        self.clock = int(time.time() * 1000)
        self.calls = []
        self.envelopes = []
        self.transform = lambda leg, raw: raw
        self.clock_patch = patch('fx_evidence.now_ms', side_effect=lambda: self.clock)
        self.clock_patch.start()

        async def fetch(url, method='GET', headers=None, body=None):
            parsed = urlsplit(url)
            query = parse_qs(parsed.query)
            self.assertEqual((method, parsed.path, body), ('GET', '/v5/market/tickers', None))
            self.assertEqual(set(query), {'category', 'symbol'})
            self.assertFalse(any(str(key).lower().startswith('x-bapi') for key in (headers or {})),
                             'Public FX reads do not acquire or send account credentials.')
            leg = next(key for key, row in REQUESTS.items() if query == {'category': [row[0]], 'symbol': [row[1]]})
            self.calls.append((parsed.netloc, leg))
            raw = self.transform(leg, response(leg, self.clock))
            self.envelopes.append(copy.deepcopy(raw))
            self.clock += 10
            return self.rest.parse_json(json.dumps(raw))

        self.rest.fetch = fetch

    async def asyncTearDown(self):
        self.clock_patch.stop()
        await self.rest.close()

    def budget(self, remaining=5, resume_at=0):
        return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000), remaining=remaining, resume_at=resume_at)

    async def read(self, legs=(BTC_USD, BTC_USDT, USDC_USD), mode='live', budget=None):
        return await read_fx_evidence(self.rest, mode, list(legs), budget or self.budget())

    async def test_real_sdk_preserves_fixed_original_legs_envelope_time_and_explicit_weaker_time_basis(self):
        result = await self.read()
        self.assertEqual((result['version'], result['calls'], result['reason']), (1, 3, None))
        self.assertEqual([row['legId'] for row in result['receipts']], [BTC_USD, BTC_USDT, USDC_USD])
        self.assertEqual([call[0] for call in self.calls], ['api.bybit.com'] * 3)
        for row, raw in zip(result['receipts'], self.envelopes, strict=True):
            category, symbol, field, value = REQUESTS[row['legId']]
            self.assertEqual((row['category'], row['symbol'], row['field'], row['value']), (category, symbol, field, value))
            self.assertEqual(row['envelope'], raw)
            self.assertEqual(row['providerResponseAt'], raw['time'])
            self.assertIsNone(row['providerQuoteAt'], 'The REST envelope does not document an individual quote generation timestamp.')
            self.assertEqual(row['timeBasis'], 'provider_snapshot_observation')
            self.assertLessEqual(row['startedAt'], row['providerResponseAt'])
            self.assertLessEqual(row['providerResponseAt'], row['completedAt'])
            self.assertEqual((row['provider'], row['mode'], row['origin']), ('bybit', 'live', 'https://api.bybit.com'))
            self.assertEqual((row['ccxtVersion'], row['profileVersion'], row['source']),
                             ('4.5.75', 1, 'bybit-v5-rest-index-snapshot-v1'))
            self.assertEqual(row['envelopeHash'], fx_hash('bybit-fx-envelope-v1', raw))
            self.assertEqual(row['receiptHash'], fx_hash('bybit-fx-receipt-v1', {key: value for key, value in row.items() if key != 'receiptHash'}))
            self.assertNotIn('rate', row, 'Only the Node consumer forms an exact rational conversion.')

    async def test_testnet_origin_is_real_sdk_route_not_a_caller_label(self):
        self.rest.set_sandbox_mode(True)
        result = await self.read((USDC_USD,), 'testnet')
        self.assertEqual(self.calls, [('api-testnet.bybit.com', USDC_USD)])
        self.assertEqual(result['receipts'][0]['origin'], 'https://api-testnet.bybit.com')

    async def test_origin_mode_exchange_and_sdk_version_drift_fail_before_any_read(self):
        result = await self.read((USDC_USD,), 'testnet')
        self.assertEqual((result['calls'], result['receipts'], result['reason']), (0, [], 'unsupported'))
        for mutation in ({'hostname': 'evil.invalid'}, {'id': 'krakenfutures'}):
            with self.subTest(mutation=mutation), patch.multiple(self.rest, **mutation):
                self.assertEqual((await self.read())['reason'], 'unsupported')
        with patch('fx_evidence.package_version', return_value='4.5.76'):
            self.assertEqual((await self.read())['reason'], 'unsupported')
        self.assertEqual(self.calls, [])

    async def test_missing_or_changed_loaded_profile_and_unstructured_urls_never_start_a_read(self):
        with patch('fx_evidence.profile_for', return_value=None):
            self.assertEqual((await self.read())['reason'], 'unsupported')
        with patch.object(self.rest, 'urls', {'api': None}):
            self.assertEqual((await self.read())['reason'], 'unsupported')
        self.assertEqual(self.calls, [])

    async def test_unknown_duplicate_or_unbounded_leg_requests_are_rejected(self):
        for legs in (['BNB'], [BTC_USD, BTC_USD], [BTC_USD] * 4, 'USDT', [None]):
            with self.subTest(legs=legs), self.assertRaises(ExchangeContractError):
                await read_fx_evidence(self.rest, 'live', legs, self.budget())
        self.assertEqual(self.calls, [])

    async def test_wrong_category_symbol_empty_or_numeric_index_never_falls_back_to_mark_last_or_parity(self):
        for mutation in ('category', 'symbol', 'empty', 'numeric', 'missing', 'zero', 'negative', 'exponent', 'long'):
            def alter(_leg, raw):
                row = raw['result']['list'][0]
                if mutation == 'category':
                    raw['result']['category'] = 'linear'
                elif mutation == 'symbol':
                    row['symbol'] = 'BTCUSDT'
                elif mutation == 'missing':
                    row.pop('usdIndexPrice')
                else:
                    row['usdIndexPrice'] = {'empty': '', 'numeric': 1.002, 'zero': '0', 'negative': '-1',
                                            'exponent': '1e0', 'long': '9' * 100}[mutation]
                return raw
            self.transform = alter
            with self.subTest(mutation=mutation):
                result = await self.read((USDC_USD,))
                self.assertEqual((result['receipts'], result['reason'], result['calls']), ([], 'invalid_evidence', 1))

    async def test_missing_stale_future_and_boolean_provider_time_are_not_local_receipt_time(self):
        for stamp in (None, True, str(self.clock), self.clock - 10_001, self.clock + 30_000):
            self.transform = lambda _leg, raw: {**raw, 'time': stamp}
            with self.subTest(stamp=stamp):
                result = await self.read((USDC_USD,))
                self.assertEqual((result['receipts'], result['reason']), ([], 'invalid_evidence'))

    async def test_exact_snapshot_clock_and_read_span_boundaries_are_not_widened(self):
        for offset, valid in ((-1000, True), (-1001, False), (1010, True), (1011, False)):
            self.transform = lambda _leg, raw: {**raw, 'time': self.clock + offset}
            with self.subTest(offset=offset):
                result = await self.read((USDC_USD,))
                self.assertEqual(len(result['receipts']), int(valid))
        for duration, valid in ((10000, True), (10001, False), (-1, False)):
            def alter_clock(_leg, raw):
                self.clock += duration - 10  # The fake itself completes 10 ms later.
                return raw
            self.transform = alter_clock
            with self.subTest(duration=duration):
                result = await self.read((USDC_USD,))
                self.assertEqual(len(result['receipts']), int(valid))

    async def test_incomplete_duplicate_error_or_oversized_envelopes_are_not_valid_receipts(self):
        for mutation in ('duplicate', 'empty', 'missing', 'error', 'oversized', 'unsafe_number', 'surrogate'):
            def alter(_leg, raw):
                if mutation == 'duplicate':
                    raw['result']['list'] *= 2
                elif mutation == 'empty':
                    raw['result']['list'] = []
                elif mutation == 'missing':
                    raw.pop('result')
                elif mutation == 'error':
                    raw['retCode'] = 10001
                else:
                    raw['retExtInfo'] = {'note': {'oversized': 'x' * 65_536,
                                                'unsafe_number': 9_007_199_254_740_992, 'surrogate': '\ud800'}[mutation]}
                return raw
            self.transform = alter
            with self.subTest(mutation=mutation):
                self.assertEqual((await self.read((USDC_USD,)))['reason'], 'invalid_evidence')

    async def test_deep_many_token_and_utf8_oversized_envelopes_are_bounded(self):
        nested = 'leaf'
        for _ in range(13):
            nested = [nested]
        for extra in (nested, [None] * 300, '😀' * 8192):
            self.transform = lambda _leg, raw: {**raw, 'retExtInfo': {'extra': extra}}
            with self.subTest(extra_type=type(extra).__name__):
                self.assertEqual((await self.read((USDC_USD,)))['reason'], 'invalid_evidence')

    async def test_receipt_is_detached_from_mutable_sdk_response_and_original_strings_stay_exact(self):
        raw = response(USDC_USD, self.clock)
        self.rest.publicGetV5MarketTickers = AsyncMock(return_value=raw)
        result = await self.read((USDC_USD,))
        retained = copy.deepcopy(result['receipts'][0])
        raw['result']['list'][0]['usdIndexPrice'] = '500'
        raw['time'] += 1
        self.assertEqual(result['receipts'][0], retained)
        self.assertEqual(retained['value'], '1.000300')
        self.assertEqual(retained['envelope']['result']['list'][0]['usdIndexPrice'], '1.000300')

    async def test_each_real_http_read_counts_in_the_existing_shared_five(self):
        shared = self.budget()
        for _ in range(4):
            await shared.call(AsyncMock(return_value='existing recovery'))
        result = await self.read((BTC_USD, BTC_USDT, USDC_USD), budget=shared)
        self.assertEqual((shared.calls, result['calls']), (5, 1))
        self.assertEqual([row['legId'] for row in result['receipts']], [BTC_USD])
        self.assertEqual(result['reason'], 'budget_exhausted')
        self.assertEqual(len(self.calls), 1)

    async def test_deadline_or_backoff_prevents_coroutine_and_any_provider_read(self):
        for shared in (self.budget(0), self.budget(resume_at=int(time.time() * 1000) + 60_000),
                       RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 1_000))):
            with self.subTest(remaining=shared.remaining):
                result = await self.read(budget=shared)
                self.assertEqual((result['calls'], result['receipts'], result['reason']), (0, [], 'budget_exhausted'))
        self.assertEqual(self.calls, [])

    async def test_deadline_between_legs_keeps_first_original_without_restart_cache_or_false_complete_route(self):
        shared = self.budget()
        def expire(_leg, raw):
            shared.deadline.deadline_at_ms = int(time.time() * 1000) + 1_000
            return raw
        self.transform = expire
        first = await self.read((BTC_USD, BTC_USDT), budget=shared)
        self.assertEqual(([row['legId'] for row in first['receipts']], first['reason']), ([BTC_USD], 'budget_exhausted'))
        original = json.loads(json.dumps(first))
        self.transform = lambda _leg, raw: raw
        second = await self.read((BTC_USDT,))
        self.assertEqual([row['legId'] for row in second['receipts']], [BTC_USDT])
        self.assertEqual(first, original, 'Later reads do not mutate prior receipts or invent a local quote cache.')

    async def test_rate_limit_preserves_successful_prefix_and_shared_retry_after(self):
        original = self.rest.fetch
        async def fail_second(*args, **kwargs):
            if self.calls:
                self.rest.last_response_headers = {'Retry-After': '90'}
                raise RateLimitExceeded('local 429 fixture')
            return await original(*args, **kwargs)
        self.rest.fetch = fail_second
        shared = self.budget()
        result = await self.read((BTC_USD, BTC_USDT, USDC_USD), budget=shared)
        self.assertEqual((result['calls'], shared.calls, shared.remaining, result['reason']), (2, 2, 0, 'transient'))
        self.assertEqual([row['legId'] for row in result['receipts']], [BTC_USD])
        self.assertGreater(result['nextReadAt'], int(time.time() * 1000) + 85_000)
        resumed = await self.read(budget=self.budget(resume_at=result['nextReadAt']))
        self.assertEqual((resumed['calls'], resumed['reason']), (0, 'budget_exhausted'))

    async def test_network_failure_is_unknown_not_zero_or_provider_absence(self):
        self.rest.fetch = AsyncMock(side_effect=RequestTimeout('local timeout fixture'))
        result = await self.read((USDC_USD,))
        self.assertEqual((result['calls'], result['receipts'], result['reason']), (1, [], 'transient'))
        self.assertGreater(result['nextReadAt'], int(time.time() * 1000))

    async def test_sdk_retry_option_cannot_hide_a_second_http_call_inside_one_budget_call(self):
        self.rest.options['maxRetriesOnFailure'] = 2
        self.rest.fetch = AsyncMock(side_effect=RequestTimeout('no hidden SDK retry'))
        shared = self.budget()
        result = await self.read((USDC_USD,), budget=shared)
        self.assertEqual((result['calls'], shared.calls, self.rest.fetch.await_count), (1, 1, 1))
        self.assertEqual(result['reason'], 'transient')

    async def test_individually_valid_cross_legs_over_one_second_apart_are_retained_not_certified_as_a_pair(self):
        def stagger(leg, raw):
            if leg == BTC_USD:
                self.clock += 1_100
            return raw
        self.transform = stagger
        result = await self.read((BTC_USD, BTC_USDT))
        self.assertEqual(len(result['receipts']), 2)
        times = [row['providerResponseAt'] for row in result['receipts']]
        self.assertGreater(max(times) - min(times), 1_000)
        self.assertNotIn('rate', result)
        self.assertNotIn('routeComplete', result, 'Only the Node pairing consumer may certify cross-leg suitability.')

    async def test_origin_change_during_read_cannot_label_foreign_evidence_as_original_origin(self):
        def change(_leg, raw):
            self.rest.set_sandbox_mode(True)
            return raw
        self.transform = change
        result = await self.read((USDC_USD,))
        self.assertEqual((result['calls'], result['receipts'], result['reason']), (1, [], 'unsupported'))


class FxHashTests(unittest.TestCase):
    def test_full_original_receipt_hash_is_order_independent_domain_and_content_bound(self):
        value = {'😀': 'é', '\ue000': 'unicode', '10': 'ten', '2': 'two', 'nested': {'b': True, 'a': None}}
        canonical = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        expected = hashlib.sha256(('bybit-fx-envelope-v1\n' + canonical).encode('utf-8')).hexdigest()
        self.assertEqual(fx_hash('bybit-fx-envelope-v1', dict(reversed(list(value.items())))), expected)
        self.assertNotEqual(fx_hash('bybit-fx-receipt-v1', value), expected)
        self.assertNotEqual(fx_hash('bybit-fx-envelope-v1', {**value, '2': 'changed'}), expected)

    def test_hash_never_reinterprets_float_or_unsafe_integer_as_original_decimal(self):
        for value in (1.0, 0.1, float('nan'), float('inf'), 9_007_199_254_740_992, '\ud800', {1: 'key'}):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                fx_hash('bybit-fx-envelope-v1', value)

    def test_json_keys_are_bounded_strings_without_control_characters(self):
        for key in ('x' * 257, 'bad\nkey', 'bad\x7fkey', 'bad\x85key'):
            with self.subTest(key=repr(key)), self.assertRaises(ValueError):
                fx_hash('bybit-fx-envelope-v1', {key: 'value'})


if __name__ == '__main__':
    unittest.main()
