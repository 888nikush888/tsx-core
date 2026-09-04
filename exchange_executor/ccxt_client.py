from __future__ import annotations

import asyncio
import json
import hmac
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any

import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro
from ccxt.async_support.base.exchange import Exchange as CcxtExchange

from ccxt_capabilities import PRO_CAPABILITIES, REST_CAPABILITIES
from ccxt_profiles import PROFILES, ExchangeProfile, profile_for
from ccxt_registry import CcxtExchangeRegistry
from ccxt_sdk_policy import client_class
from common import ExchangeContractError, RequestDeadline, external_account_cache_key, external_account_id
from credentials import CredentialStore

CERTIFIED_EXCHANGES = set(PROFILES)
REQUIRED_REST_CAPABILITIES = REST_CAPABILITIES
REQUIRED_PRO_CAPABILITIES = PRO_CAPABILITIES


def _credential_fingerprint(secret: dict[str, Any], exchange: str, mode: str) -> str:
    canonical = json.dumps(secret, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return external_account_cache_key(exchange, mode, canonical)


def credential_generation(clients: AccountClients) -> str:
    return external_account_cache_key("credential-generation", "v1", clients.credential_fingerprint)


def _account_identity(secret: dict[str, Any], exchange: str, _mode: str) -> str:
    # This value is only retained inside the executor process. The adapter
    # applies external_account_id exactly once before it crosses the trust
    # boundary, preserving bindings created by the certified native adapters.
    profile = profile_for(exchange)
    if profile is None:
        raise ExchangeContractError("Exchange has no certified identity profile.")
    if profile.identity_strategy == "wallet_address":
        return secret["walletAddress"].lower()
    # Existing bindings intentionally retain the credential-binding semantics
    # of the first rollout. Phase 2 does not migrate external account ids.
    if profile.identity_strategy == "credential_binding":
        return secret["apiKey"]
    for field in ("uid", "accountId", "login"):
        if secret.get(field):
            return str(secret[field])
    raise ExchangeContractError("Certified account identity cannot be derived from credentials.")


def _assert_hyperliquid_master_key_binding(secret: dict[str, Any], exchange: str) -> None:
    if exchange != "hyperliquid":
        return
    try:
        private_key = str(secret["privateKey"])
        wallet_address = str(secret["walletAddress"])
        if not private_key.startswith("0x") or len(private_key) != 66:
            raise ValueError("invalid private key")
        # Use the cryptographic primitive shipped with the exact pinned CCXT
        # runtime rather than a second wallet library or an SDK client object.
        derived_address = CcxtExchange.eth_get_address_from_private_key(private_key)
    except Exception as error:
        raise ExchangeContractError(
            "Hyperliquid credentials are not bound to the configured master wallet."
        ) from error
    if not hmac.compare_digest(derived_address.lower(), wallet_address.lower()):
        raise ExchangeContractError(
            "Hyperliquid credentials are not bound to the configured master wallet."
        )


def _client_configuration(account: dict[str, str], secret: dict[str, Any]) -> dict[str, Any]:
    profile = profile_for(account["exchange"])
    if profile is None:
        raise ExchangeContractError("Exchange has no certified TSX profile.")
    options = profile.client_options()
    configuration: dict[str, Any] = {
        "enableRateLimit": True,
        "timeout": 10_000,
        "options": options,
    }
    configuration.update(secret)
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
    profile: ExchangeProfile
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
    def __init__(
        self,
        credentials: CredentialStore,
        exchange_catalog: CcxtExchangeRegistry | None = None,
    ) -> None:
        self.credentials = credentials
        self.exchange_catalog = exchange_catalog or CcxtExchangeRegistry()
        self._clients: dict[str, AccountClients] = {}
        self._lock = asyncio.Lock()
        self._account_locks: dict[str, asyncio.Lock] = {}
        self._closing = False

    async def account(self, account: dict[str, str]) -> AccountClients:
        async with self._account_locks.setdefault(account["id"], asyncio.Lock()):
            return await self._account_locked(account)

    @asynccontextmanager
    async def mutation(self, account: dict[str, str], deadline: RequestDeadline):
        # The lease pins the client until the entire side-effecting request has
        # settled. A concurrent read/rotation cannot close it mid-dispatch.
        lock = self._account_locks.setdefault(account["id"], asyncio.Lock())
        await asyncio.wait_for(lock.acquire(), timeout=deadline.sdk_timeout_seconds())
        try:
            clients = await asyncio.wait_for(self._account_locked(account), timeout=deadline.sdk_timeout_seconds())
            self.assert_binding(account, clients)
            # Keep per-request binding off the shared read/stream client object.
            yield replace(clients, account=dict(account))
        finally:
            lock.release()

    def assert_binding(self, account: dict[str, str], clients: AccountClients) -> None:
        expected = account.get("expectedAccountFingerprint")
        generation = account.get("credentialGeneration")
        identity = external_account_id(account["exchange"], account["mode"], clients.account_identity)
        if not expected or not generation:
            raise ExchangeContractError("A verified account fingerprint and credential generation are required for writes.")
        if not hmac.compare_digest(expected, identity) or not hmac.compare_digest(generation, credential_generation(clients)):
            raise ExchangeContractError("Account fingerprint or credential generation changed before the exchange mutation.")
        secret = self.credentials.account(account["id"], account["exchange"])["credentials"]
        current = _credential_fingerprint(secret, account["exchange"], account["mode"])
        if not hmac.compare_digest(current, clients.credential_fingerprint):
            raise ExchangeContractError("Credentials changed while the exchange mutation was being prepared.")

    async def _account_locked(self, account: dict[str, str]) -> AccountClients:
        if self._closing:
            raise ExchangeContractError("Exchange client registry is shutting down.")
        exchange = account["exchange"]
        descriptor = self.exchange_catalog.descriptor(exchange)
        if descriptor is None or descriptor.get("status") != "certified":
            raise ExchangeContractError("Exchange is not certified for TSX trading.")
        if account["mode"] not in descriptor.get("modes", []):
            raise ExchangeContractError("Account mode is not certified for this exchange.")
        secret = self.credentials.account(account["id"], exchange)["credentials"]
        # The currently certified Hyperliquid scope is deliberately master-key
        # only. Agent-wallet keys remain quarantined until their grant can be
        # read back and bound to the same credential generation.
        _assert_hyperliquid_master_key_binding(secret, exchange)
        fingerprint = _credential_fingerprint(secret, exchange, account["mode"])
        cache_key = account["id"]
        existing = self._clients.get(cache_key)
        if existing and existing.credential_fingerprint == fingerprint:
            clients = existing
        else:
            clients = await self._replace_clients(account, secret, fingerprint, existing)
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

    async def _replace_clients(
        self,
        account: dict[str, str],
        secret: dict[str, Any],
        fingerprint: str,
        existing: AccountClients | None,
    ) -> AccountClients:
        if existing:
            await existing.close()
        exchange = account["exchange"]
        profile = profile_for(exchange)
        if profile is None:
            raise ExchangeContractError("Certified exchange profile is unavailable.")
        configuration = _client_configuration(account, secret)
        rest_class = getattr(ccxt_async, exchange, None)
        pro_class = getattr(ccxt_pro, exchange, None)
        if rest_class is None or pro_class is None:
            raise ExchangeContractError("Certified CCXT exchange class is unavailable.")
        rest = client_class(exchange, rest_class)(configuration)
        pro = client_class(exchange, pro_class)(configuration)
        if account["mode"] == "testnet":
            await self._enable_sandbox(rest, pro)
        _assert_capabilities(rest, REQUIRED_REST_CAPABILITIES, f"{exchange} REST")
        _assert_capabilities(pro, REQUIRED_PRO_CAPABILITIES, f"{exchange} Pro")
        return AccountClients(
            dict(account), fingerprint, _account_identity(secret, exchange, account["mode"]),
            rest, pro, asyncio.Lock(), profile,
        )

    @staticmethod
    async def _enable_sandbox(rest: Any, pro: Any) -> None:
        try:
            rest.set_sandbox_mode(True)
            pro.set_sandbox_mode(True)
        except Exception as error:
            await asyncio.gather(rest.close(), pro.close(), return_exceptions=True)
            raise ExchangeContractError("Exchange testnet mode is not supported by CCXT.") from error

    async def close(self) -> None:
        self._closing = True
        for account_id in sorted(self._account_locks):
            async with self._account_locks[account_id]:
                async with self._lock:
                    client = self._clients.pop(account_id, None)
                if client is not None:
                    await client.close()
