"""Complete current account scopes through CCXT envelopes, never through sliced collection helpers."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from common import ExchangeContractError, IncompleteCurrentStateError, RequestDeadline, decimal_string
from history_reader import RecoveryBudgetExhausted, RecoveryReadBudget, now_ms, source_evidence
from order_evidence import merge_ccxt_order

MAX_CURRENT_CALLS = 64
MAX_CURRENT_ROWS = 100_000


def _rows(value: Any, label: str, limit: int = MAX_CURRENT_ROWS) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(row, dict) for row in value):
        raise ExchangeContractError(f"Current {label} response omitted its bounded collection.")
    return value


def _token(value: Any, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or value.strip() != value or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise ExchangeContractError(f"Invalid current {label} identity.")
    return value


def _provider_time(value: Any, source: str) -> None:
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,16}", value):
        value = int(value)
    if type(value) is not int or value < 0:
        raise ExchangeContractError("Current-state response omitted its provider timestamp.")
    if abs(now_ms() - value) > 30_000:
        raise IncompleteCurrentStateError(source, "provider_snapshot_not_fresh")


def _same_position(current: dict[str, Any], incoming: dict[str, Any]) -> bool:
    # Mark price/PnL/timestamps naturally move between pages; changed exposure is not a coherent observation.
    return all(str(current.get(field)) == str(incoming.get(field))
               for field in ("contracts", "entryPrice", "leverage", "marginMode"))


@dataclass
class CurrentRead:
    budget: RecoveryReadBudget
    orders: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    positions: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    sources: dict[str, dict[str, Any]] = field(default_factory=dict)

    def begin(self, source: str, scopes: list[str]) -> None:
        if not scopes or len(scopes) > MAX_CURRENT_CALLS or len(set(scopes)) != len(scopes):
            raise IncompleteCurrentStateError(source, "scope_budget_exceeded")
        self.sources[source] = {**source_evidence(source, now_ms(), "unknown", "current_state_pending"),
                                "scopes": [{"scope": scope, "pages": 0, "complete": False} for scope in scopes]}

    async def call(self, source: str, scope: str, operation) -> Any:
        try:
            result = await self.budget.call(operation)
        except RecoveryBudgetExhausted as error:
            raise IncompleteCurrentStateError(source, "current_page_budget_exhausted") from error
        evidence = next(row for row in self.sources[source]["scopes"] if row["scope"] == scope)
        evidence["pages"] += 1
        return result

    def complete(self, source: str, scope: str) -> None:
        evidence = self.sources[source]
        next(row for row in evidence["scopes"] if row["scope"] == scope)["complete"] = True
        if all(row["complete"] for row in evidence["scopes"]):
            evidence.update(completeness="complete", reason=None, completedAt=now_ms())

    def add(self, source: str, row: dict[str, Any]) -> None:
        symbol = _token(row.get("symbol"), "provider symbol")
        if source == "orders":
            key = symbol, _token(row.get("id"), "order")
            self.orders[key] = merge_ccxt_order(self.orders[key], row) if key in self.orders else row
        else:
            key = symbol, str(row.get("side"))
            if key in self.positions and not _same_position(self.positions[key], row):
                raise IncompleteCurrentStateError(source, "position_changed_during_pagination")
            self.positions[key] = row
        if len(self.orders) + len(self.positions) > MAX_CURRENT_ROWS:
            raise IncompleteCurrentStateError(source, "current_row_budget_exceeded")


def _bybit_scopes(rest: Any, source: str) -> list[dict[str, str]]:
    settlements = {"USDT", "USDC"}
    markets = getattr(rest, "markets", None)
    if not isinstance(markets, dict):
        raise ExchangeContractError("Bybit current-state requires loaded market scopes.")
    for market in markets.values():
        if market.get("linear") is True and market.get("contract") is True:
            coin = market.get("settleId") or market.get("settle")
            if not isinstance(coin, str) or not re.fullmatch(r"[A-Z0-9]{1,20}", coin):
                raise ExchangeContractError("Bybit market omitted its settlement scope.")
            settlements.add(coin)
    scopes = [{"category": "linear", "settleCoin": coin} for coin in sorted(settlements)]
    scopes.extend({"category": category} for category in (["inverse", "option", "spot"] if source == "orders" else ["inverse", "option"]))
    return scopes


def _bybit_page(response: Any, category: str, limit: int) -> tuple[list[dict[str, Any]], str]:
    if not isinstance(response, dict) or type(response.get("retCode")) is not int or response["retCode"] != 0:
        raise ExchangeContractError("Invalid Bybit current-state envelope.")
    _provider_time(response.get("time"), "bybit")
    result = response.get("result")
    if not isinstance(result, dict) or result.get("category") != category:
        raise ExchangeContractError("Bybit current-state category mismatch.")
    rows = _rows(result.get("list"), "Bybit page", limit)
    cursor = result.get("nextPageCursor")
    if not isinstance(cursor, str) or len(cursor) > 4096 or any(ord(char) < 32 for char in cursor):
        raise ExchangeContractError("Bybit current-state omitted its continuation evidence.")
    return rows, cursor


def _bybit_parsed(rest: Any, source: str, raw: dict[str, Any], scope: dict[str, str]) -> dict[str, Any] | None:
    if scope["category"] != "linear":
        # These product types share account resources but are not executable by this profile.
        if source == "orders" or decimal_string(raw.get("size"), "foreign position size") != "0":
            raise ExchangeContractError(f"Unmanaged Bybit {scope['category']} {source} require explicit account review.")
        return None
    market = rest.safe_market(_token(raw.get("symbol"), "Bybit symbol"), None, None, "contract")
    if not isinstance(market, dict) or market.get("linear") is not True or market.get("contract") is not True:
        raise ExchangeContractError("Bybit current market is not a linear contract.")
    if (market.get("settleId") or market.get("settle")) != scope["settleCoin"]:
        raise ExchangeContractError("Bybit current market conflicts with the requested settlement scope.")
    if source == "positions" and (type(raw.get("positionIdx")) is not int or raw["positionIdx"] != 0):
        raise ExchangeContractError("Unmanaged Bybit hedge position requires explicit account review.")
    parser = rest.parse_order if source == "orders" else rest.parse_position
    return parser(raw, market)


async def _bybit_scope(rest: Any, read: CurrentRead, source: str, scope: dict[str, str]) -> None:
    key = scope["category"] + ":" + scope.get("settleCoin", "all")
    params: dict[str, Any] = {**scope, "limit": 50 if source == "orders" else 200}
    if source == "orders":
        params["openOnly"] = 0  # No orderFilter: conditional orders are part of the same account scope.
    method = rest.privateGetV5OrderRealtime if source == "orders" else rest.privateGetV5PositionList
    cursors: set[str] = set()
    while True:
        response = await read.call(source, key, lambda: method(dict(params)))
        rows, cursor = _bybit_page(response, scope["category"], params["limit"])
        for raw in rows:
            parsed = _bybit_parsed(rest, source, raw, scope)
            if parsed is not None:
                read.add(source, parsed)
        if not cursor:
            read.complete(source, key)
            return
        if cursor in cursors:
            raise ExchangeContractError("Bybit current-state continuation cursor repeated.")
        cursors.add(cursor)
        params["cursor"] = cursor


async def _bybit(rest: Any, read: CurrentRead) -> None:
    for source in ("positions", "orders"):
        scopes = _bybit_scopes(rest, source)
        read.begin(source, [scope["category"] + ":" + scope.get("settleCoin", "all") for scope in scopes])
        for scope in scopes:
            await _bybit_scope(rest, read, source, scope)


async def _kraken(rest: Any, read: CurrentRead) -> None:
    for source, method, collection in (("positions", rest.privateGetOpenpositions, "openPositions"),
                                       ("orders", rest.privateGetOpenorders, "openOrders")):
        read.begin(source, ["futures:all"])
        response = await read.call(source, "futures:all", lambda: method({}))
        if not isinstance(response, dict) or response.get("result") != "success":
            raise ExchangeContractError("Invalid Kraken current-state envelope.")
        if not isinstance(response.get("serverTime"), str) or rest.parse8601(response["serverTime"]) is None:
            raise ExchangeContractError("Kraken current-state omitted its provider timestamp.")
        _provider_time(rest.parse8601(response["serverTime"]), source)
        parser = rest.parse_position if source == "positions" else rest.parse_order
        for raw in _rows(response.get(collection), "Kraken account"):
            read.add(source, parser(raw))
        read.complete(source, "futures:all")


def _dex_names(response: Any) -> list[str]:
    if not isinstance(response, list) or not response or response[0] is not None or len(response) > MAX_CURRENT_CALLS:
        raise ExchangeContractError("Hyperliquid DEX discovery omitted its complete scope list.")
    names = [""]
    for dex in response[1:]:
        if not isinstance(dex, dict) or not isinstance(dex.get("name"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", dex["name"]):
            raise ExchangeContractError("Invalid Hyperliquid DEX identity.")
        names.append(dex["name"])
    if len(set(names)) != len(names):
        raise ExchangeContractError("Duplicate Hyperliquid DEX scope.")
    return names


async def _hyperliquid(rest: Any, read: CurrentRead) -> None:
    names = _dex_names(await read.budget.call(lambda: rest.publicPostInfo({"type": "perpDexs"})))
    user, _ = rest.handle_public_address("fetchOpenOrders", {})
    _token(user, "Hyperliquid account")
    for source in ("positions", "orders"):
        read.begin(source, [f"perp:{name}" for name in names])
        for dex in names:
            scope = f"perp:{dex}"
            params = {"type": "clearinghouseState" if source == "positions" else "frontendOpenOrders", "user": user, "dex": dex}
            response = await read.call(source, scope, lambda: rest.publicPostInfo(dict(params)))
            if source == "positions" and not isinstance(response, dict):
                raise ExchangeContractError("Hyperliquid current-state omitted its position envelope.")
            if source == "positions":
                _provider_time(response.get("time"), source)
            raw_rows = response.get("assetPositions") if source == "positions" else response
            for raw in _rows(raw_rows, "Hyperliquid account"):
                detail = raw.get("position") if source == "positions" else raw
                coin = _token(detail.get("coin") if isinstance(detail, dict) else None, "Hyperliquid coin")
                if (coin.split(":", 1)[0] if ":" in coin else "") != dex:
                    raise ExchangeContractError("Hyperliquid current coin conflicts with its requested DEX scope.")
                row = rest.parse_position(raw) if source == "positions" else rest.parse_order({**raw, "ccxtStatus": "open"})
                read.add(source, row)
            read.complete(source, scope)


async def read_current_state(rest: Any, exchange: str, deadline: RequestDeadline, *, maximum_calls: int = MAX_CURRENT_CALLS):
    methods = {"bybit": ("privateGetV5OrderRealtime", "privateGetV5PositionList"),
               "krakenfutures": ("privateGetOpenorders", "privateGetOpenpositions"), "hyperliquid": ("publicPostInfo", "handle_public_address")}
    reader = {"bybit": _bybit, "krakenfutures": _kraken, "hyperliquid": _hyperliquid}.get(exchange)
    read = CurrentRead(RecoveryReadBudget(deadline, remaining=maximum_calls))
    if reader and all(callable(getattr(rest, method, None)) for method in methods[exchange]):
        try:
            await reader(rest, read)
        except RecoveryBudgetExhausted as error:
            raise IncompleteCurrentStateError("discovery", "current_page_budget_exhausted") from error
    else:
        # Compatibility evidence only: a generic wrapper with unknown pagination is never certified complete.
        for source, operation in (("positions", rest.fetch_positions),
                                  ("orders", lambda: rest.fetch_open_orders(None, None, 50 if exchange == "bybit" else None))):
            started = now_ms()
            for row in _rows(await read.budget.call(operation), "generic account"):
                read.add(source, row)
            read.sources[source] = source_evidence(source, started, "unknown", "provider_pagination_not_proven")
    return list(read.orders.values()), list(read.positions.values()), list(read.sources.values())
