"""Provider numbers stay ASCII and retain their original spelling boundaries."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bybit_account_mode import _time, _uid
from common import DECIMAL_PATTERN, SIGNED_DECIMAL_PATTERN, ExchangeContractError
from current_state import _provider_time
from execution_constraints import _leverage
from fill_identity import _numeric_id
from fx_tier_budget import _positive_integer
from kucoin_contracts import _ORIGINAL_NUMBER
from kucoin_history import _large_integer, _state
from kucoin_money import _offset, _window
from kucoin_provider_common import exact_integer


NON_ASCII_DIGITS = ('\u0661', '\uff11', '\U0001d7d9', '\u0967')


class NumericSyntaxTests(unittest.TestCase):
    def test_decimal_precision_and_sign_syntax_are_unchanged(self):
        maximum = '9' * 36 + '.' + '9' * 18
        for text in ('0', '1', '0.000000000000000001', maximum):
            with self.subTest(text=text):
                self.assertIsNotNone(DECIMAL_PATTERN.fullmatch(text))
                self.assertIsNotNone(SIGNED_DECIMAL_PATTERN.fullmatch('-' + text))
        for text in ('01', '+1', '1.', '.1', '1e2', '1_000', '9' * 37, '0.' + '1' * 19, '1\n'):
            with self.subTest(text=text):
                self.assertIsNone(DECIMAL_PATTERN.fullmatch(text))
                self.assertIsNone(SIGNED_DECIMAL_PATTERN.fullmatch(text))
        for digit in NON_ASCII_DIGITS:
            for text in (digit, '1' + digit, '1.' + digit):
                with self.subTest(text=text):
                    self.assertIsNone(DECIMAL_PATTERN.fullmatch(text))
                    self.assertIsNone(SIGNED_DECIMAL_PATTERN.fullmatch('-' + text))

    def test_original_provider_exponents_remain_separate_from_canonical_decimals(self):
        for text in ('1.000E-3', '1E1', '2.000', '1e+20', '0.10000'):
            self.assertIsNotNone(_ORIGINAL_NUMBER.fullmatch(text))
        for text in ('01', '+1', '1.', '.1', '-1', 'NaN', '1_000'):
            self.assertIsNone(_ORIGINAL_NUMBER.fullmatch(text))
        for digit in NON_ASCII_DIGITS:
            for text in ('1' + digit, '1.' + digit, '1e' + digit):
                self.assertIsNone(_ORIGINAL_NUMBER.fullmatch(text))

    def test_account_identity_and_provider_times_do_not_accept_unicode_digits(self):
        self.assertEqual(_uid('0'), '0')
        self.assertEqual(_uid('9' * 32), '9' * 32)
        self.assertEqual(_time('0001'), 1)
        with patch('current_state.now_ms', return_value=1):
            self.assertIsNone(_provider_time('0001', 'orders'))
            for digit in NON_ASCII_DIGITS:
                for text in (digit, '1' + digit):
                    with self.subTest(text=text):
                        with self.assertRaises(ExchangeContractError):
                            _uid(text)
                        with self.assertRaises(ExchangeContractError):
                            _time(text)
                        with self.assertRaises(ExchangeContractError):
                            _provider_time(text, 'orders')
        for text in ('01', '9' * 33):
            with self.assertRaises(ExchangeContractError):
                _uid(text)

    def test_fill_ids_keep_leading_zeroes_but_leverage_requires_a_positive_integer(self):
        self.assertEqual(_numeric_id('0' * 256), '0' * 256)
        self.assertIsNone(_numeric_id('1' * 257))
        self.assertIsNone(_numeric_id(True))
        self.assertEqual(_leverage('9999.00'), 9999)
        for text in ('0', '01', '1.1', '10000', '+1'):
            with self.assertRaises(ExchangeContractError):
                _leverage(text)
        for digit in NON_ASCII_DIGITS:
            text = '1' + digit
            self.assertIsNone(_numeric_id(text))
            with self.assertRaises(ExchangeContractError):
                _leverage(text)

    def test_integer_and_notional_boundaries_keep_the_original_exact_range(self):
        maximum = '9' * 20
        self.assertEqual(_large_integer(maximum, 'time'), int(maximum))
        self.assertEqual(_offset(maximum, 'offset'), maximum)
        self.assertEqual(exact_integer('9007199254740991', 'time'), 9_007_199_254_740_991)
        self.assertEqual(_positive_integer('9' * 256), int('9' * 256))
        for text in ('01', '+1', '1.0', '1e1', *('1' + digit for digit in NON_ASCII_DIGITS)):
            with self.subTest(text=text):
                with self.assertRaises(ExchangeContractError):
                    _large_integer(text, 'time')
                with self.assertRaises(ExchangeContractError):
                    _offset(text, 'offset')
                with self.assertRaises(ExchangeContractError):
                    exact_integer(text, 'time')
                with self.assertRaises(ExchangeContractError):
                    _positive_integer(text)
        for text in ('0', '9' * 257):
            with self.assertRaises(ExchangeContractError):
                _positive_integer(text)

    def test_history_and_money_cursors_preserve_distinct_leading_zero_rules(self):
        history = {'source': 'orders', 'providerAccountUid': 'fixture-uid', 'baselineSince': 0,
                   'windowSince': 0, 'windowUntil': 1, 'cursor': '1:0002'}
        money = {'windowSince': 0, 'windowUntil': 1, 'cursor': '0001'}
        self.assertEqual(_state(history, 'fixture-uid')['cursor'], '1:0002')
        self.assertEqual(_window(money, maximum_width=1), (0, 1, '0001'))
        for text in ('01', '1:' + '9' * 10, *('1:' + digit for digit in NON_ASCII_DIGITS)):
            invalid = {**history, 'cursor': text}
            with self.assertRaises(ExchangeContractError):
                _state(invalid, 'fixture-uid')
        for text in ('9' * 17, '+1', *NON_ASCII_DIGITS):
            invalid = {**money, 'cursor': text}
            with self.assertRaises(ExchangeContractError):
                _window(invalid, maximum_width=1)


if __name__ == '__main__':
    unittest.main()
