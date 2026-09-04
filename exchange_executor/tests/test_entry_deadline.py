"""Original signal deadlines across local waits; all provider operations are fakes."""
from __future__ import annotations

import copy
import sys
import time
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_adapter import CcxtAdapter
from common import ExchangeContractError, RequestDeadline, UnresolvedOrderOutcome
from test_contracts import FakeHyperliquidRest, FakeRegistry, bound_test_account
from test_entry_price_constraints import bounded_orders, rest_fixture
from server import Application, execute


class EntryDeadlineTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        if hasattr(self, 'clock_patch'):
            self.clock_patch.stop()
        self.clock = [time.time()]
        self.clock_patch = patch('time.time', side_effect=lambda: self.clock[0])
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        entry, stop = bounded_orders()
        entry['entryExpiresAt'] = int(self.clock[0] * 1000) + 5000
        return entry, stop, RequestDeadline(int(self.clock[0] * 1000) + 30_000)

    async def test_expiry_during_mutation_wait_never_reaches_provider_reads_or_writes(self):
        entry, stop, deadline = self.fixture()
        original = copy.deepcopy((entry, stop))
        rest = rest_fixture()
        rest.fetch_positions = AsyncMock(return_value=[])
        registry = FakeRegistry(rest)
        mutation = registry.mutation

        @asynccontextmanager
        async def delayed(account, budget):
            self.assertEqual(budget.deadline_at_ms, original[0]['entryExpiresAt'])
            self.clock[0] += 6
            async with mutation(account, budget) as clients:
                yield clients

        registry.mutation = delayed
        with self.assertRaisesRegex(ExchangeContractError, 'ENTRY_INTENT_EXPIRED'):
            await CcxtAdapter(registry).submit_protected_entry(bound_test_account(), entry, stop, deadline)
        self.assertEqual((entry, stop), original)
        rest.fetch_positions.assert_not_awaited()
        self.assertEqual((rest.created_batches, rest.leverage), ([], []))

    async def test_expiry_after_each_mode_or_tier_read_never_sends_entry(self):
        for phase in ('first_mode', 'final_mode', 'first_tier', 'final_tier'):
            with self.subTest(phase=phase):
                entry, stop, deadline = self.fixture()
                rest = rest_fixture()
                rest.configured_leverage = 10
                adapter = CcxtAdapter(FakeRegistry(rest))
                name = '_entry_mode_fence' if phase.endswith('mode') else '_entry_tier_fence'
                read = getattr(adapter, name)
                count = [0]

                async def delayed(*args):
                    evidence = await read(*args)
                    count[0] += 1
                    if count[0] == (1 if phase.startswith('first') else 2):
                        self.clock[0] += 6
                    return evidence

                setattr(adapter, name, delayed)
                with self.assertRaisesRegex(ExchangeContractError, 'ENTRY_INTENT_EXPIRED'):
                    await adapter.submit_protected_entry(bound_test_account(), entry, stop, deadline)
                self.assertEqual(rest.created_batches, [])
                if phase.startswith('first'):
                    self.assertEqual(rest.leverage, [])

    async def test_expiry_cannot_be_extended_while_waiting_for_ownership(self):
        entry, stop, deadline = self.fixture()
        rest = rest_fixture()
        registry = FakeRegistry(rest)
        mutation = registry.mutation

        @asynccontextmanager
        async def changed(account, budget):
            entry['entryExpiresAt'] += 30_000
            async with mutation(account, budget) as clients:
                yield clients

        registry.mutation = changed
        with self.assertRaisesRegex(ExchangeContractError, 'ENTRY_DEADLINE_CHANGED'):
            await CcxtAdapter(registry).submit_protected_entry(bound_test_account(), entry, stop, deadline)
        self.assertEqual((rest.created_batches, rest.leverage), ([], []))

    async def test_missing_invalid_or_expired_original_never_acquires_client(self):
        entry, stop, deadline = self.fixture()
        for value in (None, True, '123', 1.5, 0, -1, 2**53, int(self.clock[0] * 1000)):
            registry = FakeRegistry(rest_fixture())
            registry.mutation = Mock(side_effect=AssertionError('Must reject before client acquisition.'))
            with self.subTest(value=value), self.assertRaisesRegex(ExchangeContractError, 'ENTRY_(DEADLINE_UNPROVEN|INTENT_EXPIRED)'):
                await CcxtAdapter(registry).submit_protected_entry(bound_test_account(), {**entry, 'entryExpiresAt': value}, stop, deadline)
            registry.mutation.assert_not_called()

    async def test_private_preparation_copy_cannot_replace_its_captured_deadline(self):
        entry, stop, deadline = self.fixture()
        rest = rest_fixture()
        adapter = CcxtAdapter(FakeRegistry(rest))
        read = adapter._entry_tier_fence

        async def changed(clients, market, request, spec, budget):
            evidence = await read(clients, market, request, spec, budget)
            request['entryExpiresAt'] += 30_000
            return evidence

        adapter._entry_tier_fence = changed
        with self.assertRaisesRegex(ExchangeContractError, 'ENTRY_DEADLINE_CHANGED'):
            await adapter.submit_protected_entry(bound_test_account(), entry, stop, deadline)
        self.assertEqual((rest.created_batches, rest.leverage), ([], []))

    async def test_expired_http_payload_has_precise_code_without_fabricated_absence(self):
        import asyncio
        import json

        entry, stop, deadline = self.fixture()
        self.clock[0] += 6
        application = Application.__new__(Application)
        application.credentials = SimpleNamespace(token=lambda: 'fake-token')
        application.adapter = SimpleNamespace(submit_protected_entry=AsyncMock(side_effect=AssertionError('No dispatch.')))
        request = SimpleNamespace(app={'application': application, 'request_semaphore': asyncio.Semaphore(1)},
            headers={'Authorization': 'Bearer fake-token'}, content_length=100, path='/v1/submit-protected-entry',
            json=AsyncMock(return_value={'account': bound_test_account(), 'entry': entry, 'protectiveStop': stop,
                                        'deadlineAt': deadline.deadline_at_ms}))
        response = await execute(request)
        body = json.loads(response.text)
        self.assertEqual((response.status, body['code']), (422, 'ENTRY_INTENT_EXPIRED'))
        self.assertNotIn('sideEffects', body, 'A generic TTL error must not certify unknown earlier writes absent.')
        application.adapter.submit_protected_entry.assert_not_called()

    async def test_valid_entry_remains_valid_and_late_ack_does_not_erase_possible_send(self):
        entry, stop, deadline = self.fixture()
        rest = rest_fixture()
        create = rest.create_orders

        async def late_ack(orders):
            result = await create(orders)
            self.clock[0] += 6
            return result

        rest.create_orders = late_ack
        result = await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), entry, stop, deadline)
        self.assertEqual(result['entry']['status'], 'filled')
        self.assertEqual(len(rest.created_batches), 1)
        self.assertEqual(rest.cleanup_orders, [])

    async def test_unknown_after_possible_send_is_not_expired_absence_or_fallback(self):
        entry, stop, deadline = self.fixture()
        rest = rest_fixture()
        create = rest.create_orders

        async def late_failure(orders):
            await create(orders)
            self.clock[0] += 6
            raise TimeoutError('Response lost after possible provider send.')

        rest.create_orders = late_failure
        with self.assertRaises(UnresolvedOrderOutcome) as error:
            await CcxtAdapter(FakeRegistry(rest)).submit_protected_entry(bound_test_account(), entry, stop, deadline)
        self.assertTrue(error.exception.side_effects)
        self.assertEqual(len(rest.created_batches), 1)
        self.assertEqual(rest.cleanup_orders, [])

    async def test_expired_entry_does_not_poison_later_reduce_only_stop(self):
        entry, _, deadline = self.fixture()
        rest = FakeHyperliquidRest()
        adapter = CcxtAdapter(FakeRegistry(rest, 'hyperliquid'))
        self.clock[0] += 6
        with self.assertRaisesRegex(ExchangeContractError, 'ENTRY_INTENT_EXPIRED'):
            await adapter.submit_order(bound_test_account('hyperliquid'), entry, deadline)
        _, stop = bounded_orders(exchange='hyperliquid')
        await adapter.submit_order(bound_test_account('hyperliquid'), stop, deadline)
        self.assertEqual(len(rest.submitted), 1)
        self.assertTrue(rest.submitted[0][1]['params']['reduceOnly'])


if __name__ == '__main__':
    unittest.main()
