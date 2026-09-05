from __future__ import annotations

import asyncio
import copy
import time
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any

import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro

from ccxt_capabilities import (
    CANDIDATE_PRO_REQUIREMENTS,
    CANDIDATE_REST_REQUIREMENTS,
    PRO_CAPABILITIES,
    REST_CAPABILITIES,
    capability_flags,
    missing_capabilities,
)
from ccxt_certification import certification_result
from ccxt_profiles import PROFILES, CredentialField, ExchangeProfile, profile_for
from symbol_resolver import linear_swap_markets

CERTIFICATION_STATUSES = {
    "discovered", "candidate", "certified", "quarantined", "ineligible", "deprecated"
}
CREDENTIAL_ALLOWLIST = {
    "apiKey", "secret", "uid", "accountId", "login", "password", "twofa",
    "privateKey", "walletAddress", "token",
}


def _required_credentials(client: Any) -> list[str]:
    fields = getattr(client, "requiredCredentials", {})
    if not isinstance(fields, dict):
        return []
    return sorted(key for key, required in fields.items() if required is True)


def _credential_fields(required: list[str], profile: ExchangeProfile | None) -> list[dict[str, Any]]:
    if profile:
        return [field.public() for field in profile.credential_fields]
    labels = {
        "apiKey": "API Key", "secret": "API Secret", "uid": "UID", "accountId": "Account ID",
        "login": "Login", "password": "Password", "twofa": "2FA", "privateKey": "Private Key",
        "walletAddress": "Wallet Address", "token": "Token",
    }
    non_secret = {"uid", "accountId", "login", "walletAddress"}
    return [
        CredentialField(field, labels[field], secret=field not in non_secret).public()
        for field in required
        if field in CREDENTIAL_ALLOWLIST
    ]


