"""Fresh account/symbol-bound tiers and actual scope, using only reviewed read endpoints."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from decimal import Decimal, localcontext
from importlib.metadata import version
from typing import Any

from ccxt_client import credential_generation, decimal_text
from ccxt_profiles import profile_for
from common import RequestDeadline, external_account_id
from current_state import read_current_state
from execution_constraints import _bound_hyperliquid_user, profile_hash
from fx_tier_budget import assert_fx_tier_budget
from leverage_tiers import (TierEvidenceError, assert_quantity_tier, normalize_bybit_tiers,
                            normalize_hyperliquid_tiers, normalize_kraken_tiers, number, require_tier)

TIER_AGE_MS = 10_000
SOURCES = {'bybit': 'bybit_v5_risk_limit_mark_authenticated_scope_v1',
           'hyperliquid': 'hyperliquid_meta_asset_context_bound_scope_v1',
           'krakenfutures': 'kraken_authenticated_trading_instruments_mark_scope_v1'}


def _now() -> int:
    return int(time.time() * 1000)


async def _read(deadline: RequestDeadline, operation):
    deadline.ensure(250)
    return await asyncio.wait_for(operation(), timeout=deadline.sdk_timeout_seconds())


def _rows(value: Any, maximum=500):
    require_tier(isinstance(value, list) and len(value) <= maximum and all(isinstance(row, dict) for row in value), 'Tier source collection is incomplete.')
    return value


def _timestamp(value: Any) -> None:
    require_tier(type(value) is int and abs(_now() - value) < TIER_AGE_MS, 'Tier provider timestamp is missing or stale.')


def _bybit_result(response: Any):
    require_tier(isinstance(response, dict) and type(response.get('retCode')) is int and response['retCode'] == 0, 'Bybit tier read failed.')
    _timestamp(response.get('time'))
    result = response.get('result')
    require_tier(isinstance(result, dict) and result.get('category') == 'linear', 'Bybit tier category is invalid.')
    return result


async def _bybit(rest, market, deadline):
    rows, cursors, params = [], set(), {'category': 'linear', 'symbol': market['id']}
    for _ in range(32):
        result = _bybit_result(await _read(deadline, lambda: rest.publicGetV5MarketRiskLimit(dict(params))))
        rows.extend(_rows(result.get('list')))
        cursor = result.get('nextPageCursor')
        require_tier(isinstance(cursor, str) and len(cursor) <= 4096 and len(rows) <= 500, 'Bybit tier continuation is incomplete.')
        if not cursor:
            tiers = normalize_bybit_tiers(rows, market['id'])
            ticker = _bybit_result(await _read(deadline, lambda: rest.publicGetV5MarketTickers({'category': 'linear', 'symbol': market['id']})))
            prices = _rows(ticker.get('list'))
            require_tier(len(prices) == 1 and prices[0].get('symbol') == market['id'], 'Bybit mark symbol is not proven.')
            return tiers, number(prices[0].get('markPrice'), positive=True)
        require_tier(cursor not in cursors, 'Bybit tier continuation repeated.')
        cursors.add(cursor)
        params['cursor'] = cursor
    raise TierEvidenceError('Bybit tier pagination exceeded its bounded read budget.')


async def _hyperliquid(clients, market, deadline):
    _bound_hyperliquid_user(clients)
    require_tier(':' not in market['base'] and market['settle'] == 'USDC' and market['quote'] == 'USDC', 'Hyperliquid tier DEX/currency is unreviewed.')
    response = await _read(deadline, lambda: clients.rest.publicPostInfo({'type': 'metaAndAssetCtxs'}))
    require_tier(isinstance(response, list) and len(response) == 2 and isinstance(response[0], dict), 'Hyperliquid tier metadata is incomplete.')
    require_tier(type(response[0].get('collateralToken')) is int and response[0]['collateralToken'] == 0,
                 'Hyperliquid first-perp collateral token is not proven.')
    universe, contexts = _rows(response[0].get('universe'), 10000), _rows(response[1], 10000)
    require_tier(len(universe) == len(contexts), 'Hyperliquid mark universe is incomplete.')
    matches = [index for index, asset in enumerate(universe) if asset.get('name') == market['base']]
    require_tier(len(matches) == 1, 'Hyperliquid tier coin is missing or duplicated.')
    index = matches[0]
    require_tier(universe[index].get('isDelisted', False) is False, 'Hyperliquid market is delisted.')
    tiers = normalize_hyperliquid_tiers(universe[index], response[0].get('marginTables'))
    return tiers, number(contexts[index].get('markPx'), positive=True)


async def _kraken(rest, market, deadline):
    require_tier(str(market['id']).upper().startswith('PF_') and market['quote'] == 'USD', 'Kraken tier contract units are unreviewed.')
    # CCXT 4.5.75 has no generated accessor; its own request/sign route remains authoritative.
    response = await _read(deadline, lambda: rest.request('trading/instruments', 'private', 'GET', {'contractType': 'flexible_futures'}))
    require_tier(isinstance(response, dict) and response.get('result') == 'success', 'Kraken account-applicable instruments are missing.')
    _timestamp(rest.parse8601(response.get('serverTime')))
    rows = _rows(response.get('instruments'), 10000)
    matches = [row for row in rows if str(row.get('symbol')).lower() == market['id'].lower()]
    require_tier(len(matches) == 1, 'Kraken account instrument is missing or duplicated.')
    instrument = matches[0]
    require_tier(instrument.get('restricted') is False and instrument.get('isExpired') is False
                 and instrument.get('postOnly') is False, 'Kraken instrument cannot admit this entry.')
    require_tier(instrument.get('type') == 'flexible_futures' and number(market['contractSize'], positive=True) == '1'
                 and instrument.get('quote') == market['quote'] and instrument.get('base') == market['base'], 'Kraken account instrument units changed.')
    precision = instrument.get('contractValueTradePrecision')
    require_tier(type(precision) is int and -18 <= precision <= 18, 'Kraken quantity precision is missing.')
    require_tier(Decimal(10) ** -precision == Decimal(number(market.get('precision', {}).get('amount'), positive=True)),
                 'Kraken authenticated quantity precision changed.')
    tiers = normalize_kraken_tiers(instrument.get('marginLevels'))
    ticker = await _read(deadline, lambda: rest.fetch_ticker(market['symbol']))
    require_tier(isinstance(ticker, dict) and ticker.get('symbol') == market['symbol'], 'Kraken mark symbol is not proven.')
    _timestamp(ticker.get('timestamp'))
    info = ticker.get('info')
    require_tier(isinstance(info, dict), 'Kraken mark source is missing.')
    return tiers, number(info.get('markPrice'), positive=True)


async def _scope(clients, market, deadline):
    if clients.account['exchange'] == 'hyperliquid':
        actual, _ = clients.rest.handle_public_address('fetchOpenOrders', {})
        require_tier(str(actual).lower() == _bound_hyperliquid_user(clients), 'Actual public scope address is not bound to this account.')
    orders, positions, sources = await read_current_state(clients.rest, clients.account['exchange'], deadline)
    require_tier({row.get('source') for row in sources} == {'orders', 'positions'}
                 and all(row.get('completeness') == 'complete' for row in sources), 'Complete actual tier scope is not proven.')
    quantity = Decimal(0)
    with localcontext() as context:
        context.prec = 180
        for position in positions:
            if position['symbol'] == market['symbol']:
                quantity += Decimal(number(position.get('contracts'))) * Decimal(number(market['contractSize'], positive=True))
    return {'complete': True, 'positionQuantity': number(decimal_text(quantity)),
            'openOrderCount': sum(row['symbol'] == market['symbol'] for row in orders)}


def _binding(clients, market):
    profile = profile_for(clients.account['exchange'])
    require_tier(profile is not None and version('ccxt') == '4.5.75', 'Tier execution profile is unreviewed.')
    require_tier(market.get('linear') is True and market.get('contract') is True
                 and market.get('quote') in ('USD', 'USDC', 'USDT'), 'Tier valuation requires reviewed linear quote units.')
    return {'version': 1, 'exchange': clients.account['exchange'], 'symbol': f"{str(market['base']).upper()}USDT", 'providerSymbol': market['symbol'],
            'accountFingerprint': external_account_id(clients.account['exchange'], clients.account['mode'], clients.account_identity),
            'credentialGeneration': credential_generation(clients), 'ccxtVersion': '4.5.75', 'profileHash': profile_hash(profile),
            'source': SOURCES[clients.account['exchange']], 'currency': market['quote'], 'contractSize': number(market['contractSize'], positive=True)}


async def read_tier_evidence(clients, market, deadline: RequestDeadline):
    started = _now()
    binding = _binding(clients, market)
    exchange = clients.account['exchange']
    if exchange == 'hyperliquid':
        tiers, mark = await _hyperliquid(clients, market, deadline)
    else:
        tiers, mark = await {'bybit': _bybit, 'krakenfutures': _kraken}[exchange](clients.rest, market, deadline)
    scope = await _scope(clients, market, deadline)
    require_tier(0 <= _now() - started < TIER_AGE_MS, 'Tier read evidence expired.')
    return {**binding, 'markPrice': mark, 'tiers': tiers, 'scope': scope, 'observedAt': started, 'expiresAt': started + TIER_AGE_MS}


def evidence_hash(value):
    fields = [value[key] for key in ('exchange', 'symbol', 'providerSymbol', 'accountFingerprint', 'credentialGeneration',
                                     'ccxtVersion', 'profileHash', 'source', 'currency', 'contractSize')]
    fields.append([[row['lowerBound'], row['upperBound'], row['maxLeverage']] for row in value['tiers']])
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def assert_tier_entry(clients, market, request, spec, evidence):
    require_tier(all(evidence.get(key) == value for key, value in _binding(clients, market).items()), 'Tier account/market binding changed.')
    require_tier(0 <= _now() - evidence['observedAt'] < TIER_AGE_MS and evidence['expiresAt'] == evidence['observedAt'] + TIER_AGE_MS,
                 'Tier entry evidence expired.')
    require_tier(evidence['scope'] == {'complete': True, 'positionQuantity': '0', 'openOrderCount': 0}, 'Existing or unknown tier scope blocks scale-in.')
    decision = request.get('leverageTierDecision')
    require_tier(isinstance(decision, dict), 'Original leverage tier decision is missing.')
    exact_budget = type(decision.get('version')) is int and decision['version'] == 2
    require_tier((decision.get('version') == 1 or exact_budget) and decision.get('evidenceHash') == evidence_hash(evidence)
                 and decision.get('providerSymbol') == market['symbol'] and decision.get('contractSize') == evidence['contractSize'], 'Original leverage tier table or contract changed.')
    quantity = number(request.get('quantity'), positive=True)
    leverage = request.get('leverage')
    require_tier(decision.get('quantity') == quantity and decision.get('leverage') == leverage, 'Original leverage tier sizing changed.')
    with localcontext() as context:
        context.prec = 180
        require_tier(Decimal(number(spec['amount'], positive=True)) * Decimal(evidence['contractSize']) == Decimal(quantity), 'SDK contract rounding changed tier quantity.')
    tier = assert_quantity_tier(evidence['tiers'], quantity, evidence['markPrice'], leverage)
    require_tier(decision.get('tierIndex') == tier, 'Current mark changed the original notional tier.')
    if exact_budget:
        assert_fx_tier_budget(decision, evidence['currency'], quantity, evidence['markPrice'], spec.get('price'))
        return
    with localcontext() as context:
        context.prec = 180
        valuation = max(Decimal(evidence['markPrice']), Decimal(number(spec.get('price'), positive=True)))
        require_tier(Decimal(quantity) * valuation <= Decimal(number(decision.get('maximumNotional'), positive=True)),
                     'Current valuation exceeds the original margin/notional budget.')
