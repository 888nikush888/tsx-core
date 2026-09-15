"""Closed offline acceptance contracts shared by the runner and durable journal.

This module performs validation only; it does not import storage or the runner.
"""
from __future__ import annotations

import copy
import math
import re
from decimal import Decimal, InvalidOperation, localcontext
from urllib.parse import urlsplit


TESTNET_ORIGINS = {
    "hyperliquid": "https://api.hyperliquid-testnet.xyz",
    "bybit": "https://api-testnet.bybit.com",
    "krakenfutures": "https://demo-futures.kraken.com",
}
AUTHORIZATION = "RUN APPROVED TESTNET ACCEPTANCE"


class AcceptanceRefused(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AcceptanceRefused(message)


def positive_decimal(value: object) -> Decimal:
    require(isinstance(value, str) and len(value) <= 128 and re.fullmatch(r"\d+(?:\.\d+)?", value) is not None,
            "notional must be a positive decimal string")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise AcceptanceRefused("invalid notional") from error
    require(result.is_finite() and result > 0, "notional must be finite and positive")
    return result


def validate_origins(origins: dict) -> None:
    require(isinstance(origins, dict) and bool(origins), "reviewed profile origins required")
    for profile, origin in origins.items():
        require(isinstance(profile, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile) is not None,
                "invalid profile identity")
        require(isinstance(origin, str), "invalid testnet origin")
        try:
            parsed = urlsplit(origin)
        except ValueError as error:
            raise AcceptanceRefused("invalid testnet origin") from error
        require(parsed.scheme == "https" and bool(parsed.hostname) and parsed.username is None
                and parsed.password is None and origin == "https://" + parsed.netloc,
                "exact nonsecret HTTPS origin required")


def validate_plan(plan: dict, source_sha: str, profile_hash: str, profile_origins: dict | None = None) -> None:
    origins = TESTNET_ORIGINS if profile_origins is None else profile_origins
    validate_origins(origins)
    require(isinstance(plan, dict) and set(plan) == {
        "sourceSha", "profileHash", "ccxtVersion", "exchange", "environment", "host",
        "allowedTestnetOrigins", "accountReferenceHash", "limits",
    }, "invalid preflight schema; secrets and raw account data are forbidden")
    require(isinstance(source_sha, str) and re.fullmatch(r"[a-f0-9]{40}", source_sha) is not None
            and plan["sourceSha"] == source_sha, "source SHA differs")
    require(isinstance(profile_hash, str) and re.fullmatch(r"[a-f0-9]{64}", profile_hash) is not None
            and plan["profileHash"] == profile_hash, "profile hash differs")
    require(plan["ccxtVersion"] == "4.5.75", "CCXT version differs")
    exchange = plan["exchange"]
    require(isinstance(exchange, str) and exchange in origins and plan["environment"] == "testnet", "unapproved testnet exchange")
    require(plan["host"] == origins[exchange]
            and isinstance(plan["allowedTestnetOrigins"], list)
            and plan["allowedTestnetOrigins"] == [plan["host"]], "mainnet or unclear host refused")
    require(isinstance(plan["accountReferenceHash"], str)
            and re.fullmatch(r"[a-f0-9]{64}", plan["accountReferenceHash"]) is not None,
            "nonsecret account reference hash required")
    validate_limits(plan["limits"])


def validate_limits(limits: dict) -> None:
    require(isinstance(limits, dict) and set(limits) == {
        "maxNotionalUsd", "maxOrderCount", "timeBudgetSeconds",
    }, "all explicit limits are required")
    positive_decimal(limits["maxNotionalUsd"])
    for key in ("maxOrderCount", "timeBudgetSeconds"):
        require(type(limits[key]) is int and limits[key] > 0, "positive order/time limits are required")


def journal_binding(plan: dict, profile_origins: dict | None = None) -> dict:
    origins = TESTNET_ORIGINS if profile_origins is None else profile_origins
    validate_plan(plan, plan.get("sourceSha"), plan.get("profileHash"), origins)
    return copy.deepcopy({"version": 1, "runnerVersion": "offline-journal-v1",
                          "transport": "local-fake-only", "plan": plan, "profileOrigins": origins})


def validate_journal_binding(binding: dict) -> None:
    require(isinstance(binding, dict) and set(binding) == {
        "version", "runnerVersion", "transport", "plan", "profileOrigins",
    }, "invalid journal binding")
    require(binding == journal_binding(binding["plan"], binding["profileOrigins"]), "journal version differs")


def fields(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected.split()), "closed nonsecret evidence schema required")


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_:/.-]{1,200}", value) is not None,
            "original nonsecret identity required")


def quantity(value):
    require(isinstance(value, str) and len(value) <= 128 and re.fullmatch(r"\d+(?:\.\d+)?", value) is not None,
            "explicit finite quantity required")
    return Decimal(value)


def exact_sum(values):
    with localcontext() as context:
        context.prec = 512
        return sum(values, Decimal(0))


