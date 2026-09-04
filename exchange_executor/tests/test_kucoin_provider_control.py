"""Control-plane contracts for the bounded KuCoin Classic provider package."""
from __future__ import annotations

import socket
import time
import unittest
from unittest.mock import AsyncMock, patch

from common import ExchangeContractError, RequestDeadline, UnresolvedOrderOutcome
from history_reader import RecoveryReadBudget
from kucoin_execution import classify_kucoin_batch_ack
from kucoin_identity import read_kucoin_classic_observation


FINGERPRINT = "a" * 64
GENERATION = "b" * 64
UID = "165000215"
SYMBOL = "XBTUSDTM"


class Rest:
    def __init__(self):
        self.privateGetUserApiKey = AsyncMock(return_value={
            "code": "200000",
            "data": {
                "remark": "must-not-escape",
                "apiKey": "masked-must-not-escape",
                "apiVersion": 3,
                "permission": "General,Futures",
                "createdAt": 1_758_765_668_000,
                "uid": UID,
                "isMaster": True,
                "region": "PW",
                "kycStatus": 1,
                "siteType": "global",
            },
        })
        self.utaPrivateGetAccountMode = AsyncMock(return_value={
            "code": "200000",
            "data": {"selfAccountMode": "CLASSIC", "unifiedSubAccount": [], "classicSubAccount": [UID]},
        })
        self.futuresPrivateGetPositionGetPositionMode = AsyncMock(return_value={
            "code": "200000", "data": {"positionMode": 0},
        })
        self.futuresPrivateGetPositionGetMarginMode = AsyncMock(return_value={
            "code": "200000", "data": {"symbol": SYMBOL, "marginMode": "CROSS"},
        })
        self.futuresPrivateGetGetCrossUserLeverage = AsyncMock(return_value={
            "code": "200000", "data": {"symbol": SYMBOL, "leverage": "20"},
        })


def budget(calls=5):
    return RecoveryReadBudget(RequestDeadline(int(time.time() * 1000) + 30_000), remaining=calls)


def expected_legs():
    return [
        {"role": "entry", "clientOrderId": "tsx-entry", "providerSymbol": SYMBOL},
        {"role": "stop_loss", "clientOrderId": "tsx-stop", "providerSymbol": SYMBOL},
    ]


class KucoinControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for target in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                       (socket, "getaddrinfo"), (socket, "create_connection")):
            blocker = patch.object(*target, side_effect=AssertionError("Live transport forbidden."))
            blocker.start()
            self.addCleanup(blocker.stop)

    async def test_identity_and_modes_are_one_five_read_bound_observation(self):
        rest = Rest()
        reads = budget()
        result = await read_kucoin_classic_observation(
            rest,
            SYMBOL,
            reads,
            account_fingerprint=FINGERPRINT,
            credential_generation=GENERATION,
        )
        self.assertEqual(reads.calls, 5)
        self.assertEqual(result["providerAccountUid"], UID)
        self.assertEqual(result["providerSymbol"], SYMBOL)
        self.assertEqual((result["accountMode"], result["positionMode"], result["marginMode"]),
                         ("CLASSIC", "oneway", "cross"))
        self.assertEqual(result["leverage"], 20)
        self.assertEqual(result["permissions"], ["Futures", "General"])
        self.assertNotIn("apiKey", repr(result))
        self.assertNotIn("must-not-escape", repr(result))
        rest.futuresPrivateGetPositionGetMarginMode.assert_awaited_once_with({"symbol": SYMBOL})
        rest.futuresPrivateGetGetCrossUserLeverage.assert_awaited_once_with({"symbol": SYMBOL})

    async def test_identity_uid_drift_and_missing_modes_fail_closed(self):
        for mutation in ("uid", "classic", "position", "margin", "leverage", "permission"):
            with self.subTest(mutation=mutation):
                rest = Rest()
                expected_uid = None
                if mutation == "uid":
                    expected_uid = "other-uid"
                elif mutation == "classic":
                    rest.utaPrivateGetAccountMode.return_value["data"]["selfAccountMode"] = "UNIFIED"
                elif mutation == "position":
                    rest.futuresPrivateGetPositionGetPositionMode.return_value["data"] = {}
                elif mutation == "margin":
                    rest.futuresPrivateGetPositionGetMarginMode.return_value["data"]["marginMode"] = "ISOLATED"
                elif mutation == "leverage":
                    rest.futuresPrivateGetGetCrossUserLeverage.return_value["data"]["leverage"] = 20.0
                else:
                    rest.privateGetUserApiKey.return_value["data"]["permission"] = "General"
                with self.assertRaises(ExchangeContractError):
                    await read_kucoin_classic_observation(
                        rest,
                        SYMBOL,
                        budget(),
                        account_fingerprint=FINGERPRINT,
                        credential_generation=GENERATION,
                        expected_provider_uid=expected_uid,
                    )

    async def test_identity_requires_binding_hashes_and_exact_symbol(self):
        for arguments in (
            {"account_fingerprint": "x", "credential_generation": GENERATION},
            {"account_fingerprint": FINGERPRINT, "credential_generation": "x"},
            {"account_fingerprint": FINGERPRINT, "credential_generation": GENERATION, "provider_symbol": "xbtusdtm"},
        ):
            with self.subTest(arguments=arguments), self.assertRaises(ExchangeContractError):
                await read_kucoin_classic_observation(
                    Rest(),
                    arguments.pop("provider_symbol", SYMBOL),
                    budget(),
                    **arguments,
                )

    def test_batch_ack_classifies_both_legs_by_exact_original_identity(self):
        response = {
            "code": "200000",
            "data": [
                {"orderId": "9007199254740993001", "clientOid": "tsx-entry", "symbol": SYMBOL,
                 "code": "200000", "msg": "success"},
                {"orderId": "9007199254740993002", "clientOid": "tsx-stop", "symbol": SYMBOL,
                 "code": "200000", "msg": "success"},
            ],
        }
        result = classify_kucoin_batch_ack(response, expected_legs())
        self.assertEqual(result[0]["exchangeOrderId"], "9007199254740993001")
        self.assertEqual(result[1]["exchangeOrderId"], "9007199254740993002")
        self.assertEqual([row["status"] for row in result], ["accepted", "accepted"])

    def test_batch_ack_preserves_explicit_per_leg_rejection(self):
        response = {
            "code": "200000",
            "data": [
                {"orderId": "11", "clientOid": "tsx-entry", "symbol": SYMBOL,
                 "code": "200000", "msg": "success"},
                {"orderId": None, "clientOid": "tsx-stop", "symbol": SYMBOL,
                 "code": "300001", "msg": "active order limit"},
            ],
        }
        result = classify_kucoin_batch_ack(response, expected_legs())
        self.assertEqual([row["status"] for row in result], ["accepted", "rejected"])
        self.assertIsNone(result[1]["exchangeOrderId"])
        self.assertEqual(result[1]["providerCode"], "300001")

    def test_batch_ack_missing_duplicate_or_wrong_leg_is_unresolved_after_dispatch(self):
        cases = [
            {"code": "200000", "data": []},
            {"code": "200000", "data": [
                {"orderId": "1", "clientOid": "tsx-entry", "symbol": SYMBOL, "code": "200000", "msg": "ok"},
                {"orderId": "2", "clientOid": "tsx-entry", "symbol": SYMBOL, "code": "200000", "msg": "ok"},
            ]},
            {"code": "200000", "data": [
                {"orderId": "1", "clientOid": "tsx-entry", "symbol": "OTHER", "code": "200000", "msg": "ok"},
            ]},
        ]
        for response in cases:
            with self.subTest(response=response), self.assertRaises(UnresolvedOrderOutcome) as captured:
                classify_kucoin_batch_ack(response, expected_legs())
            self.assertTrue(captured.exception.details["unresolvedClientOrderIds"])

    def test_batch_ack_rejects_float_bool_or_unexpected_leg_inputs(self):
        bad_rows = [
            {"orderId": 1.0, "clientOid": "tsx-entry", "symbol": SYMBOL, "code": "200000", "msg": "ok"},
            {"orderId": True, "clientOid": "tsx-entry", "symbol": SYMBOL, "code": "200000", "msg": "ok"},
            {"orderId": "1", "clientOid": "foreign", "symbol": SYMBOL, "code": "200000", "msg": "ok"},
        ]
        for row in bad_rows:
            response = {"code": "200000", "data": [row]}
            with self.subTest(row=row), self.assertRaises(UnresolvedOrderOutcome):
                classify_kucoin_batch_ack(response, expected_legs())

    def test_batch_ack_unknown_or_transient_provider_code_is_unresolved(self):
        for code in ("300002", "429000", "500000", "new-code"):
            response = {"code": "200000", "data": [
                {"orderId": None, "clientOid": "tsx-entry", "symbol": SYMBOL,
                 "code": code, "msg": "not a reviewed definite rejection"},
            ]}
            with self.subTest(code=code), self.assertRaises(UnresolvedOrderOutcome):
                classify_kucoin_batch_ack(response, expected_legs())


if __name__ == "__main__":
    unittest.main()
