"""Recovery-first bounded fairness; no independent funding request budget or worker."""
from __future__ import annotations

import copy

from ccxt.base.errors import BadRequest, InvalidOrder, NetworkError, NotSupported, RateLimitExceeded

from account_log_reader import read_account_log_page, validate_log_checkpoint
from bybit_account_mode import read_bybit_account_mode
from common import ExchangeContractError
from history_reader import RecoveryBudgetExhausted, now_ms


class RecoveryBudgetSlice:
    def __init__(self, budget, limit):
        self.budget, self.limit, self.started_calls = budget, limit, budget.calls

    @property
    def remaining(self):
        return min(self.budget.remaining, max(0, self.limit - (self.budget.calls - self.started_calls)))

    @property
    def calls(self):
        return self.budget.calls

    @property
    def resume_at(self):
        return self.budget.resume_at

    async def call(self, operation):
        if self.remaining <= 0:
            raise RecoveryBudgetExhausted()
        return await self.budget.call(operation)

    def suspend(self, rest, error):
        self.budget.suspend(rest, error)


def account_log_request(recovery, exchange):
    value = recovery.get('accountLogs') if isinstance(recovery, dict) else None
    return validate_log_checkpoint(value, exchange) if value is not None else None


async def read_account_mode(rest, exchange, query, budget, binding, *, scheduled=False):
    if not query.get('readAccountMode'):
        return None
    before = budget.calls
    observation, reason = None, None
    try:
        if exchange != 'bybit':
            raise NotImplementedError()
        # Persisted producer revision alternates bootstrap-mode work with old
        # history if mode evidence repeatedly fails. Restart cannot reset fairness.
        revision = (query.get('accountLogs') or {}).get('revision', 0)
        if budget.remaining < 2 or (not scheduled and revision % 2 == 1):
            raise RecoveryBudgetExhausted()
        observation = await read_bybit_account_mode(rest, budget, binding[0], binding[1])
    except RecoveryBudgetExhausted:
        reason = 'budget_exhausted'
    except (NetworkError, RateLimitExceeded, TimeoutError) as error:
        budget.suspend(rest, error)
        reason = 'transient'
    except (NotImplementedError, NotSupported, BadRequest, InvalidOrder, ExchangeContractError):
        reason = 'unsupported'
    return {'calls': budget.calls - before, 'observation': observation, 'reason': reason}


def _skipped_log_reason(reason):
    if reason in ('source_unsupported', 'source_retention_unproven'):
        return 'unsupported'
    if reason == 'invalid_source_evidence':
        return 'invalid_evidence'
    return 'transient' if reason == 'transient' else 'budget_exhausted'


async def read_account_logs(rest, exchange, query, budget, user, *, scheduled=False):
    checkpoint = query.get('accountLogs')
    if checkpoint is None:
        return None
    before = budget.calls
    receipt, next_state = await read_account_log_page(rest, exchange, checkpoint, budget, user)
    if scheduled and budget.calls == before and receipt is None:
        return {'baseRevision': checkpoint['revision'], 'calls': 0, 'checkpoint': copy.deepcopy(checkpoint),
                'receipts': [], 'readSkipped': _skipped_log_reason(next_state.get('reason'))}
    next_state['revision'] = checkpoint['revision'] + 1
    return {'baseRevision': checkpoint['revision'], 'calls': budget.calls - before,
            'checkpoint': next_state, 'receipts': [receipt] if receipt else []}


def target_budget(query, budget):
    logs = query.get('accountLogs')
    due = logs is not None and logs['nextReadAt'] <= now_ms()
    # At least one complete Bybit targeted lookup (2 calls) has priority. Bound
    # repeated uncertainty so it cannot permanently starve durable money history.
    return RecoveryBudgetSlice(budget, 2) if due or query.get('readAccountMode') else budget


def propagate_cooldown(progress, budget):
    if progress is not None and 'readSkipped' not in progress and budget.resume_at > now_ms():
        progress['checkpoint'].update(nextReadAt=budget.resume_at, reason='transient')
