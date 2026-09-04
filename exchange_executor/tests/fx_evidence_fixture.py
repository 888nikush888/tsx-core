"""Emit actual FX producer output for Node; all SDK transport stays locally fake."""
from __future__ import annotations

import asyncio
import json

from test_fx_evidence import FxEvidenceTests


async def fixture():
    probe = FxEvidenceTests()
    await probe.asyncSetUp()
    try:
        return await probe.read()
    finally:
        await probe.asyncTearDown()


if __name__ == '__main__':
    print(json.dumps(asyncio.run(fixture()), separators=(',', ':'), ensure_ascii=True))
