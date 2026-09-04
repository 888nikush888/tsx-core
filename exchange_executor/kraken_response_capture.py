"""One request's Kraken account-log originals, before the pinned SDK float parser.

The caller owns the existing deadline/budget. This module performs no retry,
uses no shared last-response slot and does not certify wallet/reporting scope.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import re
import secrets
from contextvars import ContextVar
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from common import ExchangeContractError


MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_JSON_NODES = 50_000
MAX_JSON_DEPTH = 32
MAX_NUMBER_TEXT = 256
MAX_REQUEST_TEXT = 8192
HISTORY_ROOTS = frozenset({
    'https://futures.kraken.com/api/history/',
    'https://demo-futures.kraken.com/api/history/',
})
_INVALID_UNICODE = re.compile('[\ud800-\udfff\ufffd]')
_CONTROL = re.compile('[\x00-\x1f\x7f]')
_CLIENT_BINDING_KEY = secrets.token_bytes(32)


def _error(reason: str) -> ExchangeContractError:
    # Never interpolate request headers, credentials or the private response.
    return ExchangeContractError(f'Kraken response capture is unproved: {reason}.')


def _client_binding(rest: Any) -> tuple[str, str]:
    if getattr(rest, 'id', None) != 'krakenfutures':
        raise _error('client')
    urls = getattr(rest, 'urls', None)
    api = urls.get('api') if isinstance(urls, dict) else None
    root = api.get('history') if isinstance(api, dict) else None
    if not isinstance(root, str) or root not in HISTORY_ROOTS:
        raise _error('history origin')
    values = (getattr(rest, 'apiKey', None), getattr(rest, 'secret', None))
    if any(not isinstance(value, str) or not value for value in values):
        raise _error('credentials')
    digest = hmac.digest(_CLIENT_BINDING_KEY, json.dumps(values, ensure_ascii=True).encode(), 'sha256').hex()
    return root, digest


def _request_params(params: Any) -> dict[str, Any]:
    required = {'version', 'sort', 'since', 'before', 'count'}
    if not isinstance(params, dict) or not required <= params.keys() or params.keys() - required - {'from'}:
        raise _error('request parameters')
    if params['version'] != 'v3' or params['sort'] != 'asc' or type(params['count']) is not int or params['count'] != 500:
        raise _error('request profile')
    for key in ('since', 'before', 'from'):
        if key in params and (type(params[key]) is not int or params[key] < 0 or len(str(params[key])) > MAX_NUMBER_TEXT):
            raise _error('request integer')
    if params['before'] <= params['since'] or ('from' in params and params['from'] < 1):
        raise _error('request interval')
    return dict(params)


@dataclass(repr=False)
class _Capture:
    client: Any
    task: Any
    root: str
    credential_hash: str
    query: dict[str, str]
    active: bool = True
    sent: bool = False
    response_seen: bool = False
    failed: bool = False
    exact: dict[str, Any] | None = field(default=None, repr=False)

    def fail(self, reason: str) -> None:
        self.failed = True
        raise _error(reason)

    def assert_owner(self, rest: Any) -> None:
        if not self.active or self.failed or rest is not self.client or asyncio.current_task() is not self.task:
            self.fail('request ownership')
        if _client_binding(rest) != (self.root, self.credential_hash):
            self.fail('changed client binding')

    def assert_request(self, url: Any, method: Any, headers: Any, body: Any) -> None:
        if method != 'GET' or body is not None or not isinstance(url, str) or not isinstance(headers, dict):
            self.fail('transport shape')
        if not _request_text(url) or any(not _request_text(key) or not _request_text(value) for key, value in headers.items()):
            self.fail('transport text')
        try:
            parsed = urlsplit(url)
        except (UnicodeError, ValueError):
            self.fail('endpoint encoding')
        if parsed.fragment or parsed.scheme + '://' + parsed.netloc + parsed.path != self.root + 'v3/account-log':
            self.fail('endpoint scope')
        try:
            pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, errors='strict')
        except (UnicodeError, ValueError):
            self.fail('query encoding')
        if len(pairs) != len(self.query) or dict(pairs) != self.query:
            self.fail('query scope')
        if headers.get('APIKey') != self.client.apiKey or not isinstance(headers.get('Authent'), str) or not headers['Authent']:
            self.fail('authenticated request')


_CURRENT: ContextVar[_Capture | None] = ContextVar('tsx_kraken_exact_response', default=None)


def _request_text(value: Any) -> bool:
    return (isinstance(value, str) and 0 < len(value) <= MAX_REQUEST_TEXT
            and not _CONTROL.search(value) and not _INVALID_UNICODE.search(value))


def _number(token: str) -> Decimal:
    if len(token) > MAX_NUMBER_TEXT:
        raise _error('number length')
    try:
        result = Decimal(token)
    except InvalidOperation as error:
        raise _error('number syntax') from error
    # Check before formatting: 1e100000000 must not allocate a huge string.
    if not result.is_finite() or abs(result.as_tuple().exponent) > MAX_NUMBER_TEXT or result.adjusted() > MAX_NUMBER_TEXT:
        raise _error('number range')
    if len(format(result, 'f')) > MAX_NUMBER_TEXT:
        raise _error('expanded number length')
    return result


def _integer(token: str) -> int:
    if len(token) > MAX_NUMBER_TEXT:
        raise _error('integer length')
    return int(token)


def _constant(_token: str) -> Any:
    raise _error('non-finite number')


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _error('duplicate JSON key')
        result[key] = value
    return result


def _bounded_tree(root: Any) -> None:
    stack, nodes = [(root, 0)], 0
    while stack:
        value, depth = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
            raise _error('JSON structure budget')
        if isinstance(value, dict):
            for key, child in value.items():
                stack.extend(((key, depth + 1), (child, depth + 1)))
        elif isinstance(value, list):
            stack.extend((child, depth + 1) for child in value)
        elif isinstance(value, str) and _INVALID_UNICODE.search(value):
            raise _error('invalid JSON Unicode')


def _exact_json(body: Any) -> dict[str, Any]:
    if not isinstance(body, str) or len(body) > MAX_RESPONSE_BYTES:
        raise _error('missing or oversized response text')
    try:
        if len(body.encode('utf-8', errors='strict')) > MAX_RESPONSE_BYTES:
            raise _error('response byte budget')
        result = json.loads(body, parse_float=_number, parse_int=_integer,
                            parse_constant=_constant, object_pairs_hook=_unique_object)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise _error('invalid original JSON') from error
    if not isinstance(result, dict):
        raise _error('response object')
    _bounded_tree(result)
    return result


class KrakenResponseCapture:
    """Installed before SDK construction; other requests retain the SDK behavior."""

    async def fetch(self, url, method='GET', headers=None, body=None):
        scope = _CURRENT.get()
        if scope is not None:
            scope.assert_owner(self)
            scope.assert_request(url, method, headers, body)
            if scope.sent:
                scope.fail('repeated transport')
            scope.sent = True
        return await super().fetch(url, method, headers, body)

    def on_rest_response(self, code, reason, url, method, response_headers, response_body, request_headers, request_body):
        scope = _CURRENT.get()
        if scope is not None:
            scope.assert_owner(self)
            scope.assert_request(url, method, request_headers, request_body)
            if not scope.sent or scope.response_seen:
                scope.fail('missing transport or repeated response hook')
            scope.response_seen = True
            # Let the actual SDK classify HTTP failures (including Retry-After),
            # rather than converting a rate limit into invented successful data.
            if type(code) is int and code == 200:
                scope.exact = _exact_json(response_body)
        return super().on_rest_response(code, reason, url, method, response_headers, response_body, request_headers, request_body)


async def read_exact_kraken_account_log(rest: Any, params: dict[str, Any]) -> dict[str, Any]:
    """Call inside budget.call's coroutine, not around its wait_for child task."""
    if not callable(getattr(rest, 'historyGetAccountLog', None)):
        raise NotImplementedError('Kraken account-log endpoint is unavailable.')
    if _CURRENT.get() is not None:
        raise _error('nested capture')
    request = _request_params(params)
    root, fingerprint = _client_binding(rest)
    scope = _Capture(rest, asyncio.current_task(), root, fingerprint,
                     {key: str(value) for key, value in request.items() if key != 'version'})
    token = _CURRENT.set(scope)
    try:
        # Pinned fetch2 consumes this local option before signing. No global SDK
        # configuration mutation and no hidden second HTTP call under one grant.
        result = await rest.historyGetAccountLog({**request, 'maxRetriesOnFailure': 0})
        scope.assert_owner(rest)
        if not isinstance(result, dict) or not scope.sent or not scope.response_seen or scope.exact is None:
            scope.fail('missing exact response capture')
        return scope.exact
    finally:
        scope.active = False
        scope.exact = None
        _CURRENT.reset(token)
