from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bybit_adapter import BybitAdapter
from common import (
    ExchangeContractError,
    RequestDeadline,
    decimal_string,
    external_account_cache_key,
    external_account_id,
    map_bybit_status,
    optional_positive_decimal_string,
    signed_decimal_string,
)
from credentials import CredentialError, CredentialStore
from hyperliquid_adapter import HyperliquidAdapter
from server import Handler, executor_error_code
from stream_hub import AccountStream, _canonical_payload, _event_type, _symbol


class ContractTests(unittest.TestCase):
    def test_executor_failures_have_stable_secret_free_endpoint_codes(self) -> None:
        self.assertEqual(executor_error_code("/v1/stream-events"), "STREAM_POLL_FAILED")
        self.assertEqual(executor_error_code("/v1/open-state"), "OPEN_STATE_FAILED")
        self.assertEqual(executor_error_code("/unknown"), "EXECUTOR_REQUEST_FAILED")

    def test_websocket_events_are_normalized_and_cursor_gaps_fail_safe(self) -> None:
        stream = AccountStream(
            {"id": "account-stream", "exchange": "bybit", "mode": "testnet"},
            {"apiKey": "test-key", "apiSecret": "test-secret"},
            "a" * 64,
        )
        message = {
            "topic": "execution",
            "creationTime": 1_700_000_000_000,
            "data": [{"symbol": "BTCUSDT", "execId": "fill-1", "seq": 7}],
        }
        stream._ingest("execution", message)
        stream._ingest("execution", message)
        batch = stream.poll(0)
        self.assertEqual([event["cursor"] for event in batch["events"]], [1, 2])
        self.assertEqual(batch["events"][0]["eventKey"], batch["events"][1]["eventKey"])
        self.assertEqual(batch["events"][0]["eventType"], "execution")
        self.assertEqual(batch["events"][0]["symbol"], "BTCUSDT")
        self.assertTrue(stream.poll(99)["gap"])
        self.assertEqual(_event_type("orderUpdates"), "order")
        self.assertEqual(_event_type("webData2"), "position")
        self.assertEqual(_symbol("hyperliquid", "ETH"), "ETHUSDC")
        truncated, digest = _canonical_payload({"value": "x" * (70 * 1024)})
        self.assertTrue(truncated["truncated"])
        self.assertEqual(truncated["sha256"], digest)

    def test_stream_subscription_failure_is_degraded_and_never_escapes_poll(self) -> None:
        class WebSocketConnectionClosedException(Exception):
            pass

        class ClosedPublicClient:
            def __init__(self) -> None:
                self.closed = False

            @staticmethod
            def subscribe(*_args, **_kwargs):
                raise WebSocketConnectionClosedException("provider details must not escape")

            def exit(self) -> None:
                self.closed = True

        stream = AccountStream(
            {"id": "account-stream", "exchange": "hyperliquid", "mode": "testnet"},
            {"walletAddress": "0x" + "1" * 40},
            "b" * 64,
        )
        client = ClosedPublicClient()
        stream._status = "healthy"
        stream._started_at = 1
        stream._clients = [client]
        stream._public_client = client

        stream.ensure_started(["ETHUSDT"])

        health = stream.poll(0)["health"]
        self.assertEqual(health["status"], "degraded")
        self.assertEqual(
            health["lastError"],
            "STREAM_SUBSCRIBE_FAILED: WebSocketConnectionClosedException",
        )
        self.assertNotIn("provider details", health["lastError"])
        self.assertIsNone(health["startedAt"])
        self.assertTrue(client.closed)
        self.assertGreater(stream._next_retry_at, time.monotonic())

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
        self.assertIsNone(optional_positive_decimal_string("0.0", "triggerPx"))
        self.assertEqual(optional_positive_decimal_string("1450.0", "triggerPx"), "1450")

    def test_status_mapping_is_fail_closed(self) -> None:
        self.assertEqual(map_bybit_status("Filled"), "filled")
        self.assertEqual(map_bybit_status("FutureStatus"), "unknown")

    def test_secret_account_cache_keys_are_keyed_and_domain_separated(self) -> None:
        first = external_account_cache_key("bybit-key", "mainnet", "high-entropy-api-key")
        self.assertEqual(first, external_account_cache_key("bybit-key", "mainnet", "high-entropy-api-key"))
        self.assertNotEqual(first, external_account_cache_key("bybit-key", "testnet", "high-entropy-api-key"))
        self.assertNotIn("high-entropy-api-key", first)
        with self.assertRaises(ExchangeContractError):
            external_account_cache_key("bybit-key", "mainnet", "")

    def test_external_account_ids_are_keyed_and_domain_separated(self) -> None:
        first = external_account_id("bybit", "mainnet", "public-account-123")
        self.assertEqual(first, external_account_id("bybit", "mainnet", "public-account-123"))
        self.assertNotEqual(first, external_account_id("bybit", "testnet", "public-account-123"))
        self.assertNotIn("public-account-123", first)
        with self.assertRaises(ExchangeContractError):
            external_account_id("bybit", "mainnet", "")

    def test_executor_deadline_is_bounded_and_fail_closed(self) -> None:
        deadline = RequestDeadline.from_payload({"deadlineAt": int(time.time() * 1000) + 2_000})
        self.assertGreater(deadline.remaining_ms(), 0)
        expired_deadline = {"deadlineAt": int(time.time() * 1000) - 1}
        with self.assertRaises(ExchangeContractError):
            RequestDeadline.from_payload(expired_deadline)
        excessive_deadline = {"deadlineAt": int(time.time() * 1000) + 60_000}
        with self.assertRaises(ExchangeContractError):
            RequestDeadline.from_payload(excessive_deadline)

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
    def get_api_key_information(self):
        return {"retCode": 0, "result": {"userID": "stable-subaccount-42"}}

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

    def get_transaction_log(self, **_kwargs):
        return {
            "retCode": 0,
            "result": {
                "list": [{"funding": "-1.25"}, {"funding": "0.20"}],
                "nextPageCursor": "",
            },
        }


