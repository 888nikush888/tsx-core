from __future__ import annotations

import asyncio
import time
from decimal import Decimal
from typing import Any, Awaitable

from ccxt.base.errors import BadRequest, InvalidOrder, OrderNotFound

from ccxt_client import CcxtClientRegistry, AccountClients, decimal_text
from common import ExchangeContractError, RequestDeadline, decimal_string, external_account_id


def _canonical_symbol(market: dict[str, Any]) -> str:
    base = str(market.get("base") or "").upper()
    if not base or not base.isalnum():
        raise ExchangeContractError("CCXT market has no canonical base asset.")
    return f"{base}USDT"


def _requested_base(symbol: str) -> str:
    normalized = symbol.upper().replace("/", "").replace("-", "").replace(":", "")
    for suffix in ("USDTUSDT", "USDCUSDC", "USDUSD", "USDT", "USDC", "USD"):
        if normalized.endswith(suffix) and len(normalized) > len(suffix):
            return normalized[: -len(suffix)]
    raise ExchangeContractError(f"Symbol {symbol} must be a USD, USDC or USDT pair.")


def _precision_step(value: Any, fallback: str) -> str:
    if value is None:
        return fallback
    number = Decimal(str(value))
    if number <= 0:
        return fallback
    return decimal_text(number)


def _status(value: Any) -> str:
    return {
        "open": "open",
        "closed": "filled",
        "canceled": "cancelled",
        "cancelled": "cancelled",
        "expired": "cancelled",
        "rejected": "rejected",
    }.get(str(value or "").lower(), "unknown")


def _client_order_id(order: dict[str, Any], fallback: str = "") -> str:
    value = order.get("clientOrderId") or order.get("client_order_id") or fallback
    return str(value or "")


def _trigger_price(order: dict[str, Any]) -> Any:
    for key in ("triggerPrice", "stopPrice", "stopLossPrice", "takeProfitPrice"):
        if order.get(key) is not None:
            return order[key]
    info = order.get("info") if isinstance(order.get("info"), dict) else {}
    for key in ("triggerPrice", "triggerPx", "stopPrice", "stopPx"):
        if info.get(key) not in (None, "", "0", 0):
            return info[key]
    return None


def _reduce_only(order: dict[str, Any]) -> bool:
    if order.get("reduceOnly") is not None:
        return order.get("reduceOnly") is True
    info = order.get("info") if isinstance(order.get("info"), dict) else {}
    value = info.get("reduceOnly")
    return value is True or str(value).lower() == "true"


def _ledger_funding_amount(item: dict[str, Any]) -> Decimal | None:
    info = item.get("info") if isinstance(item.get("info"), dict) else {}
    amount = info.get("realized_funding")
    if amount is None:
        amount = info.get("realizedFunding")
    if amount is None:
        amount = info.get("payment")
    if amount is not None:
        return Decimal(str(amount))
    if str(item.get("type") or "").lower() != "funding" or item.get("amount") is None:
        return None
    value = Decimal(str(item["amount"]))
    return -value if str(item.get("direction") or "").lower() == "out" else value


def _order_result(order: dict[str, Any], fallback_client_id: str = "") -> dict[str, Any]:
    client_order_id = _client_order_id(order, fallback_client_id)
    exchange_order_id = str(order.get("id") or client_order_id)
    if not client_order_id or not exchange_order_id:
        raise ExchangeContractError("CCXT order result omitted its identifiers.")
    status = _status(order.get("status"))
    filled = Decimal(str(order.get("filled") or 0))
    if status == "open" and filled > 0:
        status = "partially_filled"
    return {
        "clientOrderId": client_order_id,
        "exchangeOrderId": exchange_order_id,
        "status": status,
        "filledQuantity": decimal_text(filled),
        "averagePrice": decimal_text(order.get("average"), "0") if order.get("average") is not None else None,
        "error": None if status != "rejected" else "Exchange rejected the order.",
        "raw": order,
    }


def _market_order_result(
    order: dict[str, Any],
    market: dict[str, Any],
    fallback_client_id: str = "",
) -> dict[str, Any]:
    result = _order_result(order, fallback_client_id)
    contract_size = Decimal(str(market.get("contractSize") or 1))
    if contract_size <= 0:
        raise ExchangeContractError("CCXT market has an invalid contract size.")
    result["filledQuantity"] = decimal_text(Decimal(result["filledQuantity"]) * contract_size)
    return result


