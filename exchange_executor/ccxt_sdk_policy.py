"""Narrow, pinned SDK overrides: account setup is never an incidental read/order effect."""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

from common import ExchangeContractError
from entry_deadline import assert_entry_transport_deadline
from kraken_response_capture import KrakenResponseCapture


class EntryTransportDeadline:
    async def fetch(self, *args, **kwargs):
        assert_entry_transport_deadline()
        return await super().fetch(*args, **kwargs)


class HyperliquidNoAutomaticSetup:
    """Keep CCXT initialize_client and its read-only abstraction discovery intact.

    CCXT 4.5.75 otherwise sends approveBuilderFee even with builderFee=False,
    then setReferrer. Neither action belongs to an authorized trading operation.
    Returning False records no approval and leaves builder attachment disabled.
    """

    @staticmethod
    async def handle_builder_fee_approval() -> bool:
        return False

    @staticmethod
    async def set_ref() -> bool:
        return False


class HyperliquidAgentTestnetTransport:
    """Refuse any post-construction REST or WebSocket route drift for agents."""

    @staticmethod
    def _agent_exchange_action(body: Any) -> None:
        def invalid_constant(_value: str) -> None:
            raise ValueError("constant")

        def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            value: dict[str, Any] = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate")
                value[key] = item
            return value

        try:
            if not isinstance(body, str) or len(body.encode("utf-8")) > 64 * 1024:
                raise ValueError("body")
            envelope = json.loads(body, object_pairs_hook=unique, parse_constant=invalid_constant)
            if not isinstance(envelope, dict) or set(envelope) != {"action", "nonce", "signature"}:
                raise ValueError("envelope")
            action = envelope["action"]
            if not isinstance(action, dict) or "builder" in action:
                raise ValueError("action")
            kind = action.get("type")
            if kind == "order":
                orders = action.get("orders")
                if not isinstance(orders, list) or not all(isinstance(order, dict) for order in orders):
                    raise ValueError("orders")
                assets = [order.get("a") for order in orders]
            elif kind in {"cancel", "cancelByCloid"}:
                cancels = action.get("cancels")
                if not isinstance(cancels, list) or not all(isinstance(item, dict) for item in cancels):
                    raise ValueError("cancels")
                assets = [item.get("a" if kind == "cancel" else "asset") for item in cancels]
            elif kind == "updateLeverage" and action.get("isCross") is True:
                assets = [action.get("asset")]
            else:
                raise ValueError("unsupported action")
            if not assets or len(assets) > 3 or any(type(asset) is not int or not 0 <= asset < 10_000 for asset in assets):
                raise ValueError("asset scope")
        except (TypeError, ValueError, UnicodeError):
            raise ExchangeContractError("Hyperliquid agent SDK action is outside reviewed trading scope.") from None

    def _agent_transport(self, url: Any, websocket: bool, method: Any = None, body: Any = None) -> None:
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            api = self.urls.get("api") if isinstance(self.urls, dict) else None
            valid = (parsed is not None and isinstance(api, dict)
                     and parsed.scheme == ("wss" if websocket else "https")
                     and parsed.netloc == "api.hyperliquid-testnet.xyz"
                     and parsed.path in (("/ws",) if websocket else ("/info", "/exchange"))
                     and not parsed.query and not parsed.fragment
                     and api.get("public") == "https://api.hyperliquid-testnet.xyz"
                     and api.get("private") == "https://api.hyperliquid-testnet.xyz"
                     and getattr(self, "aiohttp_trust_env", None) is False
                     and not any(getattr(self, name, None) for name in (
                         "httpProxy", "httpsProxy", "socksProxy", "aiohttp_proxy", "proxy", "proxyUrl",
                     )))
            if websocket:
                valid = valid and api.get("ws") == {"public": "wss://api.hyperliquid-testnet.xyz/ws"}
            else:
                valid = valid and method == "POST"
            if not valid:
                raise ExchangeContractError("Hyperliquid agent SDK route is outside reviewed Testnet scope.")
            if not websocket and parsed is not None and parsed.path == "/exchange":
                if getattr(self, "_tsx_agent_order_authority", False) is not True:
                    raise ExchangeContractError("Hyperliquid agent order authority is REST-only.")
                self._agent_exchange_action(body)
        except ExchangeContractError:
            raise
        except (TypeError, ValueError):
            raise ExchangeContractError("Hyperliquid agent SDK route is outside reviewed Testnet scope.") from None

    async def fetch(self, url: Any, method: Any = "GET", headers: Any = None, body: Any = None) -> Any:
        self._agent_transport(url, False, method, body)
        return await super().fetch(url, method, headers, body)

    async def watch(self, url: Any, *args: Any, **kwargs: Any) -> Any:
        self._agent_transport(url, True)
        return await super().watch(url, *args, **kwargs)


def client_class(exchange: str, sdk_class: type[Any], *, agent_testnet: bool = False) -> type[Any]:
    # Apply to both REST and Pro before construction/load_markets, not only at submit.
    bases: tuple[type[Any], ...] = (EntryTransportDeadline, HyperliquidNoAutomaticSetup, sdk_class) if exchange == 'hyperliquid' else (EntryTransportDeadline, sdk_class)
    if agent_testnet:
        if exchange != "hyperliquid":
            raise ExchangeContractError("Agent Testnet transport is Hyperliquid-only.")
        bases = (HyperliquidAgentTestnetTransport, *bases)
    if exchange == 'krakenfutures':
        bases = (EntryTransportDeadline, KrakenResponseCapture, sdk_class)
    return type(f'Tsx{sdk_class.__name__}', bases, {})
