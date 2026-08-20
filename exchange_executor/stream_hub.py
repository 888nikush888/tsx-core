from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

from hyperliquid.info import Info
from hyperliquid.utils import constants
from pybit.unified_trading import WebSocket

from common import ExchangeContractError
from credentials import CredentialStore

MAX_BUFFERED_EVENTS = 2_000
MAX_EVENTS_PER_POLL = 500
MAX_EVENT_BYTES = 64 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
STREAM_RETRY_BASE_SECONDS = 1.0
STREAM_RETRY_MAX_SECONDS = 30.0


def _milliseconds(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    if parsed < 0:
        return fallback
    if parsed < 10_000_000_000:
        parsed *= 1_000
    return min(parsed, MAX_SAFE_INTEGER)


def _sequence(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if -MAX_SAFE_INTEGER <= parsed <= MAX_SAFE_INTEGER else None


def _canonical_payload(value: Any) -> tuple[Any, str]:
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)
    except (TypeError, ValueError):
        encoded = json.dumps({"unserializableType": type(value).__name__}, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    if len(encoded.encode("utf-8")) <= MAX_EVENT_BYTES:
        return json.loads(encoded), digest
    return {"truncated": True, "sha256": digest, "bytes": len(encoded.encode("utf-8"))}, digest


def _event_type(channel: str) -> str:
    normalized = channel.lower()
    if "fill" in normalized or "execution" in normalized:
        return "execution"
    if "order" in normalized:
        return "order"
    if "position" in normalized or "webdata" in normalized or "userstate" in normalized:
        return "position"
    if "candle" in normalized or "kline" in normalized:
        return "candle"
    if "mid" in normalized or "ticker" in normalized or "trade" in normalized:
        return "market"
    return "stream_status"


def _symbol(exchange: str, value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().upper().replace("/", "").replace("-", "")
    if exchange == "hyperliquid" and not normalized.endswith(("USD", "USDC", "USDT")):
        normalized = f"{normalized}USDC"
    if len(normalized) > 40 or not normalized.isalnum():
        return None
    return normalized


def _records(message: dict[str, Any]) -> list[dict[str, Any]]:
    data = message.get("data")
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)] or [message]
    if isinstance(data, dict):
        fills = data.get("fills")
        if isinstance(fills, list):
            return [item for item in fills if isinstance(item, dict)] or [data]
        return [data]
    return [message]

def _record_symbol(record: dict[str, Any]) -> Any:
    order = record.get("order")
    order_coin = order.get("coin") if isinstance(order, dict) else None
    return record.get("symbol") or record.get("coin") or record.get("s") or order_coin


@dataclass(frozen=True)
class StreamEvent:
    cursor: int
    event_key: str
    event_type: str
    symbol: str | None
    sequence: int | None
    occurred_at: int
    received_at: int
    payload: Any

    def as_dict(self) -> dict[str, Any]:
        return {
            "cursor": self.cursor,
            "eventKey": self.event_key,
            "eventType": self.event_type,
            "symbol": self.symbol,
            "sequence": self.sequence,
            "occurredAt": self.occurred_at,
            "receivedAt": self.received_at,
            "payload": self.payload,
        }


class AccountStream:
    def __init__(
        self,
        account: dict[str, str],
        secret: dict[str, Any],
        credential_fingerprint: str,
    ) -> None:
        self.account = dict(account)
        self.secret = dict(secret)
        self.credential_fingerprint = credential_fingerprint
        self._events: deque[StreamEvent] = deque(maxlen=MAX_BUFFERED_EVENTS)
        self._cursor = 0
        self._lock = threading.RLock()
        self._started_at: int | None = None
        self._last_event_at: int | None = None
        self._last_error: str | None = None
        self._status = "starting"
        self._starting = False
        self._closed = False
        self._clients: list[Any] = []
        self._public_client: Any | None = None
        self._public_symbols: set[str] = set()
        self._public_emitted_at: dict[str, int] = {}
        self._retry_attempt = 0
        self._next_retry_at = 0.0

    def ensure_started(self, symbols: list[str]) -> None:
        clients_to_close: list[Any] = []
        start_thread = False
        with self._lock:
            if self._closed:
                raise ExchangeContractError("Exchange stream is stopped.")
            new_symbols = set(symbols) - self._public_symbols
            if self._status == "healthy" and new_symbols:
                try:
                    self._subscribe_symbols(sorted(new_symbols))
                except Exception as error:
                    self._record_failure_locked("STREAM_SUBSCRIBE_FAILED", error)
                    clients_to_close = self._detach_clients_locked()
            if self._status == "healthy" and self._started_at is not None:
                return
            if not self._starting and time.monotonic() >= self._next_retry_at:
                if not clients_to_close:
                    clients_to_close = self._detach_clients_locked()
                self._starting = True
                start_thread = True
        self._close_clients(clients_to_close)
        if start_thread:
            threading.Thread(
                target=self._start,
                args=(symbols,),
                name=f"exchange-stream-{self.account['id']}",
                daemon=True,
            ).start()

    def _record_failure_locked(self, code: str, error: Exception) -> None:
        self._status = "degraded"
        self._started_at = None
        self._last_error = f"{code}: {type(error).__name__}"[:500]
        self._retry_attempt = min(self._retry_attempt + 1, 16)
        delay = min(
            STREAM_RETRY_MAX_SECONDS,
            STREAM_RETRY_BASE_SECONDS * (2 ** (self._retry_attempt - 1)),
        )
        self._next_retry_at = time.monotonic() + delay

    def _detach_clients_locked(self) -> list[Any]:
        clients = list(self._clients)
        self._clients.clear()
        self._public_client = None
        self._public_symbols.clear()
        return clients

    @staticmethod
    def _close_clients(clients: list[Any]) -> None:
        for client in clients:
            try:
                if isinstance(client, Info):
                    client.disconnect_websocket()
                elif hasattr(client, "exit"):
                    client.exit()
            except Exception:
                continue

    def _start(self, symbols: list[str]) -> None:
        clients_to_close: list[Any] = []
        try:
            if self.account["exchange"] == "bybit":
                self._start_bybit(symbols)
            else:
                self._start_hyperliquid(symbols)
            now = int(time.time() * 1_000)
            with self._lock:
                self._started_at = now
                self._status = "healthy"
                self._last_error = None
                self._retry_attempt = 0
                self._next_retry_at = 0.0
        except Exception as error:
            with self._lock:
                self._record_failure_locked("STREAM_INITIALIZATION_FAILED", error)
                clients_to_close = self._detach_clients_locked()
        finally:
            with self._lock:
                self._starting = False
            self._close_clients(clients_to_close)

    def _start_bybit(self, symbols: list[str]) -> None:
        options = {
            "testnet": self.account["mode"] == "testnet",
            "api_key": self.secret["apiKey"],
            "api_secret": self.secret["apiSecret"],
        }
        private = WebSocket(channel_type="private", **options)
        private.order_stream(self._callback("order"))
        private.execution_stream(self._callback("execution"))
        private.position_stream(self._callback("position"))
        public = WebSocket(
            channel_type="linear",
            testnet=self.account["mode"] == "testnet",
        )
        with self._lock:
            self._clients.extend([private, public])
            self._public_client = public
        self._subscribe_bybit_symbols(public, symbols)

    def _start_hyperliquid(self, symbols: list[str]) -> None:
        base_url = (
            constants.TESTNET_API_URL
            if self.account["mode"] == "testnet"
            else constants.MAINNET_API_URL
        )
        info = Info(base_url, skip_ws=False, timeout=10)
        address = self.secret["walletAddress"]
        info.subscribe({"type": "orderUpdates", "user": address}, self._callback("orderUpdates"))
        info.subscribe({"type": "userFills", "user": address}, self._callback("userFills"))
        info.subscribe({"type": "webData2", "user": address}, self._callback("webData2"))
        info.subscribe({"type": "allMids"}, self._callback("allMids"))
        with self._lock:
            self._clients.append(info)
            self._public_client = info
        self._subscribe_hyperliquid_symbols(info, symbols)

    def _subscribe_symbols(self, symbols: list[str]) -> None:
        if not symbols:
            return
        public = self._public_client
        if public is None:
            return
        if self.account["exchange"] == "bybit":
            self._subscribe_bybit_symbols(public, symbols)
        else:
            self._subscribe_hyperliquid_symbols(public, symbols)

    def _subscribe_bybit_symbols(self, public: Any, symbols: list[str]) -> None:
        additions = [symbol for symbol in symbols if symbol not in self._public_symbols]
        if not additions:
            return
        public.ticker_stream(symbol=additions, callback=self._callback("ticker"))
        public.kline_stream(interval=1, symbol=additions, callback=self._callback("kline"))
        with self._lock:
            self._public_symbols.update(additions)

    def _subscribe_hyperliquid_symbols(self, info: Info, symbols: list[str]) -> None:
        additions = [symbol for symbol in symbols if symbol not in self._public_symbols]
        for symbol in additions:
            coin = symbol
            for suffix in ("USDT", "USDC", "USD"):
                if coin.endswith(suffix):
                    coin = coin[: -len(suffix)]
                    break
            info.subscribe(
                {"type": "candle", "coin": coin, "interval": "1m"},
                self._callback("candle"),
            )
        with self._lock:
            self._public_symbols.update(additions)

    def _callback(self, channel_hint: str) -> Callable[[Any], None]:
        def callback(message: Any) -> None:
            try:
                self._ingest(channel_hint, message)
            except Exception as error:
                with self._lock:
                    self._record_failure_locked("STREAM_EVENT_REJECTED", error)

        return callback

    def _ingest(self, channel_hint: str, message: Any) -> None:
        received_at = int(time.time() * 1_000)
        if not isinstance(message, dict):
            message = {"data": message}
        channel = str(message.get("topic") or message.get("channel") or channel_hint)
        event_type = _event_type(channel)
        for record in _records(message):
            throttle_key = f"{event_type}:{_record_symbol(record) or channel}"
            if event_type in {"market", "candle"}:
                with self._lock:
                    previous_emit = self._public_emitted_at.get(throttle_key, 0)
                    if received_at - previous_emit < 1_000:
                        continue
                    self._public_emitted_at[throttle_key] = received_at
            payload, digest = _canonical_payload(
                {"channel": channel, "record": record, "messageId": message.get("id")}
            )
            occurred_at = _milliseconds(
                record.get("time")
                or record.get("timestamp")
                or record.get("execTime")
                or record.get("updatedTime")
                or message.get("creationTime"),
                received_at,
            )
            symbol = _symbol(
                self.account["exchange"],
                _record_symbol(record),
            )
            sequence = _sequence(
                record.get("seq")
                or record.get("sequence")
                or message.get("seq")
                or message.get("creationTime")
            )
            event_key = hashlib.sha256(
                f"{self.account['exchange']}|{self.account['id']}|{event_type}|{digest}".encode("utf-8")
            ).hexdigest()
            with self._lock:
                self._cursor += 1
                self._events.append(
                    StreamEvent(
                        cursor=self._cursor,
                        event_key=event_key,
                        event_type=event_type,
                        symbol=symbol,
                        sequence=sequence,
                        occurred_at=occurred_at,
                        received_at=received_at,
                        payload=payload,
                    )
                )
                self._last_event_at = received_at
                self._last_error = None
                self._status = "healthy"

    def poll(self, cursor: int) -> dict[str, Any]:
        with self._lock:
            earliest = self._events[0].cursor if self._events else self._cursor + 1
            gap = cursor > self._cursor or (cursor > 0 and cursor < earliest - 1)
            events = [event for event in self._events if event.cursor > cursor][:MAX_EVENTS_PER_POLL]
            next_cursor = events[-1].cursor if events else self._cursor
            return {
                "events": [event.as_dict() for event in events],
                "nextCursor": next_cursor,
                "gap": gap,
                "health": {
                    "status": self._status,
                    "startedAt": self._started_at,
                    "lastEventAt": self._last_event_at,
                    "lastError": self._last_error,
                },
            }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._status = "stopped"
            clients = self._detach_clients_locked()
        self._close_clients(clients)


class ExchangeStreamHub:
    def __init__(self, credentials: CredentialStore) -> None:
        self.credentials = credentials
        self._streams: dict[str, AccountStream] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _credential_fingerprint(
        account: dict[str, str],
        secret: dict[str, Any],
    ) -> str:
        content = json.dumps(
            {"account": account, "secret": secret},
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def poll(
        self,
        account: dict[str, str],
        cursor: int,
        symbols: list[str],
    ) -> dict[str, Any]:
        if not isinstance(cursor, int) or cursor < 0 or cursor > MAX_SAFE_INTEGER:
            raise ExchangeContractError("cursor must be a non-negative safe integer.")
        if (
            not isinstance(symbols, list)
            or len(symbols) > 100
            or any(
                not isinstance(symbol, str)
                or len(symbol) > 40
                or not symbol.isalnum()
                or not symbol.endswith(("USD", "USDC", "USDT"))
                for symbol in symbols
            )
        ):
            raise ExchangeContractError("symbols must contain at most 100 normalized USD pairs.")
        secret = self.credentials.account(account["id"], account["exchange"])
        fingerprint = self._credential_fingerprint(account, secret)
        with self._lock:
            stream = self._streams.get(account["id"])
            if stream and stream.credential_fingerprint != fingerprint:
                stream.close()
                stream = None
            if stream is None:
                stream = AccountStream(account, secret, fingerprint)
                self._streams[account["id"]] = stream
        normalized_symbols = sorted(set(symbols))
        stream.ensure_started(normalized_symbols)
        return stream.poll(cursor)

    def close(self) -> None:
        with self._lock:
            streams = list(self._streams.values())
            self._streams.clear()
        for stream in streams:
            stream.close()
