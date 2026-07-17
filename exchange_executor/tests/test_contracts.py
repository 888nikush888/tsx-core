from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bybit_adapter import BybitAdapter
from common import ExchangeContractError, decimal_string, map_bybit_status
from credentials import CredentialError, CredentialStore
from hyperliquid_adapter import HyperliquidAdapter


class ContractTests(unittest.TestCase):
    def test_plain_decimals_only(self) -> None:
        self.assertEqual(decimal_string("1.2300", "price", positive=True), "1.23")
        with self.assertRaises(ExchangeContractError):
            decimal_string("1e3", "price")
        with self.assertRaises(ExchangeContractError):
            decimal_string("0", "price", positive=True)

    def test_status_mapping_is_fail_closed(self) -> None:
        self.assertEqual(map_bybit_status("Filled"), "filled")
        self.assertEqual(map_bybit_status("FutureStatus"), "unknown")

    def test_credential_file_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "trading").mkdir()
            (root / "exchange_executor_token").write_text("a" * 64 + "\n", encoding="utf-8")
            account_id = "11111111-1111-4111-8111-111111111111"
            (root / "trading" / f"{account_id}.json").write_text(
                json.dumps({
                    "version": 1,
                    "accountId": account_id,
                    "exchange": "bybit",
                    "apiKey": "bybit-key-123",
                    "apiSecret": "bybit-secret-123",
                    "updatedAt": 1,
                }),
                encoding="utf-8",
            )
            store = CredentialStore(directory)
            self.assertEqual(store.token(), "a" * 64)
            self.assertEqual(store.account(account_id, "bybit")["apiKey"], "bybit-key-123")
            with self.assertRaises(CredentialError):
                store.account(account_id, "hyperliquid")

    def test_hyperliquid_official_response_mapping(self) -> None:
        resting = HyperliquidAdapter._order_result(
            "0x" + "1" * 32,
            {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": 42}}]}}},
        )
        self.assertEqual(resting["status"], "open")
        self.assertEqual(resting["exchangeOrderId"], "42")
        filled = HyperliquidAdapter._order_result(
            "0x" + "2" * 32,
            {"status": "ok", "response": {"data": {"statuses": [{"filled": {"oid": 43, "totalSz": "1.25", "avgPx": "10"}}]}}},
        )
        self.assertEqual(filled["status"], "filled")
        self.assertEqual(filled["filledQuantity"], "1.25")


class FakeBybitHttp:
    def get_instruments_info(self, **_kwargs):
        return {
            "retCode": 0,
            "result": {"list": [{
                "lotSizeFilter": {"qtyStep": "0.001", "minOrderQty": "0.001", "minNotionalValue": "5"},
                "priceFilter": {"tickSize": "0.1"},
                "leverageFilter": {"maxLeverage": "50"},
            }]},
        }

    def get_tickers(self, **_kwargs):
        return {"retCode": 0, "result": {"list": [{"markPrice": "100.5"}]}}


class BybitMappingTests(unittest.TestCase):
    def test_market_metadata_comes_from_official_contract(self) -> None:
        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: FakeBybitHttp()
        snapshot = adapter.market_snapshot({"id": "x", "exchange": "bybit", "mode": "testnet"}, "BTCUSDT")
        self.assertEqual(snapshot["markPrice"], "100.5")
        self.assertEqual(snapshot["quantityStep"], "0.001")
        self.assertEqual(snapshot["maxLeverage"], 50)


if __name__ == "__main__":
    unittest.main()
