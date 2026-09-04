"""Immutable entry-only price boundaries; no market or unprotected fallback."""
from __future__ import annotations

from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, localcontext
from typing import Any

from ccxt_profiles import ExchangeProfile
from common import ExchangeContractError, decimal_string

BOUNDARY_FIELDS = {'version', 'referencePrice', 'maxSlippagePercent', 'priceTick', 'limitPrice'}
IOC = {'bybit': 'IOC', 'hyperliquid': 'Ioc', 'krakenfutures': 'ioc'}


class EntryPriceConstraintError(ExchangeContractError):
    code = 'ENTRY_PRICE_BOUND_UNPROVEN'
    http_status = 422
    # A previous leverage adjustment may have happened before the final fence.
    # Never claim the entire operation was side-effect free.


def needs_entry_boundary(request: dict[str, Any]) -> bool:
    return request.get('reduceOnly') is not True and (
        request.get('orderType') == 'market' or request.get('timeInForce') is not None
        or request.get('entryPriceBoundary') is not None)


def assert_boundary(request: dict[str, Any], price_tick: str) -> str:
    boundary = request.get('entryPriceBoundary')
    if not isinstance(boundary, dict) or set(boundary) != BOUNDARY_FIELDS or type(boundary['version']) is not int or boundary['version'] != 1:
        raise EntryPriceConstraintError('Original entry price boundary is missing or invalid.')
    values = {key: Decimal(decimal_string(boundary[key], key, positive=True)) for key in BOUNDARY_FIELDS - {'version'}}
    if values['maxSlippagePercent'] > 5 or values['priceTick'] != Decimal(price_tick):
        raise EntryPriceConstraintError('Original entry boundary does not match its certified market tick or slippage.')
    if request.get('maxSlippagePercent') != boundary['maxSlippagePercent']:
        raise EntryPriceConstraintError('Original entry slippage changed.')
    side = request.get('side')
    if side not in ('buy', 'sell'):
        raise EntryPriceConstraintError('Bounded entry side is invalid.')
    with localcontext() as context:
        context.prec = 180
        factor = 100 + values['maxSlippagePercent'] if side == 'buy' else 100 - values['maxSlippagePercent']
        ticks = values['referencePrice'] * factor / (100 * values['priceTick'])
        allowed = ticks.to_integral_value(rounding=ROUND_FLOOR if side == 'buy' else ROUND_CEILING) * values['priceTick']
    if allowed <= 0 or values['limitPrice'] != allowed:
        raise EntryPriceConstraintError('Tick rounding widened or changed the original entry price boundary.')
    if (request.get('role'), request.get('orderType'), request.get('timeInForce')) != ('entry', 'limit', 'IOC'):
        raise EntryPriceConstraintError('Bounded entry requires the protected limit IOC order form.')
    if request.get('postOnly') is True or request.get('reduceOnly') is True or request.get('price') != boundary['limitPrice']:
        raise EntryPriceConstraintError('Submitted entry contradicts its original price boundary.')
    return boundary['limitPrice']


def apply_entry_boundary(profile: ExchangeProfile, request: dict[str, Any], spec: dict[str, Any], price_tick: str) -> None:
    if not needs_entry_boundary(request):
        return
    if profile.execution_capabilities.protected_bounded_entry != 'limit_ioc_batch_v1':
        raise EntryPriceConstraintError('Protected bounded-entry batch support is not proven for this profile.')
    limit = assert_boundary(request, price_tick)
    if spec['type'] != 'limit' or Decimal(str(spec['price'])) != Decimal(limit):
        raise EntryPriceConstraintError('Provider precision changed the original entry price boundary.')
    spec['params']['timeInForce'] = IOC[profile.id]


def assert_final_entry_spec(profile: ExchangeProfile, request: dict[str, Any], spec: dict[str, Any], price_tick: str) -> None:
    if not needs_entry_boundary(request):
        return
    limit = assert_boundary(request, price_tick)
    expected = (request['side'], 'limit', Decimal(limit), IOC[profile.id], False)
    actual = (spec['side'], spec['type'], Decimal(str(spec['price'])), spec['params'].get('timeInForce'), spec['params'].get('reduceOnly'))
    if actual != expected or spec['params'].get('postOnly') or 'slippage' in spec['params']:
        raise EntryPriceConstraintError('Final provider dispatch changed the original entry price contract.')
