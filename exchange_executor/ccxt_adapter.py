from __future__ import annotations

import asyncio
import copy
import time
from dataclasses import asdict
from decimal import Decimal, getcontext, localcontext
from typing import Any, Awaitable, Callable

from ccxt.base.errors import OrderNotFound

from ccxt_client import CcxtClientRegistry, AccountClients, credential_generation, decimal_text
from ccxt_profiles import ExchangeProfile, profile_for
from common import (
    ExchangeContractError, RequestDeadline, SymbolUnavailableError, UnresolvedOrderOutcome,
    decimal_string, external_account_id,
)
from order_identity import cancel_target, correlate_batch, order_identifier, write_order_identity
from provider_order_identity import batch_tag_params, observed_parent_fields
from fill_identity import native_fill_identity
from fill_quantity_provenance import observe_fill_quantity
from order_evidence import merge_ccxt_order, normalized_status as _status
from remote_evidence import normalize_trades
from history_reader import RecoveryReadBudget, lookup_order_evidence, now_ms, recover_order_evidence, recovery_request, source_evidence
from history_pagination import history_request, read_history_pages
from history_coverage import fresh_fill_source
from current_state import read_current_state
from accounting_evidence import funding_total, reporting_balance
from account_log_scheduler import account_log_request, read_account_logs, read_account_mode, target_budget, propagate_cooldown
from recovery_schedule import recovery_schedule_request, assert_schedule_binding, read_scheduled_recovery
from execution_constraints import assert_entry_constraints, profile_hash, read_account_mode_observation, read_entry_constraints
from entry_price_constraints import apply_entry_boundary, assert_final_entry_spec, needs_entry_boundary, EntryPriceConstraintError
from leverage_tier_evidence import assert_tier_entry, read_tier_evidence
from leverage_tiers import TierEvidenceError
from entry_deadline import EntryDeadline, assert_entry_deadline, entry_deadline_scope
from symbol_resolver import SymbolResolutionError, requested_base, resolve_symbol

INVALID_CONTRACT_SIZE = "CCXT market has an invalid contract size."


def _canonical_symbol(market: dict[str, Any]) -> str:
    base = str(market.get("base") or "").upper()
    if not base or not base.isalnum():
        raise ExchangeContractError("CCXT market has no canonical base asset.")
    return f"{base}USDT"


def _requested_base(symbol: str) -> str:
    """Backward-compatible contract wrapper around the central resolver."""
    try:
        return requested_base(symbol)
    except SymbolResolutionError as error:
        raise ExchangeContractError(str(error)) from error


def _precision_step(value: Any, label: str) -> str:
    if value is None:
        raise ExchangeContractError(f"CCXT market omits certified {label} metadata.")
    number = Decimal(str(value))
    if not number.is_finite() or number <= 0:
        raise ExchangeContractError(f"CCXT market has invalid certified {label} metadata.")
    return decimal_text(number)


def _contract_size(market: dict[str, Any]) -> Decimal:
    if market.get("contractSize") is None:
        raise ExchangeContractError("CCXT market omits its certified contract size.")
    value = Decimal(str(market["contractSize"]))
    if not value.is_finite() or value <= 0:
        raise ExchangeContractError(INVALID_CONTRACT_SIZE)
    return value


def _market_mark_price(ticker: dict[str, Any]) -> Decimal:
    info = ticker.get("info") if isinstance(ticker.get("info"), dict) else {}
    value = ticker.get("mark") or ticker.get("last") or info.get("markPrice") or info.get("mark_price")
    if value is None:
        bid, ask = ticker.get("bid"), ticker.get("ask")
        if bid is not None and ask is not None:
            value = (Decimal(str(bid)) + Decimal(str(ask))) / 2
    if value is None:
        raise ExchangeContractError("CCXT ticker omitted the mark/last price.")
    return Decimal(str(value))


def _positive_market_limit(limits: dict[str, Any], dimension: str, label: str) -> Decimal:
    value = (limits.get(dimension) or {}).get("min")
    if value is None:
        raise ExchangeContractError(f"CCXT market omits certified {label} metadata.")
    number = Decimal(str(value))
    if not number.is_finite() or number <= 0:
        raise ExchangeContractError(f"CCXT market has invalid certified {label} metadata.")
    return number


def _market_constraints(market: dict[str, Any]) -> dict[str, str]:
    precision = market.get("precision") or {}
    limits = market.get("limits") or {}
    contract_size = _contract_size(market)
    amount_step = Decimal(_precision_step(precision.get("amount"), "quantity step"))
    minimum_contracts = _positive_market_limit(limits, "amount", "minimum quantity")
    minimum_notional = _positive_market_limit(limits, "cost", "minimum notional")
    return {
        "priceTick": _precision_step(precision.get("price"), "price tick"),
        "quantityStep": decimal_text(amount_step * contract_size),
        "minimumQuantity": decimal_text(minimum_contracts * contract_size),
        "minimumNotional": decimal_text(minimum_notional),
        "contractSize": decimal_text(contract_size),
    }


def _clients_profile(clients: AccountClients) -> ExchangeProfile:
    profile = getattr(clients, "profile", None) or profile_for(clients.account["exchange"])
    if profile is None:
        raise ExchangeContractError("CCXT account has no certified exchange profile.")
    return profile


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
    client_order_id, exchange_order_id = write_order_identity(order, fallback_client_id)
    status = _status(order.get("status"))
    if order.get("filled") is None:
        raise ExchangeContractError("CCXT order result omitted its cumulative filled quantity.")
    filled = Decimal(decimal_text(order["filled"]))
    if filled < 0:
        raise ExchangeContractError("CCXT order result has a negative filled quantity.")
    if status == "open" and filled > 0:
        status = "partially_filled"
    return {
        "clientOrderId": client_order_id,
        "exchangeOrderId": exchange_order_id,
        "status": status,
        "filledQuantity": decimal_text(filled),
        "averagePrice": decimal_text(order.get("average"), "0") if order.get("average") is not None else None,
        "error": None if status != "rejected" else "Exchange rejected the order.",
        "raw": order.get("_identityOriginal", order),
        **({"identityEvidence": order["identityEvidence"]} if "identityEvidence" in order else {}),
    }


