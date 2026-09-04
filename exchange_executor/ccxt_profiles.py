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
class ExecutionCapabilities:
    """Versioned implementation declarations, never observations of a real account."""

    provider_api_version: str
    one_way_readback: str
    margin_mode_readback: str
    leverage_readback: str
    leverage_set: str
    account_mode_readback: str
    protected_bounded_entry: str = "not_proven"
    automatic_account_setup: str = "none"
    leverage_tiers: str = 'not_proven'


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
    execution_capabilities: ExecutionCapabilities

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
        # Order preference within the implemented first-perp-DEX settlement scope.
        settlement_preference=("USDC",),
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
        execution_capabilities=ExecutionCapabilities(
            "hyperliquid-info-exchange-v1", "inherent_oneway_bound_clearinghouse",
            "bound_active_asset_data", "bound_active_asset_data", "sets_margin_mode_requires_cross_proof",
            "bound_user_abstraction_disabled", "limit_ioc_batch_v1",
            automatic_account_setup="blocked_builder_fee_and_referral_v1",
            leverage_tiers='bound_meta_asset_context_complete_scope_v1',
        ),
    ),
    "bybit": ExchangeProfile(
        id="bybit",
        profile_version=1,
        default_type="swap",
        default_sub_type="linear",
        settlement_preference=("USDT", "USDC"),
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
        execution_capabilities=ExecutionCapabilities(
            "bybit-v5", "authenticated_symbol_position_idx", "authenticated_account_info",
            "authenticated_symbol_position", "same_mode_leverage",
            "authenticated_account_info", "limit_ioc_batch_v1",
            leverage_tiers='risk_limit_mark_authenticated_complete_scope_v1',
        ),
    ),
    "krakenfutures": ExchangeProfile(
        id="krakenfutures",
        profile_version=1,
        default_type="swap",
        default_sub_type=None,
        settlement_preference=("USD",),
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
        execution_capabilities=ExecutionCapabilities(
            "kraken-derivatives-v3", "inherent_netting_authenticated_positions", "authenticated_leverage_preferences",
            "effective_collateral_ratio", "unsupported_in_cross_sets_isolated",
            "authenticated_multi_collateral_preferences",
            leverage_tiers='authenticated_trading_instruments_complete_scope_v1',
        ),
    ),
}


def profile_for(exchange: str) -> ExchangeProfile | None:
    return PROFILES.get(exchange)
