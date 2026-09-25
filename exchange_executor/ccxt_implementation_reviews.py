"""Trusted receipt pins, added only after actual independent gates and review.

Never populated by receipts, imports or probes. Keys bind exchange/profile version;
values are exact receipt byte hashes. This authority file is outside its own tree
commitment. An empty map grants no V2 approval; account/history data are untouched.
"""
from types import MappingProxyType

APPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({
    ('hyperliquid', 1): ('7a3e79b9b4cc3a41070eec30a2cdacf878e15c766a204b6b4d9e6e5f4fae3c4a',),
})
