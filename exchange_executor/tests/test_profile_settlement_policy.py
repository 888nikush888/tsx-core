"""Declaration parity with the implemented provider-specific entry boundaries."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_profiles import PROFILES


class ProfileSettlementPolicyTests(unittest.TestCase):
    def test_hyperliquid_declares_only_native_first_dex_usdc(self):
        self.assertEqual(PROFILES['hyperliquid'].settlement_preference, ('USDC',))

    def test_bybit_declares_only_supported_linear_settlements(self):
        self.assertEqual(PROFILES['bybit'].settlement_preference, ('USDT', 'USDC'))

    def test_kraken_declares_only_implemented_pf_usd_units(self):
        self.assertEqual(PROFILES['krakenfutures'].settlement_preference, ('USD',))

    def test_default_settlement_and_execution_policy_are_not_changed(self):
        for exchange, settle in [('hyperliquid', 'USDC'), ('bybit', 'USDT'), ('krakenfutures', 'USD')]:
            with self.subTest(exchange=exchange):
                profile = PROFILES[exchange]
                self.assertEqual(profile.client_options()['defaultSettle'], settle)
                self.assertEqual(profile.default_type, 'swap')
                self.assertEqual(profile.position_mode, 'oneway')
                self.assertEqual(profile.margin_mode, 'cross')
                self.assertEqual(profile.modes, ('testnet', 'live'))
                self.assertEqual(profile.protected_entry_strategy, 'certified_batch')


if __name__ == '__main__':
    unittest.main()
