from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants
from hyperliquid.utils.types import Cloid

from common import (
    ExchangeContractError,
    RequestDeadline,
    decimal_string,
    external_account_id,
    optional_positive_decimal_string,
    signed_decimal_string,
)
from credentials import CredentialStore


class HyperliquidAdapter:
    def __init__(self, credentials: CredentialStore) -> None:
        self.credentials = credentials

    def _clients(
        self,
        account: dict[str, str],
        deadline: RequestDeadline | None = None,
    ) -> tuple[Info, Exchange, str]:
        secret = self.credentials.account(account["id"], "hyperliquid")
        base_url = constants.TESTNET_API_URL if account["mode"] == "testnet" else constants.MAINNET_API_URL
        wallet = Account.from_key(secret["privateKey"])
        timeout = deadline.sdk_timeout_seconds() if deadline else 10
        info = Info(base_url, skip_ws=True, timeout=timeout)
        exchange = Exchange(wallet, base_url, account_address=secret["walletAddress"], timeout=timeout)
        if deadline:
            exchange.set_expires_after(deadline.deadline_at_ms)
        return info, exchange, secret["walletAddress"]

    @staticmethod
    def _coin(symbol: str) -> str:
        for suffix in ("USDT", "USDC", "USD"):
            if symbol.endswith(suffix) and len(symbol) > len(suffix):
                return symbol[: -len(suffix)]
        return symbol

    @staticmethod
    def _identity(account: dict[str, str], address: str) -> str:
        return external_account_id("hyperliquid", account["mode"], address.lower())

    def verify(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> dict[str, Any]:
        snapshot = self.account_snapshot(account, deadline)
        _, _, address = self._clients(account) if deadline is None else self._clients(account, deadline)
        identity = self._identity(account, address)
        return {
            "verified": True,
            "equity": snapshot["equity"],
            "externalAccountId": identity,
            "accountFingerprint": identity,
        }

    def account_snapshot(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> dict[str, str]:
        info, _, address = self._clients(account) if deadline is None else self._clients(account, deadline)
        if deadline:
            deadline.ensure(250)
        state = info.user_state(address)
        summary = state.get("marginSummary", {})
        unrealized_pnl = sum(
            (Decimal(str(item.get("position", {}).get("unrealizedPnl", "0"))) for item in state.get("assetPositions", [])),
            Decimal("0"),
        )
        now = int(time.time() * 1000)
        funding_rows = self._funding_history(
            info, address, now - (now % 86_400_000), now, deadline
        )
        funding_pnl = sum(
            (
                Decimal(signed_decimal_string(row.get("delta", {}).get("usdc", "0"), "funding usdc"))
                for row in funding_rows
            ),
            Decimal("0"),
        )
        return {
            "equity": decimal_string(summary.get("accountValue"), "accountValue", positive=True),
            "availableBalance": decimal_string(state.get("withdrawable", "0"), "withdrawable"),
            "unrealizedPnl": signed_decimal_string(str(unrealized_pnl), "unrealizedPnl"),
            "marginUsed": decimal_string(summary.get("totalMarginUsed", "0"), "totalMarginUsed"),
            "fundingPnlToday": signed_decimal_string(str(funding_pnl), "fundingPnlToday"),
        }

    @staticmethod
    def _funding_history(
        info: Any,
        address: str,
        start_time: int,
        end_time: int,
        deadline: RequestDeadline | None = None,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        cursor = start_time
        for _ in range(5):
            if deadline:
                deadline.ensure(250)
            page = info.user_funding_history(address, cursor, end_time)
            if not isinstance(page, list) or any(not isinstance(row, dict) for row in page):
                raise ExchangeContractError("Hyperliquid funding history returned an invalid contract.")
            rows.extend(page)
            if len(rows) > 2_500:
                raise ExchangeContractError("Hyperliquid funding history exceeded the bounded item limit.")
            if len(page) < 500:
                return rows
            last_time = page[-1].get("time")
            if not isinstance(last_time, int) or last_time < cursor:
                raise ExchangeContractError("Hyperliquid funding history pagination did not advance.")
            cursor = last_time + 1
            if cursor > end_time:
                return rows
        raise ExchangeContractError("Hyperliquid funding history exceeded the bounded pagination limit.")

    def market_snapshot(
        self,
        account: dict[str, str],
        symbol: str,
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        info, _, _ = self._clients(account) if deadline is None else self._clients(account, deadline)
        if deadline:
            deadline.ensure(250)
        coin = self._coin(symbol)
        metadata, contexts = info.meta_and_asset_ctxs()
        universe = metadata.get("universe", [])
        index = next((position for position, asset in enumerate(universe) if asset.get("name") == coin), None)
        if index is None or index >= len(contexts):
            raise ExchangeContractError(f"Hyperliquid symbol {coin} is unavailable.")
        asset = universe[index]
        mark = Decimal(decimal_string(contexts[index].get("markPx"), "markPx", positive=True))
        tick_exponent = max(-6, mark.adjusted() - 4)
        price_tick = Decimal(1).scaleb(tick_exponent)
        quantity_step = Decimal(1).scaleb(-int(asset.get("szDecimals", 0)))
        return {
            "symbol": symbol,
            "markPrice": decimal_string(str(mark), "markPrice", positive=True),
            "priceTick": decimal_string(str(price_tick), "priceTick", positive=True),
            "quantityStep": decimal_string(str(quantity_step), "quantityStep", positive=True),
            "minimumQuantity": decimal_string(str(quantity_step), "minimumQuantity", positive=True),
            "minimumNotional": "10",
            "maxLeverage": int(asset.get("maxLeverage", 1)),
            "observedAt": int(time.time() * 1000),
        }

    def submit_order(
        self,
        account: dict[str, str],
        request: dict[str, Any],
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        info, exchange, _ = self._clients(account) if deadline is None else self._clients(account, deadline)
        coin = self._coin(request["symbol"])
        is_buy = request["side"] == "buy"
        cloid = Cloid.from_str(request["clientOrderId"])
        if request["role"] == "entry":
            if deadline:
                deadline.ensure(500)
            leverage_response = exchange.update_leverage(int(request["leverage"]), coin, is_cross=True)
            if leverage_response.get("status") != "ok":
                raise ExchangeContractError("Hyperliquid leverage update failed.")
        quantity = float(decimal_string(request["quantity"], "quantity", positive=True))
        if request["orderType"] == "limit":
            price = float(decimal_string(request["price"], "price", positive=True))
            order_type = {"limit": {"tif": "Alo" if request.get("postOnly") else "Gtc"}}
        elif request["orderType"] == "stop_market":
            price = float(decimal_string(request["triggerPrice"], "triggerPrice", positive=True))
            order_type = {"trigger": {"triggerPx": price, "isMarket": True, "tpsl": "sl"}}
        else:
            if deadline:
                deadline.ensure(500)
            mark = Decimal(str(info.all_mids()[coin]))
            slippage = Decimal("1")
            if request["role"] == "entry":
                slippage = Decimal(decimal_string(
                    request.get("maxSlippagePercent"), "maxSlippagePercent", positive=True
                ))
            if slippage > Decimal("10"):
                raise ExchangeContractError("maxSlippagePercent exceeds the provider-side safety cap.")
            multiplier = slippage / Decimal("100")
            price = float(mark * (Decimal("1") + multiplier if is_buy else Decimal("1") - multiplier))
            order_type = {"limit": {"tif": "Ioc"}}
        if deadline:
            deadline.ensure(500)
            _, exchange, _ = self._clients(account, deadline)
        response = exchange.order(
            coin,
            is_buy,
            quantity,
            price,
            order_type,
            reduce_only=bool(request["reduceOnly"]),
            cloid=cloid,
        )
        return self._order_result(request["clientOrderId"], response)

    def submit_protected_entry(
        self,
        account: dict[str, str],
        entry: dict[str, Any],
        protective_stop: dict[str, Any],
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        self._validate_protective_stop(entry, protective_stop)
        info, exchange, _ = self._clients(account, deadline)
        coin = self._coin(entry["symbol"])
        is_buy = entry["side"] == "buy"
        if deadline:
            deadline.ensure(500)
        leverage_response = exchange.update_leverage(int(entry["leverage"]), coin, is_cross=True)
        if leverage_response.get("status") != "ok":
            raise ExchangeContractError("Hyperliquid leverage update failed.")

        entry_quantity = float(decimal_string(entry["quantity"], "entry.quantity", positive=True))
        if entry["orderType"] == "limit":
            entry_price = float(decimal_string(entry["price"], "entry.price", positive=True))
            entry_type = {"limit": {"tif": "Alo" if entry.get("postOnly") else "Gtc"}}
        else:
            if deadline:
                deadline.ensure(500)
            mark = Decimal(str(info.all_mids()[coin]))
            slippage = Decimal(decimal_string(
                entry.get("maxSlippagePercent"), "maxSlippagePercent", positive=True
            ))
            if slippage > Decimal("10"):
                raise ExchangeContractError("maxSlippagePercent exceeds the provider-side safety cap.")
            multiplier = slippage / Decimal("100")
            entry_price = float(mark * (Decimal("1") + multiplier if is_buy else Decimal("1") - multiplier))
            entry_type = {"limit": {"tif": "Ioc"}}

        stop_price = float(decimal_string(
            protective_stop["triggerPrice"], "protectiveStop.triggerPrice", positive=True
        ))
        orders = [
            {
                "coin": coin,
                "is_buy": is_buy,
                "sz": entry_quantity,
                "limit_px": entry_price,
                "order_type": entry_type,
                "reduce_only": False,
                "cloid": Cloid.from_str(entry["clientOrderId"]),
            },
            {
                "coin": coin,
                "is_buy": not is_buy,
                "sz": entry_quantity,
                "limit_px": stop_price,
                "order_type": {"trigger": {"triggerPx": stop_price, "isMarket": True, "tpsl": "sl"}},
                "reduce_only": True,
                "cloid": Cloid.from_str(protective_stop["clientOrderId"]),
            },
        ]
        if deadline:
            deadline.ensure(500)
        response = exchange.bulk_orders(orders, grouping="normalTpsl")
        statuses = response.get("response", {}).get("data", {}).get("statuses", []) \
            if isinstance(response, dict) else []
        if not isinstance(statuses, list) or len(statuses) != 2:
            return {
                "entry": self._unknown_result(entry["clientOrderId"], response),
                "protectiveStop": self._unknown_result(protective_stop["clientOrderId"], response),
            }
        entry_response = {"status": response.get("status"), "response": {"data": {"statuses": [statuses[0]]}}}
        stop_response = {"status": response.get("status"), "response": {"data": {"statuses": [statuses[1]]}}}
        return {
            "entry": self._order_result(entry["clientOrderId"], entry_response),
            "protectiveStop": self._order_result(protective_stop["clientOrderId"], stop_response),
        }

    @staticmethod
    def _unknown_result(client_order_id: str, raw: Any) -> dict[str, Any]:
        return {
            "clientOrderId": client_order_id,
            "exchangeOrderId": "",
            "status": "unknown",
            "filledQuantity": "0",
            "averagePrice": None,
            "error": "Hyperliquid protected-entry acknowledgement was ambiguous.",
            "raw": raw,
        }

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

    @staticmethod
    def _order_result(client_order_id: str, response: Any) -> dict[str, Any]:
        result = {
            "clientOrderId": client_order_id,
            "exchangeOrderId": "",
            "status": "unknown",
            "filledQuantity": "0",
            "averagePrice": None,
            "error": None,
            "raw": response,
        }
        if not isinstance(response, dict) or response.get("status") != "ok":
            result.update(status="rejected", error=str(response.get("response") if isinstance(response, dict) else response))
            return result
        statuses = response.get("response", {}).get("data", {}).get("statuses", [])
        if len(statuses) != 1 or not isinstance(statuses[0], dict):
            result.update(error="Hyperliquid order acknowledgement was ambiguous.")
            return result
        status = statuses[0]
        if "resting" in status:
            result.update(status="open", exchangeOrderId=str(status["resting"].get("oid", "")))
        elif "filled" in status:
            fill = status["filled"]
            result.update(
                status="filled",
                exchangeOrderId=str(fill.get("oid", "")),
                filledQuantity=decimal_string(fill.get("totalSz"), "totalSz"),
                averagePrice=decimal_string(fill.get("avgPx"), "avgPx", positive=True),
            )
        elif "error" in status:
            result.update(status="rejected", error=str(status["error"]))
        return result

    def cancel_order(
        self,
        account: dict[str, str],
        client_order_id: str,
        symbol: str,
        deadline: RequestDeadline | None = None,
    ) -> dict[str, Any]:
        _, exchange, _ = self._clients(account) if deadline is None else self._clients(account, deadline)
        if deadline:
            deadline.ensure(500)
        response = exchange.cancel_by_cloid(self._coin(symbol), Cloid.from_str(client_order_id))
        result = self._order_result(client_order_id, response)
        if response.get("status") == "ok" and result["status"] == "unknown":
            result["status"] = "cancelled"
        return result

    def open_state(self, account: dict[str, str], deadline: RequestDeadline | None = None) -> dict[str, Any]:
        info, _, address = self._clients(account) if deadline is None else self._clients(account, deadline)
        if deadline:
            deadline.ensure(250)
        open_orders = info.open_orders(address)
        if deadline:
            deadline.ensure(250)
        history = info.historical_orders(address)
        if not isinstance(history, list) or len(history) > 5_000:
            raise ExchangeContractError("Hyperliquid order history exceeded the bounded item limit.")
        orders_by_cloid = self._latest_orders(history, open_orders)
        oid_to_cloid = {str(order.get("oid")): cloid for cloid, order in orders_by_cloid.items()}
        if deadline:
            deadline.ensure(250)
        fills = info.user_fills(address)
        if not isinstance(fills, list) or len(fills) > 5_000:
            raise ExchangeContractError("Hyperliquid fills exceeded the bounded item limit.")
        if deadline:
            deadline.ensure(250)
        state = info.user_state(address)
        return {
            "orders": [self._order_snapshot(order) for order in orders_by_cloid.values()],
            "positions": [
                self._position(item.get("position", {}))
                for item in state.get("assetPositions", [])
                if Decimal(str(item.get("position", {}).get("szi", "0"))) != 0
            ],
            "fills": [self._fill(fill, oid_to_cloid) for fill in fills if str(fill.get("oid")) in oid_to_cloid],
            "observedAt": int(time.time() * 1000),
            "accountFingerprint": self._identity(account, address),
        }

    @classmethod
    def _latest_orders(cls, history: Any, open_orders: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(history, list) or not isinstance(open_orders, list):
            raise ExchangeContractError("Hyperliquid order history returned an invalid contract.")
        latest: dict[str, dict[str, Any]] = {}
        ranks: dict[str, tuple[int, int]] = {}
        for record in history:
            if not isinstance(record, dict) or not isinstance(record.get("order"), dict):
                raise ExchangeContractError("Hyperliquid order history returned an invalid record.")
            order = record["order"]
            key = cls._order_key(order)
            timestamp = record.get("statusTimestamp")
            if not isinstance(timestamp, int) or timestamp < 0:
                raise ExchangeContractError("Hyperliquid order history timestamp is invalid.")
            status = cls._map_order_status(record.get("status"))
            priority = {"open": 0, "unknown": 1, "cancelled": 2, "rejected": 3, "filled": 4}[status]
            rank = (timestamp, priority)
            if key not in ranks or rank > ranks[key]:
                latest[key] = {**order, "status": record.get("status", "unknown"), "statusTimestamp": timestamp}
                ranks[key] = rank
        for order in open_orders:
            if not isinstance(order, dict):
                raise ExchangeContractError("Hyperliquid open orders returned an invalid record.")
            latest[cls._order_key(order)] = {**order, "status": "open"}
        return latest

    @staticmethod
    def _order_key(order: dict[str, Any]) -> str:
        if order.get("cloid"):
            return str(order["cloid"])
        if order.get("oid") is not None:
            return f"oid:{order['oid']}"
        raise ExchangeContractError("Hyperliquid order has no identifier.")

    @staticmethod
    def _map_order_status(value: Any) -> str:
        status = str(value or "").strip().lower()
        if status == "open":
            return "open"
        if status == "filled":
            return "filled"
        if status == "canceled" or status.endswith("canceled") or status == "scheduledcancel":
            return "cancelled"
        if status == "rejected" or status.endswith("rejected"):
            return "rejected"
        return "unknown"

    def _order_snapshot(self, order: dict[str, Any]) -> dict[str, Any]:
        status = self._map_order_status(order.get("status"))
        side = "buy" if order.get("side") in {"B", "Buy"} else "sell"
        original = order.get("origSz", order.get("sz"))
        remaining = order.get("sz", "0")
        filled = Decimal(str(original or "0")) - Decimal(str(remaining or "0"))
        return {
            "clientOrderId": str(order.get("cloid") or f"oid:{order.get('oid')}"),
            "exchangeOrderId": str(order.get("oid", "")),
            "status": status,
            "filledQuantity": decimal_string(str(max(filled, Decimal(0))), "filled quantity"),
            "averagePrice": None,
            "error": None,
            "raw": order,
            "symbol": f"{order.get('coin')}USDT",
            "role": "entry",
            "side": side,
            "quantity": decimal_string(original, "order quantity", positive=True),
            "price": optional_positive_decimal_string(order.get("limitPx"), "limitPx"),
            "triggerPrice": optional_positive_decimal_string(order.get("triggerPx"), "triggerPx"),
            "reduceOnly": bool(order.get("reduceOnly")),
        }

    @staticmethod
    def _position(position: dict[str, Any]) -> dict[str, str]:
        size = Decimal(str(position.get("szi")))
        return {
            "symbol": f"{position.get('coin')}USDT",
            "side": "LONG" if size > 0 else "SHORT",
            "quantity": decimal_string(str(abs(size)), "position size", positive=True),
            "averageEntryPrice": decimal_string(position.get("entryPx"), "entryPx", positive=True),
            "unrealizedPnl": str(position.get("unrealizedPnl", "0")),
        }

    @staticmethod
    def _fill(fill: dict[str, Any], oid_to_cloid: dict[str, str]) -> dict[str, Any]:
        return {
            "exchangeFillId": str(fill.get("tid") or f"{fill.get('hash')}:{fill.get('oid')}:{fill.get('time')}"),
            "clientOrderId": oid_to_cloid[str(fill.get("oid"))],
            "price": decimal_string(fill.get("px"), "fill price", positive=True),
            "quantity": decimal_string(fill.get("sz"), "fill size", positive=True),
            "fee": decimal_string(str(fill.get("fee", "0")).lstrip("-"), "fill fee"),
            "feeAsset": str(fill.get("feeToken")) if fill.get("feeToken") else None,
            "filledAt": int(fill.get("time")),
            "raw": fill,
        }
