"""Raw account/mode observation for the bounded KuCoin Classic profile."""
from __future__ import annotations

from typing import Any

from history_reader import RecoveryReadBudget, now_ms
from kucoin_provider_common import (
    binding,
    exact_integer,
    native_symbol,
    object_data,
    require,
    token,
)


def _permissions(value: Any) -> list[str]:
    raw = token(value, "API permissions")
    values = raw.split(",")
    require(values and len(values) <= 16 and len(values) == len(set(values)),
            "KuCoin API permissions are duplicated or unbounded.")
    normalized = sorted(token(value, "API permission",) for value in values)
    require({"General", "Futures"}.issubset(normalized),
            "KuCoin API key lacks General or Futures permission.")
    return normalized


def _uid_list(value: Any, label: str) -> list[str]:
    require(type(value) is list and len(value) <= 1_000,
            f"KuCoin {label} is not a bounded identity list.")
    result = [token(item, f"{label} identity") for item in value]
    require(len(result) == len(set(result)), f"KuCoin {label} identities are duplicated.")
    return result


async def read_kucoin_classic_observation(
    rest: Any,
    provider_symbol: str,
    budget: RecoveryReadBudget,
    *,
    account_fingerprint: str,
    credential_generation: str,
    expected_provider_uid: str | None = None,
) -> dict[str, Any]:
    """Observe the five raw controls required by the narrow Classic profile.

    This is intentionally not a profile grant.  It produces only non-secret
    evidence that another integration layer can bind to its own account record.
    """
    symbol = native_symbol(provider_symbol)
    fingerprint = binding(account_fingerprint, "account fingerprint")
    generation = binding(credential_generation, "credential generation")
    expected_uid = (token(expected_provider_uid, "expected account uid")
                    if expected_provider_uid is not None else None)

    api = object_data(await budget.call(lambda: rest.privateGetUserApiKey({})), "API key")
    uid = token(api.get("uid"), "account uid")
    require(expected_uid is None or uid == expected_uid,
            "KuCoin account identity differs from the verified binding.")
    permissions = _permissions(api.get("permission"))
    api_version = exact_integer(api.get("apiVersion"), "API version", minimum=1, maximum=100)
    require(type(api.get("isMaster")) is bool, "KuCoin API-key ownership is ambiguous.")
    created_at = exact_integer(api.get("createdAt"), "API key creation time")
    region = token(api.get("region"), "API region")
    site_type = token(api.get("siteType"), "API site type")

    account = object_data(
        await budget.call(lambda: rest.utaPrivateGetAccountMode({})), "account mode",
    )
    require(account.get("selfAccountMode") == "CLASSIC",
            "KuCoin account is not in the reviewed CLASSIC mode.")
    _uid_list(account.get("unifiedSubAccount"), "unified subaccounts")
    _uid_list(account.get("classicSubAccount"), "classic subaccounts")

    position = object_data(
        await budget.call(lambda: rest.futuresPrivateGetPositionGetPositionMode({})),
        "position mode",
    )
    require(type(position.get("positionMode")) is int and position["positionMode"] == 0,
            "KuCoin position mode is not the reviewed one-way/BOTH mode.")

    margin = object_data(
        await budget.call(
            lambda: rest.futuresPrivateGetPositionGetMarginMode({"symbol": symbol}),
        ),
        "margin mode",
    )
    require(margin.get("symbol") == symbol and margin.get("marginMode") == "CROSS",
            "KuCoin symbol is not in the reviewed CROSS margin mode.")

    leverage_data = object_data(
        await budget.call(
            lambda: rest.futuresPrivateGetGetCrossUserLeverage({"symbol": symbol}),
        ),
        "cross leverage",
    )
    require(leverage_data.get("symbol") == symbol,
            "KuCoin leverage observation returned a different symbol.")
    leverage = exact_integer(leverage_data.get("leverage"), "cross leverage", minimum=1,
                             maximum=125)

    return {
        "profile": "kucoin_classic_cross_oneway_v1",
        "providerAccountUid": uid,
        "providerSymbol": symbol,
        "accountFingerprint": fingerprint,
        "credentialGeneration": generation,
        "accountMode": "CLASSIC",
        "positionMode": "oneway",
        "marginMode": "cross",
        "leverage": leverage,
        "permissions": permissions,
        "apiVersion": api_version,
        "isMaster": api["isMaster"],
        "credentialCreatedAt": created_at,
        "region": region,
        "siteType": site_type,
        "observedAt": now_ms(),
    }
