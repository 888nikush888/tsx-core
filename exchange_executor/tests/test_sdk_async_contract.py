"""Exercise the pinned SDK's actual concurrent initialization without network I/O."""
from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import ccxt.async_support as ccxt_async
import ccxt.pro as ccxt_pro

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccxt_sdk_policy import client_class


class SdkAsyncContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_hyperliquid_setup_refusals_remain_awaitable_for_real_sdk_initialization(self):
        for sdk in (ccxt_async, ccxt_pro):
            with self.subTest(sdk=sdk.__name__):
                client = client_class('hyperliquid', sdk.hyperliquid)({'enableRateLimit': False})
                client.fetch = AsyncMock(side_effect=AssertionError('No network transport is authorized.'))
                client.is_unified_enabled = AsyncMock(return_value=False)
                try:
                    for name in ('handle_builder_fee_approval', 'set_ref'):
                        operation = getattr(client, name)
                        self.assertTrue(inspect.iscoroutinefunction(operation))
                        self.assertFalse(await operation())
                    self.assertTrue(await client.initialize_client())
                    client.is_unified_enabled.assert_awaited_once()
                    client.fetch.assert_not_awaited()
                finally:
                    await client.close()


if __name__ == '__main__':
    unittest.main()
