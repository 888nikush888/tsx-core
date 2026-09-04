"""Pure units for the reviewed KuCoin Classic USDT-settled linear perpetual.

Sources: pinned CCXT 4.5.75 kucoin.fetch_contract_markets /
create_contract_order_request, and the native Classic Get Symbol contract:
https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-symbol

KuCoin labels this quote=settlement USDT, non-inverse product isQuanto=true.
Preserve that native flag; it is not permission for other quanto products.
These checks establish neither account mode, freshness, capacity nor a profile
grant. No CCXT market, raw input, original quantity or profile is modified.

Numerical originals must be strings, integers or Decimal (e.g. a lossless JSON
decoder's parse_float=Decimal). A float-decoded info value is NOT an original
decimal. Units use TSX's existing 36-integer/18-fractional-digit boundary.
SDK counts additionally stay within the safe-integer serialization boundary.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from fractions import Fraction

from common import DECIMAL_PATTERN, ExchangeContractError


MAX_SAFE_INTEGER = 9_007_199_254_740_991
_ORIGINAL_NUMBER = re.compile(r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')


class KucoinContractError(ExchangeContractError):
    code = 'KUCOIN_CONTRACT_UNPROVEN'
    side_effects = False


@dataclass(frozen=True, slots=True)
class KucoinContract:
    native_symbol: str
    base_currency: str
    quote_currency: str
    settlement_currency: str
    provider_is_quanto: bool
    contract_size: Decimal
    price_tick: Decimal
    lot_size: int
    max_order_quantity: int
    market_max_order_quantity: int


def _require(condition, message):
    if not condition:
        raise KucoinContractError(message)


def _positive_decimal(value, label):
    _require(type(value) in (str, int, Decimal), f'{label}: exact original decimal required, not float/bool.')
    if type(value) is int:
        _require(0 < value < 10 ** 36, f'{label}: integer exceeds the exact decimal boundary.')
    if type(value) is str:
        _require(len(value) <= 80 and _ORIGINAL_NUMBER.fullmatch(value) is not None,
                 f'{label}: malformed or oversized original decimal.')
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise KucoinContractError(f'{label}: unrepresentable original decimal.') from error
    _require(number.is_finite(), f'{label}: finite decimal required.')
    parts = number.as_tuple()
    _require(number > 0 and len(parts.digits) <= 80 and -80 <= parts.exponent <= 80,
             f'{label}: positive bounded original decimal required.')
    text = format(number, 'f')
    text = text.rstrip('0').rstrip('.') if '.' in text else text
    _require(DECIMAL_PATTERN.fullmatch(text) is not None, f'{label}: exceeds TSX exact decimal precision.')
    return number


def _positive_count(value, label):
    numerator, denominator = _positive_decimal(value, label).as_integer_ratio()
    _require(denominator == 1 and numerator <= MAX_SAFE_INTEGER, f'{label}: safe whole-contract count required.')
    return numerator


def _native_symbol(value):
    _require(type(value) is str and re.fullmatch(r'[A-Z0-9]{1,64}', value) is not None,
             'Native contract symbol is missing or malformed.')
    return value


def _perpetual_scope(raw):
    exact = {'rootSymbol': 'USDT', 'type': 'FFWCSX', 'quoteCurrency': 'USDT', 'settleCurrency': 'USDT',
             'status': 'Open', 'marketStage': 'NORMAL', 'fairMethod': 'FundingRate', 'settlementSymbol': ''}
    for field, expected in exact.items():
        _require(raw.get(field) == expected, f'{field}: Classic USDT perpetual scope is not proven.')
    _require(raw.get('isInverse') is False and raw.get('isQuanto') is True,
             'Native inverse/quanto flags do not match the reviewed USDT payout model.')
    for field in ('expireDate', 'settleDate'):
        _require(field in raw and raw[field] is None, f'{field}: absence of contract expiration must be explicit.')
    for field, minimum in (('fundingRateGranularity', 1), ('nextFundingRateTime', 0)):
        value = raw.get(field)
        _require(type(value) is int and minimum <= value <= MAX_SAFE_INTEGER, f'{field}: perpetual funding metadata is unknown.')


def normalize_kucoin_contract(raw, *, expected_symbol: str) -> KucoinContract:
    """Validate one native Classic contract object, not an envelope or SDK market.

The caller must independently establish the source, account/market binding and
freshness. Native baseCurrency is retained verbatim; no BTC/XBT alias is made.
Missing fields cannot inherit CCXT's linear/active/perpetual defaults.
"""
    _require(type(raw) is dict, 'Native Classic contract object is missing.')
    symbol = _native_symbol(raw.get('symbol'))
    _require(symbol == _native_symbol(expected_symbol), 'Native contract symbol differs from the original request.')
    _perpetual_scope(raw)
    base = raw.get('baseCurrency')
    _require(type(base) is str and re.fullmatch(r'[A-Z0-9]{1,32}', base) is not None and base != 'USDT',
             'Native base currency is missing or conflicts with the settlement model.')
    contract_size = _positive_decimal(raw.get('multiplier'), 'multiplier')
    tick = _positive_decimal(raw.get('tickSize'), 'tickSize')
    step = _positive_count(raw.get('lotSize'), 'lotSize')
    maximum = _positive_count(raw.get('maxOrderQty'), 'maxOrderQty')
    market_maximum = _positive_count(raw.get('marketMaxOrderQty'), 'marketMaxOrderQty')
    _require(step <= min(maximum, market_maximum), 'Order limits do not permit one native lot.')
    return KucoinContract(symbol, base, raw['quoteCurrency'], raw['settleCurrency'], raw['isQuanto'],
                          contract_size, tick, step, maximum, market_maximum)


def kucoin_sdk_amount(raw, contract_amount, *, expected_symbol: str, expected_contract_size,
                      base_quantity, order_type: str) -> int:
    """Return an exact SDK-compatible count, never resize or round an order.

    ``order_type`` is the actual SDK type: limit or market (including a market
    triggerstop). maxOrderQty applies generally; marketMaxOrderQty additionally
    caps market orders. lotSize is both the native count step and minimum.
    The caller must still enforce price ticks, account capacity, original request,
    TTL and final actual SDK-spec equality. This is not an entry admission proof.
    """
    contract = normalize_kucoin_contract(raw, expected_symbol=expected_symbol)
    _require(order_type in ('limit', 'market'), 'Actual SDK order type must be explicit limit or market.')
    original_size = _positive_decimal(expected_contract_size, 'original contractSize')
    _require(original_size == contract.contract_size, 'Original contractSize differs from native multiplier.')
    amount = _positive_count(contract_amount, 'SDK contract amount')
    _require(amount % contract.lot_size == 0, 'SDK amount is not an exact multiple of the native lotSize.')
    maximum = contract.max_order_quantity
    if order_type == 'market':
        maximum = min(maximum, contract.market_max_order_quantity)
    _require(amount <= maximum, 'SDK amount exceeds the native order quantity limit.')
    quantity = _positive_decimal(base_quantity, 'original base quantity')
    # Rational multiplication cannot inherit Decimal context rounding, even
    # if another caller has lowered that thread's active decimal precision.
    _require(Fraction(amount) * Fraction(contract.contract_size) == Fraction(quantity),
             'SDK count times native multiplier differs from the original base quantity.')
    return amount
