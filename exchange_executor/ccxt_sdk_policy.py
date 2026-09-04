"""Narrow, pinned SDK overrides: account setup is never an incidental read/order effect."""
from __future__ import annotations

from typing import Any

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

    async def handle_builder_fee_approval(self) -> bool:
        return False

    async def set_ref(self) -> bool:
        return False


def client_class(exchange: str, sdk_class: type[Any]) -> type[Any]:
    # Apply to both REST and Pro before construction/load_markets, not only at submit.
    bases = (EntryTransportDeadline, HyperliquidNoAutomaticSetup, sdk_class) if exchange == 'hyperliquid' else (EntryTransportDeadline, sdk_class)
    if exchange == 'krakenfutures':
        bases = (EntryTransportDeadline, KrakenResponseCapture, sdk_class)
    return type(f'Tsx{sdk_class.__name__}', bases, {})
