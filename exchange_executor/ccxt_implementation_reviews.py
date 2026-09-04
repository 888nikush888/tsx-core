"""Trusted receipt pins, added only after actual independent gates and review.

Never populated by receipts, imports or probes. Keys bind exchange/profile version;
values are exact receipt byte hashes. This authority file is outside its own tree
commitment. An empty map grants no V2 approval; account/history data are untouched.
"""
from types import MappingProxyType

APPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({
    ('hyperliquid', 1): ('c471b2aa02ba26779d2d39813ab4b77c2d6d885474ede6e8dae239c252580223',),
})
