from __future__ import annotations

import hashlib
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bybit_account_mode import read_bybit_account_mode
from common import ExchangeContractError, RequestDeadline
from history_reader import RecoveryBudgetExhausted, RecoveryReadBudget


def rest(mode=5):
    return SimpleNamespace(
        privateGetV5UserQueryApi=AsyncMock(return_value={'retCode': 0, 'result': {
            'userID': 9007199254740993, 'isMaster': False, 'parentUid': '42', 'uta': 1,
            'apiKey': 'DO-NOT-RETURN', 'secret': 'DO-NOT-RETURN', 'createdAt': 'not-account-birth'}}),
        privateGetV5AccountInfo=AsyncMock(return_value={'retCode': 0, 'result': {
            'unifiedMarginStatus': mode, 'updatedTime': '0'}}),
    )


class BybitAccountModeTests(unittest.IsolatedAsyncioTestCase):
    def budget(self, remaining=5, deadline=30_000):
        return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + deadline), remaining=remaining)

    async def test_raw_bound_observation_preserves_uid_and_no_secret_or_birth_claim(self):
        client, budget = rest(), self.budget()
        result = await read_bybit_account_mode(client, budget, 'a' * 64, 'b' * 64)
        self.assertEqual(budget.calls, 2)
        self.assertEqual(result['providerAccountUid'], '9007199254740993')
        self.assertEqual(result['parentAccountUid'], '42')
        self.assertEqual(result['unifiedMarginStatus'], 5)
        self.assertEqual(result['accountUpdatedAt'], 0)
        self.assertLessEqual(result['startedAt'], result['completedAt'])
        self.assertNotIn('DO-NOT-RETURN', json.dumps(result))
        self.assertNotIn('createdAt', result)
        self.assertNotIn('upgradeTime', result)
        digest = result.pop('evidenceHash')
        self.assertEqual(digest, hashlib.sha256(json.dumps(result, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
        client.privateGetV5UserQueryApi.assert_awaited_once_with({})
        client.privateGetV5AccountInfo.assert_awaited_once_with({})

    async def test_budget_and_absolute_deadline_never_add_an_unbudgeted_mode_read(self):
        for remaining, deadline, calls in [(0, 30_000, 0), (1, 30_000, 1), (5, 1_000, 0)]:
            client, budget = rest(), self.budget(remaining, deadline)
            with self.assertRaises(RecoveryBudgetExhausted):
                await read_bybit_account_mode(client, budget, 'a' * 64, 'b' * 64)
            self.assertEqual(budget.calls, calls)
            client.privateGetV5AccountInfo.assert_not_called()

    async def test_uta_one_is_an_observation_not_synthesized_uta_two(self):
        for mode in (3, 4, 5, 6):
            result = await read_bybit_account_mode(rest(mode), self.budget(), 'a' * 64, 'b' * 64)
            self.assertEqual(result['unifiedMarginStatus'], mode)

    async def test_missing_mode_uid_role_or_consistency_never_defaults_to_uta_two(self):
        changes = [
            ('key', {'userID': True}), ('key', {'userID': 0}), ('key', {'isMaster': True}),
            ('key', {'parentUid': '0'}), ('key', {'uta': 0}), ('info', {'unifiedMarginStatus': None}),
            ('info', {'unifiedMarginStatus': True}), ('info', {'unifiedMarginStatus': 2}),
            ('info', {'updatedTime': None}),
        ]
        for source, patch in changes:
            client = rest()
            method = client.privateGetV5UserQueryApi if source == 'key' else client.privateGetV5AccountInfo
            method.return_value['result'].update(patch)
            with self.assertRaises(ExchangeContractError, msg=str(patch)):
                await read_bybit_account_mode(client, self.budget(), 'a' * 64, 'b' * 64)

    async def test_wrong_envelopes_and_future_provider_times_are_not_evidence(self):
        for response in ({}, {'retCode': '0', 'result': {}}, {'retCode': 1, 'result': {}},
                         {'retCode': 0, 'result': [], 'time': int(time.time() * 1000)}):
            client = rest()
            client.privateGetV5UserQueryApi.return_value = response
            with self.assertRaises(ExchangeContractError):
                await read_bybit_account_mode(client, self.budget(), 'a' * 64, 'b' * 64)
        client = rest()
        client.privateGetV5AccountInfo.return_value['time'] = int(time.time() * 1000) + 60_000
        with self.assertRaises(ExchangeContractError):
            await read_bybit_account_mode(client, self.budget(), 'a' * 64, 'b' * 64)


if __name__ == '__main__':
    unittest.main()