def validate_request(value):
    fields(value, "clientOrderId symbol providerSymbol side type quantity price triggerPrice reduceOnly postOnly timeInForce leverage priceBoundary source valuation")
    for key in ("clientOrderId", "symbol", "providerSymbol"):
        identifier(value[key])
    require(value["source"] == "local-fake-v1" and value["type"] == "limit"
            and value["side"] in {"buy", "sell"} and value["timeInForce"] in {"IOC", "GTC"},
            "only the closed local fake limit contract is implemented")
    require(type(value["reduceOnly"]) is bool and type(value["postOnly"]) is bool
            and type(value["leverage"]) is int and 0 < value["leverage"] <= 50, "invalid bound order flags")
    require(not (value["postOnly"] and value["timeInForce"] == "IOC"), "contradictory order flags")
    positive_decimal(value["quantity"])
    fields(value["priceBoundary"], "minimum maximum")
    minimum = positive_decimal(value["priceBoundary"]["minimum"])
    maximum = positive_decimal(value["priceBoundary"]["maximum"])
    require(minimum <= positive_decimal(value["price"]) <= maximum, "original price boundary exceeded")
    if value["triggerPrice"] is not None:
        positive_decimal(value["triggerPrice"])
    require(value["valuation"] == {"contract": "local-fake-usd-v1", "priceCurrency": "USD", "quantityUnit": "base"}
            and value["symbol"].endswith("/USD:USD"), "USD valuation requires the explicit local fake contract")


def validate_notional(request, allocated):
    with localcontext() as context:
        context.prec = 512
        bound = Decimal(request["quantity"]) * Decimal(request["priceBoundary"]["maximum"])
        require(bound <= positive_decimal(allocated), "notional understates the original bound request")


def validate_original(evidence):
    contract = evidence.get("contract") if isinstance(evidence, dict) else None
    expected = "contract bindingHash observedAt source original"
    fields(evidence, expected + (" requestHash" if contract == "local-fake-order-v1" else ""))
    require(evidence["source"] == "local-fake-v1", "real provider evidence is not implemented")
    require(isinstance(evidence["bindingHash"], str) and re.fullmatch(r"[a-f0-9]{64}", evidence["bindingHash"]), "invalid binding hash")
    require(type(evidence["observedAt"]) in (int, float) and math.isfinite(evidence["observedAt"])
            and evidence["observedAt"] >= 0, "invalid observation time")
    original = evidence["original"]
    if contract == "local-fake-account-v1":
        fields(original, "accountReferenceHash origin positionMode marginMode")
        validate_origins({"fixture": original["origin"]})
        require(original["positionMode"] in {"oneway", "hedge"} and original["marginMode"] in {"cross", "isolated"}, "invalid mode original")
    elif contract == "local-fake-order-v1":
        validate_order_original(evidence)
    elif contract == "local-fake-positions-v1":
        fields(original, "accountReferenceHash positions")
        require(isinstance(original["positions"], list), "explicit position rows required")
        for row in original["positions"]:
            fields(row, "providerSymbol quantity")
            identifier(row["providerSymbol"])
            quantity(row["quantity"])
    else:
        raise AcceptanceRefused("unsupported original contract")
    require(isinstance(original["accountReferenceHash"], str)
            and re.fullmatch(r"[a-f0-9]{64}", original["accountReferenceHash"]), "invalid account hash")


def validate_order_original(evidence):
    original = evidence["original"]
    fields(original, "accountReferenceHash clientOrderId orderId providerSymbol status quantity filledQuantity remainingQuantity fills")
    require(isinstance(evidence["requestHash"], str) and re.fullmatch(r"[a-f0-9]{64}", evidence["requestHash"]), "invalid request hash")
    for key in ("clientOrderId", "orderId", "providerSymbol"):
        identifier(original[key])
    require(original["status"] in {"open", "canceled", "filled", "rejected", "expired"}, "explicit order status required")
    total = positive_decimal(original["quantity"])
    filled, remaining = quantity(original["filledQuantity"]), quantity(original["remainingQuantity"])
    require(exact_sum([filled, remaining]) == total, "contradictory order quantities")
    require(original["status"] != "filled" or filled == total, "incomplete filled order")
    require(isinstance(original["fills"], list), "explicit fill originals required")
    fill_ids, quantities = set(), []
    for fill in original["fills"]:
        fields(fill, "fillId quantity")
        identifier(fill["fillId"])
        require(fill["fillId"] not in fill_ids, "duplicate original fill")
        fill_ids.add(fill["fillId"])
        quantities.append(positive_decimal(fill["quantity"]))
    require(exact_sum(quantities) == filled, "original fills do not cover filled quantity")


def validate_journal_event(kind, body):
    if kind == "created":
        fields(body, "binding deadline startedAt runId locationHash")
        validate_journal_binding(body["binding"])
        require(type(body["deadline"]) in (int, float) and type(body["startedAt"]) in (int, float)
                and math.isfinite(body["deadline"]) and math.isfinite(body["startedAt"]), "invalid original deadline")
        require(isinstance(body["runId"], str) and re.fullmatch(r"[a-f0-9]{32}", body["runId"])
                and isinstance(body["locationHash"], str) and re.fullmatch(r"[a-f0-9]{64}", body["locationHash"]), "invalid original journal identity")
    elif kind in {"invalid", "conflict"}:
        fields(body, "reason")
        require(body["reason"] in {"request", "account", "acknowledgement", "cleanup", "repeat"}, "invalid redacted reason")
    elif kind == "reserved":
        fields(body, "request notionalUsd")
        validate_request(body["request"])
        positive_decimal(body["notionalUsd"])
        validate_notional(body["request"], body["notionalUsd"])
    elif kind == "dispatching":
        fields(body, "clientOrderId requestHash")
        identifier(body["clientOrderId"])
        require(isinstance(body["requestHash"], str) and re.fullmatch(r"[a-f0-9]{64}", body["requestHash"]), "invalid dispatch binding")
    elif kind in {"account", "acknowledged"}:
        validate_original(body)
    elif kind == "cleanup":
        fields(body, "orders positions")
        require(isinstance(body["orders"], list), "explicit orders required")
        for evidence in [*body["orders"], body["positions"]]:
            validate_original(evidence)
    else:
        raise AcceptanceRefused("unknown journal event")


