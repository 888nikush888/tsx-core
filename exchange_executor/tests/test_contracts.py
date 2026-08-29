from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ccxt_adapter import (
    CcxtAdapter, _canonical_symbol, _ledger_funding_amount, _market_order_result, _order_result,
    _market_constraints, _market_mark_price, _normalized_fill, _normalized_open_order, _reduce_only,
    _requested_base, _status, _trigger_price,
)
import ccxt_client
from ccxt_client import (
    CERTIFIED_EXCHANGES,
    CcxtClientRegistry,
    _account_identity,
    _client_configuration,
    _credential_fingerprint,
)
from common import (
    ExchangeContractError, RequestDeadline, SymbolUnavailableError, account_request,
    decimal_string, external_account_cache_key, external_account_id,
)
from credentials import CredentialError, CredentialStore
from server import authenticated, execute, executor_error_code
from stream_hub import AccountStream, _canonical_payload, _event_type


class ContractTests(unittest.TestCase):
    def test_market_snapshot_helpers_normalize_fallback_price_and_certified_limits(self) -> None:
        self.assertEqual(
            _market_mark_price({"info": {"mark_price": "11.5"}}),
            Decimal("11.5"),
        )
        self.assertEqual(
            _market_mark_price({"bid": "10", "ask": "14"}),
            Decimal("12"),
        )
        with self.assertRaisesRegex(ExchangeContractError, "mark/last"):
            _market_mark_price({})

        market = {
            "precision": {"amount": "0.01", "price": "0.1"},
            "limits": {"amount": {"min": "0.02"}, "cost": {"min": "5"}},
            "contractSize": "0.5",
        }
        self.assertEqual(
            _market_constraints(market),
            {
                "priceTick": "0.1",
                "quantityStep": "0.005",
                "minimumQuantity": "0.01",
                "minimumNotional": "5",
                "contractSize": "0.5",
            },
        )
        for field, value, message in (
            ("amount", None, "minimum quantity"),
            ("amount", "0", "minimum quantity"),
            ("cost", None, "minimum notional"),
            ("cost", "NaN", "minimum notional"),
        ):
            invalid = {**market, "limits": {key: dict(item) for key, item in market["limits"].items()}}
            invalid["limits"][field]["min"] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ExchangeContractError, message):
                _market_constraints(invalid)

    def test_credential_fingerprint_uses_the_canonical_secret_as_hmac_key(self) -> None:
        credentials = {"secret": "secret-value", "apiKey": "api-key"}
        canonical = json.dumps(credentials, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

        fingerprint = _credential_fingerprint(credentials, "bybit", "testnet")

        self.assertEqual(
            fingerprint,
            external_account_cache_key("bybit", "testnet", canonical),
        )
        self.assertEqual(len(fingerprint), 64)
        self.assertNotEqual(
            fingerprint,
            _credential_fingerprint({**credentials, "secret": "changed"}, "bybit", "testnet"),
        )

    def test_account_contract_accepts_dynamic_exchange_ids_and_rejects_invalid_ids(self) -> None:
        self.assertEqual(CERTIFIED_EXCHANGES, {"hyperliquid", "bybit", "krakenfutures"})
        for exchange in (*sorted(CERTIFIED_EXCHANGES), "okx", "coinbaseinternational"):
            account = account_request({"account": {"id": "account-1", "exchange": exchange, "mode": "testnet"}})
            self.assertEqual(account["exchange"], exchange)
        for exchange in ("paper", "Binance", "bad id", "a" * 65):
            with self.subTest(exchange=exchange), self.assertRaises(ExchangeContractError):
                account_request({"account": {"id": "account-1", "exchange": exchange, "mode": "testnet"}})

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

    def test_missing_certified_market_uses_typed_side_effect_free_contract(self) -> None:
        clients = SimpleNamespace(
            account={"id": "account-1", "exchange": "krakenfutures", "mode": "testnet"},
            rest=SimpleNamespace(markets={}),
        )
        with self.assertRaises(SymbolUnavailableError) as raised:
            CcxtAdapter._market(clients, "BTCUSDT")
        self.assertEqual(raised.exception.code, "SYMBOL_UNAVAILABLE")
        self.assertEqual(raised.exception.http_status, 422)
        self.assertFalse(raised.exception.side_effects)
        self.assertEqual(raised.exception.details, {
            "exchange": "krakenfutures", "accountId": "account-1", "symbol": "BTCUSDT",
        })

    def test_http_contract_exposes_typed_side_effect_free_symbol_miss(self) -> None:
        class MissingMarketApplication:
            credentials = SimpleNamespace(token=lambda: "executor-token")

            @staticmethod
            async def handle(_path: str, _payload: dict[str, object]) -> dict[str, object]:
                raise SymbolUnavailableError(
                    "Symbol BTCUSDT is unavailable on the certified linear perpetual market.",
                    exchange="bybit", account_id="account-1", symbol="BTCUSDT",
                )

        class Request:
            app = {
                "application": MissingMarketApplication(),
                "request_semaphore": asyncio.Semaphore(1),
            }
            headers = {"Authorization": "Bearer executor-token"}
            content_length = 2
            path = "/v1/market-snapshot"

            @staticmethod
            async def json(*, loads):
                return loads("{}")

        response = asyncio.run(execute(Request()))
        self.assertEqual(response.status, 422)
        self.assertEqual(json.loads(response.text), {
            "error": "Symbol BTCUSDT is unavailable on the certified linear perpetual market.",
            "code": "SYMBOL_UNAVAILABLE",
            "sideEffects": False,
            "details": {"exchange": "bybit", "accountId": "account-1", "symbol": "BTCUSDT"},
        })

    def test_contract_amounts_are_normalized_back_to_base_quantity(self) -> None:
        mapped = _market_order_result(
            {"id": "order-1", "clientOrderId": "client-1", "status": "closed", "filled": "25"},
            {"contractSize": "0.001"},
        )
        self.assertEqual(mapped["filledQuantity"], "0.025")
        stop = {"reduceOnly": True, "triggerPrice": "65000"}
        self.assertTrue(_reduce_only(stop))
        self.assertEqual(_trigger_price(stop), "65000")

    def test_remote_snapshots_preserve_exchange_identity_without_client_identity(self) -> None:
        rest = SimpleNamespace(market=lambda _symbol: {
            "base": "BTC", "contractSize": "0.001",
        })
        order = _normalized_open_order(rest, {
            "id": "exchange-stop", "clientOrderId": None, "symbol": "BTC/USDT:USDT",
            "status": "open", "filled": "0", "amount": "25", "side": "sell",
            "reduceOnly": True, "triggerPrice": "59000",
        })
        self.assertIsNone(order["clientOrderId"])
        self.assertEqual(order["exchangeOrderId"], "exchange-stop")
        self.assertEqual(order["quantity"], "0.025")
        fill = _normalized_fill(rest, {"exchange-stop": {
            "id": "exchange-stop", "clientOrderId": None,
        }}, {
            "id": "fill-1", "order": "exchange-stop", "symbol": "BTC/USDT:USDT",
            "price": "60000", "amount": "10", "timestamp": 123, "fee": {"cost": "1"},
        })
        self.assertIsNotNone(fill)
        self.assertIsNone(fill["clientOrderId"])
        self.assertEqual(fill["exchangeOrderId"], "exchange-stop")
        with self.assertRaisesRegex(ExchangeContractError, "exchange identifier"):
            _normalized_open_order(rest, {
                "symbol": "BTC/USDT:USDT", "status": "open", "amount": "1", "side": "sell",
            })

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

    def test_ccxt_identity_preserves_native_adapter_account_bindings(self) -> None:
        wallet = "0x" + "Ab" * 20
        stable = _account_identity(
            {"privateKey": "0x" + "1" * 64, "walletAddress": wallet},
            "hyperliquid",
            "testnet",
        )
        self.assertEqual(stable, wallet.lower())
        self.assertEqual(
            external_account_id("hyperliquid", "testnet", stable),
            external_account_id("hyperliquid", "testnet", wallet.lower()),
        )

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
            self.assertEqual(
                store.account(account_id, "krakenfutures")["credentials"]["apiKey"],
                "kraken-key-123",
            )
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


class DelayedMarketClient:
    def __init__(self, _configuration, state) -> None:
        self.state = state
        self.has = {
            "fetchBalance": True, "fetchPositions": True, "fetchOpenOrders": True,
            "fetchMyTrades": True, "createOrder": True, "createOrders": True,
            "cancelOrder": True, "setLeverage": True, "watchOrders": True,
            "watchMyTrades": True, "watchPositions": True,
        }

    def set_sandbox_mode(self, _enabled) -> None:
        return None

    async def load_markets(self) -> None:
        self.state["loads"] += 1
        if self.state["loads"] == 2:
            self.state["started"].set()
        await self.state["release"].wait()

    async def close(self) -> None:
        self.state["closes"] += 1


class RegistryBootstrapTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_request_never_exposes_half_initialized_cached_clients(self) -> None:
        state = {
            "loads": 0, "closes": 0,
            "started": asyncio.Event(), "release": asyncio.Event(),
        }
        credentials = SimpleNamespace(account=lambda _account_id, _exchange: {
            "credentials": {
                "privateKey": "0x" + "1" * 64,
                "walletAddress": "0x" + "2" * 40,
            },
        })
        catalog = SimpleNamespace(descriptor=lambda exchange: {
            "id": exchange,
            "status": "certified",
            "modes": ["testnet", "live"],
        })
        registry = CcxtClientRegistry(credentials, catalog)
        account = {"id": "account-1", "exchange": "hyperliquid", "mode": "testnet"}
        factory = lambda configuration: DelayedMarketClient(configuration, state)
        with patch.object(ccxt_client.ccxt_async, "hyperliquid", factory), \
             patch.object(ccxt_client.ccxt_pro, "hyperliquid", factory):
            first = asyncio.create_task(registry.account(account))
            await asyncio.wait_for(state["started"].wait(), timeout=1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first

            second = asyncio.create_task(registry.account(account))
            await asyncio.sleep(0)
            self.assertFalse(second.done(), "Cached clients must still await the shared market bootstrap.")
            state["release"].set()
            clients = await asyncio.wait_for(second, timeout=1)
            self.assertTrue(clients.markets_loaded)
            self.assertEqual(state["loads"], 2)
            await registry.close()
            self.assertEqual(state["closes"], 2)


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
    def __init__(self, rest, exchange="bybit") -> None:
        self.clients = SimpleNamespace(
            account={"id": "account-1", "exchange": exchange, "mode": "testnet"},
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


class FakeHyperliquidRest(FakeProtectedRest):
    def __init__(self, ticker=None) -> None:
        super().__init__([[]])
        self.submitted = []
        self.ticker_calls = 0
        self.ticker = ticker or {"bid": 65000.0, "ask": 65010.25, "last": 65005.0}

    async def fetch_ticker(self, _symbol):
        self.ticker_calls += 1
        return self.ticker

    async def create_order(self, *args, **kwargs):
        self.submitted.append((args, kwargs))
        client_id = kwargs.get("params", {}).get("clientOrderId", "cleanup")
        return {
            "id": "exchange-order", "clientOrderId": client_id,
            "status": "open", "filled": "0",
        }


class HyperliquidOrderTests(unittest.IsolatedAsyncioTestCase):
    def deadline(self):
        return RequestDeadline(int(time.time() * 1_000) + 30_000)

    async def test_market_order_uses_directional_reference_and_strategy_slippage(self) -> None:
        rest = FakeHyperliquidRest()
        request = {
            "role": "flatten", "accountId": "account-1", "symbol": "BTCUSDT", "side": "buy",
            "orderType": "market", "quantity": "2", "price": None, "triggerPrice": None,
            "clientOrderId": "flatten-client", "reduceOnly": True, "postOnly": False,
            "leverage": 20, "maxSlippagePercent": "0.225",
        }
        result = await CcxtAdapter(FakeRegistry(rest, "hyperliquid")).submit_order(
            {"id": "account-1", "exchange": "hyperliquid", "mode": "testnet"}, request, self.deadline(),
        )
        self.assertEqual(result["exchangeOrderId"], "exchange-order")
        _args, spec = rest.submitted[0]
        self.assertEqual(spec["price"], "65010.25")
        self.assertEqual(spec["params"]["slippage"], "0.00225")
        self.assertEqual(rest.ticker_calls, 1)

    async def test_stop_market_uses_trigger_as_reference_without_stale_ticker(self) -> None:
        rest = FakeHyperliquidRest()
        request = {
            "role": "stop_loss", "accountId": "account-1", "symbol": "BTCUSDT", "side": "sell",
            "orderType": "stop_market", "quantity": "2", "price": None, "triggerPrice": "64000",
            "clientOrderId": "stop-client", "reduceOnly": True, "postOnly": False,
            "leverage": 20, "maxSlippagePercent": "0.5",
        }
        await CcxtAdapter(FakeRegistry(rest, "hyperliquid")).submit_order(
            {"id": "account-1", "exchange": "hyperliquid", "mode": "testnet"}, request, self.deadline(),
        )
        _args, spec = rest.submitted[0]
        self.assertEqual(spec["price"], "64000")
        self.assertEqual(spec["params"]["stopLossPrice"], "64000")
        self.assertEqual(spec["params"]["slippage"], "0.005")
        self.assertEqual(rest.ticker_calls, 0)

    async def test_market_reference_rejects_invalid_side_before_ticker_access(self) -> None:
        rest = FakeHyperliquidRest()
        registry = FakeRegistry(rest, "hyperliquid")
        with self.assertRaisesRegex(ExchangeContractError, "Order side is invalid"):
            await CcxtAdapter(registry)._market_order_reference(
                registry.clients, rest.markets["BTC/USDT:USDT"], "hold", self.deadline(),
            )
        self.assertEqual(rest.ticker_calls, 0)

    async def test_market_reference_skips_missing_nonpositive_and_invalid_candidates(self) -> None:
        rest = FakeHyperliquidRest({
            "ask": None,
            "mark": "0",
            "last": "not-a-number",
            "info": {"markPrice": "65006.5"},
        })
        registry = FakeRegistry(rest, "hyperliquid")
        reference = await CcxtAdapter(registry)._market_order_reference(
            registry.clients, rest.markets["BTC/USDT:USDT"], "buy", self.deadline(),
        )
        self.assertEqual(reference, "65006.5")

    async def test_market_reference_rejects_ticker_without_usable_price(self) -> None:
        rest = FakeHyperliquidRest({
            "ask": None,
            "mark": "0",
            "last": "not-a-number",
            "info": {"markPrice": None, "mark_price": "-1"},
        })
        registry = FakeRegistry(rest, "hyperliquid")
        with self.assertRaisesRegex(ExchangeContractError, "omitted a usable"):
            await CcxtAdapter(registry)._market_order_reference(
                registry.clients, rest.markets["BTC/USDT:USDT"], "buy", self.deadline(),
            )

    async def test_emergency_cleanup_uses_bounded_hyperliquid_slippage(self) -> None:
        rest = FakeHyperliquidRest()
        rest._positions = [[{"contracts": "2", "side": "long"}]]
        registry = FakeRegistry(rest, "hyperliquid")
        adapter = CcxtAdapter(registry)
        await adapter._flatten_new_symbol_exposure(
            registry.clients, rest.markets["BTC/USDT:USDT"], self.deadline(),
        )
        args, kwargs = rest.submitted[0]
        self.assertEqual(kwargs, {})
        self.assertEqual(args, (
            "BTC/USDT:USDT", "market", "sell", "2", "65000",
            {"reduceOnly": True, "slippage": "0.01"},
        ))

    async def test_emergency_cleanup_short_uses_buy_reference(self) -> None:
        rest = FakeHyperliquidRest()
        rest._positions = [[{"contracts": "2", "side": "short"}]]
        registry = FakeRegistry(rest, "hyperliquid")
        await CcxtAdapter(registry)._flatten_new_symbol_exposure(
            registry.clients, rest.markets["BTC/USDT:USDT"], self.deadline(),
        )
        args, _kwargs = rest.submitted[0]
        self.assertEqual(args[2:5], ("buy", "2", "65010.25"))

    async def test_emergency_cleanup_skips_zero_and_rejects_missing_position_side(self) -> None:
        rest = FakeHyperliquidRest()
        rest._positions = [[
            {"contracts": "0", "side": "long"},
            {"contracts": "2", "side": None},
        ]]
        registry = FakeRegistry(rest, "hyperliquid")
        with self.assertRaisesRegex(ExchangeContractError, "omitted its side"):
            await CcxtAdapter(registry)._flatten_new_symbol_exposure(
                registry.clients, rest.markets["BTC/USDT:USDT"], self.deadline(),
            )
        self.assertEqual(rest.submitted, [])


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
