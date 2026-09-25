"""Fail-closed, read-only binding for a Hyperliquid Testnet API wallet.

An agent's signing key is not the account address. The master remains the
account identity; the signer must be present in two current Testnet Info
responses before a CCXT client may be constructed. This module never signs or
sends an exchange action.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import re
import ssl
import time
from dataclasses import dataclass
from typing import Any, Callable


TESTNET_HOST = "api.hyperliquid-testnet.xyz"
TESTNET_ORIGIN = f"https://{TESTNET_HOST}"
MAX_RESPONSE_BYTES = 64 * 1024
MAX_AGENTS = 16
MIN_REMAINING_MS = 35_000
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
_REFUSAL_MESSAGE = "Hyperliquid Testnet agent grant is unproved."


class AgentGrantRefused(ValueError):
    """Non-sensitive refusal; never include provider replies or credentials."""


@dataclass(frozen=True)
class AgentGrant:
    fingerprint: str
    valid_until: int


def _refuse(condition: bool) -> None:
    if not condition:
        raise AgentGrantRefused(_REFUSAL_MESSAGE)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _refuse(key not in result)
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise AgentGrantRefused(_REFUSAL_MESSAGE)


def _verified_tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.verify_mode = ssl.CERT_REQUIRED
    context.check_hostname = True
    return context


def _close_quietly(connection: http.client.HTTPSConnection | None) -> None:
    if connection is None:
        return
    try:
        connection.close()
    except OSError:
        return


def _post_info(payload: dict[str, str]) -> Any:
    """Fixed direct TLS route, no redirects, proxies, URL input or secrets."""
    _refuse(isinstance(payload, dict) and set(payload) == {"type", "user"}
            and payload.get("type") in {"userRole", "extraAgents"}
            and isinstance(payload.get("user"), str)
            and ADDRESS.fullmatch(payload["user"]) is not None)
    connection = None
    try:
        connection = http.client.HTTPSConnection(
            TESTNET_HOST, timeout=4, context=_verified_tls_context(),
        )
        body = json.dumps(payload, separators=(",", ":")).encode("ascii")
        connection.request("POST", "/info", body=body, headers={
            "Content-Type": "application/json", "Accept": "application/json",
        })
        response = connection.getresponse()
        _refuse(response.status == 200
                and response.getheader("Content-Encoding", "identity").lower() == "identity")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        _refuse(len(raw) <= MAX_RESPONSE_BYTES)
        return json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except Exception:
        raise AgentGrantRefused(_REFUSAL_MESSAGE) from None
    finally:
        _close_quietly(connection)


def _addresses_are_distinct(master: Any, signer: Any) -> bool:
    return (isinstance(master, str) and ADDRESS.fullmatch(master) is not None
            and isinstance(signer, str) and ADDRESS.fullmatch(signer) is not None
            and master.lower() != signer.lower())


def _role_binds_master(role: Any, master: str) -> bool:
    return (isinstance(role, dict) and set(role) == {"role", "data"}
            and role["role"] == "agent"
            and isinstance(role["data"], dict) and set(role["data"]) == {"user"}
            and isinstance(role["data"]["user"], str)
            and role["data"]["user"].lower() == master)


def _valid_agent_row(row: Any) -> bool:
    return (isinstance(row, dict) and set(row) == {"name", "address", "validUntil"}
            and isinstance(row["name"], str) and len(row["name"]) <= 128
            and not any(ord(char) < 32 for char in row["name"])
            and isinstance(row["address"], str) and ADDRESS.fullmatch(row["address"]) is not None
            and type(row["validUntil"]) is int and 0 < row["validUntil"] <= 2**53 - 1)


def _select_agent_row(rows: Any, signer: str) -> dict[str, Any]:
    _refuse(isinstance(rows, list) and len(rows) <= MAX_AGENTS)
    matching = []
    for row in rows:
        _refuse(_valid_agent_row(row))
        if row["address"].lower() == signer:
            matching.append(row)
    _refuse(len(matching) == 1)
    return matching[0]


def _grant_outlives_minimum(grant: dict[str, Any], now_ms: int | None) -> bool:
    now = int(time.time() * 1000) if now_ms is None else now_ms
    return (type(now) is int and 0 <= now <= 2**53 - 1
            and grant["validUntil"] > now + MIN_REMAINING_MS)


def read_testnet_agent_grant(
    master: str, signer: str, *, requester: Callable[[dict[str, str]], Any] = _post_info,
    now_ms: int | None = None,
) -> AgentGrant:
    """Bind a current agent signer to one master and one unexpired grant."""
    _refuse(_addresses_are_distinct(master, signer))
    master, signer = master.lower(), signer.lower()
    try:
        role = requester({"type": "userRole", "user": signer})
        _refuse(_role_binds_master(role, master))
        grant = _select_agent_row(requester({"type": "extraAgents", "user": master}), signer)
        _refuse(_grant_outlives_minimum(grant, now_ms))
        descriptor = {
            "version": 1, "origin": TESTNET_ORIGIN, "master": master,
            "signer": signer, "name": grant["name"], "validUntil": grant["validUntil"],
        }
        encoded = json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode("ascii")
        return AgentGrant(hashlib.sha256(encoded).hexdigest(), grant["validUntil"])
    except Exception:
        raise AgentGrantRefused(_REFUSAL_MESSAGE) from None
