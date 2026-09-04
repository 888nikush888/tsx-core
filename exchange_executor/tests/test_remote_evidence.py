from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import _normalized_fill
from remote_evidence import normalize_trades


class RemoteEvidenceTests(unittest.TestCase):
    def test_incomplete_trades_retained_without_invented_ids_or_secrets(self):
        rest = SimpleNamespace(market=lambda _symbol: {"base": "BTC", "contractSize": "1"})
        trade = {"order": "remote-order", "symbol": "BTC/USDT:USDT", "side": "buy", "price": "100",
                 "amount": "1", "timestamp": 123, "fee": {"cost": "0", "currency": "USDT"},
                 "info": {"apiKey": "DO_NOT_SAVE"}, "headers": {"Authorization": "DO_NOT_SAVE"}}
        trades = [{**trade, "id": "real-1"}, {**trade, "id": None}, {**trade, "id": "real-2", "order": None},
                  {**trade, "id": "real-3", "timestamp": None}]
        fills, unresolved = normalize_trades(trades, lambda value: _normalized_fill(rest, {}, value))
        self.assertEqual([fill["exchangeFillId"] for fill in fills], ["real-1"])
        self.assertEqual(len(unresolved), 3)
        self.assertIsNone(unresolved[0]["providerId"])
        self.assertIsNone(unresolved[1]["evidence"]["exchangeOrderId"])
        self.assertIsNone(unresolved[2]["evidence"]["filledAt"])
        self.assertNotIn("DO_NOT_SAVE", json.dumps(unresolved))
        self.assertNotIn("info", unresolved[0]["evidence"])

    def test_distinct_real_trade_ids_with_equal_economics_remain_distinct(self):
        rest = SimpleNamespace(market=lambda _symbol: {"base": "BTC", "contractSize": "1"})
        trade = {"order": "remote-order", "symbol": "BTC/USDT:USDT", "side": "buy", "price": "100",
                 "amount": "1", "timestamp": 123, "fee": {"cost": "0", "currency": "USDT"}}
        fills, unresolved = normalize_trades([{**trade, "id": "a"}, {**trade, "id": "b"}], lambda value: _normalized_fill(rest, {}, value))
        self.assertEqual([fill["exchangeFillId"] for fill in fills], ["a", "b"])
        self.assertEqual(unresolved, [])
