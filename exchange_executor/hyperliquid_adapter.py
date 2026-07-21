from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants
from hyperliquid.utils.types import Cloid

from common import ExchangeContractError, decimal_string, signed_decimal_string
from credentials import CredentialStore


class HyperliquidAdapter:
    def __init__(self, credentials: CredentialStore) -> None:
        self.credentials = credentials

    def _clients(self, account: dict[str, str]) -> tuple[Info, Exchange, str]:
        secret = self.credentials.account(account["id"], "hyperliquid")
        base_url = constants.TESTNET_API_URL if account["mode"] == "testnet" else constants.MAINNET_API_URL
        wallet = Account.from_key(secret["privateKey"])
        info = Info(base_url, skip_ws=True)
        exchange = Exchange(wallet, base_url, account_address=secret["walletAddress"])
        return info, exchange, secret["walletAddress"]

    @staticmethod
    def _coin(symbol: str) -> str:
        for suffix in ("USDT", "USDC", "USD"):
            if symbol.endswith(suffix) and len(symbol) > len(suffix):
                return symbol[: -len(suffix)]
        return symbol

    def verify(self, account: dict[str, str]) -> dict[str, Any]:
        snapshot = self.account_snapshot(account)
        return {"verified": True, "equity": snapshot["equity"]}

    def account_snapshot(self, account: dict[str, str]) -> dict[str, str]:
        info, _, address = self._clients(account)
        state = info.user_state(address)
        summary = state.get("marginSummary", {})
        unrealized_pnl = sum(
            (Decimal(str(item.get("position", {}).get("unrealizedPnl", "0"))) for item in state.get("assetPositions", [])),
            Decimal("0"),
        )
        return {
            "equity": decimal_string(summary.get("accountValue"), "accountValue", positive=True),
            "availableBalance": decimal_string(state.get("withdrawable", "0"), "withdrawable"),
            "unrealizedPnl": signed_decimal_string(str(unrealized_pnl), "unrealizedPnl"),
            "marginUsed": decimal_string(summary.get("totalMarginUsed", "0"), "totalMarginUsed"),
        }

    def market_snapshot(self, account: dict[str, str], symbol: str) -> dict[str, Any]:
        info, _, _ = self._clients(account)
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

    def submit_order(self, account: dict[str, str], request: dict[str, Any]) -> dict[str, Any]:
        info, exchange, _ = self._clients(account)
        coin = self._coin(request["symbol"])
        is_buy = request["side"] == "buy"
        cloid = Cloid.from_str(request["clientOrderId"])
        if request["role"] == "entry":
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
            mark = Decimal(str(info.all_mids()[coin]))
            price = float(mark * (Decimal("1.01") if is_buy else Decimal("0.99")))
            order_type = {"limit": {"tif": "Ioc"}}
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

    def cancel_order(self, account: dict[str, str], client_order_id: str, symbol: str) -> dict[str, Any]:
        _, exchange, _ = self._clients(account)
        response = exchange.cancel_by_cloid(self._coin(symbol), Cloid.from_str(client_order_id))
        result = self._order_result(client_order_id, response)
        if response.get("status") == "ok" and result["status"] == "unknown":
            result["status"] = "cancelled"
        return result

    def open_state(self, account: dict[str, str]) -> dict[str, Any]:
        info, _, address = self._clients(account)
        open_orders = info.open_orders(address)
        history = info.historical_orders(address)
        order_records = [
            {**record.get("order", {}), "status": record.get("status", "unknown")}
            for record in history
            if isinstance(record, dict) and isinstance(record.get("order"), dict)
        ]
        orders_by_cloid = {
            str(order.get("cloid") or f"oid:{order.get('oid')}"): order
            for order in [*order_records, *open_orders]
            if isinstance(order, dict) and (order.get("cloid") or order.get("oid") is not None)
        }
        oid_to_cloid = {str(order.get("oid")): cloid for cloid, order in orders_by_cloid.items()}
        fills = info.user_fills(address)
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
        }

    def _order_snapshot(self, order: dict[str, Any]) -> dict[str, Any]:
        status_text = str(order.get("status", "open")).lower()
        status = "filled" if "fill" in status_text else "cancelled" if "cancel" in status_text else "open"
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
            "price": decimal_string(order["limitPx"], "limitPx", positive=True) if order.get("limitPx") else None,
            "triggerPrice": decimal_string(order["triggerPx"], "triggerPx", positive=True) if order.get("triggerPx") else None,
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
