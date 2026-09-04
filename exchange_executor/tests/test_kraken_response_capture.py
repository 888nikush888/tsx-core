"""Exact Kraken response ownership through the pinned SDK, without network I/O."""
from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import ccxt
import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from account_log_sources import kraken_page
from ccxt_sdk_policy import client_class
from common import RequestDeadline
from history_reader import RecoveryReadBudget


SINCE = 1788307200000
UID = '11111111-1111-4111-8111-111111111111'


def log_body(amount='1.000000000000000001'):
    return ('{"accountUid":"' + UID + '","logs":[{"id":9007199254740993,'
            '"date":"2026-09-02T00:00:00Z","asset":"usd","info":"funding rate change",'
            '"realized_funding":' + amount + '}]}')


def checkpoint():
    return {'windowSince': SINCE, 'windowUntil': SINCE + 1000, 'cursor': None, 'providerAccountUid': None}


def read_budget(remaining=5):
    return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000), remaining=remaining)


class LocalResponse:
    def __init__(self, body, *, status=200, before_text=None, after_response=None):
        self.body, self.status = body, status
        self.headers, self.reason = {'Content-Type': 'application/json'}, 'local fixture'
        self.before_text, self.after_response = before_text, after_response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        if self.after_response:
            await self.after_response()

    async def text(self, **_kwargs):
        if self.before_text:
            await self.before_text()
        return self.body


class LocalSession:
    """The real SDK fetch/hook/parser run; only aiohttp's session is replaced."""
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []
        self.headers = {}

    def get(self, url, **kwargs):
        self.calls.append((str(url), kwargs))
        if not self.responses:
            raise AssertionError('Unexpected HTTP request; no provider transport exists in this fixture.')
        return self.responses.pop(0)


def captured_kraken_client(responses, *, sdk_class=ccxt_async.krakenfutures):
    session = LocalSession(responses)
    rest = client_class('krakenfutures', sdk_class)({
        'apiKey': 'isolated-fixture-key', 'secret': 'aXNvbGF0ZWQtZml4dHVyZS1zZWNyZXQ=',  # gitleaks:allow
        'enableRateLimit': False, 'session': session, 'timeout_on_exit': 0,
    })
    return rest, session


class KrakenResponseCaptureTests(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_sdk_preserves_the_request_original_after_float_equal_aba(self):
        rest, session = captured_kraken_client([LocalResponse(log_body())])
        self.addAsyncCleanup(rest.close)
        self.assertEqual(ccxt.__version__, '4.5.75')
        async def overwrite_last_response():
            rest.last_http_response = log_body('1.000000000000000002')
        session.responses[0].after_response = overwrite_last_response
        self.assertEqual(json.loads(log_body()), json.loads(log_body('1.000000000000000002')))
        budget = read_budget()
        rows, cursor, *_ = await kraken_page(rest, checkpoint(), budget)
        self.assertEqual(rows[0]['realized_funding'], '1.000000000000000001')
        self.assertEqual(cursor, '9007199254740994')
        self.assertEqual((budget.calls, len(session.calls)), (1, 1))

    async def test_unrelated_response_does_not_replace_the_account_log_original(self):
        rest, session = captured_kraken_client([LocalResponse(log_body())])
        self.addAsyncCleanup(rest.close)
        async def overwrite_last_response():
            rest.last_http_response = '{"result":"success","openPositions":[]}'
        session.responses[0].after_response = overwrite_last_response
        rows, *_ = await kraken_page(rest, checkpoint(), read_budget())
        self.assertEqual(rows[0]['realized_funding'], '1.000000000000000001')

    async def test_two_concurrent_same_client_reads_retain_their_own_originals(self):
        ready, release = asyncio.Event(), asyncio.Event()
        async def pause_first():
            ready.set()
            await release.wait()
        rest, session = captured_kraken_client([
            LocalResponse(log_body(), before_text=pause_first),
            LocalResponse(log_body('1.000000000000000002')),
        ])
        self.addAsyncCleanup(rest.close)
        first = asyncio.create_task(kraken_page(rest, checkpoint(), read_budget()))
        try:
            await asyncio.wait_for(ready.wait(), 1)
            second = await kraken_page(rest, checkpoint(), read_budget())
        finally:
            release.set()
            one = await first
        self.assertEqual(one[0][0]['realized_funding'], '1.000000000000000001')
        self.assertEqual(second[0][0]['realized_funding'], '1.000000000000000002')
        self.assertEqual(len(session.calls), 2)
        query = parse_qs(urlsplit(session.calls[0][0]).query)
        self.assertEqual(query, {'since': [str(SINCE)], 'before': [str(SINCE + 1001)], 'count': ['500'], 'sort': ['asc']})

    async def test_real_rest_and_pro_demo_clients_preserve_large_cursor_without_last_response(self):
        for sdk_class in (ccxt_async.krakenfutures, ccxt_pro.krakenfutures):
            rest, session = captured_kraken_client([LocalResponse(log_body())], sdk_class=sdk_class)
            self.addAsyncCleanup(rest.close)
            rest.set_sandbox_mode(True)
            rest.enableLastHttpResponse = False
            rows, cursor, *_ = await kraken_page(rest, {**checkpoint(), 'cursor': '9007199254740993'}, read_budget())
            self.assertEqual(rows[0]['realized_funding'], '1.000000000000000001')
            self.assertEqual(cursor, '9007199254740994')
            self.assertTrue(session.calls[0][0].startswith('https://demo-futures.kraken.com/api/history/v3/account-log?'))
            self.assertEqual(parse_qs(urlsplit(session.calls[0][0]).query)['from'], ['9007199254740993'])

    async def test_parallel_unrelated_real_sdk_request_keeps_its_own_normal_parser(self):
        ready, release = asyncio.Event(), asyncio.Event()
        async def pause_first():
            ready.set()
            await release.wait()
        rest, session = captured_kraken_client([
            LocalResponse(log_body(), before_text=pause_first),
            LocalResponse('{"result":"success","openPositions":[],"unrelated":1.25}'),
        ])
        self.addAsyncCleanup(rest.close)
        first = asyncio.create_task(kraken_page(rest, checkpoint(), read_budget()))
        try:
            await asyncio.wait_for(ready.wait(), 1)
            positions = await rest.privateGetOpenpositions()
        finally:
            release.set()
            rows, *_ = await first
        self.assertEqual(positions, {'result': 'success', 'openPositions': [], 'unrelated': 1.25})
        self.assertIsInstance(positions['unrelated'], float)
        self.assertEqual(rows[0]['realized_funding'], '1.000000000000000001')
        self.assertEqual(len(session.calls), 2)


if __name__ == '__main__':
    unittest.main()
