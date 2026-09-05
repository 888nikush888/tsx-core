"""Trusted receipt pins, added only after actual independent gates and review.

Never populated by receipts, imports or probes. Keys bind exchange/profile version;
values are exact receipt byte hashes. This authority file is outside its own tree
commitment. An empty map grants no V2 approval; account/history data are untouched.
"""
from types import MappingProxyType

APPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({
    ('hyperliquid', 1): ('26768863226c70a2e7704e1516eed396d7141c819fd95087c2218defc5d65de4',),
})
