from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from pybit.unified_trading import HTTP

from common import (
    ExchangeContractError,
    RequestDeadline,
    decimal_string,
    external_account_id,
    map_bybit_status,
    optional_positive_decimal_string,
    response_list,
    signed_decimal_string,
)
from credentials import CredentialStore


class BybitAdapter:
    def __init__(self, credentials: CredentialStore) -> None:
        self.credentials = credentials
        self._identity_cache: dict[str, str] = {}

    def _client(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> HTTP:
        secret = self.credentials.account(account["id"], "bybit")
        return HTTP(
            testnet=account["mode"] == "testnet",
            api_key=secret["apiKey"],
            api_secret=secret["apiSecret"],
            recv_window=5000,
            timeout=deadline.sdk_timeout_seconds() if deadline else 10,
            force_retry=False,
        )

    def _external_account_id(
        self,
        account: dict[str, str],
        client: HTTP,
        deadline: RequestDeadline | None,
    ) -> str:
        secret = self.credentials.account(account["id"], "bybit")
        cache_key = external_account_id("bybit-key", account["mode"], secret["apiKey"])
        cached = self._identity_cache.get(cache_key)
        if cached:
            return cached
        if deadline:
            deadline.ensure(500)
        response = client.get_api_key_information()
        if not isinstance(response, dict) or response.get("retCode") != 0 or not isinstance(response.get("result"), dict):
            raise ExchangeContractError("Bybit account identity query failed.")
        result = response["result"]
        uid = result.get("userID", result.get("userId", result.get("uid")))
        if uid is None or str(uid).strip() == "":
            raise ExchangeContractError("Bybit account identity response omitted the stable UID.")
        identity = external_account_id("bybit", account["mode"], str(uid))
        self._identity_cache[cache_key] = identity
        return identity

    def verify(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> dict[str, Any]:
        snapshot = self.account_snapshot(account, deadline)
        client = self._client(account) if deadline is None else self._client(account, deadline)
        identity = self._external_account_id(account, client, deadline)
        return {
            "verified": True,
            "equity": snapshot["equity"],
            "externalAccountId": identity,
            "accountFingerprint": identity,
        }

    def account_snapshot(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> dict[str, str]:
        client = self._client(account) if deadline is None else self._client(account, deadline)
        if deadline:
            deadline.ensure(250)
        values = response_list(client.get_wallet_balance(accountType="UNIFIED"), "Bybit wallet balance")
        if len(values) != 1:
            raise ExchangeContractError("Bybit returned an ambiguous wallet balance.")
        now = int(time.time() * 1000)
        funding = self._all_pages(
            client.get_transaction_log,
            "Bybit funding transaction log",
            deadline=deadline,
            max_pages=5,
            max_items=250,
            accountType="UNIFIED",
            category="linear",
            type="SETTLEMENT",
            startTime=now - (now % 86_400_000),
            endTime=now,
            limit=50,
        )
        funding_pnl = sum(
            (Decimal(signed_decimal_string(item.get("funding") or "0", "funding")) for item in funding),
            Decimal("0"),
        )
        return {
            "equity": decimal_string(values[0].get("totalEquity"), "totalEquity", positive=True),
            "availableBalance": decimal_string(values[0].get("totalAvailableBalance"), "totalAvailableBalance"),
            "unrealizedPnl": signed_decimal_string(values[0].get("totalPerpUPL", "0"), "totalPerpUPL"),
            "marginUsed": decimal_string(values[0].get("totalInitialMargin", "0"), "totalInitialMargin"),
            "fundingPnlToday": signed_decimal_string(str(funding_pnl), "fundingPnlToday"),
        }

    def market_snapshot(
        self,
        account: dict[str, str],
        symbol: str,
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        client = self._client(account) if deadline is None else self._client(account, deadline)
        if deadline:
            deadline.ensure(250)
        instruments = response_list(client.get_instruments_info(category="linear", symbol=symbol), "Bybit instrument info")
        tickers = response_list(client.get_tickers(category="linear", symbol=symbol), "Bybit ticker")
        if len(instruments) != 1 or len(tickers) != 1:
            raise ExchangeContractError(f"Bybit symbol {symbol} is unavailable or ambiguous.")
        instrument = instruments[0]
        lot = instrument.get("lotSizeFilter", {})
        price = instrument.get("priceFilter", {})
        leverage = instrument.get("leverageFilter", {})
        return {
            "symbol": symbol,
            "markPrice": decimal_string(tickers[0].get("markPrice"), "markPrice", positive=True),
            "priceTick": decimal_string(price.get("tickSize"), "tickSize", positive=True),
            "quantityStep": decimal_string(lot.get("qtyStep"), "qtyStep", positive=True),
            "minimumQuantity": decimal_string(lot.get("minOrderQty"), "minOrderQty", positive=True),
            "minimumNotional": decimal_string(lot.get("minNotionalValue"), "minNotionalValue", positive=True),
            "maxLeverage": int(leverage.get("maxLeverage")),
            "observedAt": int(time.time() * 1000),
        }

    def submit_order(
        self,
        account: dict[str, str],
        request: dict[str, Any],
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        client = self._client(account) if deadline is None else self._client(account, deadline)
        symbol = request["symbol"]
        if request["role"] == "entry":
            if deadline:
                deadline.ensure(500)
            leverage = str(request["leverage"])
            response = client.set_leverage(
                category="linear", symbol=symbol, buyLeverage=leverage, sellLeverage=leverage
            )
            if response.get("retCode") not in {0, 110043}:
                raise ExchangeContractError(f"Bybit leverage update failed: {response.get('retMsg')}")
        arguments: dict[str, Any] = {
            "category": "linear",
            "symbol": symbol,
            "side": "Buy" if request["side"] == "buy" else "Sell",
            "orderType": "Market" if request["orderType"] in {"market", "stop_market"} else "Limit",
            "qty": decimal_string(request["quantity"], "quantity", positive=True),
            "orderLinkId": request["clientOrderId"],
            "reduceOnly": bool(request["reduceOnly"]),
            "positionIdx": 0,
        }
        if request.get("price") is not None:
            arguments["price"] = decimal_string(request["price"], "price", positive=True)
            arguments["timeInForce"] = "PostOnly" if request.get("postOnly") else "GTC"
        if request["orderType"] == "stop_market":
            arguments["triggerPrice"] = decimal_string(request["triggerPrice"], "triggerPrice", positive=True)
            arguments["triggerDirection"] = 2 if request["side"] == "sell" else 1
            arguments["triggerBy"] = "MarkPrice"
            arguments["closeOnTrigger"] = True
        if request["role"] == "entry" and request["orderType"] == "market":
            tolerance = Decimal(decimal_string(request.get("maxSlippagePercent"), "maxSlippagePercent", positive=True))
            if tolerance < Decimal("0.01") or tolerance > Decimal("10"):
                raise ExchangeContractError("maxSlippagePercent is outside Bybit's supported range.")
            arguments["slippageToleranceType"] = "Percent"
            arguments["slippageTolerance"] = decimal_string(str(tolerance), "maxSlippagePercent", positive=True)
        attached_stop = request.get("providerProtectiveStop")
        if request["role"] == "entry" and attached_stop is not None:
            self._validate_protective_stop(request, attached_stop)
            arguments["stopLoss"] = decimal_string(
                attached_stop["triggerPrice"], "protectiveStop.triggerPrice", positive=True
            )
            arguments["tpslMode"] = "Partial"
            arguments["slOrderType"] = "Market"
            arguments["slTriggerBy"] = "MarkPrice"
        if deadline:
            deadline.ensure(500)
            client = self._client(account, deadline)
        response = client.place_order(**arguments)
        if response.get("retCode") != 0:
            return self._result(request, "", "rejected", "0", None, response.get("retMsg"), response)
        order_id = str(response.get("result", {}).get("orderId", ""))
        return self._confirm_order(client, request, order_id, response, deadline)

    def submit_protected_entry(
        self,
        account: dict[str, str],
        entry: dict[str, Any],
        protective_stop: dict[str, Any],
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        protected_entry = {**entry, "providerProtectiveStop": protective_stop}
        entry_result = self.submit_order(account, protected_entry, deadline)
        if entry_result["status"] in {"open", "partially_filled", "filled"}:
            stop_status = "open"
            stop_error = None
        elif entry_result["status"] in {"cancelled", "rejected"}:
            stop_status = "cancelled"
            stop_error = "Entry did not become active."
        else:
            stop_status = "unknown"
            stop_error = "Attached stop acknowledgement is unknown with the entry outcome."
        stop_result = self._result(
            protective_stop,
            f"attached:{entry_result.get('exchangeOrderId', '')}",
            stop_status,
            "0",
            None,
            stop_error,
            {"providerManaged": True, "entryOrderId": entry_result.get("exchangeOrderId", "")},
        )
        return {"entry": entry_result, "protectiveStop": stop_result}

    @staticmethod
    def _validate_protective_stop(entry: dict[str, Any], stop: dict[str, Any]) -> None:
        if entry.get("role") != "entry" or stop.get("role") != "stop_loss":
            raise ExchangeContractError("Protected entry requires entry and stop_loss roles.")
        if not bool(stop.get("reduceOnly")) or stop.get("orderType") != "stop_market":
            raise ExchangeContractError("Protective stop must be a reduce-only stop-market order.")
        if stop.get("symbol") != entry.get("symbol") or stop.get("accountId") != entry.get("accountId"):
            raise ExchangeContractError("Protective stop must match the entry account and symbol.")
        if stop.get("side") == entry.get("side"):
            raise ExchangeContractError("Protective stop side must oppose the entry side.")
        if decimal_string(stop.get("quantity"), "protectiveStop.quantity", positive=True) != decimal_string(
            entry.get("quantity"), "entry.quantity", positive=True
        ):
            raise ExchangeContractError("Protective stop quantity must match the entry quantity.")

    def _confirm_order(
        self,
        client: HTTP,
        request: dict[str, Any],
        order_id: str,
        raw: Any,
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        for attempt in range(3):
            if attempt:
                if deadline:
                    deadline.ensure(250)
                time.sleep(0.2)
            for method in (client.get_open_orders, client.get_order_history):
                if deadline:
                    deadline.ensure(250)
                values = response_list(
                    method(category="linear", symbol=request["symbol"], orderLinkId=request["clientOrderId"], limit=1),
                    "Bybit order confirmation",
                )
                if values:
                    order = values[0]
                    return self._result(
                        request,
                        str(order.get("orderId") or order_id),
                        map_bybit_status(str(order.get("orderStatus", ""))),
                        decimal_string(order.get("cumExecQty", "0"), "cumExecQty"),
                        decimal_string(order["avgPrice"], "avgPrice", positive=True) if order.get("avgPrice") else None,
                        str(order.get("rejectReason")) if order.get("rejectReason") not in {None, "EC_NoError"} else None,
                        order,
                    )
        return self._result(request, order_id, "unknown", "0", None, "Bybit acknowledgement was not confirmed.", raw)

    def cancel_order(
        self,
        account: dict[str, str],
        client_order_id: str,
        symbol: str,
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        client = self._client(account) if deadline is None else self._client(account, deadline)
        if deadline:
            deadline.ensure(500)
        response = client.cancel_order(category="linear", symbol=symbol, orderLinkId=client_order_id)
        if response.get("retCode") != 0:
            return {
                "clientOrderId": client_order_id,
                "exchangeOrderId": "",
                "status": "rejected",
                "filledQuantity": "0",
                "averagePrice": None,
                "error": response.get("retMsg"),
                "raw": response,
            }
        request = {"symbol": symbol, "clientOrderId": client_order_id}
        return self._confirm_order(
            client, request, str(response.get("result", {}).get("orderId", "")), response, deadline
        )

    def open_state(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> dict[str, Any]:
        client = self._client(account) if deadline is None else self._client(account, deadline)
        identity = self._external_account_id(account, client, deadline)
        window_start = int(time.time() * 1000) - 24 * 60 * 60 * 1000
        open_orders = self._all_pages(
            client.get_open_orders, "Bybit open orders", deadline=deadline,
            category="linear", settleCoin="USDT", limit=50,
        )
        history = self._all_pages(
            client.get_order_history, "Bybit order history", deadline=deadline,
            category="linear", settleCoin="USDT", startTime=window_start, limit=50,
        )
        orders_by_id = {
            str(order.get("orderLinkId") or f"orderId:{order.get('orderId')}"): order
            for order in [*history, *open_orders]
            if order.get("orderLinkId") or order.get("orderId")
        }
        executions = self._all_pages(
            client.get_executions, "Bybit executions", deadline=deadline,
            category="linear", startTime=window_start, limit=100,
        )
        positions = self._all_pages(
            client.get_positions, "Bybit positions", deadline=deadline,
            category="linear", settleCoin="USDT", limit=200,
        )
        return {
            "orders": [self._order_snapshot(order) for order in orders_by_id.values()],
            "positions": [self._position(position) for position in positions if DecimalValue(position.get("size")) > 0],
            "fills": [self._fill(execution) for execution in executions if execution.get("orderLinkId")],
            "observedAt": int(time.time() * 1000),
            "accountFingerprint": identity,
        }

    @staticmethod
    def _all_pages(
        method: Any,
        label: str,
        *,
        deadline: RequestDeadline | None = None,
        max_pages: int = 5,
        max_items: int = 1_000,
        **arguments: Any,
    ) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        cursor: str | None = None
        seen: set[str] = set()
        for _ in range(max_pages):
            if deadline:
                deadline.ensure(250)
            response = method(**arguments, **({"cursor": cursor} if cursor else {}))
            values.extend(response_list(response, label))
            if len(values) > max_items:
                raise ExchangeContractError(f"{label} exceeded the bounded item limit.")
            result = response.get("result", {})
            next_cursor = result.get("nextPageCursor") if isinstance(result, dict) else None
            if not next_cursor:
                return values
            cursor = str(next_cursor)
            if cursor in seen:
                raise ExchangeContractError(f"{label} returned a repeated pagination cursor.")
            seen.add(cursor)
        raise ExchangeContractError(f"{label} exceeded the bounded pagination limit.")

    @staticmethod
    def _result(request: dict[str, Any], order_id: str, status: str, filled: str, average: str | None, error: str | None, raw: Any) -> dict[str, Any]:
        return {
            "clientOrderId": request["clientOrderId"],
            "exchangeOrderId": order_id,
            "status": status,
            "filledQuantity": filled,
            "averagePrice": average,
            "error": error,
            "raw": raw,
        }

    def _order_snapshot(self, order: dict[str, Any]) -> dict[str, Any]:
        side = "buy" if order.get("side") == "Buy" else "sell"
        return {
            **self._result(
                {"clientOrderId": str(order.get("orderLinkId") or f"orderId:{order.get('orderId')}")},
                str(order.get("orderId", "")),
                map_bybit_status(str(order.get("orderStatus", ""))),
                decimal_string(order.get("cumExecQty", "0"), "cumExecQty"),
                optional_positive_decimal_string(order.get("avgPrice"), "avgPrice"),
                None,
                order,
            ),
            "symbol": str(order.get("symbol")),
            "role": "entry",
            "side": side,
            "quantity": decimal_string(order.get("qty"), "qty", positive=True),
            "price": optional_positive_decimal_string(order.get("price"), "price"),
            "triggerPrice": optional_positive_decimal_string(order.get("triggerPrice"), "triggerPrice"),
            "reduceOnly": bool(order.get("reduceOnly")),
        }

    @staticmethod
    def _position(position: dict[str, Any]) -> dict[str, str]:
        return {
            "symbol": str(position.get("symbol")),
            "side": "LONG" if position.get("side") == "Buy" else "SHORT",
            "quantity": decimal_string(position.get("size"), "position size", positive=True),
            "averageEntryPrice": decimal_string(position.get("avgPrice"), "average entry price", positive=True),
            "unrealizedPnl": str(position.get("unrealisedPnl", "0")),
        }

    @staticmethod
    def _fill(execution: dict[str, Any]) -> dict[str, Any]:
        return {
            "exchangeFillId": str(execution.get("execId")),
            "clientOrderId": str(execution.get("orderLinkId")),
            "price": decimal_string(execution.get("execPrice"), "execution price", positive=True),
            "quantity": decimal_string(execution.get("execQty"), "execution quantity", positive=True),
            "fee": decimal_string(str(execution.get("execFee", "0")).lstrip("-"), "execution fee"),
            "feeAsset": "USDT",
            "filledAt": int(execution.get("execTime")),
            "raw": execution,
        }


def DecimalValue(value: Any):
    from decimal import Decimal
    return Decimal(str(value or "0"))
