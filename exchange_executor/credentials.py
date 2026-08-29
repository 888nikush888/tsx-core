from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from typing import Any

ACCOUNT_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
CREDENTIAL_FIELDS = {
    "apiKey", "secret", "uid", "accountId", "login", "password", "twofa",
    "privateKey", "walletAddress", "token",
}


class CredentialError(ValueError):
    pass


class CredentialStore:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.accounts = self.root / "trading"

    def token(self) -> str:
        token = self._read_small_file(self.root / "exchange_executor_token", 1024).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            raise CredentialError("Exchange executor token is invalid.")
        return token

    def account(self, account_id: str, exchange: str) -> dict[str, Any]:
        if not ACCOUNT_ID.fullmatch(account_id):
            raise CredentialError("Invalid account identifier.")
        content = self._read_small_file(self.accounts / f"{account_id}.json", 8192)
        try:
            value = json.loads(content)
        except json.JSONDecodeError as error:
            raise CredentialError("Trading credential JSON is invalid.") from error
        if not isinstance(value, dict) or value.get("version") not in {1, 2}:
            raise CredentialError("Unsupported trading credential version.")
        if value.get("accountId") != account_id or value.get("exchange") != exchange:
            raise CredentialError("Trading credentials do not match the requested account.")
        normalized = self._normalize(value, exchange)
        self._validate_fields(normalized["credentials"], exchange)
        return normalized

    @staticmethod
    def _read_small_file(file_path: Path, maximum: int) -> str:
        metadata = file_path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise CredentialError(f"{file_path.name} must be a regular file.")
        if metadata.st_size < 1 or metadata.st_size > maximum:
            raise CredentialError(f"{file_path.name} has an invalid size.")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(file_path, flags)
        try:
            with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as handle:
                return handle.read(maximum + 1)
        finally:
            os.close(descriptor)

    @staticmethod
    def _normalize(value: dict[str, Any], exchange: str) -> dict[str, Any]:
        if value.get("version") == 1:
            credentials = (
                {"privateKey": value.get("privateKey"), "walletAddress": value.get("walletAddress")}
                if exchange == "hyperliquid"
                else {"apiKey": value.get("apiKey"), "secret": value.get("apiSecret")}
            )
        else:
            if set(value) != {"version", "accountId", "exchange", "credentials", "updatedAt"}:
                raise CredentialError("Trading credential V2 has an invalid schema.")
            credentials = value.get("credentials")
        if not isinstance(credentials, dict):
            raise CredentialError("Trading credential fields are invalid.")
        unknown = set(credentials) - CREDENTIAL_FIELDS
        if unknown:
            raise CredentialError(f"Trading credentials contain an unsupported credential field: {sorted(unknown)[0]}.")
        return {
            "version": 2,
            "accountId": value["accountId"],
            "exchange": exchange,
            "credentials": credentials,
            "updatedAt": value.get("updatedAt"),
        }

    @staticmethod
    def _validate_fields(value: dict[str, Any], exchange: str) -> None:
        for field, field_value in value.items():
            if not isinstance(field_value, str) or not 1 <= len(field_value) <= 4096 or any(char in field_value for char in "\r\n\0"):
                raise CredentialError(f"{exchange} {field} is invalid.")
        if exchange == "hyperliquid":
            if not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(value.get("privateKey", ""))):
                raise CredentialError("Hyperliquid private key is invalid.")
            if not re.fullmatch(r"0x[0-9a-fA-F]{40}", str(value.get("walletAddress", ""))):
                raise CredentialError("Hyperliquid wallet address is invalid.")
            return
        if exchange in {"bybit", "krakenfutures"}:
            for field in ("apiKey", "secret"):
                secret = value.get(field)
                if not isinstance(secret, str) or not 8 <= len(secret) <= 256 or any(char in secret for char in "\r\n\0"):
                    raise CredentialError(f"{exchange} {field} is invalid.")
        # Dynamically discovered exchanges are validated against the same
        # allowlist here; required fields are enforced by their certified
        # catalog/profile before the control plane writes the file.
