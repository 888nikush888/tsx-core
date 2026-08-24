from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro

from common import ExchangeContractError, external_account_cache_key
from credentials import CredentialStore

CERTIFIED_EXCHANGES = {"hyperliquid", "bybit", "krakenfutures"}
REQUIRED_REST_CAPABILITIES = (
    "fetchBalance",
    "fetchPositions",
    "fetchOpenOrders",
    "fetchMyTrades",
    "createOrder",
    "createOrders",
    "cancelOrder",
    "setLeverage",
)
REQUIRED_PRO_CAPABILITIES = (
    "watchOrders",
    "watchMyTrades",
    "watchPositions",
)


def _credential_fingerprint(secret: dict[str, Any], exchange: str, mode: str) -> str:
    canonical = json.dumps(secret, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return external_account_cache_key(exchange, mode, hashlib.sha256(canonical.encode("utf-8")).hexdigest())


def _account_identity(secret: dict[str, Any], exchange: str, _mode: str) -> str:
    # This value is only retained inside the executor process. The adapter
    # applies external_account_id exactly once before it crosses the trust
    # boundary, preserving bindings created by the certified native adapters.
    return secret["walletAddress"].lower() if exchange == "hyperliquid" else secret["apiKey"]


def _client_configuration(account: dict[str, str], secret: dict[str, Any]) -> dict[str, Any]:
    options: dict[str, Any] = {"defaultType": "swap"}
    configuration: dict[str, Any] = {
        "enableRateLimit": True,
        "timeout": 10_000,
        "options": options,
    }
    if account["exchange"] == "hyperliquid":
        configuration.update({
            "privateKey": secret["privateKey"],
            "walletAddress": secret["walletAddress"],
        })
        # CCXT's optional Hyperliquid builder integration must never charge a
        # fee for TSX Core orders.
        options.update({"builderFee": False, "approvedBuilderFee": False})
    else:
        configuration.update({"apiKey": secret["apiKey"], "secret": secret["apiSecret"]})
        if account["exchange"] == "bybit":
            options.update({"defaultSubType": "linear", "defaultSettle": "USDT"})
    return configuration


def _assert_capabilities(client: Any, required: tuple[str, ...], label: str) -> None:
    missing = [name for name in required if client.has.get(name) is not True]
    if missing:
        raise ExchangeContractError(f"{label} lacks certified CCXT capabilities: {', '.join(missing)}")


def decimal_text(value: Any, default: str = "0") -> str:
    if value is None or value == "":
        return default
    try:
        number = Decimal(str(value))
    except Exception as error:
        raise ExchangeContractError("CCXT returned an invalid decimal value.") from error
    if not number.is_finite():
        raise ExchangeContractError("CCXT returned a non-finite decimal value.")
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return "0" if rendered in {"", "-0"} else rendered


@dataclass
class AccountClients:
    account: dict[str, str]
    credential_fingerprint: str
    account_identity: str
    rest: Any
    pro: Any
    lock: asyncio.Lock
    markets_loaded: bool = False
    market_load_task: asyncio.Task[None] | None = None

    async def load_markets(self) -> None:
        if self.markets_loaded:
            return
        async with self.lock:
            if self.markets_loaded:
                return
            if self.market_load_task is None:
                self.market_load_task = asyncio.create_task(self._load_markets())
            task = self.market_load_task
        try:
            # An HTTP request deadline must not cancel the shared market
            # bootstrap for every concurrent REST and Pro consumer. Later
            # callers await the same task and never observe a half-initialized
            # CCXT client from the registry cache.
            await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        except Exception:
            async with self.lock:
                if self.market_load_task is task:
                    self.market_load_task = None
            raise

    async def _load_markets(self) -> None:
        await asyncio.gather(self.rest.load_markets(), self.pro.load_markets())
        self.markets_loaded = True

    async def close(self) -> None:
        async with self.lock:
            task = self.market_load_task
            self.market_load_task = None
        if task is not None and not task.done():
            task.cancel()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        await asyncio.gather(self.rest.close(), self.pro.close(), return_exceptions=True)


class CcxtClientRegistry:
    def __init__(self, credentials: CredentialStore) -> None:
        self.credentials = credentials
        self._clients: dict[str, AccountClients] = {}
        self._lock = asyncio.Lock()

    async def account(self, account: dict[str, str]) -> AccountClients:
        exchange = account["exchange"]
        if exchange not in CERTIFIED_EXCHANGES:
            raise ExchangeContractError("Exchange is not in the certified CCXT allowlist.")
        secret = self.credentials.account(account["id"], exchange)
        fingerprint = _credential_fingerprint(secret, exchange, account["mode"])
        cache_key = account["id"]
        async with self._lock:
            existing = self._clients.get(cache_key)
            if existing and existing.credential_fingerprint == fingerprint:
                clients = existing
            else:
                if existing:
                    await existing.close()
                configuration = _client_configuration(account, secret)
                rest_class = getattr(ccxt_async, exchange, None)
                pro_class = getattr(ccxt_pro, exchange, None)
                if rest_class is None or pro_class is None:
                    raise ExchangeContractError("Certified CCXT exchange class is unavailable.")
                rest = rest_class(configuration)
                pro = pro_class(configuration)
                if account["mode"] == "testnet":
                    try:
                        rest.set_sandbox_mode(True)
                        pro.set_sandbox_mode(True)
                    except Exception as error:
                        await asyncio.gather(rest.close(), pro.close(), return_exceptions=True)
                        raise ExchangeContractError("Exchange testnet mode is not supported by CCXT.") from error
                _assert_capabilities(rest, REQUIRED_REST_CAPABILITIES, f"{exchange} REST")
                _assert_capabilities(pro, REQUIRED_PRO_CAPABILITIES, f"{exchange} Pro")
                clients = AccountClients(
                    dict(account), fingerprint, _account_identity(secret, exchange, account["mode"]),
                    rest, pro, asyncio.Lock(),
                )
                self._clients[cache_key] = clients
        try:
            await clients.load_markets()
            return clients
        except asyncio.CancelledError:
            # AccountClients shields the shared bootstrap task. Keeping this
            # cache entry lets the next bounded request await that same task.
            raise
        except Exception:
            async with self._lock:
                if self._clients.get(cache_key) is clients:
                    self._clients.pop(cache_key, None)
            await clients.close()
            raise

    async def close(self) -> None:
        async with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)
