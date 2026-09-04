"""Node-produced decisions through real Python gates and CCXT; no provider transport.

Only synthetic in-memory identities are used. Fresh read timestamps belong to local
fake observations, not actual provider evidence. This fixture grants no profile.
"""
from __future__ import annotations

import asyncio
import copy
import json
import sys
from importlib.metadata import version
from pathlib import Path
from unittest.mock import AsyncMock
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import CcxtAdapter
from leverage_tier_evidence import assert_tier_entry, read_tier_evidence
from leverage_tiers import TierEvidenceError
from test_contracts import FakeRegistry
from test_entry_price_constraints import deadline, rest_fixture
from test_entry_price_sdk import sdk

SYMBOL = 'BTC/USDT:USDT'
CONTRACTS = {'unit': '1', 'milli': '0.001'}


def local_rest(contract, mark='100'):
    rest = rest_fixture()
    rest.markets[SYMBOL]['contractSize'] = CONTRACTS[contract]
    original_ticker = rest.publicGetV5MarketTickers

    async def ticker(params):
        response = await original_ticker(params)
        response['result']['list'][0]['markPrice'] = mark
        return response

    rest.publicGetV5MarketTickers = ticker
    return rest


async def context():
    tiers = {}
    for contract in CONTRACTS:
        rest = local_rest(contract)
        registry = FakeRegistry(rest)
        tiers[contract] = await read_tier_evidence(registry.clients, rest.markets[SYMBOL], deadline())
    return {'ccxtVersion': version('ccxt'), 'account': registry.clients.account, 'tiers': tiers}


async def signed_batch(real, spec):
    # SDK account-mode setup is supplied by a fake; all other real HTTP is rejected.
    real.is_unified_enabled = AsyncMock(return_value=[False, True])

    async def transport(url, method, headers, _body):
        if method != 'POST' or urlsplit(url).path != '/v5/order/create-batch':
            raise AssertionError('Unexpected SDK transport; provider network is forbidden.')
        if not headers.get('X-BAPI-SIGN'):
            raise AssertionError('The real pinned SDK must sign its actual request.')
        return {'retCode': 0, 'retMsg': 'OK', 'result': {'list': []}, 'retExtInfo': {'list': []}}

    real.fetch = AsyncMock(side_effect=transport)
    await real.create_orders([copy.deepcopy(spec)])
    url, _method, headers, body = real.fetch.await_args.args
    payload = json.loads(body)
    return {'spec': spec, 'wire': payload['request'][0], 'category': payload['category'],
            'endpoint': urlsplit(url).path, 'signed': bool(headers.get('X-BAPI-SIGN'))}


async def exercise(case):
    original = copy.deepcopy(case['request'])
    rest = local_rest(case['contract'], case['mark'])
    registry = FakeRegistry(rest)
    real = sdk('bybit')
    real.apiKey, real.secret, real.enableRateLimit = 'isolated-key', 'isolated-secret', False
    real.markets[SYMBOL]['contractSize'] = float(CONTRACTS[case['contract']])
    rest.amount_to_precision, rest.price_to_precision = real.amount_to_precision, real.price_to_precision
    result = {'name': case['name'], 'code': None}
    try:
        if case['path'] == 'gate':
            evidence = await read_tier_evidence(registry.clients, rest.markets[SYMBOL], deadline())
            spec = {'amount': case['request']['quantity'], 'price': case['specPrice']}
            assert_tier_entry(registry.clients, rest.markets[SYMBOL], case['request'], spec, evidence)
        else:
            spec, _market = await CcxtAdapter(registry)._order_spec(registry.clients, case['request'], deadline())
            result.update(await signed_batch(real, spec))
    except TierEvidenceError as error:
        result.update(code=error.code, message=str(error))
    finally:
        result.update(requestUnchanged=case['request'] == original, setterCalls=len(rest.leverage),
                      batchCalls=real.fetch.await_count)
        await real.close()
    return result


async def main():
    if version('ccxt') != '4.5.75':
        raise AssertionError('This fixture requires the pinned CCXT 4.5.75.')
    if sys.argv[1] == 'context':
        return await context()
    if sys.argv[1] != 'check':
        raise AssertionError('Unknown local fixture mode.')
    cases = json.loads(sys.stdin.read(512001))
    if not isinstance(cases, list) or len(cases) > 50:
        raise AssertionError('Fixture case limit exceeded.')
    return [await exercise(case) for case in cases]


if __name__ == '__main__':
    print(json.dumps(asyncio.run(main()), ensure_ascii=False, separators=(',', ':')))
