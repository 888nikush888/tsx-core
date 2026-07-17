from __future__ import annotations

import hmac
import json
import os
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from bybit_adapter import BybitAdapter
from common import ExchangeContractError, account_request
from credentials import CredentialError, CredentialStore
from hyperliquid_adapter import HyperliquidAdapter

MAX_BODY_BYTES = 128 * 1024


class Application:
    def __init__(self, secret_directory: str) -> None:
        self.credentials = CredentialStore(secret_directory)
        self.token = load_token_with_retry(self.credentials)
        self.adapters = {
            "hyperliquid": HyperliquidAdapter(self.credentials),
            "bybit": BybitAdapter(self.credentials),
        }

    def handle(self, path: str, payload: dict[str, Any]) -> Any:
        account = account_request(payload)
        adapter = self.adapters[account["exchange"]]
        if path == "/v1/verify-account":
            return adapter.verify(account)
        if path == "/v1/account-snapshot":
            return adapter.account_snapshot(account)
        if path == "/v1/market-snapshot":
            return adapter.market_snapshot(account, required_string(payload, "symbol"))
        if path == "/v1/submit-order":
            request = payload.get("request")
            if not isinstance(request, dict):
                raise ExchangeContractError("request is required.")
            return adapter.submit_order(account, request)
        if path == "/v1/cancel-order":
            return adapter.cancel_order(
                account,
                required_string(payload, "clientOrderId"),
                required_string(payload, "symbol"),
            )
        if path == "/v1/open-state":
            return adapter.open_state(account)
        raise ExchangeContractError("Unknown executor endpoint.")


def required_string(payload: dict[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ExchangeContractError(f"{name} is required.")
    return value


def load_token_with_retry(credentials: CredentialStore) -> str:
    deadline = time.monotonic() + 60
    while True:
        try:
            return credentials.token()
        except FileNotFoundError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


class Handler(BaseHTTPRequestHandler):
    server_version = "cb2-exchange-executor"

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json(HTTPStatus.OK, {"status": "ok"})
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

    def do_POST(self) -> None:
        try:
            if not self._authenticated():
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized."})
                return
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 2 or content_length > MAX_BODY_BYTES:
                raise ExchangeContractError("Request body size is invalid.")
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict):
                raise ExchangeContractError("Request body must be an object.")
            result = self.server.application.handle(self.path, payload)  # type: ignore[attr-defined]
            self._json(HTTPStatus.OK, result)
        except (CredentialError, ExchangeContractError, json.JSONDecodeError, ValueError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception as error:  # SDK/network errors are not exposed with secret-bearing details.
            print(f"executor_error type={type(error).__name__}", file=sys.stderr, flush=True)
            self._json(HTTPStatus.BAD_GATEWAY, {"error": "Official exchange SDK request failed."})

    def _authenticated(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.application.token}"  # type: ignore[attr-defined]
        return hmac.compare_digest(authorization, expected)

    def _json(self, status: HTTPStatus, payload: Any) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"executor_http {format_string % args}", file=sys.stderr, flush=True)


def main() -> None:
    host = os.environ.get("EXECUTOR_HOST", "0.0.0.0")
    port = int(os.environ.get("EXECUTOR_PORT", "8090"))
    application = Application(os.environ.get("MANAGED_SECRET_DIR", "/app/secrets"))
    server = ThreadingHTTPServer((host, port), Handler)
    server.application = application  # type: ignore[attr-defined]
    server.daemon_threads = True
    print(f"executor_listening host={host} port={port}", flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
