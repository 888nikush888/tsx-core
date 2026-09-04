"""Allowlisted monetary source envelopes; no generic CCXT income/float normalization."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal
from typing import Any

from common import ExchangeContractError
from kraken_response_capture import read_exact_kraken_account_log

SPECS = {
    'bybit': ('bybit_uta_transaction_log_scope_v1', {'accountType': 'UNIFIED'}),
    'hyperliquid': ('hyperliquid_user_funding_v1', {'type': 'userFunding'}),
    'krakenfutures': ('kraken_account_log_v3', {'version': 'v3', 'sort': 'asc'}),
}
FIELDS = {
    'bybit': 'id transactionTime type subType transSubType category symbol side currency funding cashFlow change fee tradeId orderId orderLinkId qty size tradePrice feeRate bonusChange cashBalance',
    'hyperliquid': 'hash time coin type usdc szi fundingRate nSamples',
    'krakenfutures': 'id date asset collateral contract info booking_uid margin_account execution fee realized_funding realized_pnl old_balance new_balance funding_rate mark_price trade_price exchange_rate exchange_rate_from conversion_fee conversion_spread_percentage liquidation_fee',
}


def source_spec(exchange: str) -> tuple[str, str]:
    namespace, filters = SPECS[exchange]
    serialized = json.dumps(filters, separators=(',', ':'))
    return namespace, hashlib.sha256(serialized.encode()).hexdigest()


def _records(rows: Any, exchange: str, maximum: int) -> list[dict[str, str | None]]:
    if not isinstance(rows, list) or len(rows) > maximum or any(not isinstance(row, dict) for row in rows):
        raise ExchangeContractError('Account log has no bounded record collection.')
    return [_record(row, exchange) for row in rows]


def _record(row: dict[str, Any], exchange: str) -> dict[str, str | None]:
    if exchange == 'hyperliquid':
        delta = row.get('delta')
        if not isinstance(delta, dict):
            return {'hash': str(row.get('hash', '')), 'type': 'invalid_delta'}
        row = {**delta, 'hash': row.get('hash'), 'time': row.get('time')}
    result = {}
    for field in FIELDS[exchange].split():
        if field not in row:
            continue
        value = row[field]
        if value is None:
            result[field] = None
        elif isinstance(value, (str, int, Decimal)) and not isinstance(value, bool):
            text = format(value, 'f') if isinstance(value, Decimal) else str(value)
            if len(text) > 256 or any(ord(character) < 32 for character in text):
                raise ExchangeContractError('Account log economic field is oversized or contains control characters.')
            result[field] = text
        else:
            raise ExchangeContractError('Account log money must retain exact original decimals.')
    return result


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ExchangeContractError('Account log omitted its source envelope.')
    return value


async def bybit_page(rest, state, budget):
    params = {**SPECS['bybit'][1], 'startTime': state['windowSince'], 'endTime': state['windowUntil'], 'limit': 50}
    if state['cursor']:
        params['cursor'] = state['cursor']
    response = _object(await budget.call(lambda: rest.privateGetV5AccountTransactionLog(params)))
    if type(response.get('retCode')) is not int or response['retCode'] != 0:
        raise ExchangeContractError('Invalid Bybit account-log response code.')
    result = _object(response.get('result'))
    cursor = result.get('nextPageCursor')
    if not isinstance(cursor, str) or len(cursor) > 4096 or (cursor and cursor == state['cursor']):
        raise ExchangeContractError('Account log cursor is missing or did not advance.')
    return _records(result.get('list'), 'bybit', 50), cursor or None, not cursor, response.get('time'), None


async def hyperliquid_page(rest, state, budget, user):
    if not isinstance(user, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', user):
        raise ExchangeContractError('Account log requires the verified user address.')
    start = int(state['cursor']) if state['cursor'] is not None else state['windowSince']
    rows = _records(await budget.call(lambda: rest.publicPostInfo({
        'type': 'userFunding', 'user': user, 'startTime': start, 'endTime': state['windowUntil'],
    })), 'hyperliquid', 5000)
    times = [int(row['time']) for row in rows]
    if times != sorted(times) or any(stamp < start or stamp > state['windowUntil'] for stamp in times):
        raise ExchangeContractError('Account-log timestamp ordering/window is invalid.')
    if not times:
        return rows, None, True, None, None
    last = times[-1]
    if last > start:
        return rows, str(last), False, None, None
    if len(rows) >= 500:
        return rows, state['cursor'], False, None, 'timestamp_saturated'
    # Re-read the inclusive boundary; fewer than 500 records in the single
    # timestamp cannot saturate either the element or distinct-block limit.
    exhausted = last == state['windowUntil']
    return rows, None if exhausted else str(last + 1), exhausted, None, None


async def kraken_page(rest, state, budget):
    params = {**SPECS['krakenfutures'][1], 'since': state['windowSince'], 'before': state['windowUntil'] + 1, 'count': 500}
    if state['cursor']:
        params['from'] = int(state['cursor'])
    response = await budget.call(lambda: read_exact_kraken_account_log(rest, params))
    uid = response.get('accountUid')
    if not isinstance(uid, str) or not uid or state['providerAccountUid'] not in (None, uid):
        raise ExchangeContractError('Kraken account-log UID is missing or changed.')
    rows = _records(response.get('logs'), 'krakenfutures', 500)
    ids = [int(row['id']) for row in rows]
    if ids != sorted(set(ids)) or any(value < int(state['cursor'] or '1') for value in ids):
        raise ExchangeContractError('Kraken account-log IDs did not advance.')
    for row in rows:
        stamp = int(datetime.fromisoformat(row['date'].replace('Z', '+00:00')).timestamp() * 1000)
        if not state['windowSince'] <= stamp <= state['windowUntil']:
            raise ExchangeContractError('Kraken account-log event is outside the pinned window.')
    return rows, str(ids[-1] + 1) if ids else None, not rows, None, uid
