"""Interval evidence is distinct from traversal, ownership and REST snapshot atomicity."""
from __future__ import annotations

from typing import Any

from common import ExchangeContractError

PROFILES = {'bybit': 'bybit_v5_linear_endpoint_v1', 'krakenfutures': 'kraken_v3_executions_v1',
            'hyperliquid': 'hyperliquid_retained_fills_v1'}


def validate_coverage(value: Any, baseline: int, scanned: int | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('version') != 1 or value.get('profile') not in PROFILES.values():
        raise ExchangeContractError('Invalid historical coverage profile.')
    since, through = value.get('since'), value.get('through')
    if type(since) is not int or type(through) is not int or since != baseline or scanned is None or not since <= through <= scanned:
        raise ExchangeContractError('Invalid historical coverage interval.')
    return {'version': 1, 'profile': value['profile'], 'since': since, 'through': through}


def cover_window(state: dict[str, Any], exchange: str) -> dict[str, Any]:
    previous = state.get('coverage')
    profile = PROFILES[exchange]
    if previous and previous['profile'] != profile:
        raise ExchangeContractError('Historical coverage changed its provider profile.')
    # A completed newer window cannot repair an earlier hole or promote a legacy cursor.
    start = previous['through'] if previous else state['baselineSince']
    if state['providerSymbol'] is not None or state['windowSince'] > start:
        return state
    return {**state, 'coverage': {'version': 1, 'profile': profile, 'since': state['baselineSince'],
                                'through': max(start, state['windowUntil'])}}


def covered_window(state: dict[str, Any]) -> bool:
    value = state.get('coverage')
    return bool(value and value['since'] == state['baselineSince'] and value['through'] >= state['windowUntil'])


def fresh_fill_source(source: dict[str, Any], progress: list[dict[str, Any]], exchange: str,
                      since: int, started: int) -> dict[str, Any]:
    if exchange == 'bybit':
        return {**source, 'reason': 'option_history_scope_unproved'}
    rows = [row for row in progress if row['checkpoint']['source'] == 'fills' and row['checkpoint']['providerSymbol'] is None]
    if len(rows) != 1:
        return source
    update, state = rows[0], rows[0]['checkpoint']
    coverage = state.get('coverage')
    if (not coverage or coverage['profile'] != PROFILES.get(exchange) or coverage['since'] > since
            or coverage['through'] < started or state['completeness'] != 'complete' or update['pages'] == 0):
        return source
    probe = state.get('retention')
    if probe and (exchange != 'hyperliquid' or probe['phase'] != 'proved' or probe['validatedAt'] < started
                  or coverage['through'] > min(probe['fixedUntil'], probe['originalUntil'])):
        return source
    return {**source, 'completeness': 'complete', 'reason': None, 'since': coverage['since']}
