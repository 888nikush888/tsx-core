"""Trusted receipt pins, added only after actual independent gates and review.

Never populated by receipts, imports or probes. Keys bind exchange/profile version;
values are exact receipt byte hashes. This authority file is outside its own tree
commitment. An empty map grants no V2 approval; account/history data are untouched.
"""
from types import MappingProxyType

APPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({
    ('hyperliquid', 1): ('90dd3f4ec6ad9774c11f8d47631a5d4cb07ef9ce7729555daf1cec8793be4ae9',),
})
