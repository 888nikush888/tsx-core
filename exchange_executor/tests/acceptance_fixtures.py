"""Closed, explicitly synthetic originals for the offline acceptance tool only."""
from __future__ import annotations

import hashlib
import json

SHA = "a" * 40
PROFILE_HASH = "b" * 64
HOSTS = {
    "hyperliquid": "https://api.hyperliquid-testnet.xyz",
    "bybit": "https://api-testnet.bybit.com",
    "krakenfutures": "https://demo-futures.kraken.com",
}


def plan(exchange="bybit"):
    return {
        "sourceSha": SHA, "profileHash": PROFILE_HASH, "ccxtVersion": "4.5.75",
        "exchange": exchange, "environment": "testnet", "host": HOSTS[exchange],
        "allowedTestnetOrigins": [HOSTS[exchange]], "accountReferenceHash": PROFILE_HASH,
        "limits": {"maxNotionalUsd": "5", "maxOrderCount": 2, "timeBudgetSeconds": 30},
    }


def request(client="own-1", *, side="buy", price="2"):
    return {
        "clientOrderId": client, "symbol": "COIN/USD:USD", "providerSymbol": "COINUSD",
        "side": side, "type": "limit", "quantity": "1", "price": price,
        "triggerPrice": None, "reduceOnly": side == "sell", "postOnly": False,
        "timeInForce": "IOC", "leverage": 1,
        "priceBoundary": {"minimum": "1", "maximum": "2"}, "source": "local-fake-v1",
        "valuation": {"contract": "local-fake-usd-v1", "priceCurrency": "USD", "quantityUnit": "base"},
    }


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def account_evidence(guard, now=100):
    return {
        "contract": "local-fake-account-v1", "bindingHash": guard.binding_hash,
        "observedAt": now, "source": "local-fake-v1",
        "original": {"accountReferenceHash": PROFILE_HASH, "origin": guard.plan["host"],
                     "positionMode": "oneway", "marginMode": "cross"},
    }


def order_evidence(guard, order_request, remote="remote-1", *, now=100, status="open", filled="0"):
    return {
        "contract": "local-fake-order-v1", "bindingHash": guard.binding_hash,
        "requestHash": digest(order_request), "observedAt": now, "source": "local-fake-v1",
        "original": {
            "accountReferenceHash": PROFILE_HASH, "clientOrderId": order_request["clientOrderId"],
            "orderId": remote, "providerSymbol": order_request["providerSymbol"],
            "status": status, "quantity": order_request["quantity"], "filledQuantity": filled,
            "remainingQuantity": str(1 - int(filled)),
            "fills": [] if filled == "0" else [{"fillId": "fill-" + remote, "quantity": filled}],
        },
    }


def position_evidence(guard, now=100):
    return {
        "contract": "local-fake-positions-v1", "bindingHash": guard.binding_hash,
        "observedAt": now, "source": "local-fake-v1",
        "original": {"accountReferenceHash": PROFILE_HASH,
                     "positions": [{"providerSymbol": "COINUSD", "quantity": "0"}]},
    }
