from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import deque
from typing import Any, Awaitable, Callable

from ccxt.base.errors import NetworkError

from ccxt_adapter import CcxtAdapter, _canonical_symbol
from ccxt_client import AccountClients, CcxtClientRegistry
from common import ExchangeContractError
from stream_transport import StreamTransportObserver

MAX_BUFFERED_EVENTS = 2_000
MAX_EVENTS_PER_POLL = 500
MAX_EVENT_BYTES = 64 * 1024
STREAM_RETRY_MAX_SECONDS = 30.0
STREAM_DEGRADED_GRACE_SECONDS = 15.0


def _canonical_payload(value: Any) -> tuple[Any, str]:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    size = len(encoded.encode("utf-8"))
    if size <= MAX_EVENT_BYTES:
        return json.loads(encoded), digest
    return {"truncated": True, "sha256": digest, "bytes": size}, digest


def _event_type(channel: str) -> str:
    return {
        "orders": "order",
        "trades": "execution",
        "positions": "position",
        "tickers": "market",
    }.get(channel, "stream_status")


def _records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        if value and all(isinstance(item, dict) for item in value.values()) and "symbol" not in value:
            return list(value.values())
        return [value]
    return [{"value": value}]


class AccountStream:
    def __init__(
        self,
        account: dict[str, str],
        clients: AccountClients,
        *,
        monotonic: Callable[[], float] | None = None,
        retry_sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.account = dict(account)
        self.clients = clients
        self.credential_fingerprint = clients.credential_fingerprint
        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_BUFFERED_EVENTS)
        self._cursor = 0
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._symbols: set[str] = set()
        self._started_at: int | None = None
        self._last_event_at: int | None = None
        self._status = "starting"
        self._monotonic = monotonic or time.monotonic
        self._channel_failures: dict[str, tuple[float, str]] = {}
        self._network_retries: dict[str, tuple[str, tuple[str, ...]] | None] = {}
        self._transport = StreamTransportObserver(clients.pro)
        self._retry_sleep = retry_sleep
        self._closed = False
        self._lock = asyncio.Lock()

    async def ensure_started(self, symbols: list[str]) -> None:
        if self._closed:
            raise ExchangeContractError("Exchange stream is stopped.")
        async with self._lock:
            if not self._tasks:
                self._started_at = int(time.time() * 1_000)
                self._tasks["orders"] = asyncio.create_task(
                    self._watch("orders", self.clients.pro.watch_orders), name=f"ccxt-pro-orders-{self.account['id']}",
                )
                self._tasks["trades"] = asyncio.create_task(
                    self._watch("trades", self.clients.pro.watch_my_trades), name=f"ccxt-pro-trades-{self.account['id']}",
                )
                self._tasks["positions"] = asyncio.create_task(
                    self._watch("positions", self.clients.pro.watch_positions), name=f"ccxt-pro-positions-{self.account['id']}",
                )
                self._status = "healthy"
            requested = set(symbols)
            if requested != self._symbols:
                self._symbols = requested
                ticker = self._tasks.pop("tickers", None)
                if ticker:
                    ticker.cancel()
                self._record_channel_success("tickers")
                if requested and self.clients.pro.has.get("watchTickers") is True:
                    provider_symbols = [CcxtAdapter._market(self.clients, symbol)["symbol"] for symbol in sorted(requested)]
                    self._tasks["tickers"] = asyncio.create_task(
                        self._watch("tickers", lambda: self.clients.pro.watch_tickers(provider_symbols)),
                        name=f"ccxt-pro-tickers-{self.account['id']}",
                    )

    async def _watch(self, channel: str, operation: Callable[[], Awaitable[Any]]) -> None:
        attempt = 0
        while not self._closed:
            self._transport.begin(channel)
            token = self._transport.channel.set(channel)
            try:
                value = await operation()
                attempt = 0
                self._record_channel_success(channel)
                self._ingest(channel, value)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                attempt = min(attempt + 1, 16)
                self._record_channel_failure(channel, error)
                await self._retry_sleep(min(STREAM_RETRY_MAX_SECONDS, 2 ** (attempt - 1)))
            finally:
                self._transport.channel.reset(token)

    def _record_channel_success(self, channel: str) -> None:
        self._channel_failures.pop(channel, None)
        self._network_retries.pop(channel, None)

    def _record_channel_failure(self, channel: str, error: Exception) -> None:
        message = f"CCXT_PRO_{channel.upper()}_FAILED: {type(error).__name__}"[:500]
        recoverable = isinstance(error, NetworkError) and (
            channel not in self._channel_failures or channel in self._network_retries
        )
        first_failed_at = self._channel_failures.get(channel, (self._monotonic(), message))[0]
        self._channel_failures[channel] = (first_failed_at, message)
        self._network_retries.pop(channel, None)
        if recoverable:
            self._network_retries[channel] = self._transport.key(channel)

    def _health(self) -> tuple[str, str | None]:
        if self._status != "healthy":
            return self._status, None
        for channel, key in list(self._network_retries.items()):
            if self._transport.recovered(channel, key):
                self._record_channel_success(channel)
                print(
                    f"executor_stream_transport_recovered exchange={self.account['exchange']} channel={channel}",
                    flush=True,
                )
        now = self._monotonic()
        sustained = sorted(
            (
                (channel, first_failed_at, message)
                for channel, (first_failed_at, message) in self._channel_failures.items()
                if now - first_failed_at >= STREAM_DEGRADED_GRACE_SECONDS
            ),
            key=lambda item: (item[1], item[0]),
        )
        if not sustained:
            return "healthy", None
        return "degraded", sustained[0][2]

    def _ingest(self, channel: str, value: Any) -> None:
        received_at = int(time.time() * 1_000)
        event_type = _event_type(channel)
        for record in _records(value):
            payload, digest = _canonical_payload({"channel": channel, "record": record})
            symbol = None
            provider_symbol = record.get("symbol")
            if isinstance(provider_symbol, str):
                try:
                    symbol = _canonical_symbol(self.clients.pro.market(provider_symbol))
                except Exception:
                    symbol = None
            occurred_at = record.get("timestamp") or received_at
            try:
                occurred_at = int(occurred_at)
            except (TypeError, ValueError):
                occurred_at = received_at
            sequence_value = record.get("nonce") or record.get("sequence")
            sequence = int(sequence_value) if isinstance(sequence_value, int) and not isinstance(sequence_value, bool) else None
            event_key = hashlib.sha256(
                f"ccxt-pro|{self.account['exchange']}|{self.account['id']}|{event_type}|{digest}".encode("utf-8")
            ).hexdigest()
            self._cursor += 1
            self._events.append({
                "cursor": self._cursor,
                "eventKey": event_key,
                "eventType": event_type,
                "symbol": symbol,
                "sequence": sequence,
                "occurredAt": occurred_at,
                "receivedAt": received_at,
                "payload": payload,
            })
            self._last_event_at = received_at

    def poll(self, cursor: int) -> dict[str, Any]:
        status, last_error = self._health()
        first = self._events[0]["cursor"] if self._events else self._cursor + 1
        gap = cursor > self._cursor or (cursor + 1 < first)
        events = [] if gap else [event for event in self._events if event["cursor"] > cursor][:MAX_EVENTS_PER_POLL]
        next_cursor = self._cursor if gap else (events[-1]["cursor"] if events else cursor)
        return {
            "events": events,
            "nextCursor": next_cursor,
            "gap": gap,
            "health": {
                "status": status,
                "startedAt": self._started_at,
                "lastEventAt": self._last_event_at,
                "lastError": last_error,
            },
        }

    async def close(self) -> None:
        self._closed = True
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._transport.close()
        self._status = "stopped"


class ExchangeStreamHub:
    def __init__(self, registry: CcxtClientRegistry) -> None:
        self.registry = registry
        self._streams: dict[str, AccountStream] = {}
        self._lock = asyncio.Lock()

    async def poll(self, account: dict[str, str], cursor: int, symbols: list[str]) -> dict[str, Any]:
        if cursor < 0 or len(symbols) > 100 or any(not isinstance(symbol, str) for symbol in symbols):
            raise ExchangeContractError("Invalid stream polling contract.")
        clients = await self.registry.account(account)
        async with self._lock:
            stream = self._streams.get(account["id"])
            if stream and stream.credential_fingerprint != clients.credential_fingerprint:
                await stream.close()
                stream = None
            if stream is None:
                stream = AccountStream(account, clients)
                self._streams[account["id"]] = stream
        await stream.ensure_started(symbols)
        return stream.poll(cursor)

    async def close(self) -> None:
        async with self._lock:
            streams = list(self._streams.values())
            self._streams.clear()
        await asyncio.gather(*(stream.close() for stream in streams), return_exceptions=True)
