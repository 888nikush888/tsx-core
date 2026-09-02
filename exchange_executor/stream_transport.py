"""Observe CCXT's shared subscription transport without manufacturing trade events.

CCXT watch methods return only when data changes, not when a quiet subscription
reconnects. Keep that distinction here, for both watch and watch_multiple and
without exchange-specific URL, payload or topic parsing. CCXT is version-pinned;
the tests exercise these hooks against its actual base implementation.
"""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from inspect import signature
from typing import Any


@dataclass
class SubscriptionAttempt:
    key: tuple[str, tuple[str, ...]]
    client: Any
    future: Any = None
    sent: bool = False

    def ready(self) -> bool:
        connected = self.client.connected
        return bool(
            self.sent
            and self.future is not None and not self.future.done()
            and connected.done() and not connected.cancelled()
            and connected.exception() is None
            and self.client.error is None and not self.client.closed()
            and all(key in self.client.subscriptions for key in self.key[1])
        )


class StreamTransportObserver:
    def __init__(self, pro: Any) -> None:
        self.pro = pro
        self.channel: ContextVar[str | None] = ContextVar("stream_channel", default=None)
        self._sending: ContextVar[SubscriptionAttempt | None] = ContextVar("stream_send", default=None)
        self._attempts: dict[str, SubscriptionAttempt] = {}
        self._originals: dict[str, Any] = {}
        # Keep only current CCXT clients. Old socket hooks are self-contained and
        # do not retain the observer after the owning AccountStream is closed.
        self._send_hooks: dict[Any, tuple[Any, set[tuple[str, tuple[str, ...]]]]] = {}
        for name in ("watch", "watch_multiple"):
            original = getattr(pro, name, None)
            if callable(original):
                self._originals[name] = original
                setattr(pro, name, self._wrap(name, original))
        authenticate = getattr(pro, "authenticate", None)
        if callable(authenticate):
            self._originals["authenticate"] = authenticate

            async def authentication(*args: Any, **kwargs: Any) -> Any:
                token = self.channel.set(None)
                try:
                    return await authenticate(*args, **kwargs)
                finally:
                    self.channel.reset(token)

            pro.authenticate = authentication

    def begin(self, channel: str) -> None:
        self._attempts.pop(channel, None)

    def key(self, channel: str) -> tuple[str, tuple[str, ...]] | None:
        attempt = self._attempts.get(channel)
        return attempt.key if attempt else None

    def recovered(self, channel: str, failed_key: tuple[str, tuple[str, ...]] | None) -> bool:
        attempt = self._attempts.get(channel)
        # A failure before the first subscription (e.g. during authentication)
        # has no topic yet. Only the later data subscription can prove recovery.
        return bool(attempt and (failed_key is None or failed_key == attempt.key) and attempt.ready())

    def _send_history(self, client: Any) -> set[tuple[str, tuple[str, ...]]]:
        for old in list(self._send_hooks):
            if old is not client and old.closed():
                original, _ = self._send_hooks.pop(old)
                old.send = original
        if client not in self._send_hooks:
            original = client.send
            sent: set[tuple[str, tuple[str, ...]]] = set()
            sending = self._sending

            async def send(*args: Any, **kwargs: Any) -> Any:
                result = await original(*args, **kwargs)
                attempt = sending.get()
                if attempt is not None and attempt.client is client:
                    attempt.sent = True
                    sent.add(attempt.key)
                return result

            client.send = send
            self._send_hooks[client] = (original, sent)
        return self._send_hooks[client][1]

    def _wrap(self, name: str, original: Any) -> Any:
        call_signature = signature(original)
        subscription_name = "subscribe_hash" if name == "watch" else "subscribe_hashes"

        def watch(*args: Any, **kwargs: Any) -> Any:
            channel = self.channel.get()
            if channel is None:
                return original(*args, **kwargs)
            arguments = call_signature.bind(*args, **kwargs).arguments
            subscribe_hashes = arguments.get(subscription_name)
            if subscribe_hashes is None:
                return original(*args, **kwargs)
            keys = [subscribe_hashes] if name == "watch" else subscribe_hashes
            client = self.pro.client(arguments["url"])
            key = (name, tuple(keys))
            sent = self._send_history(client)
            reused = key in sent and all(item in client.subscriptions for item in keys)
            attempt = SubscriptionAttempt(key, client, sent=reused)
            self._attempts[channel] = attempt
            token = self._sending.set(attempt)
            try:
                attempt.future = original(*args, **kwargs)
            finally:
                self._sending.reset(token)
            return attempt.future

        return watch

    def close(self) -> None:
        for name, original in self._originals.items():
            setattr(self.pro, name, original)
        for client, (original, _) in self._send_hooks.items():
            client.send = original
        self._send_hooks.clear()
        self._attempts.clear()
