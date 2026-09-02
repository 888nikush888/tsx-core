from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import ccxt.pro as ccxt_pro
from ccxt.async_support.base.ws.client import Client
from ccxt.base.errors import AuthenticationError, NetworkError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_profiles import PROFILES
from stream_hub import AccountStream


async def settle(predicate) -> None:
    for _ in range(100):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("Async watcher did not reach the expected state")


class Harness:
    """Real, pinned CCXT watch/watch_multiple dispatch with only network I/O faked."""

    def __init__(self, exchange: str):
        self.pro = getattr(ccxt_pro, exchange)({"enableRateLimit": False})
        self.original_watch = self.pro.watch
        self.original_multiple = self.pro.watch_multiple
        self.pro.open = lambda: None
        self.pro.check_ws_proxy_settings = lambda: (None, None, None)
        self.socket = self.new_socket()
        self.pro.client = lambda _url: self.socket
        self.require_auth = False

        async def authenticate():
            return await self.pro.watch("wss://fixture.invalid", "auth", {"op": "auth"}, "auth")

        self.pro.authenticate = authenticate
        self.now = 100.0
        self.retries = asyncio.Queue()
        self.resume = asyncio.Queue()
        self.stream = AccountStream(
            {"id": "test-account", "exchange": exchange, "mode": "testnet"},
            SimpleNamespace(pro=self.pro, credential_fingerprint="fixture"),
            monotonic=lambda: self.now, retry_sleep=self.retry,
        )
        self.stream._status = "healthy"
        self.multiple = exchange != "hyperliquid"
        self.topic = "orders"

    @staticmethod
    def new_socket(block_send: bool = False) -> Client:
        client = Client("wss://fixture.invalid", lambda *_: None, lambda *_: None,
                        lambda *_: None, lambda *_: None)
        client.connection = SimpleNamespace(closed=False)
        client.connected.resolve("fixture")
        client.sent = False
        client.allow_send = asyncio.Event()
        if not block_send:
            client.allow_send.set()

        async def send(_message):
            await client.allow_send.wait()
            client.sent = True

        client.send = send
        return client

    async def retry(self, delay: float) -> None:
        self.retries.put_nowait(delay)
        await self.resume.get()

    async def operation(self):
        if self.require_auth:
            await self.pro.authenticate()
        if self.multiple:
            return await self.pro.watch_multiple(
                "wss://fixture.invalid", [self.topic], {"subscribe": self.topic}, [self.topic],
            )
        return await self.pro.watch(
            url="wss://fixture.invalid", message_hash=self.topic,
            message={"subscribe": self.topic}, subscribe_hash=self.topic,
        )

    async def start(self) -> None:
        self.stream._tasks["orders"] = asyncio.create_task(self.stream._watch("orders", self.operation))
        await settle(lambda: self.socket.sent)

    async def fail(self, error: Exception) -> float:
        self.socket.reject(error)
        self.socket.error = error
        self.socket.connection.closed = True
        return await asyncio.wait_for(self.retries.get(), 1)

    async def reconnect(self, *, block_send: bool = False) -> None:
        self.socket = self.new_socket(block_send)
        self.resume.put_nowait(None)
        await settle(lambda: self.topic in self.socket.subscriptions)
        if not block_send:
            await settle(lambda: self.socket.sent)

    def status(self) -> str:
        return self.stream.poll(0)["health"]["status"]

    async def close(self) -> None:
        await self.stream.close()
        for future in self.socket.futures.values():
            future.cancel()
        await self.pro.close()


class StreamTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_quiet_reconnect_recovers_without_an_order_for_every_profile(self):
        for exchange in PROFILES:
            for downtime in (1.0, 16.0):
                with self.subTest(exchange=exchange, downtime=downtime):
                    harness = Harness(exchange)
                    try:
                        await harness.start()
                        self.assertEqual(await harness.fail(NetworkError("disconnect")), 1)
                        harness.now += downtime
                        self.assertEqual(harness.status(), "healthy" if downtime < 15 else "degraded")
                        await harness.reconnect()
                        harness.now += 60
                        self.assertEqual(harness.status(), "healthy")
                        self.assertEqual(harness.stream.poll(0)["events"], [])
                        self.assertEqual(harness.stream.poll(0)["nextCursor"], 0)
                    finally:
                        await harness.close()
                    self.assertEqual(harness.pro.watch, harness.original_watch)
                    self.assertEqual(harness.pro.watch_multiple, harness.original_multiple)

    async def test_socket_open_or_other_channel_success_is_not_a_sent_subscription(self):
        harness = Harness("bybit")
        try:
            await harness.start()
            await harness.fail(NetworkError("disconnect"))
            harness.now += 16
            await harness.reconnect(block_send=True)
            harness.stream._record_channel_success("positions")
            self.assertEqual(harness.status(), "degraded")
            harness.socket.allow_send.set()
            await settle(lambda: harness.socket.sent)
            self.assertEqual(harness.status(), "healthy")
        finally:
            await harness.close()

    async def test_different_subscription_and_failed_socket_cannot_recover(self):
        harness = Harness("krakenfutures")
        try:
            await harness.start()
            await harness.fail(NetworkError("disconnect"))
            harness.now += 16
            harness.topic = "authentication"
            await harness.reconnect()
            self.assertEqual(harness.status(), "degraded", "An auth handshake is not the orders subscription")
            await harness.fail(NetworkError("still offline"))
            await harness.reconnect()
            harness.socket.error = NetworkError("failed send")
            self.assertEqual(harness.status(), "degraded")
            harness.socket.error = None
            harness.socket.connection.closed = True
            self.assertEqual(harness.status(), "degraded")
        finally:
            await harness.close()

    async def test_authentication_and_contract_errors_require_actual_channel_success(self):
        for error in (AuthenticationError("invalid key"), ValueError("invalid payload")):
            harness = Harness("hyperliquid")
            try:
                await harness.start()
                await harness.fail(error)
                harness.now += 16
                await harness.reconnect()
                self.assertEqual(harness.status(), "degraded")
                await harness.fail(NetworkError("later network error"))
                await harness.reconnect()
                self.assertEqual(harness.status(), "degraded", "A network retry must not clear a prior auth/contract error")
                harness.socket.resolve([], "orders")
                await settle(lambda: harness.status() == "healthy")
                self.assertEqual(harness.stream.poll(0)["events"], [])
            finally:
                await harness.close()

    async def test_retry_backoff_stays_bounded_and_degradation_is_not_reset(self):
        harness = Harness("bybit")
        try:
            await harness.start()
            for attempt in range(8):
                self.assertEqual(await harness.fail(NetworkError("offline")), min(30, 2 ** attempt))
                harness.now += 5
                if attempt >= 2:
                    self.assertEqual(harness.status(), "degraded")
                await harness.reconnect()
            self.assertEqual(harness.status(), "healthy")
        finally:
            await harness.close()

    async def test_authentication_is_never_mistaken_for_the_data_subscription(self):
        for initial_auth_failure in (True, False):
            harness = Harness("bybit")
            try:
                harness.require_auth = initial_auth_failure
                await harness.start()
                await harness.fail(NetworkError("connection reset"))
                harness.now += 16
                harness.require_auth = True
                harness.socket = harness.new_socket()
                harness.resume.put_nowait(None)
                await settle(lambda: harness.socket.sent)
                self.assertEqual(harness.status(), "degraded", "Sending authentication alone is not recovery")
                harness.socket.resolve(True, "auth")
                await settle(lambda: harness.status() == "healthy")
                self.assertIn("orders", harness.socket.subscriptions)
            finally:
                await harness.close()


if __name__ == "__main__":
    unittest.main()
