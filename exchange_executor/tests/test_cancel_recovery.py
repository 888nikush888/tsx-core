from __future__ import annotations

import unittest

from test_contracts import FakeProtectedRest, FakeRegistry, bound_test_account
from test_mutation_identity import deadline
from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, UnresolvedOrderOutcome


class CancelRest(FakeProtectedRest):
    def __init__(self, exchange="bybit"):
        super().__init__([[]])
        self.has["fetchOrder"] = True
        self.exchange = exchange
        self.status = "open"
        self.lookups = []
        self.cancels = []
        self.override = {}
        self.acknowledged_quantity = "0"

    def order(self):
        return {"id": "remote-owned", "clientOrderId": None, "symbol": next(iter(self.markets.values()))['symbol'], "side": "buy",
                "status": self.status, "amount": "1", "filled": "0", "average": None, **self.override}

    async def fetch_open_orders(self, symbol=None, since=None, limit=None, params=None):
        self.lookups.append(("active", symbol, params))
        return [self.order()] if symbol and params and self.status == "open" else []

    async def fetch_canceled_and_closed_orders(self, symbol, since, limit, params):
        self.lookups.append(("terminal", symbol, params))
        return [self.order()] if symbol and "orderId" in params and self.status != "open" else []

    async def fetch_order(self, identifier, symbol, params=None):
        self.lookups.append(("generic", symbol, params))
        if self.exchange == "bybit":
            raise AssertionError("UTA recent-order cache is not an authoritative cancel lookup.")
        return self.order()

    async def cancel_order(self, identifier, symbol):
        self.cancels.append((identifier, symbol))
        return {**self.order(), "status": "canceled", "filled": self.acknowledged_quantity}


class CancelRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_bybit_cancel_uses_exact_active_or_terminal_lookup_without_uta_cache(self):
        for status in ("open", "canceled"):
            with self.subTest(status=status):
                rest = CancelRest()
                rest.status = status
                result = await CcxtAdapter(FakeRegistry(rest)).cancel_order(
                    bound_test_account(), "local-owned", "BTCUSDT", deadline(), "remote-owned", "BTC/USDT:USDT")
                self.assertEqual(result["clientOrderId"], "local-owned")
                self.assertEqual(result["exchangeOrderId"], "remote-owned")
                self.assertEqual(result["status"], "cancelled")
                self.assertEqual(len(rest.cancels), 1 if status == "open" else 0)
                self.assertFalse(any(row[0] == "generic" for row in rest.lookups))

    async def test_all_profiles_reject_changed_identity_before_cancellation(self):
        for exchange in ("bybit", "hyperliquid", "krakenfutures"):
            for changed in ({"id": "foreign"}, {"clientOrderId": "foreign"}, {"symbol": "ETH/USDT:USDT"}):
                with self.subTest(exchange=exchange, changed=changed):
                    rest = CancelRest(exchange)
                    rest.override = changed
                    registry = FakeRegistry(rest, exchange)
                    with self.assertRaises(ExchangeContractError):
                        await CcxtAdapter(registry).cancel_order(
                            bound_test_account(exchange), "local-owned", "BTCUSDT", deadline(), "remote-owned", next(iter(rest.markets.values()))['symbol'])
                    self.assertEqual(rest.cancels, [])

    async def test_incomplete_cancel_acknowledgement_is_unresolved_without_write_retry(self):
        rest = CancelRest("hyperliquid")
        rest.acknowledged_quantity = None
        with self.assertRaises(UnresolvedOrderOutcome):
            await CcxtAdapter(FakeRegistry(rest, "hyperliquid")).cancel_order(
                bound_test_account("hyperliquid"), "local-owned", "BTCUSDT", deadline(), "remote-owned", "BTC/USDC:USDC")
        self.assertEqual(len(rest.cancels), 1)


if __name__ == "__main__":
    unittest.main()
