from __future__ import annotations

import asyncio
import hmac
import os
import sys
import time
from typing import Any

from aiohttp import web

from ccxt_adapter import CcxtAdapter
from ccxt_client import CcxtClientRegistry
from common import ExchangeContractError, RequestDeadline, account_request
from credentials import CredentialStore
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


class Application:
    def __init__(self, secret_directory: str) -> None:
        self.credentials = CredentialStore(secret_directory)
        load_token_with_retry(self.credentials)
        self.registry = CcxtClientRegistry(self.credentials)
        self.adapter = CcxtAdapter(self.registry)
        self.streams = ExchangeStreamHub(self.registry)

    async def handle(self, path: str, payload: dict[str, Any]) -> Any:
        deadline = RequestDeadline.from_payload(payload)
        account = account_request(payload)
        if path == "/v1/verify-account":
            return await self.adapter.verify(account, deadline)
        if path == "/v1/account-snapshot":
            return await self.adapter.account_snapshot(account, deadline)
        if path == "/v1/market-snapshot":
            return await self.adapter.market_snapshot(account, required_string(payload, "symbol"), deadline)
        if path == "/v1/submit-order":
            request = payload.get("request")
            if not isinstance(request, dict):
                raise ExchangeContractError("request is required.")
            return await self.adapter.submit_order(account, request, deadline)
        if path == "/v1/submit-protected-entry":
            entry = payload.get("entry")
            stop = payload.get("protectiveStop")
            if not isinstance(entry, dict) or not isinstance(stop, dict):
                raise ExchangeContractError("entry and protectiveStop are required.")
            return await self.adapter.submit_protected_entry(account, entry, stop, deadline)
        if path == "/v1/cancel-order":
            return await self.adapter.cancel_order(
                account,
                required_string(payload, "clientOrderId"),
                required_string(payload, "symbol"),
                deadline,
            )
        if path == "/v1/open-state":
            return await self.adapter.open_state(account, deadline)
        if path == "/v1/stream-events":
            cursor, symbols = payload.get("cursor"), payload.get("symbols")
            if not isinstance(cursor, int) or isinstance(cursor, bool) or not isinstance(symbols, list):
                raise ExchangeContractError("cursor and symbols are required.")
            deadline.ensure()
            return await self.streams.poll(account, cursor, symbols)
        raise ExchangeContractError("Unknown executor endpoint.")

    async def close(self) -> None:
        await self.streams.close()
        await self.registry.close()


def authenticated(request: web.Request, application: Application) -> bool:
    expected = f"Bearer {application.credentials.token()}"
    return hmac.compare_digest(request.headers.get("Authorization", ""), expected)


def json_response(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(
        payload,
        status=status,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
        dumps=lambda value: __import__("json").dumps(value, separators=(",", ":"), default=str),
    )


async def health(request: web.Request) -> web.Response:
    return json_response({"status": "ok"})


async def execute(request: web.Request) -> web.Response:
    application: Application = request.app["application"]
    semaphore: asyncio.Semaphore = request.app["request_semaphore"]
    if not authenticated(request, application):
        return json_response({"error": "Unauthorized."}, 401)
    if request.content_length is None or request.content_length < 2 or request.content_length > MAX_BODY_BYTES:
        return json_response({"error": "Request body size is invalid."}, 400)
    try:
        async with semaphore:
            payload = await request.json(loads=__import__("json").loads)
            if not isinstance(payload, dict):
                raise ExchangeContractError("Request body must be an object.")
            return json_response(await application.handle(request.path, payload))
    except (ExchangeContractError, ValueError) as error:
        return json_response({"error": str(error)}, 400)
    except Exception as error:
        code = executor_error_code(request.path)
        print(f"executor_error endpoint={request.path} code={code} type={type(error).__name__}", file=sys.stderr, flush=True)
        return json_response({"error": "CCXT exchange request failed.", "code": code}, 502)


async def cleanup(app: web.Application) -> None:
    await app["application"].close()


def create_web_application(application: Application) -> web.Application:
    app = web.Application(client_max_size=MAX_BODY_BYTES)
    app["application"] = application
    app["request_semaphore"] = asyncio.Semaphore(MAX_IN_FLIGHT_REQUESTS)
    app.router.add_get("/healthz", health)
    for path in EXECUTOR_ERROR_CODES:
        app.router.add_post(path, execute)
    app.on_cleanup.append(cleanup)
    return app


def main() -> None:
    host = os.environ.get("EXECUTOR_HOST", "0.0.0.0")
    port = int(os.environ.get("EXECUTOR_PORT", "8090"))
    application = Application(os.environ.get("MANAGED_SECRET_DIR", "/app/secrets"))
    print(f"executor_listening host={host} port={port} integration=ccxt ccxt_pro=true", flush=True)
    web.run_app(create_web_application(application), host=host, port=port, print=None, shutdown_timeout=30)


if __name__ == "__main__":
    main()
