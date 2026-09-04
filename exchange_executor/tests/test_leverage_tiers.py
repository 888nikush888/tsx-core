from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from leverage_tiers import TierEvidenceError, assert_quantity_tier, normalize_bybit_tiers, normalize_hyperliquid_tiers, normalize_kraken_tiers


class TierNormalizationTests(unittest.TestCase):
    def test_bybit_complete_ranges_and_boundaries(self):
        tiers = normalize_bybit_tiers([
            {'id': 1, 'symbol': 'BTCUSDT', 'riskLimitValue': '1000', 'maxLeverage': '50', 'isLowestRisk': 1},
            {'id': 2, 'symbol': 'BTCUSDT', 'riskLimitValue': '5000', 'maxLeverage': '10', 'isLowestRisk': 0},
        ], 'BTCUSDT')
        assert_quantity_tier(tiers, '9.999999999999999999', '100', 50)
        with self.assertRaises(TierEvidenceError):
            assert_quantity_tier(tiers, '10', '100', 50)
        assert_quantity_tier(tiers, '10', '100', 10)
        with self.assertRaises(TierEvidenceError):
            assert_quantity_tier(tiers, '50', '100', 10)

    def test_hyperliquid_implicit_small_id_and_explicit_table(self):
        self.assertEqual(normalize_hyperliquid_tiers({'marginTableId': 20, 'maxLeverage': 20}, []),
                         [{'lowerBound': '0', 'upperBound': None, 'maxLeverage': 20}])
        tiers = normalize_hyperliquid_tiers({'marginTableId': 51, 'maxLeverage': 10},
            [[51, {'marginTiers': [{'lowerBound': '0', 'maxLeverage': 10}, {'lowerBound': '3000000', 'maxLeverage': 5}]}]])
        self.assertEqual(tiers[1]['maxLeverage'], 5)
        for asset in ({'maxLeverage': 50}, {'marginTableId': 50, 'maxLeverage': 50}):
            with self.assertRaises(TierEvidenceError):
                normalize_hyperliquid_tiers(asset, [])

    def test_kraken_account_schedule_not_public_professional_guess(self):
        tiers = normalize_kraken_tiers([
            {'numNonContractUnits': '0', 'initialMargin': '0.02'},
            {'numNonContractUnits': '100000', 'initialMargin': '0.03'},
        ])
        self.assertEqual([row['maxLeverage'] for row in tiers], [50, 33])
        with self.assertRaises(TierEvidenceError):
            normalize_kraken_tiers([{'contracts': '0', 'initialMargin': '0.02'}])

    def test_missing_duplicate_gapped_or_increasing_tiers_fail(self):
        rows = [{'id': 1, 'symbol': 'BTCUSDT', 'riskLimitValue': '1000', 'maxLeverage': '10', 'isLowestRisk': 1}]
        for invalid in ([], rows + rows, [{**rows[0], 'symbol': 'ETHUSDT'}],
                        [{**rows[0], 'isLowestRisk': 0}],
                        rows + [{**rows[0], 'id': 3, 'riskLimitValue': '2000', 'maxLeverage': '20', 'isLowestRisk': 0}]):
            with self.assertRaises(TierEvidenceError):
                normalize_bybit_tiers(invalid, 'BTCUSDT')
