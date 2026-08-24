from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ccxt_adapter import (
    CcxtAdapter, _canonical_symbol, _ledger_funding_amount, _market_order_result, _order_result,
    _reduce_only, _requested_base, _status, _trigger_price,
)
from ccxt_client import CERTIFIED_EXCHANGES, _account_identity, _client_configuration
from common import ExchangeContractError, RequestDeadline, account_request, decimal_string
from credentials import CredentialError, CredentialStore
from server import authenticated, executor_error_code
from stream_hub import AccountStream, _canonical_payload, _event_type


class ContractTests(unittest.TestCase):
    def test_only_certified_ccxt_exchanges_are_accepted(self) -> None:
        self.assertEqual(CERTIFIED_EXCHANGES, {"hyperliquid", "bybit", "krakenfutures"})
        for exchange in CERTIFIED_EXCHANGES:
            account = account_request({"account": {"id": "account-1", "exchange": exchange, "mode": "testnet"}})
            self.assertEqual(account["exchange"], exchange)
        with self.assertRaises(ExchangeContractError):
            account_request({"account": {"id": "account-1", "exchange": "binance", "mode": "testnet"}})

    def test_executor_failures_have_stable_secret_free_endpoint_codes(self) -> None:
        self.assertEqual(executor_error_code("/v1/stream-events"), "STREAM_POLL_FAILED")
        self.assertEqual(executor_error_code("/v1/open-state"), "OPEN_STATE_FAILED")
        self.assertEqual(executor_error_code("/unknown"), "EXECUTOR_REQUEST_FAILED")

    def test_hyperliquid_builder_fee_is_explicitly_disabled(self) -> None:
        config = _client_configuration(
            {"id": "a", "exchange": "hyperliquid", "mode": "testnet"},
            {"privateKey": "0x" + "1" * 64, "walletAddress": "0x" + "2" * 40},
        )
        self.assertFalse(config["options"]["builderFee"])
        self.assertFalse(config["options"]["approvedBuilderFee"])

    def test_ccxt_symbol_and_status_normalization_is_fail_closed(self) -> None:
        market = {"base": "BTC"}
        self.assertEqual(_canonical_symbol(market), "BTCUSDT")
        self.assertEqual(_requested_base("BTC/USD:USD"), "BTC")
        self.assertEqual(_status("closed"), "filled")
        self.assertEqual(_status("future-provider-status"), "unknown")
        mapped = _order_result({"id": "order-1", "clientOrderId": "client-1", "status": "open", "filled": 0})
        self.assertEqual(mapped["clientOrderId"], "client-1")
        self.assertEqual(mapped["status"], "open")
        partial = _order_result({"id": "order-2", "clientOrderId": "client-2", "status": "open", "filled": "1"})
        self.assertEqual(partial["status"], "partially_filled")

    def test_contract_amounts_are_normalized_back_to_base_quantity(self) -> None:
        mapped = _market_order_result(
            {"id": "order-1", "clientOrderId": "client-1", "status": "closed", "filled": "25"},
            {"contractSize": "0.001"},
        )
        self.assertEqual(mapped["filledQuantity"], "0.025")
        stop = {"reduceOnly": True, "triggerPrice": "65000"}
        self.assertTrue(_reduce_only(stop))
        self.assertEqual(_trigger_price(stop), "65000")

    def test_ledger_funding_excludes_trade_pnl_and_preserves_sign(self) -> None:
        self.assertIsNone(_ledger_funding_amount({"type": "trade", "amount": 99}))
        self.assertEqual(_ledger_funding_amount({"type": "funding", "amount": "2", "direction": "out"}), -2)
        self.assertEqual(_ledger_funding_amount({"info": {"realized_funding": "-0.25"}}), Decimal("-0.25"))

    def test_external_identity_survives_secret_rotation_but_not_api_key_rebinding(self) -> None:
        first = _account_identity({"apiKey": "same-key", "apiSecret": "old-secret"}, "bybit", "live")
        rotated = _account_identity({"apiKey": "same-key", "apiSecret": "new-secret"}, "bybit", "live")
        rebound = _account_identity({"apiKey": "different-key", "apiSecret": "new-secret"}, "bybit", "live")
        self.assertEqual(first, rotated)
        self.assertNotEqual(first, rebound)

    def test_plain_decimals_and_deadlines_remain_bounded(self) -> None:
        self.assertEqual(decimal_string("1.2300", "price", positive=True), "1.23")
        with self.assertRaises(ExchangeContractError):
            decimal_string("1e3", "price")
        deadline = RequestDeadline.from_payload({"deadlineAt": int(time.time() * 1000) + 2_000})
        self.assertGreater(deadline.remaining_ms(), 0)
        with self.assertRaises(ExchangeContractError):
            RequestDeadline.from_payload({"deadlineAt": int(time.time() * 1000) + 60_000})

    def test_credential_contract_supports_kraken_futures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "trading").mkdir()
            (root / "exchange_executor_token").write_text("a" * 64 + "\n", encoding="utf-8")
            account_id = "11111111-1111-4111-8111-111111111111"
            (root / "trading" / f"{account_id}.json").write_text(json.dumps({
                "version": 1, "accountId": account_id, "exchange": "krakenfutures",
                "apiKey": "kraken-key-123", "apiSecret": "kraken-secret-123", "updatedAt": 1,
            }), encoding="utf-8")
            store = CredentialStore(directory)
            self.assertEqual(store.account(account_id, "krakenfutures")["apiKey"], "kraken-key-123")
            with self.assertRaises(CredentialError):
                store.account(account_id, "bybit")

    def test_authentication_observes_executor_token_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "trading").mkdir()
            token_file = root / "exchange_executor_token"
            token_file.write_text("a" * 64 + "\n", encoding="utf-8")
            application = SimpleNamespace(credentials=CredentialStore(directory))
            request = SimpleNamespace(headers={"Authorization": f"Bearer {'a' * 64}"})
            self.assertTrue(authenticated(request, application))
            token_file.write_text("b" * 64 + "\n", encoding="utf-8")
            request.headers = {"Authorization": f"Bearer {'b' * 64}"}
            self.assertTrue(authenticated(request, application))

    def test_pro_event_helpers_are_bounded_and_normalized(self) -> None:
        truncated, digest = _canonical_payload({"value": "x" * (70 * 1024)})
        self.assertTrue(truncated["truncated"])
        self.assertEqual(truncated["sha256"], digest)
        self.assertEqual(_event_type("orders"), "order")
        self.assertEqual(_event_type("positions"), "position")


