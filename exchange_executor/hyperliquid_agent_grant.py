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


class AgentGrantRefused(ValueError):
    """Non-sensitive refusal; never include provider replies or credentials."""


@dataclass(frozen=True)
class AgentGrant:
    fingerprint: str
    valid_until: int


def _refuse(condition: bool) -> None:
    if not condition:
        raise AgentGrantRefused("Hyperliquid Testnet agent grant is unproved.")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _refuse(key not in result)
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise AgentGrantRefused("Hyperliquid Testnet agent grant is unproved.")


def _post_info(payload: dict[str, str]) -> Any:
    """Fixed direct TLS route, no redirects, proxies, URL input or secrets."""
    _refuse(isinstance(payload, dict) and set(payload) == {"type", "user"}
            and payload.get("type") in {"userRole", "extraAgents"}
            and isinstance(payload.get("user"), str)
            and ADDRESS.fullmatch(payload["user"]) is not None)
    connection = None
    try:
        connection = http.client.HTTPSConnection(
            TESTNET_HOST, timeout=4, context=ssl.create_default_context(),
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
        raise AgentGrantRefused("Hyperliquid Testnet agent grant is unproved.") from None
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass


def read_testnet_agent_grant(
    master: str, signer: str, *, requester: Callable[[dict[str, str]], Any] = _post_info,
    now_ms: int | None = None,
) -> AgentGrant:
    """Bind a current agent signer to one master and one unexpired grant."""
    _refuse(isinstance(master, str) and ADDRESS.fullmatch(master) is not None
            and isinstance(signer, str) and ADDRESS.fullmatch(signer) is not None
            and master.lower() != signer.lower())
    master, signer = master.lower(), signer.lower()
    try:
        role = requester({"type": "userRole", "user": signer})
        _refuse(isinstance(role, dict) and set(role) == {"role", "data"}
                and role["role"] == "agent"
                and isinstance(role["data"], dict) and set(role["data"]) == {"user"}
                and isinstance(role["data"]["user"], str)
                and role["data"]["user"].lower() == master)
        rows = requester({"type": "extraAgents", "user": master})
        _refuse(isinstance(rows, list) and len(rows) <= MAX_AGENTS)
        matching = []
        for row in rows:
            _refuse(isinstance(row, dict) and set(row) == {"name", "address", "validUntil"}
                    and isinstance(row["name"], str) and len(row["name"]) <= 128
                    and not any(ord(char) < 32 for char in row["name"])
                    and isinstance(row["address"], str) and ADDRESS.fullmatch(row["address"]) is not None
                    and type(row["validUntil"]) is int and 0 < row["validUntil"] <= 2**53 - 1)
            if row["address"].lower() == signer:
                matching.append(row)
        _refuse(len(matching) == 1)
        grant = matching[0]
        now = int(time.time() * 1000) if now_ms is None else now_ms
        _refuse(type(now) is int and 0 <= now <= 2**53 - 1
                and grant["validUntil"] > now + MIN_REMAINING_MS)
        descriptor = {
            "version": 1, "origin": TESTNET_ORIGIN, "master": master,
            "signer": signer, "name": grant["name"], "validUntil": grant["validUntil"],
        }
        encoded = json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode("ascii")
        return AgentGrant(hashlib.sha256(encoded).hexdigest(), grant["validUntil"])
    except Exception:
        raise AgentGrantRefused("Hyperliquid Testnet agent grant is unproved.") from None
