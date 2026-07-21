from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bybit_adapter import BybitAdapter
from common import ExchangeContractError, decimal_string, map_bybit_status, signed_decimal_string
from credentials import CredentialError, CredentialStore
from hyperliquid_adapter import HyperliquidAdapter
from server import Handler


class ContractTests(unittest.TestCase):
    def test_plain_decimals_only(self) -> None:
        self.assertEqual(decimal_string("1.2300", "price", positive=True), "1.23")
        self.assertEqual(signed_decimal_string("-12.3400", "pnl"), "-12.34")
        self.assertEqual(signed_decimal_string("-0", "pnl"), "0")
        with self.assertRaises(ExchangeContractError):
            decimal_string("1e3", "price")
        with self.assertRaises(ExchangeContractError):
            signed_decimal_string("+1", "pnl")
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

    def test_executor_authentication_accepts_factory_reset_token_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "trading").mkdir()
            token_file = root / "exchange_executor_token"
            token_file.write_text("a" * 64 + "\n", encoding="utf-8")
            handler = Handler.__new__(Handler)
            handler.server = SimpleNamespace(application=SimpleNamespace(credentials=CredentialStore(directory)))
            handler.headers = {"Authorization": f"Bearer {'a' * 64}"}
            self.assertTrue(handler._authenticated())
            token_file.write_text("b" * 64 + "\n", encoding="utf-8")
            handler.headers = {"Authorization": f"Bearer {'b' * 64}"}
            self.assertTrue(handler._authenticated(), "The sidecar must accept the rotated token without restart.")

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
    def get_wallet_balance(self, **_kwargs):
        return {
            "retCode": 0,
            "result": {"list": [{
                "totalEquity": "1000.00", "totalAvailableBalance": "800",
                "totalPerpUPL": "-12.5", "totalInitialMargin": "200",
            }]},
        }

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
    def test_account_snapshot_exposes_live_dashboard_finance(self) -> None:
        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: FakeBybitHttp()
        self.assertEqual(adapter.account_snapshot({}), {
            "equity": "1000", "availableBalance": "800",
            "unrealizedPnl": "-12.5", "marginUsed": "200",
        })

    def test_market_metadata_comes_from_official_contract(self) -> None:
        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: FakeBybitHttp()
        snapshot = adapter.market_snapshot({"id": "x", "exchange": "bybit", "mode": "testnet"}, "BTCUSDT")
        self.assertEqual(snapshot["markPrice"], "100.5")
        self.assertEqual(snapshot["quantityStep"], "0.001")
        self.assertEqual(snapshot["maxLeverage"], 50)

    def test_open_state_pagination_is_bounded_and_complete(self) -> None:
        calls: list[str | None] = []

        def page(**kwargs):
            calls.append(kwargs.get("cursor"))
            return {
                "retCode": 0,
                "result": {
                    "list": [{"id": len(calls)}],
                    "nextPageCursor": "next" if len(calls) == 1 else "",
                },
            }

        values = BybitAdapter._all_pages(page, "test pages", category="linear", limit=50)
        self.assertEqual(values, [{"id": 1}, {"id": 2}])
        self.assertEqual(calls, [None, "next"])


class HyperliquidMappingTests(unittest.TestCase):
    def test_account_snapshot_sums_official_position_upl(self) -> None:
        class InfoStub:
            @staticmethod
            def user_state(_address):
                return {
                    "marginSummary": {"accountValue": "1500", "totalMarginUsed": "300"},
                    "withdrawable": "1200",
                    "assetPositions": [
                        {"position": {"unrealizedPnl": "10.25"}},
                        {"position": {"unrealizedPnl": "-4.75"}},
                    ],
                }

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda _account: (InfoStub(), object(), "0xwallet")
        self.assertEqual(adapter.account_snapshot({}), {
            "equity": "1500", "availableBalance": "1200",
            "unrealizedPnl": "5.5", "marginUsed": "300",
        })


if __name__ == "__main__":
    unittest.main()