def _remote_order_result(order: dict[str, Any]) -> dict[str, Any]:
    """Normalize an exchange snapshot without inventing a provider client id.

    Some exchanges legitimately omit ``clientOrderId`` from fetch-order responses,
    especially for provider-attached protective orders.  The exchange id remains
    the authoritative remote identity and the control plane performs the safe
    correlation against locally persisted orders.
    """
    client_order_id = _client_order_id(order) or None
    exchange_order_id = order_identifier(order.get("id"), "exchange")
    if not exchange_order_id:
        raise ExchangeContractError("CCXT remote order omitted its exchange identifier.")
    status = _status(order.get("status"))
    filled = None if order.get("filled") is None else Decimal(decimal_text(order["filled"]))
    if filled is not None and filled < 0:
        raise ExchangeContractError("CCXT remote order has a negative cumulative fill quantity.")
    if status == "open" and filled is not None and filled > 0:
        status = "partially_filled"
    return {
        "clientOrderId": client_order_id,
        "exchangeOrderId": exchange_order_id,
        "status": status,
        "filledQuantity": None if filled is None else decimal_text(filled),
        "averagePrice": decimal_text(order.get("average"), "0") if order.get("average") is not None else None,
        "error": None if status != "rejected" else "Exchange rejected the order.",
        "raw": order.get("_identityOriginal", order),
        **({"identityEvidence": order["identityEvidence"]} if "identityEvidence" in order else {}),
    }


def _market_order_result(
    order: dict[str, Any],
    market: dict[str, Any],
    fallback_client_id: str = "",
) -> dict[str, Any]:
    result = _order_result(order, fallback_client_id)
    contract_size = _contract_size(market)
    result["filledQuantity"] = decimal_text(Decimal(result["filledQuantity"]) * contract_size)
    if market.get("symbol"):
        if order.get("symbol") is not None and order["symbol"] != market["symbol"]:
            raise ExchangeContractError("CCXT order result does not match the requested provider symbol.")
        result["providerSymbol"] = market["symbol"]
    return result


def _normalized_open_order(rest: Any, order: dict[str, Any], exchange: str = "") -> dict[str, Any]:
    market = rest.market(order["symbol"])
    contract_size = _contract_size(market)
    amount = Decimal(str(order.get("amount") or 0)) * contract_size
    trigger_price = _trigger_price(order)
    reduce_only = _reduce_only(order)
    result = _remote_order_result(order)
    provider_time = order.get("lastUpdateTimestamp")
    if provider_time is not None and (type(provider_time) is not int or not 0 <= provider_time <= now_ms() + 60_000):
        raise ExchangeContractError("Remote order has an invalid provider event timestamp.")
    if result["filledQuantity"] is not None:
        result["filledQuantity"] = decimal_text(Decimal(result["filledQuantity"]) * contract_size)
    return {
        **result,
        "symbol": _canonical_symbol(market),
        "providerSymbol": order["symbol"],
        "providerTimestamp": provider_time,
        "role": "stop_loss" if reduce_only and trigger_price is not None else "entry",
        "side": str(order.get("side") or "").lower(),
        "quantity": decimal_text(amount),
        "price": decimal_text(order.get("price"), "0") if order.get("price") is not None else None,
        "triggerPrice": decimal_text(trigger_price, "0") if trigger_price is not None else None,
        "reduceOnly": reduce_only,
        **observed_parent_fields(order, market, exchange),
    }


def _position_contracts(position: dict[str, Any]) -> Decimal:
    value = position.get("contracts")
    if value is None or value == "" or isinstance(value, bool):
        raise ExchangeContractError("CCXT position omitted its executed quantity.")
    return Decimal(decimal_string(decimal_text(value), "position.contracts"))


def _linear_accounting_metadata(market: dict[str, Any]) -> dict[str, Any] | None:
    if market.get("linear") is not True or not isinstance(market.get("settle"), str) or not market["settle"]:
        return None
    if not isinstance(market.get("symbol"), str) or not market["symbol"]:
        return None
    return {"version": 1, "source": "ccxt-market-v1", "providerSymbol": market["symbol"],
            "settlementAsset": market["settle"], "linear": True, "quantityUnit": "base"}


def _normalized_position(rest: Any, position: dict[str, Any]) -> dict[str, Any] | None:
    contracts = _position_contracts(position)
    if contracts == 0:
        return None
    market = rest.market(position["symbol"])
    side = str(position.get("side") or "").lower()
    if side not in {"long", "short"}:
        raise ExchangeContractError("CCXT position omitted its side.")
    return {
        "symbol": _canonical_symbol(market),
        "providerSymbol": order_identifier(position["symbol"], "position provider symbol"),
        "side": side.upper(),
        "quantity": decimal_text(contracts * _contract_size(market)),
        "averageEntryPrice": decimal_text(position.get("entryPrice")),
        "unrealizedPnl": decimal_text(position["unrealizedPnl"]) if position.get("unrealizedPnl") is not None else None,
        "markPrice": decimal_string(decimal_text(position["markPrice"]), "position mark price", positive=True)
        if position.get("markPrice") is not None else None,
        "accounting": _linear_accounting_metadata(market),
    }


