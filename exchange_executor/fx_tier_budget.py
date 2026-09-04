"""Exact positive v2 notional caps, not FX-source or account authorization.

MoneyValue bounds reproduce Node's 36-integer/18-fractional-digit display.
The cap comparison uses the original reduced fraction, never either bound.
"""
from __future__ import annotations

import re
from fractions import Fraction
from math import gcd

from leverage_tiers import number, require_tier

VALUE_FIELDS = {'lower', 'upper', 'exact', 'decimal', 'precision', 'terms'}
FRACTION_FIELDS = {'numerator', 'denominator'}


def _shape(value, fields):
    require_tier(type(value) is dict and set(value) == fields, 'Invalid exact notional value fields.')


def _positive_integer(value):
    require_tier(type(value) is str and re.fullmatch(r'[1-9][0-9]{0,255}', value) is not None,
                 'Invalid positive bounded notional coefficient.')
    return int(value)


def _display(units):
    digits = str(units).zfill(19)
    require_tier(len(digits[:-18]) <= 36, 'Notional display exceeds the 36-digit integer limit.')
    return (digits[:-18] + '.' + digits[-18:]).rstrip('0').rstrip('.')


def exact_positive_money_value(value):
    """Validate canonical serialized exact MoneyValue; bounded intervals are inadmissible."""
    _shape(value, VALUE_FIELDS)
    _shape(value['exact'], FRACTION_FIELDS)
    numerator, denominator = (_positive_integer(value['exact'][field]) for field in ('numerator', 'denominator'))
    require_tier(gcd(numerator, denominator) == 1, 'Notional fraction must already be canonically reduced.')
    require_tier(type(value['terms']) is int and 1 <= value['terms'] <= 9_007_199_254_740_991,
                 'Notional terms must be a positive safe integer.')
    units, remainder = divmod(numerator * 10 ** 18, denominator)
    lower, upper = _display(units), _display(units + bool(remainder))
    decimal = None if remainder else lower
    precision = 'exact_rational' if remainder else 'exact_decimal'
    require_tier(value['lower'] == lower and value['upper'] == upper and value['decimal'] == decimal
                 and value['precision'] == precision, 'Notional fraction, bounds, decimal and precision disagree.')
    return Fraction(numerator, denominator)


def assert_fx_tier_budget(decision, currency, quantity, mark, spec_price):
    maximum = exact_positive_money_value(decision.get('maximumNotionalValue'))
    require_tier(decision.get('maximumNotionalCurrency') == currency, 'Original notional budget currency changed.')
    require_tier('maximumNotional' in decision and decision['maximumNotional'] == decision['maximumNotionalValue']['decimal'],
                 'Original notional decimal alias differs from its exact value.')
    # All decimal operands retain the existing tier decimal validation. Fraction
    # parses those exact normalized strings without any Decimal context division.
    valuation = max(Fraction(number(mark, positive=True)), Fraction(number(spec_price, positive=True)))
    require_tier(Fraction(number(quantity, positive=True)) * valuation <= maximum,
                 'Current valuation exceeds the original margin/notional budget.')
