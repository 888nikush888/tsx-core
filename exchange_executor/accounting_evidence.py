"""Profile-bound balance units and legacy payload validation; history uses the shared durable producer."""
from __future__ import annotations

import re
from decimal import Decimal, localcontext
from typing import Any

from common import ExchangeContractError, decimal_string, signed_decimal_string


def _asset(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[A-Z0-9][A-Z0-9._-]{0,31}', value):
        raise ExchangeContractError('Invalid accounting asset.')
    return value


def _rows(value: Any, limit: int) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(row, dict) for row in value):
        raise ExchangeContractError('Invalid accounting collection.')
    return value


def funding_total(evidence: dict[str, Any], reporting_currency: str) -> str | None:
    if evidence['status'] != 'complete':
        return None
    total = Decimal(0)
    with localcontext() as context:
        context.prec = 100
        for event in evidence['events']:
            amount = Decimal(event['amount'])
            if amount != 0 and event['asset'] != reporting_currency:
                return None
            total += amount
    return signed_decimal_string(format(total, 'f'), 'funding total')


def _original_decimal(value: Any, field: str) -> Decimal:
    if not isinstance(value, str):
        raise ExchangeContractError(f'{field} requires its exact original decimal string.')
    return Decimal(signed_decimal_string(value, field))


def _hyperliquid_position_price_pnl(row: dict[str, Any]) -> tuple[Decimal, Decimal, str]:
    position = row.get('position')
    if row.get('type') != 'oneWay' or not isinstance(position, dict):
        raise ExchangeContractError('Clearinghouse position shape is unproved.')
    coin = position.get('coin')
    if not isinstance(coin, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,31}', coin):
        raise ExchangeContractError('Position collateral is not proved for the first perpetual DEX.')
    size = _original_decimal(position.get('szi'), 'position size')
    value = _original_decimal(position.get('positionValue'), 'position value')
    pnl = _original_decimal(position.get('unrealizedPnl'), 'unrealized PnL')
    if value < 0 or (size == 0 and (value != 0 or pnl != 0)):
        raise ExchangeContractError('Position notional contradicts its size.')
    if size != 0:
        entry = _original_decimal(position.get('entryPx'), 'entry price')
        calculated = (value - abs(size) * entry) * (1 if size > 0 else -1)
        if entry <= 0 or calculated != pnl:
            raise ExchangeContractError('Reported PnL is not proved to be the exact price component.')
    return pnl, value, coin


def _hyperliquid_price_pnl(info: dict[str, Any], summary: dict[str, Any]) -> str:
    # Native first-DEX USDC perps. Funding is a separate cash flow (cumFunding),
    # never added to mark-notional minus signed entry cost. Rounded/mismatched
    # economics remain unproved; no epsilon or fabricated zero is used.
    with localcontext() as context:
        context.prec = 100
        positions = [_hyperliquid_position_price_pnl(row) for row in _rows(info.get('assetPositions'), 1000)]
        if len({coin for _, _, coin in positions}) != len(positions):
            raise ExchangeContractError('Duplicate clearinghouse position.')
        if sum((value for _, value, _ in positions), Decimal(0)) != _original_decimal(summary.get('totalNtlPos'), 'total notional'):
            raise ExchangeContractError('Clearinghouse position coverage differs from its aggregate.')
        return signed_decimal_string(format(sum((pnl for pnl, _, _ in positions), Decimal(0)), 'f'), 'price PnL')


def reporting_balance(exchange: str, balance: dict[str, Any]) -> dict[str, Any]:
    info = balance.get('info')
    if not isinstance(info, dict):
        raise ExchangeContractError('Balance omitted its reporting-unit evidence.')
    if exchange == 'bybit':
        rows = _rows((info.get('result') or {}).get('list'), 10)
        if len(rows) != 1 or rows[0].get('accountType') != 'UNIFIED':
            raise ExchangeContractError('Bybit balance scope is not a unique unified account.')
        row = rows[0]
        assets = sorted({_asset(coin.get('coin')) for coin in _rows(row.get('coin'), 1000)})
        return {'reportingCurrency': 'USD', 'settlementAssets': assets, 'source': 'bybit-wallet-balance-v1',
                'unrealizedPnlSemantics': 'price_only',
                'equity': decimal_string(row.get('totalEquity'), 'equity'),
                'availableBalance': decimal_string(row.get('totalAvailableBalance'), 'available balance'),
                'unrealizedPnl': signed_decimal_string(row.get('totalPerpUPL'), 'unrealized PnL'),
                'marginUsed': decimal_string(row.get('totalInitialMargin'), 'margin')}
    if exchange == 'hyperliquid':
        summary = info.get('marginSummary')
        if not isinstance(summary, dict):
            raise ExchangeContractError('Hyperliquid perpetual account summary is missing.')
        return {'reportingCurrency': 'USDC', 'settlementAssets': ['USDC'], 'source': 'hyperliquid-clearinghouse-state-v1',
                'unrealizedPnl': _hyperliquid_price_pnl(info, summary), 'unrealizedPnlSemantics': 'price_only',
                'equity': decimal_string(summary.get('accountValue'), 'equity'),
                'availableBalance': decimal_string(info.get('withdrawable'), 'available balance'),
                'marginUsed': decimal_string(summary.get('totalMarginUsed'), 'margin')}
    raise ExchangeContractError('Account-wide reporting/valuation profile is not certified for this balance.')
