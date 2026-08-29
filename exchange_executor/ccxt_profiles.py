from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

ProtectedEntryStrategy = Literal[
    "certified_batch", "attached_stop", "native_bracket", "unsupported"
]
IdentityStrategy = Literal[
    "wallet_address", "exchange_account_uid", "subaccount_uid", "credential_binding"
]


@dataclass(frozen=True)
class CredentialField:
    id: str
    label: str
    required: bool = True
    secret: bool = True

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "required": self.required,
            "secret": self.secret,
        }


@dataclass(frozen=True)
class ExchangeProfile:
    id: str
    profile_version: int
    default_type: str
    default_sub_type: str | None
    settlement_preference: tuple[str, ...]
    modes: tuple[str, ...]
    protected_entry_strategy: ProtectedEntryStrategy
    identity_strategy: IdentityStrategy
    position_mode: str
    margin_mode: str
    my_trades_requires_symbol: bool
    market_order_strategy: str
    builder_fee_enabled: bool | None
    credential_fields: tuple[CredentialField, ...]

    def client_options(self) -> dict[str, Any]:
        options: dict[str, Any] = {"defaultType": self.default_type}
        if self.default_sub_type:
            options["defaultSubType"] = self.default_sub_type
        if self.settlement_preference:
            options["defaultSettle"] = self.settlement_preference[0]
        if self.builder_fee_enabled is False:
            options.update({"builderFee": False, "approvedBuilderFee": False})
        return options


PROFILES: dict[str, ExchangeProfile] = {
    "hyperliquid": ExchangeProfile(
        id="hyperliquid",
        profile_version=1,
        default_type="swap",
        default_sub_type=None,
        settlement_preference=("USDC", "USDT", "USD"),
        modes=("testnet", "live"),
        protected_entry_strategy="certified_batch",
        identity_strategy="wallet_address",
        position_mode="oneway",
        margin_mode="cross",
        my_trades_requires_symbol=False,
        market_order_strategy="reference_slippage",
        builder_fee_enabled=False,
        credential_fields=(
            CredentialField("privateKey", "Private Key"),
            CredentialField("walletAddress", "Wallet Address", secret=False),
        ),
    ),
    "bybit": ExchangeProfile(
        id="bybit",
        profile_version=1,
        default_type="swap",
        default_sub_type="linear",
        settlement_preference=("USDT", "USDC", "USD"),
        modes=("testnet", "live"),
        protected_entry_strategy="certified_batch",
        identity_strategy="credential_binding",
        position_mode="oneway",
        margin_mode="cross",
        my_trades_requires_symbol=False,
        market_order_strategy="native_market",
        builder_fee_enabled=None,
        credential_fields=(
            CredentialField("apiKey", "API Key"),
            CredentialField("secret", "API Secret"),
        ),
    ),
    "krakenfutures": ExchangeProfile(
        id="krakenfutures",
        profile_version=1,
        default_type="swap",
        default_sub_type=None,
        settlement_preference=("USD", "USDT", "USDC"),
        modes=("testnet", "live"),
        protected_entry_strategy="certified_batch",
        identity_strategy="credential_binding",
        position_mode="oneway",
        margin_mode="cross",
        my_trades_requires_symbol=True,
        market_order_strategy="native_market",
        builder_fee_enabled=None,
        credential_fields=(
            CredentialField("apiKey", "API Key"),
            CredentialField("secret", "API Secret"),
        ),
    ),
}


def profile_for(exchange: str) -> ExchangeProfile | None:
    return PROFILES.get(exchange)

