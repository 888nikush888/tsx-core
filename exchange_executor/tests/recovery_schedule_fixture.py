"""Emit real pinned-SDK fake responses for the separate Node boundary validator."""
from __future__ import annotations

import asyncio
import json

from test_recovery_schedule import RecoveryScheduleTests, RequestDeadline, now


async def fixture():
    case = RecoveryScheduleTests('test_legacy_query_has_no_synthetic_schedule')
    await case.asyncSetUp()
    try:
        cases = []
        for phase in (0, 1, 2, 3):
            query = case.query(phase)
            response = await case.read(query)
            cases.append({'recovery': query, 'acquisition': response['acquisition']})
        query = case.query()
        query.pop('fxEvidence')
        query.pop('readAccountMode')
        for grant in query['recoverySchedule']['grants']:
            grant.update(maxCalls=0, deferredReason='not_due')
        cases.append({'recovery': query, 'acquisition': (await case.read(query))['acquisition']})

        def invalid_second(path, params, raw):
            if path == '/v5/market/tickers' and params['symbol'] == 'BTCUSDT':
                raw['result']['list'][0]['indexPrice'] = None
            return raw
        case.transform = invalid_second
        query = case.query()
        cases.append({'recovery': query, 'acquisition': (await case.read(query))['acquisition']})
        query = case.query(1)
        before = len(case.http)
        class AfterHistoryDeadline(RequestDeadline):
            def remaining_ms(self):
                return 1000 if len(case.http) - before >= 4 else super().remaining_ms()
        response = await case.read(query, AfterHistoryDeadline(now() + 30000))
        cases.append({'recovery': query, 'acquisition': response['acquisition']})
        return {'account': case.account, 'context': query['recoverySchedule']['binding'], 'cases': cases}
    finally:
        await case.asyncTearDown()


if __name__ == '__main__':
    print(json.dumps(asyncio.run(fixture()), separators=(',', ':')))