class FakePro:
    has = {"watchTickers": False}
    markets = {"BTC/USDT:USDT": {"symbol": "BTC/USDT:USDT", "base": "BTC"}}

    def market(self, symbol):
        return self.markets[symbol]


class FakeProtectedRest:
    def __init__(self, positions, orders=None, failure=None) -> None:
        self.markets = {
            "BTC/USDT:USDT": {
                "symbol": "BTC/USDT:USDT", "base": "BTC", "quote": "USDT", "settle": "USDT",
                "contract": True, "swap": True, "linear": True, "active": True, "contractSize": "1",
                "limits": {"leverage": {"max": 50}},
            },
        }
        self.has = {"fetchMarketLeverageTiers": False}
        self._positions = list(positions)
        self._orders = orders
        self._failure = failure
        self.created_batches = []
        self.cleanup_orders = []
        self.leverage = []

    async def fetch_positions(self, _symbols=None):
        return self._positions.pop(0) if self._positions else []

    async def set_leverage(self, leverage, symbol):
        self.leverage.append((leverage, symbol))

    async def create_orders(self, orders):
        self.created_batches.append(orders)
        if self._failure:
            raise self._failure
        return self._orders

    async def fetch_open_orders(self, *_args):
        return []

    async def create_order(self, *args):
        self.cleanup_orders.append(args)
        return {"id": "cleanup"}

    def amount_to_precision(self, _symbol, amount):
        return str(amount)

    def price_to_precision(self, _symbol, price):
        return str(price)


class FakeRegistry:
    def __init__(self, rest) -> None:
        self.clients = SimpleNamespace(
            account={"id": "account-1", "exchange": "bybit", "mode": "testnet"},
            rest=rest,
        )
        self.calls = 0

    async def account(self, _account):
        self.calls += 1
        return self.clients


