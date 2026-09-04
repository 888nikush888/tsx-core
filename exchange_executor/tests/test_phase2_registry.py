from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ccxt.async_support as installed_ccxt

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ccxt_registry import CcxtExchangeRegistry
from ccxt_certification import CertificationResult
from credentials import CredentialError, CredentialStore, _credential_text_is_valid
from server import Application
from symbol_resolver import SymbolResolutionError, resolve_symbol


REST_REQUIRED = {
    "fetchBalance": True,
    "fetchPositions": True,
    "fetchOpenOrders": True,
    "fetchMyTrades": True,
    "createOrder": True,
    "createOrders": True,
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

    def test_every_installed_ccxt_rest_exchange_is_statically_discoverable(self) -> None:
        catalog = CcxtExchangeRegistry().catalog()
        self.assertEqual(
            {entry["id"] for entry in catalog["exchanges"]},
            set(installed_ccxt.exchanges),
        )

    def test_static_discovery_has_no_network_and_quarantines_unreviewed_legacy_profiles(self) -> None:
        # The scenario is explicitly unreviewed, independent of future genuine
        # approval pins in the checkout or finished container.
        with patch('ccxt_certification.APPROVED_IMPLEMENTATION_RECEIPTS', {}):
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
            self.assertEqual(entries[exchange]["status"], "quarantined")
            self.assertEqual(entries[exchange]["modes"], [])
            self.assertIn('review', entries[exchange]['reason'].lower())
            self.assertEqual(entries[exchange]["provider"], "ccxt")
            self.assertTrue(entries[exchange]["restAvailable"])
            self.assertTrue(entries[exchange]["proAvailable"])
            self.assertEqual(entries[exchange]["requiredCredentials"], ["apiKey", "secret"])
        self.assertEqual(
            entries["hyperliquid"]["requiredCredentials"],
            ["apiKey", "secret"],
            "Static descriptors expose CCXT's raw credential requirements independently of profile overrides.",
        )
        self.assertEqual(entries["okx"]["status"], "discovered")
        self.assertEqual(entries["restonly"]["status"], "ineligible")
        self.assertEqual(entries["unsupported"]["status"], "ineligible")
        self.assertNotEqual(entries["okx"]["status"], "certified")

    def test_registry_obeys_independent_validator_result_not_public_probe_flags(self):
        # This isolates catalog projection, not receipt review or provider acceptance.
        # The real receipt/tree/pin path is exercised in test_certification_evidence.
        with patch('ccxt_registry.certification_result', return_value=CertificationResult(True, None)):
            entries = {entry['id']: entry for entry in self.registry().catalog()['exchanges']}
        self.assertEqual(entries['bybit']['status'], 'certified')
        self.assertEqual(entries['bybit']['modes'], ['testnet', 'live'])
        self.assertEqual(entries['okx']['status'], 'discovered')
        self.assertEqual(StaticExchange.network_calls, 0)

    def test_profile_missing_from_installed_ccxt_is_reported_as_deprecated(self) -> None:
        rest, pro = fake_modules()
        rest.exchanges.remove("krakenfutures")
        delattr(rest, "krakenfutures")
        pro.exchanges.remove("krakenfutures")
        delattr(pro, "krakenfutures")
        catalog = CcxtExchangeRegistry(
            rest_module=rest,
            pro_module=pro,
            ccxt_version="4.5.75",
            certifications_directory=ROOT / "certifications",
        ).catalog()
        kraken = next(entry for entry in catalog["exchanges"] if entry["id"] == "krakenfutures")
        self.assertEqual(kraken["status"], "deprecated")
        self.assertFalse(kraken["ccxt"]["rest"])
        self.assertFalse(kraken["ccxt"]["pro"])
        self.assertEqual(kraken["modes"], [])

    def test_certification_evidence_version_drift_quarantines_exchange(self) -> None:
        rest, pro = fake_modules()
        catalog = CcxtExchangeRegistry(
            rest_module=rest,
            pro_module=pro,
            ccxt_version="4.5.76",
            certifications_directory=ROOT / "certifications",
        ).catalog()
        entries = {entry["id"]: entry for entry in catalog["exchanges"]}
        self.assertEqual(entries["hyperliquid"]["status"], "quarantined")
        self.assertIn("version", entries["hyperliquid"]["reason"].lower())

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
    @staticmethod
    def market(identifier, **changes):
        row = {"id": identifier, "symbol": "BTC/USDT:USDT", "base": "BTC", "quote": "USDT", "settle": "USDT",
               "type": "swap", "contract": True, "spot": False, "swap": True, "future": False, "option": False,
               "linear": True, "inverse": False, "active": True, "expiry": None, "contractSize": 1}
        row.update(changes)
        return row

    def test_resolver_filters_to_active_linear_swaps_and_uses_profile_settlement_order(self) -> None:
        markets = {
            "spot": self.market("spot", type="spot", symbol="BTC/USDT", contract=False, spot=True, swap=False,
                                linear=None, inverse=None, settle=None, contractSize=None),
            "inverse": self.market("inverse", symbol="BTC/USD:BTC", quote="USD", settle="BTC", linear=False, inverse=True),
            "usdc": self.market("usdc", symbol="BTC/USDC:USDC", quote="USDC", settle="USDC"),
            "usdt": self.market("usdt"),
        }
        self.assertEqual(resolve_symbol(markets, "BTCUSDT", ("USDC", "USDT", "USD"))["symbol"], "BTC/USDC:USDC")

    def test_resolver_fails_closed_on_ambiguity(self) -> None:
        markets = {
            "a": self.market("a"),
            "b": self.market("b"),
        }
        with self.assertRaisesRegex(SymbolResolutionError, "SYMBOL_AMBIGUOUS"):
            resolve_symbol(markets, "BTCUSDT", ("USDT", "USDC", "USD"))


class CredentialV2Tests(unittest.TestCase):
    def test_credential_text_validation_is_bounded_and_rejects_control_characters(self) -> None:
        self.assertTrue(_credential_text_is_valid("12345678", minimum=8, maximum=256))
        for invalid in (None, "1234567", "x" * 257, "valid-value\nleak", "bad\0value"):
            with self.subTest(invalid=invalid):
                self.assertFalse(_credential_text_is_valid(invalid, minimum=8, maximum=256))

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
