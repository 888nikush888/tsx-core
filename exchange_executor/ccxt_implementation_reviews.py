"""Trusted receipt pins, added only after actual independent gates and review.

Never populated by receipts, imports or probes. Keys bind exchange/profile version;
values are exact receipt byte hashes. This authority file is outside its own tree
commitment. An empty map grants no V2 approval; account/history data are untouched.
"""
from types import MappingProxyType

APPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({
    ('hyperliquid', 1): ('cf9aea59a20dc02820b3b2a47b16d0540e4d63403d614c11ee98d7ecee6630f0',),
})
