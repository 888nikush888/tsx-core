from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ccxt_registry import CcxtExchangeRegistry
from credentials import CredentialError, CredentialStore
from server import Application
from symbol_resolver import SymbolResolutionError, resolve_symbol


REST_REQUIRED = {
    "fetchBalance": True,
    "fetchPositions": True,
    "fetchOpenOrders": True,
    "fetchMyTrades": True,
    "createOrder": True,
    "cancelOrder": True,
    "setLeverage": True,
}
PRO_REQUIRED = {
    "watchOrders": True,
    "watchMyTrades": True,
    "watchPositions": True,
}


class StaticExchange:
    name = "Static Exchange"
    requiredCredentials = {"apiKey": True, "secret": True}
    has = REST_REQUIRED
    constructed = 0
    network_calls = 0

    def __init__(self, _configuration=None) -> None:
        type(self).constructed += 1

    async def load_markets(self):
        type(self).network_calls += 1
        raise AssertionError("static discovery must not load markets")

    async def close(self):
        return None


class ProExchange(StaticExchange):
    has = PRO_REQUIRED


class UnsupportedCredentials(StaticExchange):
    requiredCredentials = {"apiKey": True, "rsaPrivateKey": True}


class ProbeExchange(StaticExchange):
    name = "Probe Exchange"
    loaded = 0
    private_calls = 0
    order_calls = 0
    closed = 0

    async def load_markets(self):
        type(self).loaded += 1
        return {
            "BTC/USDT:USDT": {
                "symbol": "BTC/USDT:USDT",
                "base": "BTC",
                "quote": "USDT",
                "settle": "USDT",
                "contract": True,
                "swap": True,
                "linear": True,
                "active": True,
            }
        }

    async def fetch_balance(self):
        type(self).private_calls += 1
        raise AssertionError("public probe must not use private methods")

    async def create_order(self, *_args, **_kwargs):
        type(self).order_calls += 1
        raise AssertionError("public probe must not submit orders")

    async def close(self):
        type(self).closed += 1


def fake_modules():
    rest = SimpleNamespace(
        exchanges=["hyperliquid", "bybit", "krakenfutures", "okx", "restonly", "unsupported"],
        hyperliquid=type("Hyperliquid", (StaticExchange,), {"name": "Hyperliquid"}),
        bybit=type("Bybit", (StaticExchange,), {"name": "Bybit"}),
        krakenfutures=type("KrakenFutures", (StaticExchange,), {"name": "Kraken Futures"}),
        okx=ProbeExchange,
        restonly=type("RestOnly", (StaticExchange,), {"name": "REST only"}),
        unsupported=UnsupportedCredentials,
    )
    pro = SimpleNamespace(
        exchanges=["hyperliquid", "bybit", "krakenfutures", "okx", "unsupported"],
        hyperliquid=type("HyperliquidPro", (ProExchange,), {}),
        bybit=type("BybitPro", (ProExchange,), {}),
        krakenfutures=type("KrakenFuturesPro", (ProExchange,), {}),
        okx=type("OkxPro", (ProExchange,), {}),
        unsupported=type("UnsupportedPro", (ProExchange,), {}),
    )
    return rest, pro


class RegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        StaticExchange.network_calls = 0
        ProbeExchange.loaded = 0
        ProbeExchange.private_calls = 0
        ProbeExchange.order_calls = 0
        ProbeExchange.closed = 0

    def registry(self) -> CcxtExchangeRegistry:
        rest, pro = fake_modules()
        return CcxtExchangeRegistry(
            rest_module=rest,
            pro_module=pro,
            ccxt_version="4.5.75",
            certifications_directory=ROOT / "certifications",
        )

    def test_static_discovery_has_no_network_and_certifies_only_evidence_backed_profiles(self) -> None:
        catalog = self.registry().catalog()
        entries = {entry["id"]: entry for entry in catalog["exchanges"]}
        self.assertNotIn("paper", entries)
        self.assertEqual(catalog["implementation"], {
            "library": "ccxt",
            "version": "4.5.75",
            "streaming": "ccxt-pro",
            "orderAuthority": "rest",
        })
        self.assertEqual(StaticExchange.network_calls, 0)
        for exchange in ("hyperliquid", "bybit", "krakenfutures"):
            self.assertEqual(entries[exchange]["status"], "certified")
            self.assertEqual(entries[exchange]["provider"], "ccxt")
        self.assertEqual(entries["okx"]["status"], "discovered")
        self.assertEqual(entries["restonly"]["status"], "ineligible")
        self.assertEqual(entries["unsupported"]["status"], "ineligible")
        self.assertNotEqual(entries["okx"]["status"], "certified")

    async def test_public_probe_only_loads_public_markets_and_never_certifies(self) -> None:
        registry = self.registry()
        result = await registry.probe("okx")
        self.assertEqual(result["status"], "candidate")
        self.assertTrue(result["markets"]["linearSwap"])
        self.assertEqual(ProbeExchange.loaded, 1)
        self.assertEqual(ProbeExchange.private_calls, 0)
        self.assertEqual(ProbeExchange.order_calls, 0)
        self.assertEqual(ProbeExchange.closed, 1)
        cached = await registry.probe("okx")
        self.assertEqual(cached, result)
        self.assertEqual(ProbeExchange.loaded, 1)

    async def test_executor_catalog_endpoints_are_dispatched_without_account_payload(self) -> None:
        application = Application.__new__(Application)
        application.exchange_catalog = self.registry()
        catalog = await application.handle("/v1/exchange-catalog", {})
        self.assertIn("exchanges", catalog)
        probe = await application.handle("/v1/exchange-probe", {"exchange": "okx"})
        self.assertEqual(probe["status"], "candidate")


class SymbolResolverTests(unittest.TestCase):
    def test_resolver_filters_to_active_linear_swaps_and_uses_profile_settlement_order(self) -> None:
        markets = {
            "spot": {"symbol": "BTC/USDT", "base": "BTC", "quote": "USDT", "contract": False, "swap": False, "linear": False, "active": True},
            "inverse": {"symbol": "BTC/USD:BTC", "base": "BTC", "quote": "USD", "settle": "BTC", "contract": True, "swap": True, "linear": False, "active": True},
            "usdc": {"symbol": "BTC/USDC:USDC", "base": "BTC", "quote": "USDC", "settle": "USDC", "contract": True, "swap": True, "linear": True, "active": True},
            "usdt": {"symbol": "BTC/USDT:USDT", "base": "BTC", "quote": "USDT", "settle": "USDT", "contract": True, "swap": True, "linear": True, "active": True},
        }
        self.assertEqual(resolve_symbol(markets, "BTCUSDT", ("USDC", "USDT", "USD"))["symbol"], "BTC/USDC:USDC")

    def test_resolver_fails_closed_on_ambiguity(self) -> None:
        markets = {
            "a": {"symbol": "BTC/USDT:A", "base": "BTC", "quote": "USDT", "settle": "USDT", "contract": True, "swap": True, "linear": True, "active": True},
            "b": {"symbol": "BTC/USDT:B", "base": "BTC", "quote": "USDT", "settle": "USDT", "contract": True, "swap": True, "linear": True, "active": True},
        }
        with self.assertRaisesRegex(SymbolResolutionError, "SYMBOL_AMBIGUOUS"):
            resolve_symbol(markets, "BTCUSDT", ("USDT", "USDC", "USD"))


class CredentialV2Tests(unittest.TestCase):
    def test_python_reads_v2_and_rejects_unknown_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            trading = Path(directory) / "trading"
            trading.mkdir()
            account_id = "11111111-1111-4111-8111-111111111111"
            destination = trading / f"{account_id}.json"
            destination.write_text(json.dumps({
                "version": 2,
                "accountId": account_id,
                "exchange": "bybit",
                "credentials": {"apiKey": "bybit-key-123", "secret": "bybit-secret-123"},
                "updatedAt": 1,
            }), encoding="utf-8")
            loaded = CredentialStore(directory).account(account_id, "bybit")
            self.assertEqual(loaded["credentials"]["secret"], "bybit-secret-123")
            value = json.loads(destination.read_text(encoding="utf-8"))
            value["credentials"]["customParams"] = "forbidden"
            destination.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(CredentialError, "unsupported credential field"):
                CredentialStore(directory).account(account_id, "bybit")


if __name__ == "__main__":
    unittest.main()
