"""Read-only Hyperliquid Testnet account snapshot. Never loads signing credentials.

This diagnostic is not provider acceptance or a release gate. It only sends the
documented userRole, clearinghouseState and openOrders requests to /info.
"""
from __future__ import annotations

import argparse
import http.client
import json
import re
import ssl
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit


INFO_ENDPOINT = "https://api.hyperliquid-testnet.xyz/info"
ADDRESS_PATTERN = re.compile(r"0x[0-9a-fA-F]{40}\Z")
MAX_ADDRESS_FILE_BYTES = 100
MAX_RESPONSE_BYTES = 64 * 1024
REQUEST_TIMEOUT_SECONDS = 5
ALLOWED_ROLES = frozenset({"user", "agent", "vault", "subAccount", "missing"})


class PreflightError(Exception):
    """A deliberately non-sensitive, operator-facing diagnostic error."""


def public_address(value: str) -> str:
    if not ADDRESS_PATTERN.fullmatch(value):
        raise PreflightError("Public wallet address must be 0x followed by 40 hex digits")
    return value


def read_public_address_file(path: Path) -> str:
    try:
        with path.open("rb") as stream:
            raw = stream.read(MAX_ADDRESS_FILE_BYTES + 1)
    except OSError as exc:
        raise PreflightError("Could not read public address file") from exc
    if len(raw) > MAX_ADDRESS_FILE_BYTES:
        raise PreflightError("Public address file is too large")
    try:
        value = raw.decode("ascii").strip("\r\n")
    except UnicodeDecodeError as exc:
        raise PreflightError("Public address file must contain ASCII text") from exc
    return public_address(value)


def validate_endpoint(endpoint: str) -> str:
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "api.hyperliquid-testnet.xyz"
        or parsed.path != "/info"
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
    ):
        raise PreflightError("Only the official Hyperliquid Testnet Info endpoint is allowed")
    return parsed.hostname


def post_info(payload: dict[str, str], *, endpoint: str = INFO_ENDPOINT, connection_factory=None):
    """Direct HTTPS connection: http.client has no proxy or redirect machinery."""
    host = validate_endpoint(endpoint)
    if payload.get("type") not in {"userRole", "clearinghouseState", "openOrders"} or set(payload) != {"type", "user"}:
        raise PreflightError("Unsupported read-only Info request")
    public_address(payload["user"])
    factory = connection_factory or http.client.HTTPSConnection
    connection = None
    try:
        connection = factory(host, timeout=REQUEST_TIMEOUT_SECONDS, context=ssl.create_default_context())
        body = json.dumps(payload, separators=(",", ":")).encode("ascii")
        connection.request("POST", "/info", body=body, headers={"Content-Type": "application/json", "Accept": "application/json"})
        response = connection.getresponse()
        # There is intentionally no follow-up request for any 3xx response.
        if response.status != 200:
            raise PreflightError("Testnet Info request did not return HTTP 200")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise PreflightError("Compressed responses are unsupported")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise PreflightError("Testnet Info response exceeds size limit")
        return json.loads(raw)
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise PreflightError("Testnet Info request or response failed validation") from exc
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass


def _nonnegative_decimal(value, field: str) -> Decimal:
    if not isinstance(value, str):
        raise PreflightError(f"Invalid {field} in Testnet response")
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise PreflightError(f"Invalid {field} in Testnet response") from exc
    if not parsed.is_finite() or parsed < 0:
        raise PreflightError(f"Invalid {field} in Testnet response")
    return parsed


def _signed_decimal(value, field: str) -> Decimal:
    if not isinstance(value, str):
        raise PreflightError(f"Invalid {field} in Testnet response")
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise PreflightError(f"Invalid {field} in Testnet response") from exc
    if not parsed.is_finite():
        raise PreflightError(f"Invalid {field} in Testnet response")
    return parsed


def summarize(role_data, account_data, orders_data) -> dict[str, object]:
    if not isinstance(role_data, dict) or role_data.get("role") not in ALLOWED_ROLES:
        raise PreflightError("Invalid account role in Testnet response")
    if not isinstance(account_data, dict) or not isinstance(account_data.get("assetPositions"), list):
        raise PreflightError("Invalid perpetual account state in Testnet response")
    if not isinstance(account_data.get("marginSummary"), dict) or not isinstance(orders_data, list):
        raise PreflightError("Invalid account summary or open orders in Testnet response")

    summary = account_data["marginSummary"]
    value = _nonnegative_decimal(summary.get("accountValue"), "account value")
    notional = _nonnegative_decimal(summary.get("totalNtlPos"), "position notional")
    withdrawable = _signed_decimal(account_data.get("withdrawable"), "withdrawable amount")
    position_count = 0
    for row in account_data["assetPositions"]:
        if not isinstance(row, dict) or not isinstance(row.get("position"), dict):
            raise PreflightError("Invalid position in Testnet response")
        if _signed_decimal(row["position"].get("szi"), "position size") != 0:
            position_count += 1
    for order in orders_data:
        if not isinstance(order, dict) or not isinstance(order.get("coin"), str) or not order.get("coin"):
            raise PreflightError("Invalid open order in Testnet response")
    return {
        "environment": "hyperliquid-testnet",
        "readOnly": True,
        "role": role_data["role"],
        "positionCount": position_count,
        "flat": position_count == 0 and notional == 0,
        "openOrderCount": len(orders_data),
        "funded": value > 0,
        "withdrawablePositive": withdrawable > 0,
        "scope": "diagnostic-only",
    }


def probe(address: str, *, requester=post_info) -> dict[str, object]:
    address = public_address(address)
    # Sequential, bounded reads; no account mutation or credential lookup.
    return summarize(
        requester({"type": "userRole", "user": address}),
        requester({"type": "clearinghouseState", "user": address}),
        requester({"type": "openOrders", "user": address}),
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--address", help="Public 0x wallet address (visible in process arguments)")
    source.add_argument("--address-file", type=Path, help="File containing only the public address")
    args = parser.parse_args(argv)
    try:
        address = read_public_address_file(args.address_file) if args.address_file is not None else public_address(args.address)
        result = probe(address)
    except PreflightError as exc:
        print(f"Hyperliquid Testnet read-only preflight failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