async def _within(deadline: RequestDeadline, operation: Awaitable[Any]) -> Any:
    deadline.ensure(250)
    return await asyncio.wait_for(operation, timeout=deadline.sdk_timeout_seconds())


class CcxtAdapter:
    def __init__(self, registry: CcxtClientRegistry) -> None:
        self.registry = registry

    async def _clients(self, account: dict[str, str], deadline: RequestDeadline) -> AccountClients:
        return await _within(deadline, self.registry.account(account))

    @staticmethod
    def _market(clients: AccountClients, requested_symbol: str) -> dict[str, Any]:
        base = _requested_base(requested_symbol)
        candidates = [
            market for market in clients.rest.markets.values()
            if market.get("base") == base
            and market.get("contract") is True
            and market.get("swap") is True
            and market.get("linear") is True
            and market.get("active") is not False
        ]
        quote_order = {
            "hyperliquid": ("USDC", "USDT", "USD"),
            "bybit": ("USDT", "USDC", "USD"),
            "krakenfutures": ("USD", "USDT", "USDC"),
        }[clients.account["exchange"]]
        candidates.sort(key=lambda market: quote_order.index(market.get("settle") or market.get("quote"))
                        if (market.get("settle") or market.get("quote")) in quote_order else len(quote_order))
        if not candidates:
            raise ExchangeContractError(f"Symbol {requested_symbol} is unavailable on the certified linear perpetual market.")
        return candidates[0]

    async def verify(self, account: dict[str, str], deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        balance = await _within(deadline, clients.rest.fetch_balance())
        equity, _available = self._balance_values(clients, balance)
        identity = external_account_id(account["exchange"], account["mode"], clients.account_identity)
        return {
            "verified": True,
            "equity": equity,
            "externalAccountId": identity,
            "accountFingerprint": identity,
            "capabilities": {
                "integration": "ccxt",
                "ccxtPro": True,
                "restOrderSubmission": True,
                "privateOrderStream": True,
                "privateTradeStream": True,
                "privatePositionStream": True,
                "builderFeeEnabled": False if account["exchange"] == "hyperliquid" else None,
                "accountIdentityBinding": "wallet" if account["exchange"] == "hyperliquid" else "api-key",
            },
        }

    @staticmethod
    def _balance_values(clients: AccountClients, balance: dict[str, Any]) -> tuple[str, str]:
        currencies = {
            "hyperliquid": ("USDC", "USDT", "USD"),
            "bybit": ("USDT", "USDC", "USD"),
            "krakenfutures": ("USD", "USDT", "USDC"),
        }[clients.account["exchange"]]
        total = balance.get("total") if isinstance(balance.get("total"), dict) else {}
        free = balance.get("free") if isinstance(balance.get("free"), dict) else {}
        for currency in currencies:
            if total.get(currency) is not None:
                return decimal_text(total[currency]), decimal_text(free.get(currency, total[currency]))
        raise ExchangeContractError("CCXT balance contains no certified settlement currency.")

    async def _funding_today(self, clients: AccountClients, deadline: RequestDeadline) -> str:
        since = int(time.time() // 86_400 * 86_400 * 1_000)
        values: list[dict[str, Any]] = []
        normalized_history = False
        try:
            if clients.rest.has.get("fetchFundingHistory") is True:
                values = await _within(deadline, clients.rest.fetch_funding_history(None, since, 500))
                normalized_history = True
            elif clients.rest.has.get("fetchLedger") is True:
                values = await _within(deadline, clients.rest.fetch_ledger(None, since, 500))
        except (BadRequest, InvalidOrder):
            return "0"
        total = Decimal("0")
        for item in values:
            amount = Decimal(str(item["amount"])) if normalized_history and item.get("amount") is not None else _ledger_funding_amount(item)
            if amount is not None:
                total += amount
        return decimal_text(total)

    async def account_snapshot(self, account: dict[str, str], deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        balance, positions = await _within(deadline, asyncio.gather(
            clients.rest.fetch_balance(), clients.rest.fetch_positions(),
        ))
        equity, available = self._balance_values(clients, balance)
        unrealized = Decimal("0")
        margin = Decimal("0")
        for position in positions:
            unrealized += Decimal(str(position.get("unrealizedPnl") or 0))
            margin_value = position.get("initialMargin")
            if margin_value is None:
                margin_value = position.get("collateral")
            margin += Decimal(str(margin_value or 0))
        funding = await self._funding_today(clients, deadline)
        return {
            "equity": equity,
            "availableBalance": available,
            "unrealizedPnl": decimal_text(unrealized),
            "marginUsed": decimal_text(margin),
            "fundingPnlToday": funding,
        }

    async def _maximum_leverage(self, clients: AccountClients, market: dict[str, Any], deadline: RequestDeadline) -> int:
        value = (market.get("limits") or {}).get("leverage", {}).get("max")
        if value is None and clients.rest.has.get("fetchMarketLeverageTiers"):
            try:
                tiers = await _within(deadline, clients.rest.fetch_market_leverage_tiers(market["symbol"]))
                if tiers:
                    value = tiers[0].get("maxLeverage")
            except (BadRequest, InvalidOrder):
                value = None
        if value is None:
            raise ExchangeContractError("CCXT market omits a certified maximum leverage.")
        return max(1, min(50, int(Decimal(str(value)))))

    async def market_snapshot(self, account: dict[str, str], symbol: str, deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        market = self._market(clients, symbol)
        ticker = await _within(deadline, clients.rest.fetch_ticker(market["symbol"]))
        info = ticker.get("info") if isinstance(ticker.get("info"), dict) else {}
        mark = ticker.get("mark") or ticker.get("last") or info.get("markPrice") or info.get("mark_price")
        if mark is None:
            bid, ask = ticker.get("bid"), ticker.get("ask")
            if bid is not None and ask is not None:
                mark = (Decimal(str(bid)) + Decimal(str(ask))) / 2
        if mark is None:
            raise ExchangeContractError("CCXT ticker omitted the mark/last price.")
        precision = market.get("precision") or {}
        limits = market.get("limits") or {}
        amount_limits = limits.get("amount") or {}
        cost_limits = limits.get("cost") or {}
        contract_size = Decimal(str(market.get("contractSize") or 1))
        if contract_size <= 0:
            raise ExchangeContractError("CCXT market has an invalid contract size.")
        quantity_step = decimal_text(Decimal(_precision_step(precision.get("amount"), "0.00000001")) * contract_size)
        minimum_contracts = Decimal(str(amount_limits.get("min") or _precision_step(precision.get("amount"), "0.00000001")))
        minimum_quantity = decimal_text(minimum_contracts * contract_size)
        minimum_notional = decimal_text(cost_limits.get("min"), "1")
        return {
            "symbol": _canonical_symbol(market),
            "providerSymbol": market["symbol"],
            "markPrice": decimal_text(mark),
            "priceTick": _precision_step(precision.get("price"), "0.00000001"),
            "quantityStep": quantity_step,
            "minimumQuantity": minimum_quantity,
            "minimumNotional": minimum_notional,
            "maxLeverage": await self._maximum_leverage(clients, market, deadline),
            "contractSize": decimal_text(contract_size),
            "observedAt": int(time.time() * 1_000),
        }

    async def _order_spec(
        self,
        clients: AccountClients,
        request: dict[str, Any],
        deadline: RequestDeadline,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        market = self._market(clients, str(request.get("symbol") or ""))
        symbol = market["symbol"]
        quantity = decimal_string(request.get("quantity"), "quantity", positive=True)
        contract_size = Decimal(str(market.get("contractSize") or 1))
        if contract_size <= 0:
            raise ExchangeContractError("CCXT market has an invalid contract size.")
        contracts = Decimal(quantity) / contract_size
        amount = clients.rest.amount_to_precision(symbol, decimal_text(contracts))
        if Decimal(str(amount)) <= 0:
            raise ExchangeContractError("Order quantity is below the market contract precision.")
        side = request.get("side")
        if side not in {"buy", "sell"}:
            raise ExchangeContractError("Order side is invalid.")
        order_type = request.get("orderType")
        if order_type not in {"market", "limit", "stop_market"}:
            raise ExchangeContractError("Order type is invalid.")
        price = request.get("price")
        params: dict[str, Any] = {
            "clientOrderId": str(request.get("clientOrderId") or ""),
            "reduceOnly": request.get("reduceOnly") is True,
        }
        if not params["clientOrderId"]:
            raise ExchangeContractError("clientOrderId is required.")
        if request.get("postOnly") is True:
            params["postOnly"] = True
            params["timeInForce"] = "PO"
        unified_type = order_type
        if order_type == "stop_market":
            trigger = decimal_string(request.get("triggerPrice"), "triggerPrice", positive=True)
            params["stopLossPrice"] = clients.rest.price_to_precision(symbol, trigger)
            unified_type = "market"
            price = None
        elif order_type == "limit":
            price = clients.rest.price_to_precision(symbol, decimal_string(price, "price", positive=True))
        else:
            price = None
        leverage = request.get("leverage")
        if not params["reduceOnly"]:
            maximum = await self._maximum_leverage(clients, market, deadline)
            if not isinstance(leverage, int) or isinstance(leverage, bool) or leverage < 1:
                raise ExchangeContractError("Order leverage is invalid.")
            await _within(deadline, clients.rest.set_leverage(min(leverage, maximum), symbol))
        return {
            "symbol": symbol,
            "type": unified_type,
            "side": side,
            "amount": amount,
            "price": price,
            "params": params,
        }, market

    async def submit_order(self, account: dict[str, str], request: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        spec, market = await self._order_spec(clients, request, deadline)
        order = await _within(deadline, clients.rest.create_order(**spec))
        return _market_order_result(order, market, spec["params"]["clientOrderId"])

    async def _cancel_if_open(self, clients: AccountClients, result: dict[str, Any], symbol: str, deadline: RequestDeadline) -> None:
        if result["status"] not in {"open", "partially_filled", "unknown"}:
            return
        try:
            await _within(deadline, clients.rest.cancel_order(result["exchangeOrderId"], symbol))
        except OrderNotFound:
            return

    @staticmethod
    def _validate_protected_entry(entry: dict[str, Any], stop: dict[str, Any]) -> None:
        if entry.get("role") != "entry" or stop.get("role") != "stop_loss":
            raise ExchangeContractError("Protected entry requires entry and stop_loss roles.")
        if stop.get("reduceOnly") is not True or stop.get("orderType") != "stop_market":
            raise ExchangeContractError("Protective stop must be a reduce-only stop-market order.")
        if entry.get("reduceOnly") is True:
            raise ExchangeContractError("Protected entry may not be reduce-only.")
        if entry.get("accountId") != stop.get("accountId") or entry.get("symbol") != stop.get("symbol"):
            raise ExchangeContractError("Entry and protective stop must match account and symbol.")
        if entry.get("side") == stop.get("side") or entry.get("side") not in {"buy", "sell"}:
            raise ExchangeContractError("Protective stop side must oppose the entry side.")
        entry_quantity = decimal_string(entry.get("quantity"), "entry.quantity", positive=True)
        stop_quantity = decimal_string(stop.get("quantity"), "protectiveStop.quantity", positive=True)
        if entry_quantity != stop_quantity:
            raise ExchangeContractError("Protective stop quantity must match the entry quantity.")

    async def _assert_symbol_has_no_position(
        self,
        clients: AccountClients,
        market: dict[str, Any],
        deadline: RequestDeadline,
    ) -> None:
        positions = await _within(deadline, clients.rest.fetch_positions([market["symbol"]]))
        if any(Decimal(str(position.get("contracts") or 0)) != 0 for position in positions):
            raise ExchangeContractError(
                "Protected entry is blocked because the exchange already reports exposure for this account and symbol."
            )

    async def _flatten_new_symbol_exposure(
        self,
        clients: AccountClients,
        market: dict[str, Any],
        deadline: RequestDeadline,
    ) -> None:
        # submit_protected_entry proves the symbol has no exposure immediately
        # before submission. Consequently every position observed here belongs
        # to the ambiguous batch and can be reduced without touching a prior
        # managed or manual position.
        positions = await _within(deadline, clients.rest.fetch_positions([market["symbol"]]))
        for position in positions:
            contracts = Decimal(str(position.get("contracts") or 0))
            if contracts == 0:
                continue
            position_side = str(position.get("side")).lower()
            if position_side not in {"long", "short"}:
                raise ExchangeContractError("CCXT position omitted its side during emergency cleanup.")
            side = "sell" if position_side == "long" else "buy"
            amount = clients.rest.amount_to_precision(market["symbol"], abs(contracts))
            await _within(deadline, clients.rest.create_order(
                market["symbol"], "market", side, amount, None, {"reduceOnly": True},
            ))

    async def submit_protected_entry(
        self,
        account: dict[str, str],
        entry: dict[str, Any],
        stop: dict[str, Any],
        deadline: RequestDeadline,
    ) -> dict[str, Any]:
        self._validate_protected_entry(entry, stop)
        clients = await self._clients(account, deadline)
        market = self._market(clients, str(entry.get("symbol") or ""))
        await self._assert_symbol_has_no_position(clients, market, deadline)
        entry_spec, market = await self._order_spec(clients, entry, deadline)
        stop_spec, stop_market = await self._order_spec(clients, stop, deadline)
        if stop_market["symbol"] != market["symbol"]:
            raise ExchangeContractError("Entry and protective stop must use the same market.")
        try:
            orders = await _within(deadline, clients.rest.create_orders([entry_spec, stop_spec]))
        except Exception as error:
            # A transport failure can occur after the exchange accepted one or
            # both legs. Query by client id, cancel what can be proven open and
            # flatten any resulting exposure before returning an unknown result.
            try:
                cleanup_deadline = RequestDeadline(int(time.time() * 1_000) + 10_000)
                recent = await self._all_recent_orders(clients, cleanup_deadline)
                for spec in (entry_spec, stop_spec):
                    client_id = spec["params"]["clientOrderId"]
                    match = next((item for item in recent if _client_order_id(item) == client_id), None)
                    if match is not None:
                        await self._cancel_if_open(clients, _order_result(match, client_id), market["symbol"], cleanup_deadline)
                await self._flatten_new_symbol_exposure(clients, market, cleanup_deadline)
            except Exception:
                pass
            raise ExchangeContractError(
                "Protected-entry batch outcome is unknown; emergency cleanup was attempted and REST reconciliation is required."
            ) from error
        if not isinstance(orders, list):
            raise ExchangeContractError("CCXT createOrders returned an invalid response.")
        mapped = [
            _market_order_result(orders[index], market, spec["params"]["clientOrderId"])
            if index < len(orders) else {
                "clientOrderId": spec["params"]["clientOrderId"],
                "exchangeOrderId": spec["params"]["clientOrderId"],
                "status": "unknown", "filledQuantity": "0", "averagePrice": None,
                "error": "CCXT batch response omitted this order.", "raw": None,
            }
            for index, spec in enumerate((entry_spec, stop_spec))
        ]
        entry_result, stop_result = mapped
        accepted = {"open", "partially_filled", "filled"}
        if entry_result["status"] in accepted and stop_result["status"] in accepted:
            return {"entry": entry_result, "protectiveStop": stop_result}
        # A batch with only one accepted leg is unsafe. Cancel both possible
        # orders and flatten any exposure before surfacing an unknown outcome.
        cleanup_deadline = RequestDeadline(int(time.time() * 1_000) + 10_000)
        await asyncio.gather(
            self._cancel_if_open(clients, entry_result, market["symbol"], cleanup_deadline),
            self._cancel_if_open(clients, stop_result, market["symbol"], cleanup_deadline),
            return_exceptions=True,
        )
        await self._flatten_new_symbol_exposure(clients, market, cleanup_deadline)
        if entry_result["status"] == "rejected" and stop_result["status"] == "rejected":
            return {"entry": entry_result, "protectiveStop": stop_result}
        raise ExchangeContractError("Protected-entry batch was incomplete; exposure was emergency-flattened.")

    async def _all_recent_orders(self, clients: AccountClients, deadline: RequestDeadline) -> list[dict[str, Any]]:
        since = int(time.time() * 1_000) - 30 * 86_400 * 1_000
        operations: list[Awaitable[Any]] = [clients.rest.fetch_open_orders(None, None, 500)]
        if clients.rest.has.get("fetchOrders") is True:
            operations.append(clients.rest.fetch_orders(None, since, 500))
        else:
            if clients.rest.has.get("fetchClosedOrders"):
                operations.append(clients.rest.fetch_closed_orders(None, since, 500))
            if clients.rest.has.get("fetchCanceledOrders"):
                operations.append(clients.rest.fetch_canceled_orders(None, since, 500))
        pages = await _within(deadline, asyncio.gather(*operations))
        by_id: dict[str, dict[str, Any]] = {}
        for page in pages:
            for order in page or []:
                key = str(order.get("id") or _client_order_id(order))
                if key:
                    by_id[key] = order
        return list(by_id.values())

    async def cancel_order(
        self,
        account: dict[str, str],
        client_order_id: str,
        symbol: str,
        deadline: RequestDeadline,
    ) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        market = self._market(clients, symbol)
        orders = await self._all_recent_orders(clients, deadline)
        match = next((order for order in orders if _client_order_id(order) == client_order_id), None)
        if match is None:
            raise ExchangeContractError("CCXT could not prove the order cancellation outcome.")
        if _status(match.get("status")) not in {"open", "partially_filled", "unknown"}:
            return _market_order_result(match, market, client_order_id)
        cancelled = await _within(deadline, clients.rest.cancel_order(str(match["id"]), market["symbol"]))
        return _market_order_result(cancelled, market, client_order_id)

    async def open_state(self, account: dict[str, str], deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        since = int(time.time() * 1_000) - 30 * 86_400 * 1_000
        orders, positions = await _within(deadline, asyncio.gather(
            self._all_recent_orders(clients, deadline),
            clients.rest.fetch_positions(),
        ))
        provider_symbols = sorted({
            str(item.get("symbol")) for item in [*orders, *positions]
            if isinstance(item.get("symbol"), str) and item.get("symbol")
        })
        if account["exchange"] == "krakenfutures":
            trade_pages = await _within(deadline, asyncio.gather(*[
                clients.rest.fetch_my_trades(symbol, since, 1_000) for symbol in provider_symbols
            ])) if provider_symbols else []
            trades = [trade for page in trade_pages for trade in (page or [])]
        else:
            trades = await _within(deadline, clients.rest.fetch_my_trades(None, since, 1_000))
        order_by_id = {str(order.get("id")): order for order in orders if order.get("id") is not None}
        normalized_orders = []
        for order in orders:
            market = clients.rest.market(order["symbol"])
            amount = Decimal(str(order.get("amount") or 0)) * Decimal(str(market.get("contractSize") or 1))
            mapped_order = _market_order_result(order, market)
            trigger_price = _trigger_price(order)
            reduce_only = _reduce_only(order)
            normalized_orders.append({
                **mapped_order,
                "symbol": _canonical_symbol(market),
                "role": "stop_loss" if reduce_only and trigger_price is not None else "entry",
                "side": str(order.get("side") or "").lower(),
                "quantity": decimal_text(amount),
                "price": decimal_text(order.get("price"), "0") if order.get("price") is not None else None,
                "triggerPrice": decimal_text(trigger_price, "0") if trigger_price is not None else None,
                "reduceOnly": reduce_only,
            })
        normalized_positions = []
        for position in positions:
            contracts = Decimal(str(position.get("contracts") or 0))
            if contracts <= 0:
                continue
            market = clients.rest.market(position["symbol"])
            side = str(position.get("side") or "").lower()
            if side not in {"long", "short"}:
                raise ExchangeContractError("CCXT position omitted its side.")
            normalized_positions.append({
                "symbol": _canonical_symbol(market),
                "side": side.upper(),
                "quantity": decimal_text(contracts * Decimal(str(market.get("contractSize") or 1))),
                "averageEntryPrice": decimal_text(position.get("entryPrice")),
                "unrealizedPnl": decimal_text(position.get("unrealizedPnl")),
            })
        normalized_fills = []
        for trade in trades:
            order = order_by_id.get(str(trade.get("order")))
            client_id = _client_order_id(order or {})
            if not client_id:
                continue
            fee = trade.get("fee") if isinstance(trade.get("fee"), dict) else {}
            market = clients.rest.market(trade["symbol"])
            base_quantity = Decimal(str(trade.get("amount") or 0)) * Decimal(str(market.get("contractSize") or 1))
            normalized_fills.append({
                "exchangeFillId": str(trade.get("id") or f"{trade.get('order')}:{trade.get('timestamp')}:{trade.get('amount')}"),
                "clientOrderId": client_id,
                "price": decimal_text(trade.get("price")),
                "quantity": decimal_text(base_quantity),
                "fee": decimal_text(fee.get("cost")),
                "feeAsset": fee.get("currency"),
                "filledAt": int(trade.get("timestamp") or time.time() * 1_000),
                "raw": trade,
            })
        identity = external_account_id(account["exchange"], account["mode"], clients.account_identity)
        return {
            "orders": normalized_orders,
            "positions": normalized_positions,
            "fills": normalized_fills,
            "observedAt": int(time.time() * 1_000),
            "accountFingerprint": identity,
        }
