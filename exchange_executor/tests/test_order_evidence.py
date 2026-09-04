from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ExchangeContractError
from order_evidence import merge_ccxt_order, merge_order_evidence


class OrderEvidenceTests(unittest.TestCase):
    def test_shared_node_python_fixture_matrix(self):
        fixture_path = Path(__file__).resolve().parents[2] / "tests/fixtures/order_evidence.json"
        for case in json.loads(fixture_path.read_text(encoding="utf-8")):
            with self.subTest(name=case["name"]):
                if case.get("error"):
                    with self.assertRaises(ExchangeContractError):
                        merge_order_evidence(case["current"], case["incoming"])
                else:
                    self.assertEqual(merge_order_evidence(case["current"], case["incoming"]), case["expected"])

    def test_raw_history_keeps_cumulative_execution_and_terminal_state(self):
        order = {"id": "remote", "symbol": "BTC/USDT:USDT", "amount": "1", "status": "canceled", "filled": "0.4", "average": "100"}
        stale = {**order, "status": "open", "filled": "0", "average": None}
        merged = merge_ccxt_order(order, stale)
        self.assertEqual((merged["status"], merged["filled"], merged["average"]), ("canceled", "0.4", "100"))
        for field, value in (("id", "different"), ("symbol", "ETH/USDT:USDT"), ("amount", "2")):
            with self.subTest(field=field), self.assertRaises(ExchangeContractError):
                merge_ccxt_order(order, {**stale, field: value})

    def test_unknown_remote_cumulative_amount_stays_unknown(self):
        order = {"status": "open", "quantity": "1", "filledQuantity": None, "averagePrice": None}
        self.assertIsNone(merge_order_evidence(order, order)["filledQuantity"])


if __name__ == "__main__":
    unittest.main()
