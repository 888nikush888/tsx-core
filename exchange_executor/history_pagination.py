"""Resumable history pages through CCXT; traversal never implies account ownership."""
from __future__ import annotations

import json
from typing import Any

from ccxt.base.errors import NetworkError, RateLimitExceeded

from common import ExchangeContractError
from history_reader import RecoveryBudgetExhausted, RecoveryReadBudget, now_ms
from kraken_history import kraken_history_page
from history_coverage import cover_window, covered_window, validate_coverage
from hyperliquid_retention import begin_retention, retention_step, validate_retention

DAY = 86_400_000
OVERLAP = 1_000


def checkpoint(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("source") not in {"orders", "fills"}:
        raise ExchangeContractError("Invalid history checkpoint source.")
    result = {"source": value["source"], "providerSymbol": _token(value.get("providerSymbol"), 256),
              "cursor": _token(value.get("cursor"), 4096)}
    for field in ("revision", "baselineSince", "windowSince", "nextReadAt"):
        result[field] = _integer(value.get(field))
    for field in ("windowUntil", "scannedThrough"):
        result[field] = None if value.get(field) is None else _integer(value[field])
    if result["windowSince"] < result["baselineSince"] or result["windowSince"] > now_ms():
        raise ExchangeContractError("Invalid history checkpoint window.")
    if result["windowUntil"] is not None and not result["windowSince"] <= result["windowUntil"] <= now_ms():
        raise ExchangeContractError("Invalid history checkpoint end.")
    if result["scannedThrough"] is not None and not result["baselineSince"] <= result["scannedThrough"] <= now_ms():
        raise ExchangeContractError("Invalid history traversal watermark.")
    if result["cursor"] and result["windowUntil"] is None:
        raise ExchangeContractError("History cursor must retain its original query window.")
    result["completeness"] = value.get("completeness")
    if result["completeness"] not in {"partial", "unknown", "complete"}:
        raise ExchangeContractError("Invalid history completeness.")
    reason = _token(value.get("reason"), 80)
    if reason is not None and any(character not in "abcdefghijklmnopqrstuvwxyz_" for character in reason):
        raise ExchangeContractError("Invalid history checkpoint reason.")
    result["reason"] = reason
    if "providerAccountUid" in value:
        result["providerAccountUid"] = _token(value["providerAccountUid"], 256)
    result["coverage"] = validate_coverage(value.get("coverage"), result["baselineSince"], result["scannedThrough"])
    if result['source'] != 'fills' and result['coverage'] is not None:
        raise ExchangeContractError('Fill coverage cannot certify order history.')
    result['retention'] = validate_retention(value.get('retention'), result)
    if len(json.dumps(result, ensure_ascii=True).encode()) >= 8192:
        raise ExchangeContractError('Oversized history checkpoint.')
    return result


def _integer(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 9_007_199_254_740_991:
        raise ExchangeContractError("Invalid history checkpoint number.")
    return value


def _token(value: Any, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise ExchangeContractError("Invalid history checkpoint token.")
    return value


def history_request(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 8:
        raise ExchangeContractError("Invalid bounded history checkpoint collection.")
    states = [checkpoint(row) for row in value]
    if len({(row["source"], row["providerSymbol"]) for row in states}) != len(states):
        raise ExchangeContractError("Duplicate history checkpoint scope.")
    if len({row["providerAccountUid"] for row in states if row.get("providerAccountUid")}) > 1:
        raise ExchangeContractError("History sources disagree about the provider account identity.")
    return states


def _window(state: dict[str, Any], width: int) -> dict[str, Any]:
    return {**state, "windowUntil": state["windowUntil"] if state["windowUntil"] is not None
            else min(now_ms(), state["windowSince"] + width)}


def _end_window(state: dict[str, Any], completeness: str, reason: str | None) -> dict[str, Any]:
    end = state["windowUntil"]
    caught_up = end >= now_ms() - OVERLAP
    if completeness == "complete" and not caught_up:
        completeness, reason = "partial", "history_pending"
    return {**state, "cursor": None, "scannedThrough": end,
            "windowSince": max(state["baselineSince"], end - OVERLAP), "windowUntil": None,
            "nextReadAt": now_ms() + 30_000 if caught_up and completeness != 'complete' else 0,
            "completeness": completeness, "reason": reason}


async def _bybit_page(rest: Any, state: dict[str, Any], budget: RecoveryReadBudget) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    state = _window(state, 7 * DAY)
    if state["windowUntil"] - state["windowSince"] > 7 * DAY:
        raise ExchangeContractError("Bybit history window exceeds seven days.")
    fills = state["source"] == "fills"
    params = {"category": "linear", "startTime": state["windowSince"], "endTime": state["windowUntil"], "limit": 100 if fills else 50}
    market = rest.market(state["providerSymbol"]) if state["providerSymbol"] else None
    if market:
        if market.get("linear") is not True:
            raise NotImplementedError("History profile does not cover inverse products.")
        params["symbol"] = market["id"]
    if state["cursor"]:
        params["cursor"] = state["cursor"]
    method = getattr(rest, "privateGetV5ExecutionList" if fills else "privateGetV5OrderHistory", None)
    if not callable(method):
        raise NotImplementedError("No verified CCXT history envelope method.")
    response = await budget.call(lambda: method(params))
    rows, cursor = _bybit_envelope(response, params["limit"])
    if cursor is not None and cursor == state["cursor"]:
        raise ExchangeContractError("Bybit returned a non-advancing history cursor.")
    # Parse individually: CCXT's collection helpers may slice/filter and lose evidence.
    parser = rest.parse_trade if fills else rest.parse_order
    parsed = [parser(row, _bybit_market(rest, row, market)) for row in rows]
    if fills and any(type(row.get('timestamp')) is not int or not state['windowSince'] <= row['timestamp'] <= state['windowUntil'] for row in parsed):
        raise ExchangeContractError('Bybit execution falls outside the requested time window.')
    if cursor:
        return parsed, {**state, "cursor": cursor, "completeness": "partial", "reason": "history_pending", "nextReadAt": 0}
    # Terminal unfilled orders have shorter retention than fills, even in a fully traversed window.
    if fills and state['windowSince'] >= now_ms() - 730 * DAY:
        await _bybit_other_execution_scopes(rest, state, budget)
        state = cover_window(state, 'bybit')
    # Bybit option history silently defaults to baseCoin=BTC. These negative probes
    # detect some foreign activity, but cannot prove all historical option bases.
    reason = 'option_history_scope_unproved' if fills and covered_window(state) else 'provider_retention_limit'
    return parsed, _end_window(state, 'unknown', reason)


def _bybit_market(rest: Any, row: dict[str, Any], market: dict[str, Any] | None) -> dict[str, Any]:
    # Some valid execution rows lack createType; CCXT would otherwise infer spot.
    resolved = market or rest.safe_market(row.get("symbol"), None, None, "contract")
    if not isinstance(resolved, dict) or resolved.get("linear") is not True or resolved.get("contract") is not True:
        raise ExchangeContractError("Bybit history market does not match its linear contract category.")
    return resolved


def _bybit_envelope(response: Any, limit: int, category: str = 'linear') -> tuple[list[dict[str, Any]], str | None]:
    if not isinstance(response, dict) or type(response.get("retCode")) is not int or response["retCode"] != 0 or not isinstance(response.get("result"), dict):
        raise ExchangeContractError("Invalid Bybit history envelope.")
    result = response["result"]
    rows = result.get("list")
    if result.get("category") != category or not isinstance(rows, list) or len(rows) > limit or any(not isinstance(row, dict) for row in rows):
        raise ExchangeContractError("Invalid Bybit history page scope or collection.")
    if "nextPageCursor" not in result or not isinstance(result["nextPageCursor"], str):
        raise ExchangeContractError("Bybit history omitted its continuation evidence.")
    return rows, _token(result["nextPageCursor"] or None, 4096)


async def _bybit_other_execution_scopes(rest: Any, state: dict[str, Any], budget: RecoveryReadBudget) -> None:
    for category in ('inverse', 'spot', 'option'):
        response = await budget.call(lambda category=category: rest.privateGetV5ExecutionList({
            'category': category, 'startTime': state['windowSince'], 'endTime': state['windowUntil'], 'limit': 1}))
        rows, cursor = _bybit_envelope(response, 1, category)
        if rows or cursor:
            # No unsupported product may be booked as a linear contract or silently ignored.
            raise ExchangeContractError(f'Unmanaged Bybit {category} executions require explicit account review.')


async def _hyperliquid_page(rest: Any, state: dict[str, Any], budget: RecoveryReadBudget) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if state["source"] != "fills" or state["providerSymbol"] is not None:
        raise NotImplementedError("Hyperliquid historical orders have no verified continuation API.")
    if not all(callable(getattr(rest, name, None)) for name in ("handle_public_address", "publicPostInfo", "parse_trade")):
        raise NotImplementedError("No verified Hyperliquid raw history adapter.")
    state = _window(state, 7 * DAY)
    if state["cursor"] is not None and not state["cursor"].isdecimal():
        raise ExchangeContractError("Invalid Hyperliquid history time cursor.")
    start = int(state["cursor"]) if state["cursor"] else state["windowSince"]
    if not state["windowSince"] <= start <= state["windowUntil"]:
        raise ExchangeContractError("Invalid Hyperliquid history time cursor.")
    # Keep the raw envelope: fetch_my_trades turns some invalid responses into an empty list.
    user, _ = rest.handle_public_address("fetchMyTrades", {})
    if state.get('retention') and state['retention']['phase'] != 'proved':
        next_state, outcome = await retention_step(rest, user, state, budget)
        if outcome == 'covered':
            next_state = cover_window(next_state, 'hyperliquid')
        if outcome is not None:
            complete = outcome == 'covered' and covered_window(next_state)
            next_state = _end_window(next_state, 'complete' if complete else 'unknown', None if complete else 'provider_retention_limit')
        return [], next_state
    response = await budget.call(lambda: rest.publicPostInfo({"type": "userFillsByTime", "user": user,
        "startTime": start, "endTime": state["windowUntil"], "aggregateByTime": False}))
    state = {**state, 'retention': None}
    if not isinstance(response, list) or len(response) > 2000 or any(not isinstance(row, dict) for row in response):
        raise ExchangeContractError("Invalid Hyperliquid history page.")
    times = [_integer(row.get("time")) for row in response]
    if any(time < start or time > state["windowUntil"] for time in times):
        raise ExchangeContractError("Hyperliquid history returned events outside its requested window.")
    rows = [rest.parse_trade(row) for row in response]
    if times:
        continuation = _hyperliquid_continuation(state, start, times)
        if continuation['windowUntil'] is not None:
            return rows, continuation
    return rows, begin_retention(state)


def _hyperliquid_continuation(state: dict[str, Any], start: int, times: list[int]) -> dict[str, Any]:
    last = max(times)
    if last > start:
        # Continue even a short page: the API also documents distinct-block page limits.
        return {**state, "cursor": str(last), "completeness": "unknown", "reason": "provider_retention_limit", "nextReadAt": 0}
    if len(times) == 2000:
        # More than one full page at the same millisecond cannot be skipped using timestamp + 1.
        return {**state, "completeness": "unknown", "reason": "timestamp_page_saturated", "nextReadAt": now_ms() + 60_000}
    if last < state["windowUntil"]:
        # Re-reading the boundary with a short single-timestamp page consumed that boundary.
        return {**state, "cursor": str(last + 1), "completeness": "unknown", "reason": "provider_retention_limit", "nextReadAt": 0}
    return _end_window(state, "unknown", "provider_retention_limit")


async def read_history_pages(rest: Any, exchange: str, states: list[dict[str, Any]], budget: RecoveryReadBudget,
                             unresolved_events: list[dict[str, Any]] | None = None,
                             ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    orders: list[dict[str, Any]] = []
    fills: list[dict[str, Any]] = []
    updates = []
    provider_uid = next((state["providerAccountUid"] for state in states if state.get("providerAccountUid")), None)
    read_started = now_ms()
    # One page per stream per pass avoids starving fills behind a large orders history.
    pending = [{"baseRevision": state["revision"], "checkpoint": dict(state), "pages": 0} for state in states]
    while pending:
        update = pending.pop(0)
        state = update["checkpoint"]
        if state["nextReadAt"] > now_ms():
            updates.append(update)
            continue
        calls_before = budget.calls
        try:
            rows, next_state, events = await _page(rest, exchange, state, budget)
            observed_uid = next_state.get("providerAccountUid")
            if provider_uid and observed_uid and provider_uid != observed_uid:
                raise ExchangeContractError("History sources disagree about the provider account identity.")
            provider_uid = provider_uid or observed_uid
            if events and unresolved_events is None:
                raise ExchangeContractError("Historical order events require a durable evidence consumer.")
            if unresolved_events is not None:
                unresolved_events.extend(events)
            (fills if state["source"] == "fills" else orders).extend(rows)
            update.update(checkpoint=next_state)
            if budget.remaining > 0 and next_state["nextReadAt"] <= now_ms() and (next_state['scannedThrough'] or 0) < read_started:
                pending.append(update)
                continue
        except RecoveryBudgetExhausted:
            update["checkpoint"] = {**state, "reason": "history_transient" if budget.resume_at > now_ms() else "history_budget_exhausted",
                                    "completeness": "partial", "nextReadAt": max(state["nextReadAt"], budget.resume_at)}
        except NotImplementedError:
            update["checkpoint"] = {**state, "reason": "history_profile_unsupported", "completeness": "unknown", "nextReadAt": now_ms() + 300_000}
        except (NetworkError, RateLimitExceeded, TimeoutError) as error:
            budget.suspend(rest, error)
            resume = budget.resume_at
            update["checkpoint"] = {**state, "reason": "history_transient", "completeness": "partial", "nextReadAt": resume}
            for deferred in pending:
                deferred["checkpoint"] = {**deferred["checkpoint"], "nextReadAt": resume}
        finally:
            update['pages'] += budget.calls - calls_before
        updates.append(update)
    for update in updates:
        update["checkpoint"]["revision"] = update["baseRevision"] + 1
    return orders, fills, updates


async def _page(rest: Any, exchange: str, state: dict[str, Any], budget: RecoveryReadBudget
                 ) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    if exchange == "bybit":
        rows, next_state = await _bybit_page(rest, state, budget)
        return rows, next_state, []
    if exchange == "hyperliquid":
        rows, next_state = await _hyperliquid_page(rest, state, budget)
        return rows, next_state, []
    if exchange == "krakenfutures":
        state = _window(state, 7 * DAY)
        rows, events, cursor, uid = await kraken_history_page(rest, state, budget)
        next_state = {**state, "cursor": cursor, "providerAccountUid": uid, "nextReadAt": 0,
                      "completeness": "partial", "reason": "history_pending"}
        if cursor is None:
            if state['source'] == 'fills':
                next_state = cover_window(next_state, 'krakenfutures')
            complete = state['source'] == 'fills' and covered_window(next_state)
            next_state = _end_window(next_state, 'complete' if complete else 'unknown', None if complete else 'history_events_require_classification')
        return rows, next_state, events
    raise NotImplementedError("History envelope for this profile has not been verified.")
