"""Exact, complete provider tier tables. Upper boundaries are conservatively exclusive."""
from __future__ import annotations

from decimal import Decimal, localcontext
from typing import Any

from common import ExchangeContractError, decimal_string


class TierEvidenceError(ExchangeContractError):
    code = 'LEVERAGE_TIERS_UNPROVEN'


def require_tier(condition: bool, reason: str) -> None:
    if not condition:
        raise TierEvidenceError(reason)


def number(value: Any, *, positive: bool = False) -> str:
    try:
        return decimal_string(str(value) if type(value) in (int, float) else value, 'tier value', positive=positive)
    except (ExchangeContractError, ValueError, TypeError) as error:
        raise TierEvidenceError('Invalid tier decimal.') from error


def _maximum(value: Any) -> int:
    raw = Decimal(number(value, positive=True))
    require_tier(raw == raw.to_integral_value(), 'Invalid tier leverage.')
    return min(int(raw), 50)


def validate_tiers(tiers: Any) -> None:
    require_tier(isinstance(tiers, list) and 0 < len(tiers) <= 500, 'Complete leverage tiers are required.')
    lower, maximum = '0', 50
    for index, tier in enumerate(tiers):
        require_tier(isinstance(tier, dict) and number(tier.get('lowerBound')) == lower, 'Leverage tier range is contradictory.')
        leverage, upper = tier.get('maxLeverage'), tier.get('upperBound')
        require_tier(type(leverage) is int and 1 <= leverage <= maximum, 'Leverage tier maxima must decrease.')
        require_tier(upper is not None or index == len(tiers) - 1, 'Only the final tier can be unlimited.')
        if upper is not None:
            require_tier(Decimal(number(upper, positive=True)) > Decimal(lower), 'Invalid tier upper bound.')
        lower, maximum = upper, leverage


def normalize_bybit_tiers(rows: Any, symbol: str) -> list[dict[str, Any]]:
    require_tier(isinstance(rows, list) and 0 < len(rows) <= 500, 'Complete Bybit tiers are missing.')
    result, previous, identifiers = [], '0', set()
    for row in rows:
        require_tier(isinstance(row, dict) and row.get('symbol') == symbol, 'Bybit tier symbol mismatch.')
        require_tier(type(row.get('isLowestRisk')) is int and row['isLowestRisk'] == (1 if not result else 0),
                     'Bybit lowest-risk tier origin is not proven.')
        identifier = number(row.get('id'), positive=True)
        require_tier(identifier not in identifiers, 'Duplicate Bybit risk tier.')
        identifiers.add(identifier)
        upper = number(row.get('riskLimitValue'), positive=True)
        result.append({'lowerBound': previous, 'upperBound': upper, 'maxLeverage': _maximum(row.get('maxLeverage'))})
        previous = upper
    validate_tiers(result)
    return result


def _lower_bound_tiers(rows: Any, leverage) -> list[dict[str, Any]]:
    require_tier(isinstance(rows, list) and 0 < len(rows) <= 500 and all(isinstance(row, dict) for row in rows), 'Complete margin tiers are missing.')
    result = [{'lowerBound': number(row.get('lowerBound')), 'upperBound': None, 'maxLeverage': leverage(row)} for row in rows]
    for index in range(len(result) - 1):
        result[index]['upperBound'] = result[index + 1]['lowerBound']
    validate_tiers(result)
    return result


def normalize_hyperliquid_tiers(asset: dict[str, Any], tables: Any) -> list[dict[str, Any]]:
    identifier = asset.get('marginTableId')
    require_tier(type(identifier) is int and identifier > 0, 'Hyperliquid margin-table identity is missing.')
    if identifier < 50:
        require_tier(_maximum(asset.get('maxLeverage')) == identifier, 'Hyperliquid implicit tier conflicts with its market.')
        return [{'lowerBound': '0', 'upperBound': None, 'maxLeverage': identifier}]
    require_tier(isinstance(tables, list) and len(tables) <= 500, 'Hyperliquid margin tables are missing.')
    matches = [row for row in tables if isinstance(row, list) and len(row) == 2 and row[0] == identifier]
    require_tier(len(matches) == 1 and isinstance(matches[0][1], dict), 'Hyperliquid margin table is missing or duplicated.')
    result = _lower_bound_tiers(matches[0][1].get('marginTiers'), lambda row: _maximum(row.get('maxLeverage')))
    require_tier(result[0]['maxLeverage'] == _maximum(asset.get('maxLeverage')), 'Hyperliquid market and tiers disagree.')
    return result


def normalize_kraken_tiers(rows: Any) -> list[dict[str, Any]]:
    require_tier(isinstance(rows, list) and 0 < len(rows) <= 500 and all(isinstance(row, dict) for row in rows),
                 'Account-applicable Kraken margin schedule is missing.')
    def leverage(row):
        with localcontext() as context:
            context.prec = 180
            initial = Decimal(number(row.get('initialMargin'), positive=True))
            require_tier(initial <= 1, 'Invalid Kraken initial margin.')
            return min(50, int(Decimal(1) / initial))
    return _lower_bound_tiers([{**row, 'lowerBound': row.get('numNonContractUnits')} for row in rows], leverage)


def assert_quantity_tier(tiers: list[dict[str, Any]], quantity: str, mark: str, leverage: int) -> int:
    validate_tiers(tiers)
    require_tier(type(leverage) is int and 1 <= leverage <= 50, 'Invalid requested tier leverage.')
    with localcontext() as context:
        context.prec = 180
        notional = Decimal(number(quantity, positive=True)) * Decimal(number(mark, positive=True))
        for index, tier in enumerate(tiers):
            if notional >= Decimal(tier['lowerBound']) and (tier['upperBound'] is None or notional < Decimal(tier['upperBound'])):
                require_tier(leverage <= tier['maxLeverage'], 'Requested leverage exceeds the quantized notional tier.')
                return index
    raise TierEvidenceError('Quantized notional is outside the proven leverage tiers.')