class CcxtExchangeRegistry:
    def __init__(
        self,
        *,
        rest_module: Any = ccxt_async,
        pro_module: Any = ccxt_pro,
        ccxt_version: str | None = None,
        certifications_directory: Path | None = None,
        probe_cache_seconds: int = 900,
    ) -> None:
        self.rest_module = rest_module
        self.pro_module = pro_module
        self.ccxt_version = ccxt_version or package_version("ccxt")
        self.certifications_directory = certifications_directory or Path(__file__).with_name("certifications")
        self.probe_cache_seconds = max(30, min(probe_cache_seconds, 86_400))
        self._descriptors = self._discover()
        self._probe_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._probe_locks: dict[str, asyncio.Lock] = {}

    def _discover(self) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        pro_ids = set(getattr(self.pro_module, "exchanges", []))
        for exchange in sorted(set(getattr(self.rest_module, "exchanges", []))):
            rest_class = getattr(self.rest_module, exchange, None)
            pro_class = getattr(self.pro_module, exchange, None) if exchange in pro_ids else None
            if rest_class is None:
                continue
            result[exchange] = self._installed_descriptor(exchange, rest_class, pro_class)
        for exchange, profile in sorted(PROFILES.items()):
            if exchange in result:
                continue
            result[exchange] = self._deprecated_descriptor(exchange, profile)
        return result

    def _installed_descriptor(self, exchange: str, rest_class: Any, pro_class: Any) -> dict[str, Any]:
        rest = rest_class({"enableRateLimit": True})
        pro = pro_class({"enableRateLimit": True}) if pro_class is not None else None
        profile = profile_for(exchange)
        required = _required_credentials(rest)
        rest_flags = capability_flags(rest, REST_CAPABILITIES)
        pro_flags = capability_flags(pro, PRO_CAPABILITIES) if pro is not None else {
            name: False for name in PRO_CAPABILITIES
        }
        status, reason = self._initial_status(exchange, profile, required, rest_flags, pro_flags)
        return {
            "id": exchange,
            "name": str(getattr(rest, "name", None) or exchange),
            "status": status,
            "reason": reason,
            "provider": "ccxt",
            "restAvailable": True,
            "proAvailable": pro is not None,
            "requiredCredentials": required,
            "ccxt": {"rest": True, "pro": pro is not None},
            "markets": {"linearSwap": None},
            "credentialFields": _credential_fields(required, profile),
            "modes": list(profile.modes) if profile and status == "certified" else [],
            "capabilities": {**rest_flags, **pro_flags},
            "profile": self._public_profile(profile),
        }

    def _deprecated_descriptor(self, exchange: str, profile: ExchangeProfile) -> dict[str, Any]:
        return {
            "id": exchange,
            "name": exchange,
            "status": "deprecated",
            "reason": "The certified exchange profile is absent from the installed CCXT version.",
            "provider": "ccxt",
            "restAvailable": False,
            "proAvailable": False,
            "requiredCredentials": [],
            "ccxt": {"rest": False, "pro": False},
            "markets": {"linearSwap": None},
            "credentialFields": _credential_fields([], profile),
            "modes": [],
            "capabilities": {
                **{name: False for name in REST_CAPABILITIES},
                **{name: False for name in PRO_CAPABILITIES},
            },
            "profile": self._public_profile(profile),
        }

    def _initial_status(
        self,
        exchange: str,
        profile: ExchangeProfile | None,
        required: list[str],
        rest_flags: dict[str, bool],
        pro_flags: dict[str, bool],
    ) -> tuple[str, str | None]:
        unsupported = sorted(set(required) - CREDENTIAL_ALLOWLIST)
        if unsupported:
            return "ineligible", f"Unsupported required credential fields: {', '.join(unsupported)}."
        rest_missing = missing_capabilities(rest_flags, CANDIDATE_REST_REQUIREMENTS)
        pro_missing = missing_capabilities(pro_flags, CANDIDATE_PRO_REQUIREMENTS)
        if rest_missing or pro_missing:
            missing = rest_missing + pro_missing
            return "ineligible", f"Missing required CCXT capabilities: {', '.join(missing)}."
        if profile is None:
            return "discovered", None
        if profile.protected_entry_strategy == "certified_batch" and rest_flags.get("createOrders") is not True:
            return "quarantined", "Certified batch protected entry is unavailable."
        evidence = certification_result(
            self.certifications_directory, exchange, self.ccxt_version, profile,
        )
        return ("certified", None) if evidence.valid else ("quarantined", evidence.reason)

    @staticmethod
    def _public_profile(profile: ExchangeProfile | None) -> dict[str, Any] | None:
        if profile is None:
            return None
        return {
            "version": profile.profile_version,
            "defaultType": profile.default_type,
            "defaultSubType": profile.default_sub_type,
            "settlementPreference": list(profile.settlement_preference),
            "protectedEntryStrategy": profile.protected_entry_strategy,
            "identityStrategy": profile.identity_strategy,
            "positionMode": profile.position_mode,
            "marginMode": profile.margin_mode,
            "myTradesRequiresSymbol": profile.my_trades_requires_symbol,
            "marketOrderStrategy": profile.market_order_strategy,
            "builderFeeEnabled": profile.builder_fee_enabled,
        }

    def catalog(self) -> dict[str, Any]:
        return {
            "implementation": {
                "library": "ccxt", "version": self.ccxt_version,
                "streaming": "ccxt-pro", "orderAuthority": "rest",
            },
            "exchanges": copy.deepcopy(list(self._descriptors.values())),
        }

    def descriptor(self, exchange: str) -> dict[str, Any] | None:
        value = self._descriptors.get(exchange)
        return copy.deepcopy(value) if value is not None else None

    async def probe(self, exchange: str) -> dict[str, Any]:
        descriptor = self._descriptors.get(exchange)
        if descriptor is None:
            raise ValueError("Unknown CCXT exchange identifier.")
        if descriptor["status"] in {"certified", "quarantined", "ineligible", "deprecated"}:
            return copy.deepcopy(descriptor)
        now = time.monotonic()
        cached = self._probe_cache.get(exchange)
        if cached and cached[0] > now:
            return copy.deepcopy(cached[1])
        lock = self._probe_locks.setdefault(exchange, asyncio.Lock())
        async with lock:
            cached = self._probe_cache.get(exchange)
            if cached and cached[0] > time.monotonic():
                return copy.deepcopy(cached[1])
            result = await self._probe_once(exchange, descriptor)
            self._probe_cache[exchange] = (time.monotonic() + self.probe_cache_seconds, result)
            self._descriptors[exchange] = result
            return copy.deepcopy(result)

    async def _probe_once(self, exchange: str, descriptor: dict[str, Any]) -> dict[str, Any]:
        rest_class = getattr(self.rest_module, exchange, None)
        if rest_class is None:
            raise ValueError("CCXT REST exchange class is unavailable.")
        client = rest_class({
            "enableRateLimit": True,
            "timeout": 10_000,
            "options": {"defaultType": "swap"},
        })
        try:
            markets = await asyncio.wait_for(client.load_markets(), timeout=30)
            compatible = bool(linear_swap_markets(markets.values())) if isinstance(markets, dict) else False
            result = copy.deepcopy(descriptor)
            result["markets"] = {"linearSwap": compatible}
            result["status"] = "candidate" if compatible else "ineligible"
            result["reason"] = None if compatible else "Public market metadata contains no active linear swap."
            result["modes"] = []
            return result
        finally:
            await client.close()