def protected_requests():
    entry = {
        "role": "entry", "accountId": "account-1", "symbol": "BTCUSDT", "side": "buy",
        "orderType": "limit", "quantity": "2", "price": "65000", "triggerPrice": None,
        "clientOrderId": "entry-client", "reduceOnly": False, "postOnly": False, "leverage": 20,
    }
    stop = {
        "role": "stop_loss", "accountId": "account-1", "symbol": "BTCUSDT", "side": "sell",
        "orderType": "stop_market", "quantity": "2", "price": None, "triggerPrice": "64000",
        "clientOrderId": "stop-client", "reduceOnly": True, "postOnly": False, "leverage": 20,
    }
    return entry, stop


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_pro_events_have_monotonic_cursors_and_gap_detection(self) -> None:
        clients = SimpleNamespace(pro=FakePro(), credential_fingerprint="a" * 64)
        stream = AccountStream({"id": "stream", "exchange": "bybit", "mode": "testnet"}, clients)
        stream._ingest("orders", {"id": "1", "symbol": "BTC/USDT:USDT", "timestamp": 10})
        stream._ingest("orders", {"id": "2", "symbol": "BTC/USDT:USDT", "timestamp": 11})
        batch = stream.poll(0)
        self.assertEqual([event["cursor"] for event in batch["events"]], [1, 2])
        self.assertEqual(batch["events"][0]["symbol"], "BTCUSDT")
        self.assertTrue(stream.poll(99)["gap"])
        await stream.close()


class ProtectedEntryTests(unittest.IsolatedAsyncioTestCase):
    def deadline(self):
        return RequestDeadline(int(time.time() * 1_000) + 30_000)

    async def test_invalid_protected_pair_is_rejected_before_any_exchange_access(self) -> None:
        entry, stop = protected_requests()
        stop["side"] = "buy"
        registry = FakeRegistry(FakeProtectedRest([[]]))
        with self.assertRaisesRegex(ExchangeContractError, "must oppose"):
            await CcxtAdapter(registry).submit_protected_entry(
                {"id": "account-1", "exchange": "bybit", "mode": "testnet"}, entry, stop, self.deadline(),
            )
        self.assertEqual(registry.calls, 0)

    async def test_existing_remote_exposure_blocks_batch_before_order_submission(self) -> None:
        entry, stop = protected_requests()
        rest = FakeProtectedRest([[{"contracts": "1", "side": "long"}]])
        with self.assertRaisesRegex(ExchangeContractError, "already reports exposure"):
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(
                {"id": "account-1", "exchange": "bybit", "mode": "testnet"}, entry, stop, self.deadline(),
            )
        self.assertEqual(rest.created_batches, [])
        self.assertEqual(rest.leverage, [])

    async def test_ambiguous_batch_only_flattens_exposure_created_after_zero_position_preflight(self) -> None:
        entry, stop = protected_requests()
        rest = FakeProtectedRest(
            [[], [{"contracts": "2", "side": "long"}]],
            failure=TimeoutError("provider response lost"),
        )
        with self.assertRaisesRegex(ExchangeContractError, "outcome is unknown"):
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(
                {"id": "account-1", "exchange": "bybit", "mode": "testnet"}, entry, stop, self.deadline(),
            )
        self.assertEqual(len(rest.created_batches), 1)
        self.assertEqual(rest.cleanup_orders, [
            ("BTC/USDT:USDT", "market", "sell", "2", None, {"reduceOnly": True}),
        ])

    async def test_complete_batch_returns_both_normalized_legs(self) -> None:
        entry, stop = protected_requests()
        rest = FakeProtectedRest([[]], orders=[
            {"id": "exchange-entry", "clientOrderId": "entry-client", "status": "open", "filled": "0"},
            {"id": "exchange-stop", "clientOrderId": "stop-client", "status": "open", "filled": "0"},
        ])
        result = await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(
            {"id": "account-1", "exchange": "bybit", "mode": "testnet"}, entry, stop, self.deadline(),
        )
        self.assertEqual(result["entry"]["exchangeOrderId"], "exchange-entry")
        self.assertEqual(result["protectiveStop"]["exchangeOrderId"], "exchange-stop")


if __name__ == "__main__":
    unittest.main()
