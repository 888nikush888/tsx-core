"""Adversarial task, endpoint and original-JSON fences for the Kraken reader."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import ccxt.async_support as ccxt_async

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from account_log_reader import read_account_log_page
from account_log_sources import kraken_page, source_spec
from common import ExchangeContractError, RequestDeadline
from history_reader import RecoveryBudgetExhausted
from kraken_response_capture import MAX_RESPONSE_BYTES, read_exact_kraken_account_log
from test_kraken_response_capture import LocalResponse, captured_kraken_client, checkpoint, log_body, read_budget, SINCE


def params():
    return {'version': 'v3', 'sort': 'asc', 'since': SINCE, 'before': SINCE + 1001, 'count': 500}


def full_checkpoint():
    namespace, filter_hash = source_spec('krakenfutures')
    return {**checkpoint(), 'version': 1, 'namespace': namespace, 'filterHash': filter_hash,
            'accountFingerprint': 'a' * 64, 'credentialGeneration': 'b' * 64,
            'revision': 2, 'requiredSince': SINCE, 'cursor': '9007199254740993',
            'scannedThrough': None, 'nextReadAt': 0, 'lastServedAt': 0, 'reason': None}


class KrakenCaptureBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def client(self, response=None):
        rest, session = captured_kraken_client([response or LocalResponse(log_body())])
        self.addAsyncCleanup(rest.close)
        return rest, session

    async def test_unhooked_or_return_only_fake_cannot_supply_evidence(self):
        for bypass in ('fetch', 'on_rest_response'):
            rest, session = self.client()
            if bypass == 'fetch':
                rest.fetch = AsyncMock(return_value=json.loads(log_body()))
            else:
                rest.on_rest_response = lambda _code, _reason, _url, _method, _rh, body, _qh, _qb: body
            with self.subTest(bypass=bypass), self.assertRaisesRegex(ExchangeContractError, 'missing exact response capture'):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(len(session.calls), 0 if bypass == 'fetch' else 1)

    async def test_duplicate_response_hook_is_not_another_valid_original(self):
        rest, session = self.client()
        original = rest.on_rest_response
        def twice(*args):
            original(*args)
            return original(*args)
        rest.on_rest_response = twice
        with self.assertRaisesRegex(ExchangeContractError, 'repeated response hook'):
            await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(len(session.calls), 1)

    async def test_wrong_signed_transport_scope_is_rejected_before_http(self):
        cases = ('host', 'path', 'version', 'method', 'body', 'query', 'duplicate_query', 'fragment', 'api_key')
        for case in cases:
            rest, session = self.client()
            sign = rest.sign
            def changed(*args, **kwargs):
                result = sign(*args, **kwargs)
                if case == 'host':
                    result['url'] = result['url'].replace('futures.kraken.com', 'example.invalid')
                elif case == 'path':
                    result['url'] = result['url'].replace('account-log', 'executions')
                elif case == 'version':
                    result['url'] = result['url'].replace('/v3/', '/v2/')
                elif case == 'method':
                    result['method'] = 'POST'
                elif case == 'body':
                    result['body'] = '{}'
                elif case == 'query':
                    result['url'] += '&asset=usd'
                elif case == 'duplicate_query':
                    result['url'] += '&sort=asc'
                elif case == 'fragment':
                    result['url'] += '#elsewhere'
                else:
                    result['headers']['APIKey'] = 'another-fixture-key'
                return result
            rest.sign = changed
            with self.subTest(case=case), self.assertRaises(ExchangeContractError):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(session.calls, [])

    async def test_response_url_cannot_depart_from_the_sent_endpoint(self):
        rest, session = self.client()
        original = rest.on_rest_response
        def wrong_response(code, reason, url, *args):
            return original(code, reason, url.replace('account-log', 'orders'), *args)
        rest.on_rest_response = wrong_response
        with self.assertRaisesRegex(ExchangeContractError, 'endpoint scope'):
            await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(len(session.calls), 1)

    async def test_client_identity_and_origin_changes_in_flight_are_rejected(self):
        for changed in ('apiKey', 'secret', 'root'):
            rest, session = self.client()
            async def mutate():
                if changed == 'root':
                    rest.urls['api']['history'] = 'https://demo-futures.kraken.com/api/history/'
                else:
                    setattr(rest, changed, 'changed-fixture-value')
            session.responses[0].before_text = mutate
            with self.subTest(changed=changed), self.assertRaisesRegex(ExchangeContractError, 'changed client binding'):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(len(session.calls), 1)

    async def test_different_client_hook_cannot_populate_the_owner_capture(self):
        rest, session = self.client()
        other, other_session = self.client()
        async def foreign_response():
            url, request = session.calls[0]
            other.on_rest_response(200, 'OK', url, 'GET', {}, log_body(), request['headers'], None)
        session.responses[0].before_text = foreign_response
        with self.assertRaisesRegex(ExchangeContractError, 'request ownership'):
            await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(other_session.calls, [])

    async def test_inherited_child_task_cannot_send_under_the_parent_capture(self):
        rest, session = self.client()
        async def child_attempt():
            with self.assertRaisesRegex(ExchangeContractError, 'request ownership'):
                await rest.historyGetAccountLog(params())
        async def spawn_child():
            await asyncio.create_task(child_attempt())
        session.responses[0].before_text = spawn_child
        with self.assertRaisesRegex(ExchangeContractError, 'request ownership'):
            await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(len(session.calls), 1)

    async def test_cancelled_owner_cannot_be_reused_by_inherited_late_task(self):
        ready, release, late_ready = asyncio.Event(), asyncio.Event(), asyncio.Event()
        rest, session = self.client()
        children = []
        async def late_child():
            late_ready.set()
            await release.wait()
            with self.assertRaisesRegex(ExchangeContractError, 'request ownership'):
                await rest.historyGetAccountLog(params())
        async def pause():
            children.append(asyncio.create_task(late_child()))
            ready.set()
            await asyncio.Event().wait()
        session.responses[0].before_text = pause
        task = asyncio.create_task(kraken_page(rest, checkpoint(), read_budget()))
        try:
            await asyncio.wait_for(ready.wait(), 1)
            await asyncio.wait_for(late_ready.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            release.set()
            await asyncio.gather(*children)
        session.responses.append(LocalResponse(log_body('2e-18')))
        rows, *_ = await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(rows[0]['realized_funding'], '0.000000000000000002')
        self.assertEqual(len(session.calls), 2)

    async def test_nested_capture_and_second_transport_are_forbidden(self):
        for nested in (True, False):
            rest, session = self.client()
            async def repeated():
                if nested:
                    await read_exact_kraken_account_log(rest, params())
                else:
                    await rest.historyGetAccountLog(params())
            session.responses[0].after_response = repeated
            expected = 'nested capture' if nested else 'repeated transport'
            with self.subTest(nested=nested), self.assertRaisesRegex(ExchangeContractError, expected):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(len(session.calls), 1)

    async def test_missing_hook_even_on_unwrapped_real_sdk_is_not_a_fallback(self):
        rest, session = self.client()
        rest.fetch = ccxt_async.krakenfutures.fetch.__get__(rest, type(rest))
        rest.on_rest_response = ccxt_async.krakenfutures.on_rest_response.__get__(rest, type(rest))
        with self.assertRaisesRegex(ExchangeContractError, 'missing exact response capture'):
            await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(len(session.calls), 1)

    async def test_budget_exhaustion_creates_no_capture_or_request(self):
        rest, session = self.client()
        budget = read_budget(0)
        with self.assertRaises(RecoveryBudgetExhausted):
            await kraken_page(rest, checkpoint(), budget)
        self.assertEqual((budget.calls, len(session.calls)), (0, 0))
        await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(len(session.calls), 1)

    async def test_existing_deadline_and_cooldown_prevent_even_one_sdk_read(self):
        for kind in ('deadline', 'cooldown'):
            rest, session = self.client()
            budget = read_budget()
            if kind == 'deadline':
                budget.deadline = RequestDeadline(0)
            else:
                budget.resume_at = budget.deadline.deadline_at_ms
            with self.subTest(kind=kind), self.assertRaises(RecoveryBudgetExhausted):
                await kraken_page(rest, checkpoint(), budget)
            self.assertEqual((budget.calls, len(session.calls)), (0, 0))

    async def test_capture_failure_or_changed_uid_never_advances_original_checkpoint(self):
        for kind in ('missing_capture', 'invalid_json', 'changed_uid'):
            body = '{"logs":NaN}' if kind == 'invalid_json' else log_body()
            rest, session = self.client(LocalResponse(body))
            original = full_checkpoint()
            if kind == 'missing_capture':
                rest.on_rest_response = lambda _c, _r, _u, _m, _h, text, _qh, _qb: text
            elif kind == 'changed_uid':
                original['providerAccountUid'] = 'another-original-account'
            budget = read_budget()
            receipt, state = await read_account_log_page(rest, 'krakenfutures', original, budget)
            with self.subTest(kind=kind):
                self.assertIsNone(receipt)
                self.assertEqual(state['reason'], 'invalid_source_evidence')
                for key in ('revision', 'windowSince', 'windowUntil', 'cursor', 'scannedThrough', 'providerAccountUid'):
                    self.assertEqual(state[key], original[key])
                self.assertEqual((budget.calls, len(session.calls)), (1, 1))

    async def test_native_rate_limit_keeps_shared_retry_after_and_original_cursor(self):
        response = LocalResponse('{"result":"error","error":"apiLimitExceeded"}', status=429)
        response.headers['Retry-After'] = '120'
        rest, session = self.client(response)
        rest.options['maxRetriesOnFailure'] = 9
        original, budget = full_checkpoint(), read_budget()
        receipt, state = await read_account_log_page(rest, 'krakenfutures', original, budget)
        self.assertIsNone(receipt)
        self.assertEqual(state['reason'], 'transient')
        self.assertEqual(state['cursor'], original['cursor'])
        self.assertIsNone(state['scannedThrough'])
        self.assertEqual((budget.calls, budget.remaining, len(session.calls)), (1, 0, 1))
        self.assertEqual(state['nextReadAt'], budget.resume_at)
        self.assertGreaterEqual(budget.resume_at, state['lastServedAt'] + 120_000)
        self.assertEqual(rest.options['maxRetriesOnFailure'], 9)
        again, _ = await read_account_log_page(rest, 'krakenfutures', original, budget)
        self.assertIsNone(again)
        self.assertEqual((budget.calls, len(session.calls)), (1, 1))

    async def test_sdk_retry_drift_is_pinned_off_without_mutating_options(self):
        rest, session = self.client(LocalResponse('{"result":"error","error":"apiLimitExceeded"}', status=429))
        rest.options['maxRetriesOnFailure'] = 7
        from ccxt.base.errors import DDoSProtection
        with self.assertRaises(DDoSProtection):
            await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(rest.options['maxRetriesOnFailure'], 7)
        self.assertEqual(len(session.calls), 1)
        self.assertNotIn('maxRetries', session.calls[0][0])

    async def test_malformed_client_url_containers_are_sanitized(self):
        invalid = (None, [], 7, {'api': None}, {'api': []}, {'api': {'history': []}}, {'api': {'history': {}}})
        for urls in invalid:
            rest, session = self.client()
            rest.urls = urls
            with self.subTest(urls=urls), self.assertRaises(ExchangeContractError):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(session.calls, [])

    async def test_malformed_signed_url_or_headers_are_sanitized(self):
        invalid = ({'url': 'https://[invalid/path'}, {'url': 'https://futures.kraken.com:bad/api/history/v3/account-log'},
                   {'url': None}, {'url': '\nhttps://futures.kraken.com/api/history/v3/account-log'},
                   {'headers': None}, {'headers': []}, {'headers': {'Authent': []}},
                   {'headers': {'APIKey': 'isolated-fixture-key', 'Authent': '\ud800'}},
                   {'headers': {'APIKey': 'isolated-fixture-key', 'Authent': 'bad\r\nheader'}})
        for changed in invalid:
            rest, session = self.client()
            sign = rest.sign
            rest.sign = lambda *args, **kwargs: {**sign(*args, **kwargs), **changed}
            with self.subTest(changed=changed), self.assertRaises(ExchangeContractError):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(session.calls, [])

    async def test_invalid_request_scope_never_reaches_transport(self):
        bad = ({'version': 'v2'}, {'sort': 'desc'}, {'count': True}, {'since': True}, {'before': SINCE},
               {'from': 0}, {'from': '9007199254740993'}, {'since': -1}, {'currency': 'USD'})
        for changed in bad:
            rest, session = self.client()
            with self.subTest(changed=changed), self.assertRaises(ExchangeContractError):
                await read_exact_kraken_account_log(rest, {**params(), **changed})
            self.assertEqual(session.calls, [])

    async def test_exact_json_rejects_ambiguous_nonfinite_or_unbounded_originals(self):
        invalid = [log_body('NaN'), log_body('Infinity'), log_body('-Infinity'), log_body('true'),
                   log_body('1e100000000'), log_body('1e-100000000'), log_body('1' * 257),
                   log_body().replace('"asset":"usd"', '"asset":"usd","asset":"eur"'),
                   log_body().replace('"asset":"usd"', '"asset":"\\ud800"'),
                   log_body().replace('"asset":"usd"', '"asset":"\ufffd"'),
                   '{"nested":' + '[' * 34 + '0' + ']' * 34 + '}', '[]', '{bad JSON}',
                   '{"padding":[' + ','.join('0' for _ in range(50_001)) + ']}',
                   '{"padding":"' + 'x' * MAX_RESPONSE_BYTES + '"}']
        for index, body in enumerate(invalid):
            rest, session = self.client(LocalResponse(body))
            with self.subTest(index=index), self.assertRaises(ExchangeContractError):
                await kraken_page(rest, checkpoint(), read_budget())
            self.assertEqual(len(session.calls), 1)

    async def test_null_original_is_preserved_as_unknown_not_zero(self):
        rest, _ = self.client(LocalResponse(log_body('null')))
        rows, *_ = await kraken_page(rest, checkpoint(), read_budget())
        self.assertIsNone(rows[0]['realized_funding'])

    async def test_capture_is_before_sdk_float_parser_and_has_no_shared_slot_dependency(self):
        rest, _ = self.client()
        original = rest.on_json_response
        parsed = []
        def normal_parser(body):
            result = original(body)
            parsed.append(result['logs'][0]['realized_funding'])
            return result
        with patch.object(rest, 'on_json_response', side_effect=normal_parser):
            rows, *_ = await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(parsed, [1.0])
        self.assertEqual(rows[0]['realized_funding'], '1.000000000000000001')


if __name__ == '__main__':
    unittest.main()
