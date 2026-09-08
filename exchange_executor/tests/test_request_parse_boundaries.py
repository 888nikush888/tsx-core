"""Reject malformed request encodings before dispatch while releasing request ownership."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import ExchangeContractError
from kraken_response_capture import read_exact_kraken_account_log
from server import Application, execute
from test_kraken_response_capture import LocalResponse, SINCE, captured_kraken_client, log_body


def http_request(application, body, route, semaphore):
    return SimpleNamespace(
        app={'application': application, 'request_semaphore': semaphore},
        headers={'Authorization': 'Bearer parse-boundary-fixture'},
        content_length=len(body.encode('utf-8')),
        path=route,
        json=AsyncMock(side_effect=lambda *, loads: loads(body)),
    )


class RequestParseBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_signed_query_is_rejected_before_transport_and_capture_can_be_reused(self):
        # The first query raises ValueError; invalid UTF-8 raises its UnicodeDecodeError subclass.
        for query in ('missing-equals', 'sort=%FF'):
            with self.subTest(query=query):
                rest, session = captured_kraken_client([LocalResponse(log_body())])
                self.addAsyncCleanup(rest.close)
                original_sign = rest.sign

                def malformed_sign(*args, query=query, sign=original_sign, **kwargs):
                    signed = sign(*args, **kwargs)
                    signed['url'] = signed['url'].split('?', 1)[0] + '?' + query
                    return signed

                rest.sign = malformed_sign
                params = {'version': 'v3', 'sort': 'asc', 'since': SINCE, 'before': SINCE + 1001, 'count': 500}
                with self.assertRaisesRegex(ExchangeContractError, 'unproved: query encoding') as raised:
                    await read_exact_kraken_account_log(rest, params)
                self.assertEqual(str(raised.exception), 'Kraken response capture is unproved: query encoding.')
                self.assertEqual(session.calls, [], 'Invalid signing must never spend an HTTP request or trigger a retry.')
                self.assertEqual(len(session.responses), 1)

                rest.sign = original_sign
                exact = await read_exact_kraken_account_log(rest, params)
                self.assertEqual(len(session.calls), 1, 'A fresh explicit read must own a clean capture after rejection.')
                self.assertEqual(exact['logs'][0]['id'], 9007199254740993)
                self.assertEqual(exact['logs'][0]['realized_funding'], Decimal('1.000000000000000001'))

    async def test_malformed_json_returns_400_without_dispatch_and_releases_capacity(self):
        application = SimpleNamespace(
            credentials=SimpleNamespace(token=lambda: 'parse-boundary-fixture'),
            handle=AsyncMock(return_value={'ok': True}),
        )
        semaphore = asyncio.Semaphore(1)
        route = '/v1/submit-order'
        for body in ('{ ', '{"request":{}} trailing'):
            request = http_request(application, body, route, semaphore)
            with self.subTest(body=body):
                response = await execute(request)
                self.assertEqual(response.status, 400)
                self.assertEqual(set(json.loads(response.text)), {'error'})
                self.assertIsInstance(json.loads(response.text)['error'], str)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                application.handle.assert_not_awaited()
                self.assertFalse(semaphore.locked(), 'JSON rejection must release the executor concurrency permit.')

        valid = http_request(application, '{"request":{"clientOrderId":"local-fixture"}}', route, semaphore)
        response = await asyncio.wait_for(execute(valid), timeout=1)
        self.assertEqual((response.status, json.loads(response.text)), (200, {'ok': True}))
        application.handle.assert_awaited_once_with(route, {'request': {'clientOrderId': 'local-fixture'}})
        self.assertFalse(semaphore.locked())

    async def test_missing_exchange_contract_returns_400_before_catalog_probe(self):
        application = Application.__new__(Application)
        application.credentials = SimpleNamespace(token=lambda: 'parse-boundary-fixture')
        application.exchange_catalog = SimpleNamespace(probe=AsyncMock())
        semaphore = asyncio.Semaphore(1)
        for body in ('{}', '{"exchange":[]}', '{"exchange":""}'):
            request = http_request(application, body, '/v1/exchange-probe', semaphore)
            with self.subTest(body=body):
                response = await execute(request)
                self.assertEqual(response.status, 400)
                self.assertEqual(json.loads(response.text), {'error': 'exchange is required.'})
                application.exchange_catalog.probe.assert_not_awaited()
                self.assertFalse(semaphore.locked())


if __name__ == '__main__':
    unittest.main()
