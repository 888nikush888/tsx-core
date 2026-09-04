"""Exact v2 notional limits; all account and SDK transports are isolated fakes."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from decimal import localcontext
from fractions import Fraction
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import CcxtAdapter
from entry_price_constraints import EntryPriceConstraintError
from leverage_tier_evidence import assert_tier_entry, read_tier_evidence
from leverage_tiers import TierEvidenceError
from test_contracts import FakeRegistry, protected_requests
from test_entry_price_constraints import bounded_orders, rest_fixture
from test_entry_price_sdk import sdk
from test_leverage_tier_evidence import TierRest, deadline, decision

SYMBOL = 'BTC/USDT:USDT'


def money_value(numerator, denominator=1, terms=1):
    fraction = Fraction(numerator, denominator)
    lower, remainder = divmod(fraction.numerator * 10 ** 18, fraction.denominator)
    def display(value):
        digits = str(value).zfill(19)
        return (digits[:-18] + '.' + digits[-18:]).rstrip('0').rstrip('.')
    result = {'lower': display(lower), 'upper': display(lower + bool(remainder)),
        'exact': {'numerator': str(fraction.numerator), 'denominator': str(fraction.denominator)},
        'decimal': None, 'precision': 'exact_rational', 'terms': terms}
    if not remainder:
        result.update(decimal=result['lower'], precision='exact_decimal')
    return result


def version_two(evidence, maximum, quantity='5'):
    return {**decision(evidence, quantity), 'version': 2, 'maximumNotional': maximum.get('decimal'),
        'maximumNotionalCurrency': evidence['currency'], 'maximumNotionalValue': copy.deepcopy(maximum)}


class ExactFxTierTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rest = TierRest()
        self.clients = FakeRegistry(self.rest).clients
        self.market = self.rest.markets[SYMBOL]
        self.evidence = await read_tier_evidence(self.clients, self.market, deadline())

    def check(self, maximum, *, quantity='5', amount='5000', price='100', evidence=None):
        evidence = self.evidence if evidence is None else evidence
        request = {'quantity': quantity, 'leverage': 20, 'leverageTierDecision': version_two(self.evidence, maximum, quantity)}
        assert_tier_entry(self.clients, self.market, request, {'amount': amount, 'price': price}, evidence)

    async def test_v2_exact_decimal_and_fractional_limits_preserve_originals(self):
        for maximum in (money_value(500), money_value(1001, 2), money_value(1501, 3, 4)):
            with self.subTest(maximum=maximum):
                original = copy.deepcopy(maximum)
                self.check(maximum)
                self.assertEqual(maximum, original)

    async def test_mark_and_actual_spec_price_are_both_checked_without_rounding(self):
        maximum = money_value(1000, 3)
        self.check(maximum, quantity='3', amount='3000', price='111.111111111111111111')
        for spec_price, mark in [('111.111111111111111112', '100'), ('100', '111.111111111111111112')]:
            with self.subTest(spec_price=spec_price, mark=mark), self.assertRaisesRegex(TierEvidenceError, 'budget'):
                self.check(maximum, quantity='3', amount='3000', price=spec_price, evidence={**self.evidence, 'markPrice': mark})

    async def test_tiny_nonzero_maximum_is_never_replaced_by_its_zero_lower_bound(self):
        tiny = '0.000000000000000001'
        evidence = {**self.evidence, 'markPrice': tiny}
        self.check(money_value(1, 10 ** 36), quantity=tiny, amount='0.000000000000001', price=tiny, evidence=evidence)
        with self.assertRaisesRegex(TierEvidenceError, 'budget'):
            self.check(money_value(1, 10 ** 36 + 1), quantity=tiny, amount='0.000000000000001', price=tiny, evidence=evidence)

    async def test_256_digit_difference_survives_small_or_default_decimal_contexts(self):
        below = money_value(500 * 10 ** 252 - 1, 10 ** 252)
        for precision in (2, 28, 180):
            with self.subTest(precision=precision), localcontext() as context:
                context.prec = precision
                self.check(money_value(500 * 10 ** 252 + 1, 10 ** 252))
                with self.assertRaisesRegex(TierEvidenceError, 'budget'):
                    self.check(below)

    async def test_canonical_coefficients_and_output_limits_are_not_relaxed(self):
        self.check(money_value(10 ** 255 + 1, 10 ** 252, 9_007_199_254_740_991))
        self.check(money_value(10 ** 36 - 1))
        invalid = [money_value(10 ** 256 + 1, 10 ** 253), money_value(1, 10 ** 256),
            money_value(10 ** 36), money_value(10 ** 55 - 1, 10 ** 19),
            {**money_value(500), 'exact': {'numerator': '1000', 'denominator': '2'}},
            {**money_value(500), 'exact': {'numerator': '0500', 'denominator': '1'}},
            {**money_value(500), 'exact': {'numerator': '+500', 'denominator': '1'}},
            {**money_value(500), 'exact': {'numerator': '500', 'denominator': '0'}},
            {**money_value(500), 'exact': {'numerator': '500', 'denominator': '-1'}},
            {**money_value(500), 'exact': {'numerator': '500', 'denominator': '１'}},
            {**money_value(500), 'exact': {'numerator': '0', 'denominator': '1'}}]
        for maximum in invalid:
            with self.subTest(maximum=maximum), self.assertRaises(TierEvidenceError):
                self.check(maximum)

    async def test_forged_bounds_decimal_precision_terms_and_bounded_values_are_rejected(self):
        source = money_value(1501, 3)
        edits = [{'lower': '500.333333333333333334'}, {'upper': '500.333333333333333333'},
            {'decimal': '500.333333333333333333'}, {'precision': 'exact_decimal'}, {'precision': 'bounded'},
            {'terms': 0}, {'terms': True}, {'terms': 1.5}, {'terms': 9_007_199_254_740_992},
            {'extra': 'unbound'}, {'exact': None}, {'exact': {**source['exact'], 'extra': 1}}]
        for edit in edits:
            with self.subTest(edit=edit), self.assertRaises(TierEvidenceError):
                self.check({**source, **edit})
        for field in source:
            incomplete = copy.deepcopy(source)
            incomplete.pop(field)
            with self.subTest(missing=field), self.assertRaises(TierEvidenceError):
                self.check(incomplete)

    async def test_exact_alias_and_currency_are_required_without_usd_parity(self):
        for edit in ({'maximumNotionalCurrency': 'USD'}, {'maximumNotionalCurrency': None},
                     {'maximumNotional': '500.0'}, {'maximumNotional': None}, {'maximumNotional': 500}):
            original = version_two(self.evidence, money_value(500))
            request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': {**original, **edit}}
            with self.subTest(edit=edit), self.assertRaises(TierEvidenceError):
                assert_tier_entry(self.clients, self.market, request, {'amount': '5000', 'price': '100'}, self.evidence)
        request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': version_two(self.evidence, money_value(1501, 3))}
        request['leverageTierDecision'].pop('maximumNotional')
        with self.assertRaises(TierEvidenceError):
            assert_tier_entry(self.clients, self.market, request, {'amount': '5000', 'price': '100'}, self.evidence)

    async def test_v2_preserves_freshness_account_scope_tier_and_sdk_quantity_fences(self):
        maximum = money_value(600)
        for changed in ({'credentialGeneration': 'f' * 64}, {'contractSize': '1'},
                        {'observedAt': self.evidence['observedAt'] - 10000},
                        {'scope': {'complete': True, 'positionQuantity': '0.001', 'openOrderCount': 0}},
                        {'markPrice': '200'}):
            with self.subTest(changed=changed), self.assertRaises(TierEvidenceError):
                self.check(maximum, evidence={**self.evidence, **changed})
        with self.assertRaisesRegex(TierEvidenceError, 'rounding'):
            self.check(maximum, amount='4999')

    async def test_v1_stays_unchanged_and_does_not_require_new_currency_fields(self):
        request = {'quantity': '5', 'leverage': 20, 'leverageTierDecision': decision(self.evidence)}
        assert_tier_entry(self.clients, self.market, request, {'amount': '5000', 'price': '100'}, self.evidence)
        with self.assertRaisesRegex(TierEvidenceError, 'budget'):
            assert_tier_entry(self.clients, self.market, request, {'amount': '5000', 'price': '100'}, {**self.evidence, 'markPrice': '121'})

    async def sdk_fixture(self, quantity='5', amount_precision=0.001):
        real = sdk('bybit')
        self.addAsyncCleanup(real.close)
        real.apiKey, real.secret, real.enableRateLimit = 'isolated-key', 'isolated-secret', False
        real.markets[SYMBOL]['contractSize'] = 0.001
        real.markets[SYMBOL]['precision']['amount'] = amount_precision
        fake = rest_fixture()
        fake.markets[SYMBOL]['contractSize'] = '0.001'
        fake.amount_to_precision, fake.price_to_precision = real.amount_to_precision, real.price_to_precision
        registry = FakeRegistry(fake)
        evidence = await read_tier_evidence(registry.clients, fake.markets[SYMBOL], deadline())
        request = protected_requests()[0]
        request.update(quantity=quantity, price='100', leverageTierDecision=version_two(evidence, money_value(1501, 3), quantity))
        return real, fake, registry, request

    async def test_actual_sdk_quantity_validated_in_spec_reaches_the_signed_batch_unchanged(self):
        real, fake, registry, request = await self.sdk_fixture()
        original = copy.deepcopy(request)
        spec, _market = await CcxtAdapter(registry)._order_spec(registry.clients, request, deadline())
        self.assertEqual(spec['amount'], '5000')
        real.is_unified_enabled = AsyncMock(return_value=[False, True])
        real.fetch = AsyncMock(return_value={'retCode': 0, 'retMsg': 'OK', 'result': {'list': []}, 'retExtInfo': {'list': []}})
        await real.create_orders([copy.deepcopy(spec)])
        url, method, headers, body = real.fetch.await_args.args
        self.assertTrue(url.endswith('/v5/order/create-batch'))
        self.assertEqual(method, 'POST')
        self.assertIn('X-BAPI-SIGN', headers)
        wire = json.loads(body)['request'][0]
        self.assertEqual((wire['qty'], wire['price']), ('5000', '100'))
        self.assertEqual(real.fetch.await_count, 1)
        self.assertEqual(request, original)
        self.assertEqual(fake.leverage, [])

    async def test_actual_sdk_rounding_blocks_before_any_setter_or_batch(self):
        real, fake, registry, request = await self.sdk_fixture('5.0005', 1)
        with self.assertRaisesRegex(TierEvidenceError, 'rounding'):
            await CcxtAdapter(registry)._order_spec(registry.clients, request, deadline())
        real.fetch.assert_not_awaited()
        self.assertEqual(fake.leverage, [])

    async def test_v2_is_not_a_kraken_protected_profile_grant(self):
        fake = rest_fixture()
        registry = FakeRegistry(fake, 'krakenfutures')
        entry, stop = bounded_orders(exchange='krakenfutures')
        entry['leverageTierDecision'].update(version=2, maximumNotional='1000000', maximumNotionalCurrency='USD',
                                            maximumNotionalValue=money_value(1000000))
        with self.assertRaisesRegex(EntryPriceConstraintError, 'batch support is not proven'):
            await CcxtAdapter(registry).submit_protected_entry(registry.clients.account, entry, stop, deadline())
        self.assertEqual((fake.created_batches, fake.leverage), ([], []))


if __name__ == '__main__':
    unittest.main()
