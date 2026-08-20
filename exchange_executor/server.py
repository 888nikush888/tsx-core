from __future__ import annotations

import hmac
import json
import os
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from bybit_adapter import BybitAdapter
from common import ExchangeContractError, RequestDeadline, account_request
from credentials import CredentialError, CredentialStore
from hyperliquid_adapter import HyperliquidAdapter
from stream_hub import ExchangeStreamHub

MAX_BODY_BYTES = 128 * 1024
MAX_IN_FLIGHT_REQUESTS = 8

EXECUTOR_ERROR_CODES = {
    "/v1/verify-account": "ACCOUNT_VERIFY_FAILED",
    "/v1/account-snapshot": "ACCOUNT_SNAPSHOT_FAILED",
    "/v1/market-snapshot": "MARKET_SNAPSHOT_FAILED",
    "/v1/submit-order": "ORDER_SUBMIT_FAILED",
    "/v1/submit-protected-entry": "PROTECTED_ENTRY_SUBMIT_FAILED",
    "/v1/cancel-order": "ORDER_CANCEL_FAILED",
    "/v1/open-state": "OPEN_STATE_FAILED",
    "/v1/stream-events": "STREAM_POLL_FAILED",
}


def executor_error_code(path: str) -> str:
    return EXECUTOR_ERROR_CODES.get(path, "EXECUTOR_REQUEST_FAILED")


class Application:
    def __init__(self, secret_directory: str) -> None:
        self.credentials = CredentialStore(secret_directory)
        load_token_with_retry(self.credentials)
        self.adapters = {
            "hyperliquid": HyperliquidAdapter(self.credentials),
            "bybit": BybitAdapter(self.credentials),
        }
        self.streams = ExchangeStreamHub(self.credentials)

    def handle(self, path: str, payload: dict[str, Any]) -> Any:
        deadline = RequestDeadline.from_payload(payload)
        account = account_request(payload)
        adapter = self.adapters[account["exchange"]]
        if path == "/v1/verify-account":
            return adapter.verify(account, deadline)
        if path == "/v1/account-snapshot":
            return adapter.account_snapshot(account, deadline)
        if path == "/v1/market-snapshot":
            return adapter.market_snapshot(account, required_string(payload, "symbol"), deadline)
        if path == "/v1/submit-order":
            return self._submit_order(adapter, account, payload, deadline)
        if path == "/v1/submit-protected-entry":
            return self._submit_protected_entry(adapter, account, payload, deadline)
        if path == "/v1/cancel-order":
            return adapter.cancel_order(
                account,
                required_string(payload, "clientOrderId"),
                required_string(payload, "symbol"),
                deadline,
            )
        if path == "/v1/open-state":
            return adapter.open_state(account, deadline)
        if path == "/v1/stream-events":
            return self._stream_events(account, payload)
        raise ExchangeContractError("Unknown executor endpoint.")

    @staticmethod
    def _submit_order(adapter: Any, account: dict[str, Any], payload: dict[str, Any], deadline: RequestDeadline) -> Any:
        request = payload.get("request")
        if not isinstance(request, dict):
            raise ExchangeContractError("request is required.")
        return adapter.submit_order(account, request, deadline)

    @staticmethod
    def _submit_protected_entry(adapter: Any, account: dict[str, Any], payload: dict[str, Any], deadline: RequestDeadline) -> Any:
        entry = payload.get("entry")
        protective_stop = payload.get("protectiveStop")
        if not isinstance(entry, dict) or not isinstance(protective_stop, dict):
            raise ExchangeContractError("entry and protectiveStop are required.")
        return adapter.submit_protected_entry(account, entry, protective_stop, deadline)

    def _stream_events(self, account: dict[str, Any], payload: dict[str, Any]) -> Any:
        cursor = payload.get("cursor")
        symbols = payload.get("symbols")
        if not isinstance(cursor, int) or not isinstance(symbols, list):
            raise ExchangeContractError("cursor and symbols are required.")
        return self.streams.poll(account, cursor, symbols)

    def close(self) -> None:
        self.streams.close()


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
    server_version = "tsx-core-exchange-executor"

    def do_GET(self) -> None:
        if self.path == "/healthz":
            draining = bool(getattr(self.server, "draining", False))
            self._json(
                HTTPStatus.SERVICE_UNAVAILABLE if draining else HTTPStatus.OK,
                {"status": "draining" if draining else "ok"},
            )
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

    def do_POST(self) -> None:
        try:
            if bool(getattr(self.server, "draining", False)):
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Executor is draining."})
                return
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
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception as error:  # SDK/network errors are not exposed with secret-bearing details.
            code = executor_error_code(self.path)
            print(
                f"executor_error endpoint={self.path} code={code} type={type(error).__name__}",
                file=sys.stderr,
                flush=True,
            )
            self._json(
                HTTPStatus.BAD_GATEWAY,
                {"error": "Official exchange SDK request failed.", "code": code},
            )

    def _authenticated(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        token = self.server.application.credentials.token()  # type: ignore[attr-defined]
        expected = f"Bearer {token}"
        return hmac.compare_digest(authorization, expected)

    def _json(self, status: HTTPStatus, payload: Any) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"executor_http {format_string % args}", file=sys.stderr, flush=True)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    request_queue_size = MAX_IN_FLIGHT_REQUESTS

    def __init__(self, server_address: tuple[str, int], handler_class: type[BaseHTTPRequestHandler]) -> None:
        super().__init__(server_address, handler_class)
        self.draining = False
        self._request_slots = threading.BoundedSemaphore(MAX_IN_FLIGHT_REQUESTS)
        self._drain_lock = threading.Lock()

    def process_request(self, request: Any, client_address: Any) -> None:
        if self.draining or not self._request_slots.acquire(blocking=False):
            self.close_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()

    def begin_draining(self) -> bool:
        with self._drain_lock:
            if self.draining:
                return False
            self.draining = True
            return True


def main() -> None:
    host = os.environ.get("EXECUTOR_HOST", "0.0.0.0")
    port = int(os.environ.get("EXECUTOR_PORT", "8090"))
    application = Application(os.environ.get("MANAGED_SECRET_DIR", "/app/secrets"))
    server = BoundedThreadingHTTPServer((host, port), Handler)
    server.application = application  # type: ignore[attr-defined]

    def request_shutdown(_signum: int, _frame: Any) -> None:
        if not server.begin_draining():
            return
        threading.Thread(target=server.shutdown, name="executor-drain", daemon=False).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    print(f"executor_listening host={host} port={port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.begin_draining()
        server.server_close()
        application.close()


if __name__ == "__main__":
    main()
