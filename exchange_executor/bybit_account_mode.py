"""Budgeted authenticated mode observations, never an upgrade date or fill finality."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from common import ExchangeContractError
from history_reader import RecoveryReadBudget, now_ms


def _uid(value: Any) -> str:
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,31}', value):
        raise ExchangeContractError('Invalid authenticated Bybit account identity.')
    return value


def _time(value: Any) -> int:
    if isinstance(value, str) and re.fullmatch(r'[0-9]{1,16}', value):
        value = int(value)
    if type(value) is not int or not 0 <= value <= 9_007_199_254_740_991:
        raise ExchangeContractError('Invalid Bybit account observation time.')
    return value


def _result(response: Any) -> dict[str, Any]:
    if (not isinstance(response, dict) or type(response.get('retCode')) is not int
            or response['retCode'] != 0 or not isinstance(response.get('result'), dict)):
        raise ExchangeContractError('Invalid authenticated Bybit account envelope.')
    if 'time' in response and abs(_time(response['time']) - now_ms()) > 30_000:
        raise ExchangeContractError('Bybit account response time is not fresh.')
    return response['result']


def _identity(key: dict[str, Any]) -> tuple[str, str, bool]:
    uid, parent, master = _uid(key.get('userID')), _uid(key.get('parentUid')), key.get('isMaster')
    if uid == '0' or type(master) is not bool or parent == uid or master != (parent == '0'):
        raise ExchangeContractError('Bybit account role and identity disagree.')
    return uid, parent, master


def _status(key: dict[str, Any], info: dict[str, Any]) -> int:
    status = info.get('unifiedMarginStatus')
    if type(status) is not int or status not in (1, 3, 4, 5, 6):
        raise ExchangeContractError('Bybit did not report a supported account mode.')
    if type(key.get('uta')) is not int or key['uta'] != int(status != 1):
        raise ExchangeContractError('Bybit authenticated account mode observations disagree.')
    return status


async def read_bybit_account_mode(rest: Any, budget: RecoveryReadBudget,
                                  account_fingerprint: str, credential_generation: str) -> dict[str, Any]:
    """The caller supplies its existing shared budget and verified binding; no SDK helpers."""
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value)
           for value in (account_fingerprint, credential_generation)):
        raise ExchangeContractError('Bybit mode observation requires its existing credential binding.')
    if not all(callable(getattr(rest, method, None))
               for method in ('privateGetV5UserQueryApi', 'privateGetV5AccountInfo')):
        raise NotImplementedError('Authenticated Bybit mode observation is unavailable.')
    started = now_ms()
    key = _result(await budget.call(lambda: rest.privateGetV5UserQueryApi({})))
    uid, parent, master = _identity(key)
    info = _result(await budget.call(lambda: rest.privateGetV5AccountInfo({})))
    status, updated, completed = _status(key, info), _time(info.get('updatedTime')), now_ms()
    if completed < started or updated > completed + 30_000:
        raise ExchangeContractError('Bybit account observation has an invalid time interval.')
    observation = {'version': 1, 'profile': 'bybit_uta_v1', 'accountFingerprint': account_fingerprint,
                   'credentialGeneration': credential_generation, 'providerAccountUid': uid,
                   'parentAccountUid': parent, 'isMaster': master, 'unifiedMarginStatus': status,
                   'accountUpdatedAt': updated, 'startedAt': started, 'completedAt': completed}
    payload = json.dumps(observation, sort_keys=True, separators=(',', ':'))
    return {**observation, 'evidenceHash': hashlib.sha256(payload.encode()).hexdigest()}
