"""Offline transport and parsing tests for the optional public-account diagnostic."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import hyperliquid_testnet_preflight as preflight


ADDRESS = "0x" + "a" * 40
ACCOUNT = {
    "assetPositions": [{"position": {"szi": "0"}}],
    "marginSummary": {"accountValue": "12.5", "totalNtlPos": "0"},
    "withdrawable": "12.5",
}


class FakeResponse:
    def __init__(self, body, status=200, encoding="identity"):
        self.body = body
        self.status = status
        self.encoding = encoding

    def getheader(self, name, default=None):
        return self.encoding if name == "Content-Encoding" else default

    def read(self, size):
        return self.body[:size]


class FakeConnection:
    calls = []
    response = FakeResponse(b"{}")

    def __init__(self, host, *, timeout, context):
        self.calls.append(("connect", host, timeout, context.verify_mode))

    def request(self, method, path, *, body, headers):
        self.calls.append(("request", method, path, json.loads(body), headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.calls.append(("close",))


class HyperliquidTestnetReadOnlyTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.calls = []
        FakeConnection.response = FakeResponse(b' {"role":"user"} ')

    def test_probe_only_reads_three_info_types_and_hides_address_and_balances(self):
        responses = iter([{"role": "user"}, ACCOUNT, []])
        requests = []

        def requester(payload):
            requests.append(payload)
            return next(responses)

        result = preflight.probe(ADDRESS, requester=requester)
        self.assertEqual([row["type"] for row in requests], ["userRole", "clearinghouseState", "openOrders"])
        self.assertTrue(all(row["user"] == ADDRESS and set(row) == {"type", "user"} for row in requests))
        self.assertEqual(result["role"], "user")
        self.assertTrue(result["flat"])
        self.assertTrue(result["funded"])
        self.assertTrue(result["withdrawablePositive"])
        self.assertEqual(result["openOrderCount"], 0)
        self.assertEqual(result["scope"], "diagnostic-only")
        rendered = json.dumps(result)
        self.assertNotIn(ADDRESS, rendered)
        self.assertNotIn("12.5", rendered)

    def test_position_and_order_data_cannot_be_mistaken_for_flat(self):
        state = {**ACCOUNT, "assetPositions": [{"position": {"szi": "-0.4"}}]}
        result = preflight.summarize({"role": "user"}, state, [{"coin": "BTC"}])
        self.assertEqual(result["positionCount"], 1)
        self.assertFalse(result["flat"])
        self.assertEqual(result["openOrderCount"], 1)
        stale = {**ACCOUNT, "marginSummary": {"accountValue": "12.5", "totalNtlPos": "0.1"}}
        self.assertFalse(preflight.summarize({"role": "user"}, stale, [])["flat"])

    def test_malformed_provider_data_fails_closed(self):
        invalid = [
            ({"role": "unknown"}, ACCOUNT, []),
            ({"role": "user"}, {**ACCOUNT, "assetPositions": "empty"}, []),
            ({"role": "user"}, {**ACCOUNT, "withdrawable": "NaN"}, []),
            ({"role": "user"}, {**ACCOUNT, "marginSummary": {"accountValue": "Infinity", "totalNtlPos": "0"}}, []),
            ({"role": "user"}, ACCOUNT, [{}]),
        ]
        for role, state, orders in invalid:
            with self.subTest(state=state, orders=orders), self.assertRaises(preflight.PreflightError):
                preflight.summarize(role, state, orders)

    def test_direct_https_ignores_proxy_environment_and_uses_exact_testnet_path(self):
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:9999", "HTTP_PROXY": "http://127.0.0.1:9999"}):
            result = preflight.post_info({"type": "userRole", "user": ADDRESS}, connection_factory=FakeConnection)
        self.assertEqual(result, {"role": "user"})
        self.assertEqual(FakeConnection.calls[0][1], "api.hyperliquid-testnet.xyz")
        self.assertEqual(FakeConnection.calls[0][2], preflight.REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(FakeConnection.calls[1][:3], ("request", "POST", "/info"))
        self.assertEqual(FakeConnection.calls[-1], ("close",))

    def test_mainnet_lookalike_port_query_and_redirect_are_rejected(self):
        for endpoint in [
            "https://api.hyperliquid.xyz/info",
            "https://api.hyperliquid-testnet.xyz.evil.invalid/info",
            "https://api.hyperliquid-testnet.xyz:443/info",
            "http://api.hyperliquid-testnet.xyz/info",
            "https://api.hyperliquid-testnet.xyz/info?x=1",
            "https://user@api.hyperliquid-testnet.xyz/info",
        ]:
            with self.subTest(endpoint=endpoint), self.assertRaises(preflight.PreflightError):
                preflight.post_info({"type": "userRole", "user": ADDRESS}, endpoint=endpoint, connection_factory=FakeConnection)
        self.assertEqual(FakeConnection.calls, [])
        FakeConnection.response = FakeResponse(b"{}", status=302)
        with self.assertRaises(preflight.PreflightError):
            preflight.post_info({"type": "userRole", "user": ADDRESS}, connection_factory=FakeConnection)
        self.assertEqual([entry[0] for entry in FakeConnection.calls], ["connect", "request", "close"])

    def test_large_or_compressed_response_is_rejected_and_closed(self):
        for response in [
            FakeResponse(b"x" * (preflight.MAX_RESPONSE_BYTES + 1)),
            FakeResponse(b"{}", encoding="gzip"),
        ]:
            FakeConnection.calls = []
            FakeConnection.response = response
            with self.assertRaises(preflight.PreflightError):
                preflight.post_info({"type": "userRole", "user": ADDRESS}, connection_factory=FakeConnection)
            self.assertEqual(FakeConnection.calls[-1], ("close",))

    def test_network_timeout_is_reported_without_provider_or_address_details(self):
        class TimedOutConnection(FakeConnection):
            def getresponse(self):
                raise TimeoutError("provider detail containing " + ADDRESS)

        with self.assertRaises(preflight.PreflightError) as caught:
            preflight.post_info({"type": "userRole", "user": ADDRESS}, connection_factory=TimedOutConnection)
        self.assertNotIn(ADDRESS, str(caught.exception))
        self.assertEqual(FakeConnection.calls[-1], ("close",))

    def test_only_public_address_file_is_accepted_without_echoing_contents(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "public-address.txt"
            path.write_text(ADDRESS + "\n", encoding="ascii")
            self.assertEqual(preflight.read_public_address_file(path), ADDRESS)
            path.write_text("private-key-like-input\n", encoding="ascii")
            with self.assertRaises(preflight.PreflightError) as caught:
                preflight.read_public_address_file(path)
            self.assertNotIn("private-key-like-input", str(caught.exception))
            path.write_bytes(b"x" * (preflight.MAX_ADDRESS_FILE_BYTES + 1))
            with self.assertRaises(preflight.PreflightError):
                preflight.read_public_address_file(path)

    def test_unsupported_request_is_refused_before_connection(self):
        with self.assertRaises(preflight.PreflightError):
            preflight.post_info({"type": "exchange", "user": ADDRESS}, connection_factory=FakeConnection)
        self.assertEqual(FakeConnection.calls, [])


if __name__ == "__main__":
    unittest.main()
