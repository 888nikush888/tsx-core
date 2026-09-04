from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ccxt_adapter import _normalized_fill, _normalized_position
from common import ExchangeContractError


class FillAccountingTests(unittest.TestCase):
    def test_position_mark_and_settlement_are_actual_metadata(self):
        rest = SimpleNamespace(market=lambda _: {"base": "BTC", "symbol": "BTC/USDT:USDT",
                                                "contractSize": "1", "linear": True, "settle": "USDT"})
        position = {"symbol": "BTC/USDT:USDT", "side": "long", "contracts": "2", "entryPrice": "100", "unrealizedPnl": "-10"}
        self.assertIsNone(_normalized_position(rest, position)["markPrice"])
        position["markPrice"] = "95"
        result = _normalized_position(rest, position)
        self.assertEqual(result["markPrice"], "95")
        self.assertEqual(result["accounting"]["settlementAsset"], "USDT")
        position.pop("unrealizedPnl")
        self.assertIsNone(_normalized_position(rest, position)["unrealizedPnl"])

    def test_fee_missing_is_not_zero(self):
        rest = SimpleNamespace(market=lambda _: {"base": "BTC", "contractSize": "1"})
        for fee in (None, {}, {"cost": None}, {"currency": "USDT"}):
            with self.subTest(fee=fee), self.assertRaises(ExchangeContractError):
                _normalized_fill(rest, {}, {"id": "1", "order": "2", "symbol": "BTC/USDT:USDT",
                                           "timestamp": 1, "amount": "1", "price": "100", "fee": fee})

    def test_actual_linear_settlement_not_fee_asset(self):
        market = {"base": "BTC", "symbol": "BTC/USDT:USDT", "contractSize": "0.01", "linear": True, "settle": "USDT"}
        rest = SimpleNamespace(market=lambda _: market)
        trade = {"id": "1", "order": "2", "symbol": market["symbol"], "timestamp": 1,
                 "amount": "3", "price": "100", "fee": {"cost": "-0.1", "currency": "BNB"}}
        result = _normalized_fill(rest, {}, trade)
        self.assertEqual(result["quantity"], "0.03")
        self.assertEqual(result["accounting"]["settlementAsset"], "USDT")
        self.assertEqual(result["accounting"]["quantityUnit"], "base")
        self.assertEqual(result["fee"], "-0.1")
        market["linear"] = False
        self.assertIsNone(_normalized_fill(rest, {}, trade)["accounting"])


if __name__ == "__main__":
    unittest.main()