def _normalized_fill(
    rest: Any, order_by_id: dict[tuple[str, str], dict[str, Any]], trade: dict[str, Any],
    exchange: str = "",
) -> dict[str, Any]:
    if trade.get("historyMissingFee") is True:
        raise ExchangeContractError("Historical execution omitted its actual fee evidence.")
    if exchange == "krakenfutures" and (trade.get("info") or {}).get("identitySource") != "kraken_history_execution_v3":
        raise ExchangeContractError("Recent Kraken fill identity is not a documented execution UID alias.")
    exchange_order_id = order_identifier(trade.get("order"), 'fill order')
    exchange_fill_id = order_identifier(trade.get("id"), 'fill')
    filled_at = trade.get("timestamp")
    if not isinstance(filled_at, int) or isinstance(filled_at, bool) or filled_at < 0:
        raise ExchangeContractError('Fill omitted its provider timestamp.')
    order = order_by_id.get((str(trade.get("symbol") or ""), exchange_order_id))
    client_id = _client_order_id(order or {}) or None
    fee = trade.get("fee") if isinstance(trade.get("fee"), dict) else {}
    if fee.get("cost") is None:
        raise ExchangeContractError("Execution omitted its actual fee evidence.")
    market = rest.market(trade["symbol"])
    input_quantity = Decimal(decimal_string(decimal_text(trade.get("amount")), 'fill amount', positive=True))
    contract_size = _contract_size(market)
    base_quantity = input_quantity * contract_size
    identity = native_fill_identity(exchange, market, trade)
    quantity_normalization = observe_fill_quantity(market, trade, identity, input_quantity, contract_size, base_quantity,
        decimal_precision=getcontext().prec, decimal_rounding=getcontext().rounding, normalized_at=now_ms())
    return {
        "exchangeFillId": exchange_fill_id,
        "clientOrderId": client_id,
        "exchangeOrderId": exchange_order_id,
        "symbol": _canonical_symbol(market),
        "providerSymbol": market.get("symbol") or trade["symbol"],
        "price": decimal_string(decimal_text(trade.get("price")), 'fill price', positive=True),
        "quantity": decimal_text(base_quantity),
        "fee": decimal_text(fee.get("cost")),
        "feeAsset": fee.get("currency"),
        "accounting": _linear_accounting_metadata(market),
        "filledAt": filled_at,
        "raw": trade,
        **({"identity": identity} if identity else {}),
        **({"quantityNormalization": quantity_normalization} if quantity_normalization else {}),
    }


def _base_order_spec(rest: Any, request: dict[str, Any], symbol: str, amount: str, exchange: str = "") -> dict[str, Any]:
    side = request.get("side")
    if side not in {"buy", "sell"}:
        raise ExchangeContractError("Order side is invalid.")
    order_type = request.get("orderType")
    if order_type not in {"market", "limit", "stop_market"}:
        raise ExchangeContractError("Order type is invalid.")
    params: dict[str, Any] = {
        "clientOrderId": str(request.get("clientOrderId") or ""),
        "reduceOnly": request.get("reduceOnly") is True,
        **batch_tag_params(request, exchange),
    }
    if not params["clientOrderId"]:
        raise ExchangeContractError("clientOrderId is required.")
    if request.get("postOnly") is True:
        params.update({"postOnly": True, "timeInForce": "PO"})
    unified_type, price = order_type, request.get("price")
    if order_type == "stop_market":
        trigger = decimal_string(request.get("triggerPrice"), "triggerPrice", positive=True)
        params["stopLossPrice"] = rest.price_to_precision(symbol, trigger)
        unified_type, price = "market", None
    elif order_type == "limit":
        price = rest.price_to_precision(symbol, decimal_string(price, "price", positive=True))
    else:
        price = None
    return {"symbol": symbol, "type": unified_type, "side": side, "amount": amount, "price": price, "params": params}