class BybitMappingTests(unittest.TestCase):
    def test_verification_returns_stable_pseudonymous_account_identity(self) -> None:
        class CredentialsStub:
            @staticmethod
            def account(_account_id, _exchange):
                return {"apiKey": "rotatable-api-key", "apiSecret": "secret"}

        adapter = BybitAdapter(CredentialsStub())
        adapter._client = lambda _account: FakeBybitHttp()
        result = adapter.verify({"id": "local", "mode": "testnet"})
        self.assertRegex(result["externalAccountId"], r"^[a-f0-9]{64}$")
        self.assertEqual(result["accountFingerprint"], result["externalAccountId"])

    def test_account_snapshot_exposes_live_dashboard_finance(self) -> None:
        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: FakeBybitHttp()
        self.assertEqual(adapter.account_snapshot({}), {
            "equity": "1000", "availableBalance": "800",
            "unrealizedPnl": "-12.5", "marginUsed": "200", "fundingPnlToday": "-1.05",
        })

    def test_market_metadata_comes_from_official_contract(self) -> None:
        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: FakeBybitHttp()
        snapshot = adapter.market_snapshot({"id": "x", "exchange": "bybit", "mode": "testnet"}, "BTCUSDT")
        self.assertEqual(snapshot["markPrice"], "100.5")
        self.assertEqual(snapshot["quantityStep"], "0.001")
        self.assertEqual(snapshot["maxLeverage"], 50)

    def test_market_entry_carries_provider_side_slippage_guard(self) -> None:
        captured: dict[str, object] = {}

        class OrderClient:
            @staticmethod
            def set_leverage(**_kwargs):
                return {"retCode": 0}

            @staticmethod
            def place_order(**kwargs):
                captured.update(kwargs)
                return {"retCode": 10001, "retMsg": "test rejection"}

        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: OrderClient()
        result = adapter.submit_order({}, {
            "symbol": "BTCUSDT", "role": "entry", "leverage": 2,
            "side": "buy", "orderType": "market", "quantity": "0.1",
            "clientOrderId": "0x" + "1" * 32, "reduceOnly": False,
            "maxSlippagePercent": "0.5",
        })
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(captured["slippageToleranceType"], "Percent")
        self.assertEqual(captured["slippageTolerance"], "0.5")

    def test_protected_entry_attaches_stop_in_the_same_provider_request(self) -> None:
        captured: dict[str, object] = {}

        class OrderClient:
            @staticmethod
            def set_leverage(**_kwargs):
                return {"retCode": 0}

            @staticmethod
            def place_order(**kwargs):
                captured.update(kwargs)
                return {"retCode": 10001, "retMsg": "intentional test rejection"}

        adapter = BybitAdapter.__new__(BybitAdapter)
        adapter._client = lambda _account: OrderClient()
        entry = {
            "accountId": "account", "symbol": "BTCUSDT", "role": "entry", "leverage": 2,
            "side": "buy", "orderType": "limit", "quantity": "0.1", "price": "100",
            "clientOrderId": "0x" + "1" * 32, "reduceOnly": False,
        }
        stop = {
            "accountId": "account", "symbol": "BTCUSDT", "role": "stop_loss", "leverage": 2,
            "side": "sell", "orderType": "stop_market", "quantity": "0.1", "triggerPrice": "95",
            "clientOrderId": "0x" + "2" * 32, "reduceOnly": True,
        }
        result = adapter.submit_protected_entry({}, entry, stop)
        self.assertEqual(result["entry"]["status"], "rejected")
        self.assertEqual(result["protectiveStop"]["status"], "cancelled")
        self.assertEqual(captured["stopLoss"], "95")
        self.assertEqual(captured["slOrderType"], "Market")
        self.assertEqual(captured["slTriggerBy"], "MarkPrice")

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

            @staticmethod
            def user_funding_history(_address, _start_time, _end_time):
                return [
                    {"delta": {"usdc": "-2.5"}, "time": 1},
                    {"delta": {"usdc": "0.5"}, "time": 2},
                ]

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda _account: (InfoStub(), object(), "0xwallet")
        self.assertEqual(adapter.account_snapshot({}), {
            "equity": "1500", "availableBalance": "1200",
            "unrealizedPnl": "5.5", "marginUsed": "300", "fundingPnlToday": "-2",
        })

    def test_open_state_uses_latest_history_status_and_accepts_zero_trigger_sentinel(self) -> None:
        cloid = "0x" + "1" * 32

        class InfoStub:
            @staticmethod
            def frontend_open_orders(_address):
                return []

            @staticmethod
            def historical_orders(_address):
                order = {
                    "coin": "ETH", "side": "B", "limitPx": "1657.8", "triggerPx": "0.0",
                    "origSz": "1", "sz": "0", "oid": 42, "cloid": cloid, "reduceOnly": False,
                }
                return [
                    {"order": order, "status": "filled", "statusTimestamp": 200},
                    {"order": {**order, "sz": "1"}, "status": "open", "statusTimestamp": 100},
                ]

            @staticmethod
            def user_fills(_address):
                return []

            @staticmethod
            def user_state(_address):
                return {"assetPositions": []}

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda _account: (InfoStub(), object(), "0xwallet")
        state = adapter.open_state({"mode": "testnet"})
        self.assertEqual(len(state["orders"]), 1)
        self.assertEqual(state["orders"][0]["status"], "filled")
        self.assertIsNone(state["orders"][0]["triggerPrice"])
        self.assertRegex(state["accountFingerprint"], r"^[a-f0-9]{64}$")

    def test_open_state_retries_transient_official_sdk_failures(self) -> None:
        attempts = 0

        class InfoStub:
            @staticmethod
            def frontend_open_orders(_address):
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    raise RuntimeError("simulated transient official SDK server error")
                return []

            @staticmethod
            def historical_orders(_address):
                return []

            @staticmethod
            def user_fills(_address):
                return []

            @staticmethod
            def user_state(_address):
                return {"assetPositions": []}

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda _account: (InfoStub(), object(), "0xwallet")
        state = adapter.open_state({"mode": "testnet"})
        self.assertEqual(attempts, 3)
        self.assertEqual(state["orders"], [])
        self.assertEqual(state["positions"], [])

    def test_open_state_preserves_protective_stop_fields_from_frontend_orders(self) -> None:
        cloid = "0x" + "3" * 32

        class InfoStub:
            @staticmethod
            def open_orders(_address):
                raise AssertionError("The basic openOrders response omits protective-stop fields.")

            @staticmethod
            def frontend_open_orders(_address):
                return [{
                    "coin": "BTC", "side": "A", "limitPx": "74000", "triggerPx": "74000",
                    "origSz": "0.00322", "sz": "0.00322", "oid": 44, "cloid": cloid,
                    "reduceOnly": True, "isTrigger": True, "orderType": "Stop Market",
                }]

            @staticmethod
            def historical_orders(_address):
                return []

            @staticmethod
            def user_fills(_address):
                return []

            @staticmethod
            def user_state(_address):
                return {"assetPositions": []}

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda _account: (InfoStub(), object(), "0xwallet")
        state = adapter.open_state({"mode": "testnet"})
        self.assertEqual(len(state["orders"]), 1)
        self.assertEqual(state["orders"][0]["status"], "open")
        self.assertEqual(state["orders"][0]["triggerPrice"], "74000")
        self.assertTrue(state["orders"][0]["reduceOnly"])

    def test_current_open_order_overrides_terminal_history_and_unknown_status_fails_closed(self) -> None:
        order = {
            "coin": "ETH", "side": "A", "limitPx": "1500", "triggerPx": "0",
            "origSz": "1", "sz": "1", "oid": 43, "cloid": None, "reduceOnly": False,
        }
        latest = HyperliquidAdapter._latest_orders(
            [{"order": order, "status": "filled", "statusTimestamp": 200}],
            [order],
        )
        self.assertEqual(latest["oid:43"]["status"], "open")
        self.assertEqual(HyperliquidAdapter._map_order_status("badAloPxRejected"), "rejected")
        self.assertEqual(HyperliquidAdapter._map_order_status("futureStatus"), "unknown")

    def test_protected_entry_uses_one_grouped_bulk_request(self) -> None:
        captured: dict[str, object] = {}

        class InfoStub:
            pass

        class ExchangeStub:
            @staticmethod
            def update_leverage(*_args, **_kwargs):
                return {"status": "ok"}

            @staticmethod
            def bulk_orders(orders, grouping="na"):
                captured["orders"] = orders
                captured["grouping"] = grouping
                return {
                    "status": "ok",
                    "response": {"data": {"statuses": [
                        {"resting": {"oid": 10}}, {"resting": {"oid": 11}},
                    ]}},
                }

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda *_args: (InfoStub(), ExchangeStub(), "0xwallet")
        entry = {
            "accountId": "account", "symbol": "ETHUSDT", "role": "entry", "leverage": 2,
            "side": "buy", "orderType": "limit", "quantity": "1", "price": "100",
            "clientOrderId": "0x" + "1" * 32, "reduceOnly": False, "postOnly": False,
        }
        stop = {
            "accountId": "account", "symbol": "ETHUSDT", "role": "stop_loss", "leverage": 2,
            "side": "sell", "orderType": "stop_market", "quantity": "1", "triggerPrice": "95",
            "clientOrderId": "0x" + "2" * 32, "reduceOnly": True,
        }
        result = adapter.submit_protected_entry({"mode": "testnet"}, entry, stop)
        self.assertEqual(result["entry"]["status"], "open")
        self.assertEqual(result["protectiveStop"]["status"], "open")
        self.assertEqual(captured["grouping"], "normalTpsl")
        self.assertEqual(len(captured["orders"]), 2)
        self.assertTrue(captured["orders"][1]["reduce_only"])

    def test_protected_entry_recovers_a_nested_stop_from_order_status(self) -> None:
        stop_id = "0x" + "2" * 32
        queries: list[str] = []

        class InfoStub:
            @staticmethod
            def query_order_by_oid(_address, client_order_id):
                queries.append(client_order_id)
                return {
                    "status": "order",
                    "order": {
                        "status": "open",
                        "order": {"oid": 11, "origSz": "1", "sz": "1", "cloid": stop_id},
                    },
                }

        class ExchangeStub:
            @staticmethod
            def update_leverage(*_args, **_kwargs):
                return {"status": "ok"}

            @staticmethod
            def bulk_orders(_orders, grouping="na"):
                self.assertEqual(grouping, "normalTpsl")
                return {
                    "status": "ok",
                    "response": {"data": {"statuses": [
                        {"filled": {"oid": 10, "totalSz": "1", "avgPx": "100"}},
                    ]}},
                }

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda *_args: (InfoStub(), ExchangeStub(), "0xwallet")
        entry = {
            "accountId": "account", "symbol": "ETHUSDT", "role": "entry", "leverage": 2,
            "side": "buy", "orderType": "limit", "quantity": "1", "price": "100",
            "clientOrderId": "0x" + "1" * 32, "reduceOnly": False, "postOnly": False,
        }
        stop = {
            "accountId": "account", "symbol": "ETHUSDT", "role": "stop_loss", "leverage": 2,
            "side": "sell", "orderType": "stop_market", "quantity": "1", "triggerPrice": "95",
            "clientOrderId": stop_id, "reduceOnly": True,
        }
        result = adapter.submit_protected_entry({"mode": "testnet"}, entry, stop)
        self.assertEqual(result["entry"]["status"], "filled")
        self.assertEqual(result["entry"]["averagePrice"], "100")
        self.assertEqual(result["protectiveStop"]["status"], "open")
        self.assertEqual(queries, [stop_id])

    def test_protected_entry_single_batch_error_rejects_both_without_querying(self) -> None:
        class InfoStub:
            @staticmethod
            def query_order_by_oid(*_args):
                raise AssertionError("A provider batch rejection is already authoritative.")

        class ExchangeStub:
            @staticmethod
            def update_leverage(*_args, **_kwargs):
                return {"status": "ok"}

            @staticmethod
            def bulk_orders(_orders, grouping="na"):
                return {"status": "ok", "response": {"data": {"statuses": [{"error": "bad batch"}]}}}

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda *_args: (InfoStub(), ExchangeStub(), "0xwallet")
        entry = {
            "accountId": "account", "symbol": "ETHUSDT", "role": "entry", "leverage": 2,
            "side": "buy", "orderType": "limit", "quantity": "1", "price": "100",
            "clientOrderId": "0x" + "1" * 32, "reduceOnly": False, "postOnly": False,
        }
        stop = {
            "accountId": "account", "symbol": "ETHUSDT", "role": "stop_loss", "leverage": 2,
            "side": "sell", "orderType": "stop_market", "quantity": "1", "triggerPrice": "95",
            "clientOrderId": "0x" + "2" * 32, "reduceOnly": True,
        }
        result = adapter.submit_protected_entry({"mode": "testnet"}, entry, stop)
        self.assertEqual(result["entry"]["status"], "rejected")
        self.assertEqual(result["protectiveStop"]["status"], "rejected")

    def test_market_ioc_prices_round_outward_to_valid_hyperliquid_ticks(self) -> None:
        class InfoStub:
            @staticmethod
            def meta_and_asset_ctxs():
                return ({"universe": [{"name": "BTC", "szDecimals": 5}]}, [{"markPx": "75499.4"}])

        request = {
            "orderType": "market", "role": "flatten", "maxSlippagePercent": "1",
        }
        sell_price, sell_type = HyperliquidAdapter._price_and_order_type(
            InfoStub(), "BTC", False, request, None
        )
        buy_price, buy_type = HyperliquidAdapter._price_and_order_type(
            InfoStub(), "BTC", True, request, None
        )
        self.assertEqual(sell_price, 74744.0)
        self.assertEqual(buy_price, 76255.0)
        self.assertEqual(sell_type, {"limit": {"tif": "Ioc"}})
        self.assertEqual(buy_type, {"limit": {"tif": "Ioc"}})

    def test_market_snapshot_tick_obeys_size_decimals_and_significant_figures(self) -> None:
        class InfoStub:
            @staticmethod
            def meta_and_asset_ctxs():
                return ({
                    "universe": [{"name": "BTC", "szDecimals": 5, "maxLeverage": 50}],
                }, [{"markPx": "75499.4"}])

        adapter = HyperliquidAdapter.__new__(HyperliquidAdapter)
        adapter._clients = lambda *_args: (InfoStub(), object(), "0xwallet")
        snapshot = adapter.market_snapshot({"mode": "testnet"}, "BTCUSDT")
        self.assertEqual(snapshot["priceTick"], "1")
        self.assertEqual(snapshot["quantityStep"], "0.00001")


if __name__ == "__main__":
    unittest.main()
