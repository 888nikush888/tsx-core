"""Task-local original entry deadline, never an account-wide recovery deadline."""
from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from common import ExchangeContractError, RequestDeadline


class EntryDeadlineError(ExchangeContractError):
    http_status = 422

    def __init__(self, code: str, detail: str):
        self.code = code
        super().__init__(f'{code}: {detail}')


class EntryDeadline:
    def __init__(self, request: dict[str, Any]):
        self.request = request
        self.expires_at = request.get('entryExpiresAt') if request.get('reduceOnly') is not True else None
        self.required = request.get('reduceOnly') is not True
        if self.required and (not isinstance(self.expires_at, int) or isinstance(self.expires_at, bool)
                              or not 0 < self.expires_at <= 2**53 - 1):
            raise EntryDeadlineError('ENTRY_DEADLINE_UNPROVEN', 'Original absolute entry deadline is required.')
        self.ensure()

    def ensure(self):
        if not self.required:
            return
        if self.request.get('entryExpiresAt') != self.expires_at or self.request.get('reduceOnly') is True:
            raise EntryDeadlineError('ENTRY_DEADLINE_CHANGED', 'Original entry deadline changed while awaiting dispatch.')
        if int(time.time() * 1000) >= self.expires_at:
            raise EntryDeadlineError('ENTRY_INTENT_EXPIRED', 'Original signal deadline expired before entry dispatch.')

    def bound_budget(self, transport: RequestDeadline) -> RequestDeadline:
        # The executor independently enforces the original horizon even if a caller
        # supplies a later transport deadline. Independent reducing keeps its own budget.
        return RequestDeadline(min(transport.deadline_at_ms, self.expires_at)) if self.required else transport


_current: ContextVar[EntryDeadline | None] = ContextVar('tsx_entry_deadline', default=None)


@contextmanager
def entry_deadline_scope(fence: EntryDeadline):
    fence.ensure()
    token = _current.set(fence if fence.required else None)
    try:
        yield
    finally:
        _current.reset(token)


def assert_entry_transport_deadline():
    """Called after SDK throttling/signing, immediately before its HTTP transport."""
    fence = _current.get()
    if fence is not None:
        fence.ensure()


def assert_entry_deadline(request: dict[str, Any]):
    if request.get('reduceOnly') is True:
        return
    assert_entry_transport_deadline()
    fence = _current.get()
    if fence is not None and request.get('entryExpiresAt') != fence.expires_at:
        raise EntryDeadlineError('ENTRY_DEADLINE_CHANGED', 'Entry request no longer matches its captured original deadline.')
    EntryDeadline(request).ensure()