def _protected_order_results(
    orders: list[dict[str, Any]], market: dict[str, Any], specs: tuple[dict[str, Any], dict[str, Any]],
    exchange: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    return correlate_batch(orders, specs, lambda order, client_id: _market_order_result(order, market, client_id), exchange)


async def _within(deadline: RequestDeadline, operation: Awaitable[Any]) -> Any:
    deadline.ensure(250)
    return await asyncio.wait_for(operation, timeout=deadline.sdk_timeout_seconds())


class CcxtAdapter:
    def __init__(self, registry: CcxtClientRegistry) -> None:
        self.registry = registry
        self._history_locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def _clients(self, account: dict[str, str], deadline: RequestDeadline) -> AccountClients:
        return await _within(deadline, self.registry.account(account))

    @staticmethod
    def _market(clients: AccountClients, requested_symbol: str) -> dict[str, Any]:
        try:
            return resolve_symbol(
                clients.rest.markets,
                requested_symbol,
                _clients_profile(clients).settlement_preference,
            )
        except SymbolResolutionError as error:
            if error.code != "SYMBOL_UNAVAILABLE":
                raise ExchangeContractError(str(error)) from error
            raise SymbolUnavailableError(
                f"Symbol {requested_symbol} is unavailable on the certified linear perpetual market.",
                exchange=clients.account["exchange"],
                account_id=clients.account["id"],
                symbol=requested_symbol,
            ) from error

    async def verify(self, account: dict[str, str], deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        balance = await _within(deadline, clients.rest.fetch_balance())
        reporting = reporting_balance(account['exchange'], balance)
        equity = reporting['equity']
        identity = external_account_id(account["exchange"], account["mode"], clients.account_identity)
        mode_observation = await read_account_mode_observation(clients, deadline)
        return {
            "verified": mode_observation["verified"],
            "reason": mode_observation["reason"],
            "entryAllowed": False,
            "equity": equity,
            "externalAccountId": identity,
            "accountFingerprint": identity,
            "credentialGeneration": credential_generation(clients),
            "capabilities": {
                "integration": "ccxt",
                "ccxtPro": True,
                "restOrderSubmission": True,
                "privateOrderStream": True,
                "privateTradeStream": True,
                "privatePositionStream": True,
                "builderFeeEnabled": _clients_profile(clients).builder_fee_enabled,
                "accountIdentityBinding": _clients_profile(clients).identity_strategy,
                "reportingCurrency": reporting['reportingCurrency'],
                "settlementAssets": reporting['settlementAssets'],
                "reportingSource": reporting['source'],
                "profileVersion": _clients_profile(clients).profile_version,
                "protectedEntryStrategy": _clients_profile(clients).protected_entry_strategy,
                "executionModeObservation": mode_observation,
                "executionCapabilities": asdict(_clients_profile(clients).execution_capabilities),
                "executionProfileHash": profile_hash(_clients_profile(clients)),
            },
        }

    async def entry_constraints(self, account: dict[str, str], symbol: str, deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        self.registry.assert_binding(account, clients)
        market = self._market(clients, symbol)
        result = await read_entry_constraints(clients, market, deadline)
        self.registry.assert_binding(account, clients)
        return result

    async def _entry_mode_fence(
        self, clients: AccountClients, market: dict[str, Any], deadline: RequestDeadline, leverage: int | None = None,
    ) -> dict[str, Any]:
        evidence = await read_entry_constraints(clients, market, deadline)
        self.registry.assert_binding(clients.account, clients)
        assert_entry_constraints(clients, market, evidence)
        if leverage is not None and evidence['leverageSemantics'] == 'configured' and evidence['leverage'] != leverage:
            raise ExchangeContractError('Entry leverage readback does not match the execution plan.')
        return evidence

    @staticmethod
    def _balance_values(clients: AccountClients, balance: dict[str, Any]) -> tuple[str, str]:
        currencies = _clients_profile(clients).settlement_preference
        total = balance.get("total") if isinstance(balance.get("total"), dict) else {}
        free = balance.get("free") if isinstance(balance.get("free"), dict) else {}
        for currency in currencies:
            if total.get(currency) is not None:
                return decimal_text(total[currency]), decimal_text(free.get(currency, total[currency]))
        raise ExchangeContractError("CCXT balance contains no certified settlement currency.")

    async def account_snapshot(self, account: dict[str, str], deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        self.registry.assert_binding(account, clients)
        balance, _positions = await _within(deadline, asyncio.gather(
            clients.rest.fetch_balance(), clients.rest.fetch_positions(),
        ))
        reporting = reporting_balance(account['exchange'], balance)
        equity, available = reporting['equity'], reporting['availableBalance']
        # Funding is now produced by the shared durable /open-state history
        # pipeline, never another five-call pool started by a balance read.
        until = now_ms()
        funding = {'status': 'incomplete', 'since': until // 86_400_000 * 86_400_000, 'until': until,
                   'cursor': None, 'source': 'durable-account-log', 'reason': 'persisted_observation_required',
                   'nextReadAt': 0, 'events': []}
        self.registry.assert_binding(account, clients)
        return {
            "equity": equity,
            "availableBalance": available,
            "unrealizedPnl": reporting['unrealizedPnl'],
            "marginUsed": reporting['marginUsed'],
            "fundingPnlToday": funding_total(funding, reporting['reportingCurrency']),
            "accounting": {
                "accountFingerprint": external_account_id(account['exchange'], account['mode'], clients.account_identity),
                "reportingCurrency": reporting['reportingCurrency'], "settlementAssets": reporting['settlementAssets'],
                "source": reporting['source'], "observedAt": now_ms(), "funding": funding,
                "unrealizedPnlSemantics": reporting['unrealizedPnlSemantics'],
            },
        }

    async def market_snapshot(self, account: dict[str, str], symbol: str, deadline: RequestDeadline) -> dict[str, Any]:
        clients = await self._clients(account, deadline)
        market = self._market(clients, symbol)
        self.registry.assert_binding(account, clients)
        tiers = await read_tier_evidence(clients, market, deadline)
        constraints = _market_constraints(market)
        return {
            "symbol": _canonical_symbol(market),
            "providerSymbol": market["symbol"],
            "markPrice": tiers['markPrice'],
            "accounting": _linear_accounting_metadata(market),
            **constraints,
            "maxLeverage": tiers['tiers'][0]['maxLeverage'],
            "observedAt": tiers['observedAt'],
            "leverageTiers": tiers,
        }

    async def _entry_tier_fence(self, clients, market, request, spec, deadline):
        if not isinstance(request.get('leverageTierDecision'), dict):
            raise TierEvidenceError('Original leverage tier decision is missing.')
        evidence = await read_tier_evidence(clients, market, deadline)
        self.registry.assert_binding(clients.account, clients)
        assert_tier_entry(clients, market, request, spec, evidence)
        return evidence

    async def _order_spec(
        self,
        clients: AccountClients,
        request: dict[str, Any],
        deadline: RequestDeadline,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        assert_entry_deadline(request)
        market, spec = self._base_order_request(clients, request)
        await self._apply_market_slippage(clients, request, spec, deadline)
        await self._fence_order_entry(clients, market, request, spec, deadline)
        return spec, market

    def _base_order_request(
        self, clients: AccountClients, request: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        market = self._market(clients, str(request.get("symbol") or ""))
        symbol = market["symbol"]
        quantity = decimal_string(request.get("quantity"), "quantity", positive=True)
        contract_size = _contract_size(market)
        with localcontext() as context:
            context.prec = 180
            contracts = Decimal(quantity) / contract_size
        amount = clients.rest.amount_to_precision(symbol, decimal_text(contracts))
        if Decimal(str(amount)) <= 0:
            raise ExchangeContractError("Order quantity is below the market contract precision.")
        spec = _base_order_spec(clients.rest, request, symbol, amount, clients.account["exchange"])
        if needs_entry_boundary(request):
            if clients.rest.has.get('createOrders') is not True:
                raise EntryPriceConstraintError('Provider SDK lacks the required bounded-entry batch capability.')
            apply_entry_boundary(_clients_profile(clients), request, spec,
                                 _precision_step(market.get('precision', {}).get('price'), 'price tick'))
        return market, spec

    async def _apply_market_slippage(
        self, clients: AccountClients, request: dict[str, Any],
        spec: dict[str, Any], deadline: RequestDeadline,
    ) -> None:
        symbol = spec["symbol"]
        if _clients_profile(clients).market_order_strategy == "reference_slippage" and spec["type"] == "market":
            slippage_percent = decimal_string(
                request.get("maxSlippagePercent"), "maxSlippagePercent", positive=True,
            )
            spec["params"]["slippage"] = decimal_text(Decimal(slippage_percent) / Decimal("100"))
            if request.get("orderType") == "stop_market":
                reference = decimal_string(request.get("triggerPrice"), "triggerPrice", positive=True)
            else:
                reference = await self._market_order_reference(clients, symbol, request.get("side"), deadline)
            spec["price"] = clients.rest.price_to_precision(symbol, reference)

    async def _fence_order_entry(
        self, clients: AccountClients, market: dict[str, Any], request: dict[str, Any],
        spec: dict[str, Any], deadline: RequestDeadline,
    ) -> None:
        leverage = request.get("leverage")
        if spec["params"]["reduceOnly"]:
            return
        if not isinstance(leverage, int) or isinstance(leverage, bool) or leverage < 1:
            raise ExchangeContractError("Order leverage is invalid.")
        mode = await self._entry_mode_fence(clients, market, deadline)
        assert_entry_deadline(request)
        tiers = await self._entry_tier_fence(clients, market, request, spec, deadline)
        assert_entry_deadline(request)
        self.registry.assert_binding(clients.account, clients)
        assert_entry_constraints(clients, market, mode)
        assert_tier_entry(clients, market, request, spec, tiers)
        await self._apply_entry_leverage(clients, spec["symbol"], request, mode, deadline)
        if clients.account["exchange"] == "bybit":
            spec["params"]["positionIdx"] = 0

    @staticmethod
    async def _apply_entry_leverage(
        clients: AccountClients, symbol: str, request: dict[str, Any],
        mode: dict[str, Any], deadline: RequestDeadline,
    ) -> None:
        leverage = request["leverage"]
        # Kraken's maxLeverage setter switches to isolated. Cross uses effective leverage from collateral/size.
        if clients.account["exchange"] == "krakenfutures" or mode["leverage"] == leverage:
            return
        if clients.account["exchange"] == "hyperliquid":
            await _within(deadline, clients.rest.set_leverage(leverage, symbol, {"marginMode": "cross"}))
        else:
            await _within(deadline, clients.rest.set_leverage(leverage, symbol))
        assert_entry_deadline(request)

    async def _market_order_reference(
        self,
        clients: AccountClients,
        symbol: str,
        side: Any,
        deadline: RequestDeadline,
    ) -> str:
        if side not in {"buy", "sell"}:
            raise ExchangeContractError("Order side is invalid.")
        ticker = await _within(deadline, clients.rest.fetch_ticker(symbol))
        info = ticker.get("info") if isinstance(ticker.get("info"), dict) else {}
        directional = ticker.get("ask") if side == "buy" else ticker.get("bid")
        candidates = (
            directional,
            ticker.get("mark"),
            ticker.get("last"),
            info.get("markPrice"),
            info.get("mark_price"),
        )
        for candidate in candidates:
            if candidate is None:
                continue
            try:
                normalized = decimal_text(candidate)
                if Decimal(normalized) <= 0:
                    continue
            except ExchangeContractError:
                continue
            return clients.rest.price_to_precision(symbol, normalized)
        raise ExchangeContractError("CCXT ticker omitted a usable market-order reference price.")

    async def submit_order(self, account: dict[str, str], request: dict[str, Any], deadline: RequestDeadline) -> dict[str, Any]:
        fence, frozen = EntryDeadline(request), copy.deepcopy(request)
        deadline = fence.bound_budget(deadline)
        async with self.registry.mutation(account, deadline) as clients:
            with entry_deadline_scope(fence):
                return await self._submit_order_owned(clients, account, frozen, deadline)

    async def _submit_order_owned(
        self, clients: AccountClients, account: dict[str, str], request: dict[str, Any], deadline: RequestDeadline,
    ) -> dict[str, Any]:
        if needs_entry_boundary(request):
            raise EntryPriceConstraintError('Bounded entry requires its protected batch; standalone submission is forbidden.')
        spec, market = await self._order_spec(clients, request, deadline)
        if not spec["params"]["reduceOnly"]:
            mode = await self._entry_mode_fence(clients, market, deadline, request['leverage'])
            assert_entry_deadline(request)
            await self._entry_tier_fence(clients, market, request, spec, deadline)
            assert_entry_constraints(clients, market, mode)
        self.registry.assert_binding(account, clients)
        assert_entry_deadline(request)
        order = await _within(deadline, clients.rest.create_order(**spec))
        try:
            return _market_order_result(order, market, spec["params"]["clientOrderId"])
        except ExchangeContractError as error:
            raise UnresolvedOrderOutcome(
                "Order acknowledgement is unresolved; REST reconciliation is required.",
                [], [spec["params"]["clientOrderId"]],
            ) from error

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
        if not isinstance(positions, list):
            raise ExchangeContractError("Position preflight returned an invalid collection.")
        if any(_position_contracts(position) != 0 for position in positions):
            raise ExchangeContractError(
                "Protected entry is blocked because the exchange already reports exposure for this account and symbol."
            )
        orders = await _within(deadline, clients.rest.fetch_open_orders(market["symbol"]))
        if not isinstance(orders, list) or orders:
            raise ExchangeContractError(
                "Protected entry is blocked because active exchange orders at this symbol are not proved absent."
            )

    async def _create_protected_orders(
        self,
        clients: AccountClients,
        market: dict[str, Any],
        specs: tuple[dict[str, Any], dict[str, Any]],
        deadline: RequestDeadline,
        leverage: int,
        entry: dict[str, Any],
    ) -> list[dict[str, Any]]:
        mode = await self._entry_mode_fence(clients, market, deadline, leverage)
        assert_entry_deadline(entry)
        await self._entry_tier_fence(clients, market, entry, specs[0], deadline)
        assert_entry_constraints(clients, market, mode)
        self.registry.assert_binding(clients.account, clients)
        if needs_entry_boundary(entry):
            assert_final_entry_spec(_clients_profile(clients), entry, specs[0],
                                    _precision_step(market.get('precision', {}).get('price'), 'price tick'))
        assert_entry_deadline(entry)
        try:
            orders = await _within(deadline, clients.rest.create_orders(list(specs)))
        except Exception as error:
            # A zero-position preflight is not an ownership proof: another
            # client can trade during this await. Recovery belongs to the
            # managed-order ledger, never to a symbol-wide blind flatten.
            raise UnresolvedOrderOutcome(
                "Protected-entry batch outcome is unknown; REST reconciliation is required.",
                [], [spec["params"]["clientOrderId"] for spec in specs],
            ) from error
        if not isinstance(orders, list):
            raise UnresolvedOrderOutcome(
                "CCXT createOrders returned an invalid response; REST reconciliation is required.",
                [], [spec["params"]["clientOrderId"] for spec in specs],
            )
        return orders

    async def _resolve_protected_results(
        self,
        clients: AccountClients,
        market: dict[str, Any],
        entry_result: dict[str, Any],
        stop_result: dict[str, Any],
        bounded_ioc: bool = False,
    ) -> dict[str, Any]:
        accepted = {"open", "partially_filled", "filled"}
        if bounded_ioc and entry_result['status'] == 'cancelled' and stop_result['status'] in accepted:
            return {"entry": entry_result, "protectiveStop": stop_result}
        if entry_result["status"] in accepted and stop_result["status"] in accepted:
            return {"entry": entry_result, "protectiveStop": stop_result}
        if entry_result["status"] == "rejected" and stop_result["status"] == "rejected":
            return {"entry": entry_result, "protectiveStop": stop_result}
        raise UnresolvedOrderOutcome(
            "Protected-entry batch was incomplete; managed REST recovery is required.",
            [entry_result, stop_result], [],
        )

    async def submit_protected_entry(
        self,
        account: dict[str, str],
        entry: dict[str, Any],
        stop: dict[str, Any],
        deadline: RequestDeadline,
    ) -> dict[str, Any]:
        self._validate_protected_entry(entry, stop)
        fence, frozen_entry, frozen_stop = EntryDeadline(entry), copy.deepcopy(entry), copy.deepcopy(stop)
        deadline = fence.bound_budget(deadline)
        async with self.registry.mutation(account, deadline) as clients:
            with entry_deadline_scope(fence):
                return await self._submit_protected_owned(clients, frozen_entry, frozen_stop, deadline)

    async def _submit_protected_owned(
        self, clients: AccountClients, entry: dict[str, Any], stop: dict[str, Any], deadline: RequestDeadline,
    ) -> dict[str, Any]:
        market = self._market(clients, str(entry.get("symbol") or ""))
        await self._assert_symbol_has_no_position(clients, market, deadline)
        entry_spec, market = await self._order_spec(clients, entry, deadline)
        stop_spec, stop_market = await self._order_spec(clients, stop, deadline)
        if stop_market["symbol"] != market["symbol"]:
            raise ExchangeContractError("Entry and protective stop must use the same market.")
        specs = (entry_spec, stop_spec)
        orders = await self._create_protected_orders(clients, market, specs, deadline, entry['leverage'], entry)
        entry_result, stop_result = _protected_order_results(orders, market, specs, clients.account["exchange"])
        return await self._resolve_protected_results(clients, market, entry_result, stop_result, needs_entry_boundary(entry))

    async def _recent_historical_orders(self, clients: AccountClients, deadline: RequestDeadline) -> list[dict[str, Any]]:
        exchange = clients.account["exchange"]
        now = now_ms()
        since = now - 30 * 86_400_000
        # Historical observations supplement, but never certify, the separate current-state collection.
        operations: list[Callable[[], Awaitable[Any]]] = []
        if exchange == "bybit" and callable(getattr(clients.rest, "fetch_canceled_and_closed_orders", None)):
            operations.append(lambda: clients.rest.fetch_canceled_and_closed_orders(None, now - 7 * 86_400_000, 50, {"until": now}))
        elif exchange == "hyperliquid" and clients.rest.has.get("fetchOrders") is True:
            operations.append(lambda: clients.rest.fetch_orders(None, None, None))
        else:
            # Kraken's fetchOrders is an exact-ID status endpoint, not a history listing.
            if clients.rest.has.get("fetchClosedOrders"):
                operations.append(lambda: clients.rest.fetch_closed_orders(None, since, 500))
            if clients.rest.has.get("fetchCanceledOrders"):
                operations.append(lambda: clients.rest.fetch_canceled_orders(None, since, 500))
        pages = []
        for operation in operations:
            pages.append(await _within(deadline, operation()))
        return self._merge_order_pages(pages)

    @staticmethod
    def _merge_order_pages(pages: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        by_id: dict[tuple[str, str], dict[str, Any]] = {}
        for page in pages:
            if not isinstance(page, list):
                raise ExchangeContractError("Order history omitted its collection.")
            for order in page:
                key = (order_identifier(order.get("symbol"), "provider symbol"), order_identifier(order.get("id"), "exchange"))
                by_id[key] = merge_ccxt_order(by_id[key], order) if key in by_id else order
        return list(by_id.values())

    async def cancel_order(
        self,
        account: dict[str, str],
        client_order_id: str,
        symbol: str,
        deadline: RequestDeadline,
        exchange_order_id: str | None = None,
        provider_symbol: str | None = None,
    ) -> dict[str, Any]:
        async with self.registry.mutation(account, deadline) as clients:
            return await self._cancel_order_owned(clients, client_order_id, symbol, deadline, exchange_order_id, provider_symbol)

    async def _cancel_order_owned(
        self, clients: AccountClients, client_order_id: str, symbol: str, deadline: RequestDeadline,
        exchange_order_id: str | None, provider_symbol: str | None,
    ) -> dict[str, Any]:
        market = self._market(clients, symbol)
        if provider_symbol is not None and provider_symbol != market["symbol"]:
            raise ExchangeContractError("Cancellation provider symbol conflicts with the local order binding.")
        reference = {"clientOrderId": client_order_id, "exchangeOrderId": exchange_order_id,
                     "providerSymbol": market["symbol"], "symbol": symbol, "role": "entry"}
        try:
            orders = await lookup_order_evidence(clients.rest, clients.account["exchange"], reference,
                                                 market["symbol"], RecoveryReadBudget(deadline))
        except NotImplementedError as error:
            raise UnresolvedOrderOutcome("No verified cancellation lookup for this order identity.", [], [client_order_id]) from error
        match = cancel_target(orders, market["symbol"], client_order_id, exchange_order_id)
        if _status(match.get("status")) not in {"open", "partially_filled", "unknown"}:
            return _market_order_result(match, market, client_order_id)
        self.registry.assert_binding(clients.account, clients)
        try:
            cancelled = await _within(deadline, clients.rest.cancel_order(match["id"], market["symbol"]))
            if not isinstance(cancelled, dict) or cancelled.get("id") != match["id"]:
                raise ExchangeContractError("Cancel acknowledgement omitted or changed its exchange identifier.")
            if cancelled.get("symbol") not in (None, market["symbol"]):
                raise ExchangeContractError("Cancel acknowledgement changed its provider symbol.")
            result = cancel_target([{**cancelled, "symbol": market["symbol"]}], market["symbol"], client_order_id, match["id"])
            return _market_order_result(result, market, client_order_id)
        except (ExchangeContractError, OrderNotFound) as error:
            # Unknown cumulative fill quantity or OrderNotFound is not a zero
            # fill cancellation. Do not retry the write or claim completion.
            raise UnresolvedOrderOutcome(
                "Order cancellation is unresolved; authoritative REST evidence is required.", [], [client_order_id],
            ) from error

    async def _recent_trades(
        self,
        account: dict[str, str],
        clients: AccountClients,
        provider_symbols: list[str],
        since: int,
        deadline: RequestDeadline,
    ) -> list[dict[str, Any]]:
        if not _clients_profile(clients).my_trades_requires_symbol:
            return await _within(deadline, clients.rest.fetch_my_trades(None, since, 100 if account["exchange"] == "bybit" else None))
        if not provider_symbols:
            return []
        pages = []
        for symbol in provider_symbols:
            pages.append(await _within(deadline, clients.rest.fetch_my_trades(symbol, since, None)))
        if any(not isinstance(page, list) for page in pages):
            raise ExchangeContractError("Fill history omitted its collection.")
        return [trade for page in pages for trade in page]

    def _recovery_symbol(self, clients: AccountClients, reference: dict[str, Any]) -> str:
        market = clients.rest.market(reference["providerSymbol"]) if reference["providerSymbol"] else self._market(clients, reference["symbol"])
        if _canonical_symbol(market) != reference["symbol"]:
            raise ExchangeContractError("Recovery symbol contradicts its local order namespace.")
        return market["symbol"]

    def _assert_scheduled_binding(self, account, clients, query):
        self.registry.assert_binding(account, clients)
        assert_schedule_binding(query['recoverySchedule'], account, clients)

    async def open_state(self, account: dict[str, str], deadline: RequestDeadline, recovery: Any = None) -> dict[str, Any]:
        started = now_ms()
        query = recovery_request(recovery)
        query["history"] = history_request(recovery.get("history", [])) if isinstance(recovery, dict) else []
        query['accountLogs'] = account_log_request(recovery, account['exchange'])
        query['readAccountMode'] = recovery.get('readAccountMode', False) if isinstance(recovery, dict) else False
        if type(query['readAccountMode']) is not bool:
            raise ExchangeContractError('Invalid account-mode read request.')
        query.update(recovery_schedule_request(recovery, query, account))
        clients = await self._clients(account, deadline)
        if query['accountLogs'] is not None or query['readAccountMode'] or query.get('recoverySchedule'):
            self.registry.assert_binding(account, clients)
            binding = (external_account_id(account['exchange'], account['mode'], clients.account_identity), credential_generation(clients))
            if query['accountLogs'] is not None and (query['accountLogs']['accountFingerprint'], query['accountLogs']['credentialGeneration']) != binding:
                raise ExchangeContractError('Account-log request does not match authenticated credentials.')
        assert_schedule_binding(query.get('recoverySchedule'), account, clients)
        lock = self._history_locks.setdefault((account["exchange"], account["mode"]), asyncio.Lock())
        await asyncio.wait_for(lock.acquire(), timeout=deadline.sdk_timeout_seconds())
        try:
            return await self._read_open_state(account, clients, deadline, query, started)
        finally:
            lock.release()

    async def _read_open_state(self, account: dict[str, str], clients: AccountClients, deadline: RequestDeadline,
                               query: dict[str, Any], started: int) -> dict[str, Any]:
        assert_schedule_binding(query.get('recoverySchedule'), account, clients)
        since = max(query["since"], now_ms() - 7 * 86_400_000) if account["exchange"] == "bybit" else query["since"]
        orders, positions, sources = await read_current_state(clients.rest, account["exchange"], deadline)
        orders = self._merge_order_pages([orders, await self._recent_historical_orders(clients, deadline)])
        provider_symbols = self._recovery_symbols(clients, orders, positions, query["orders"])
        trades_start = now_ms()
        trades = await self._recent_trades(account, clients, provider_symbols, since, deadline)
        sources.append(source_evidence("fills", trades_start, "unknown", "history_pagination_not_proven", since))
        recovery_start = now_ms()
        budget = self._recovery_read_budget(query, deadline)
        recovery = await self._recover_open_state(account, clients, query, orders, budget)
        recovered, checked = recovery['orders'], recovery['checked']
        historical_orders, historical_fills = recovery['historicalOrders'], recovery['historicalFills']
        progress, history_events = recovery['history'], recovery['events']
        extras, targeted_completed = recovery['extras'], recovery['completedAt']
        orders = self._merge_order_pages([orders, recovered])
        sources.append({**source_evidence("targeted_orders", recovery_start,
                       "complete" if all(row["status"] == "observed" for row in checked) else "partial", "positive_evidence_only"),
                        'completedAt': targeted_completed})
        if query.get('accountLogs') is not None or query.get('readAccountMode') or query.get('recoverySchedule'):
            self.registry.assert_binding(account, clients)
        assert_schedule_binding(query.get('recoverySchedule'), account, clients)
        orders = self._merge_order_pages([orders, historical_orders])
        trades.extend(historical_fills)
        self._finalize_fill_sources(sources, progress, account, query, started)
        state = {'orders': orders, 'positions': positions, 'trades': trades, 'historyEvents': history_events,
                 'started': started, 'sources': sources, 'extras': extras, 'checked': checked, 'progress': progress}
        return self._open_state_result(account, clients, state)

    def _recovery_symbols(self, clients, orders, positions, references):
        provider_symbols = sorted({
            str(item.get("symbol")) for item in [*orders, *positions]
            if isinstance(item.get("symbol"), str) and item.get("symbol")
        })
        # Local unresolved obligations contribute symbols even when REST lists are empty.
        for reference in references:
            try:
                provider_symbols.append(self._recovery_symbol(clients, reference))
            except (KeyError, SymbolUnavailableError):
                pass  # The lookup is explicitly unsupported; never evidence of absence.
        return sorted(set(provider_symbols))

    @staticmethod
    def _recovery_read_budget(query, deadline):
        resume_at = max((row["nextReadAt"] for row in query["history"] if row["reason"] == "history_transient"), default=0)
        if (query.get('accountLogs') or {}).get('reason') == 'transient':
            resume_at = max(resume_at, query['accountLogs']['nextReadAt'])
        return RecoveryReadBudget(deadline, resume_at=resume_at)

    async def _recover_open_state(self, account, clients, query, orders, budget):
        if query.get('recoverySchedule'):
            scheduled = await read_scheduled_recovery(clients.rest, account['mode'], query, orders,
                lambda reference: self._recovery_symbol(clients, reference), budget, clients.account_identity,
                lambda: self._assert_scheduled_binding(account, clients, query))
            recovered, checked, extras = scheduled['orders'], scheduled['checked'], scheduled['extras']
            historical_orders, historical_fills, progress = [], scheduled['fills'], scheduled['history']
            history_events = scheduled['events']
            targeted_completed = now_ms()
        else:
            recovered, checked = await recover_order_evidence(
                clients.rest, account["exchange"], query["orders"], orders,
                lambda reference: self._recovery_symbol(clients, reference), target_budget(query, budget),
            )
            targeted_calls = budget.calls
            identity = external_account_id(account['exchange'], account['mode'], clients.account_identity)
            extras = {}
            generation = credential_generation(clients) if query.get('readAccountMode') else ''
            mode = await read_account_mode(clients.rest, account['exchange'], query, budget, (identity, generation))
            if mode is not None:
                extras.update(accountMode=mode, targetedCalls=targeted_calls)
            logs = await read_account_logs(clients.rest, account['exchange'], query, budget, clients.account_identity)
            if logs is not None:
                extras.update(accountLogs=logs, targetedCalls=targeted_calls)
            targeted_completed = now_ms()
            history_events: list[dict[str, Any]] = []
            historical_orders, historical_fills, progress = await read_history_pages(clients.rest, account["exchange"], query["history"], budget, history_events)
            propagate_cooldown(logs, budget)
        return {'orders': recovered, 'checked': checked, 'extras': extras,
                'historicalOrders': historical_orders, 'historicalFills': historical_fills,
                'history': progress, 'events': history_events, 'completedAt': targeted_completed}

    @staticmethod
    def _finalize_fill_sources(sources, progress, account, query, started):
        for source in sources:
            if source["source"] == "fills":
                source["completedAt"] = now_ms()
                source.update(fresh_fill_source(source, progress, account['exchange'], query['since'], started))

    @staticmethod
    def _open_state_result(account, clients, state):
        orders, positions, trades = state['orders'], state['positions'], state['trades']
        order_by_id = {(str(order.get("symbol")), str(order.get("id"))): order for order in orders if order.get("id") is not None}
        normalized_orders = [_normalized_open_order(clients.rest, order, account["exchange"]) for order in orders]
        normalized_positions = [
            normalized for position in positions
            if (normalized := _normalized_position(clients.rest, position)) is not None
        ]
        normalized_fills, unresolved_events = normalize_trades(
            trades, lambda trade: _normalized_fill(clients.rest, order_by_id, trade, account["exchange"]),
        )
        unresolved_events.extend(state['historyEvents'])
        identity = external_account_id(account["exchange"], account["mode"], clients.account_identity)
        return {
            "orders": normalized_orders,
            "positions": normalized_positions,
            "fills": normalized_fills,
            "unresolvedEvents": unresolved_events,
            "observedAt": int(time.time() * 1_000),
            "accountFingerprint": identity,
            "acquisition": {"version": 1, "startedAt": state['started'], "completedAt": now_ms(),
                            "sources": state['sources'], **state['extras'],
                            "checkedOrders": state['checked'], "history": state['progress']},
        }
