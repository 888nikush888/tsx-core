from __future__ import annotations

import copy
import io
import json
import socket
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import ccxt
import ccxt.async_support as ccxt_rest
import ccxt.pro as ccxt_pro
from ccxt.async_support.base.exchange import Exchange

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import tools.audit_derivatives_candidates as inventory_audit
from tools.audit_derivatives_candidates import (
    CompletionVerdict, InventoryError, build_inventory, capability_state, load_inventory, main,
    validate_complete, validate_inventory,
)


class AdditionalExchangeInventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory = build_inventory()

    def test_complete_pinned_id_coverage_and_reproducible_bytes(self):
        self.assertEqual(ccxt.__version__, '4.5.75')
        self.assertEqual(sys.version_info[:2], (3, 12))
        self.assertEqual(len(ccxt_rest.exchanges), 103)
        self.assertEqual(len(ccxt_pro.exchanges), 76)
        self.assertEqual(self.inventory, build_inventory())
        self.assertEqual(self.inventory['inventory']['restIds'], sorted(ccxt_rest.exchanges))
        self.assertEqual(self.inventory['inventory']['proIds'], sorted(ccxt_pro.exchanges))
        self.assertEqual([row['id'] for row in self.inventory['inventory']['exchanges']], sorted(ccxt_rest.exchanges))
        validate_inventory(self.inventory)

    def test_real_installed_discovery_does_not_open_network_secrets_or_markets(self):
        import builtins
        import os
        import subprocess
        original_open = builtins.open
        original_io_open = io.open
        package_root = Path(ccxt.__file__).resolve().parent
        package_metadata = package_root.parent / 'ccxt-4.5.75.dist-info/METADATA'
        reads = []

        def checked_open(delegate, name, *args, **kwargs):
            if isinstance(name, (str, bytes, Path)):
                pathname = Path(name).resolve()
                self.assertTrue(pathname.is_relative_to(package_root) or pathname == package_metadata
                                or pathname in {inventory_audit.ROOT / 'ccxt_profiles.py',
                                                inventory_audit.ROOT / 'ccxt_capabilities.py',
                                                inventory_audit.ROOT / 'ccxt_registry.py',
                                                inventory_audit.ROOT / 'tools/audit_derivatives_candidates.py'}, pathname)
                reads.append(pathname)
            return delegate(name, *args, **kwargs)

        with ExitStack() as stack:
            for target, name in [(socket.socket, 'connect'), (socket.socket, 'connect_ex'),
                                 (socket, 'getaddrinfo'), (socket, 'create_connection'),
                                 (subprocess, 'Popen'), (Exchange, 'fetch'), (Exchange, 'load_markets'),
                                 (Exchange, 'check_required_credentials')]:
                stack.enter_context(patch.object(target, name, side_effect=AssertionError(f'offline: {name}')))
            stack.enter_context(patch.object(os, 'getenv', side_effect=AssertionError('environment secret read')))
            stack.enter_context(patch.object(type(os.environ), '__getitem__', side_effect=AssertionError('direct environment secret read')))
            stack.enter_context(patch('builtins.open', side_effect=lambda *a, **k: checked_open(original_open, *a, **k)))
            stack.enter_context(patch('io.open', side_effect=lambda *a, **k: checked_open(original_io_open, *a, **k)))
            self.assertEqual(build_inventory(), self.inventory)
        self.assertTrue(reads)

    def test_wrong_runtime_or_package_pin_is_rejected_before_discovery(self):
        with patch.object(ccxt, '__version__', '4.5.74'), self.assertRaises(InventoryError):
            build_inventory()
        with patch('tools.audit_derivatives_candidates.version', return_value='4.5.76'), self.assertRaises(InventoryError):
            build_inventory()
        with patch.object(sys, 'version_info', (3, 11)), self.assertRaises(InventoryError):
            build_inventory()

    def test_inventory_itself_blocks_accidental_constructor_network(self):
        def unsafe_constructor(_configuration):
            socket.create_connection(('forbidden.invalid', 443))
        with patch.object(ccxt_rest, 'apex', unsafe_constructor), self.assertRaisesRegex(InventoryError, 'Offline'):
            build_inventory()

    def test_native_emulated_false_absent_are_not_collapsed(self):
        self.assertEqual(capability_state(True), 'native')
        self.assertEqual(capability_state('emulated'), 'emulated')
        self.assertEqual(capability_state(False), 'missing')
        self.assertEqual(capability_state(None), 'missing')
        for value in (1, 0, 'true', {}, []):
            with self.subTest(value=value), self.assertRaises(InventoryError):
                capability_state(value)
        rows = {row['id']: row for row in self.inventory['inventory']['exchanges']}
        observed_emulated = [(row['id'], name) for row in rows.values()
                            for name, raw in row['rest']['has'].items() if raw == 'emulated']
        self.assertTrue(observed_emulated)
        for exchange, name in observed_emulated:
            self.assertNotEqual(rows[exchange]['rest']['states'][name], 'native')

    def test_regional_inheritance_is_not_alias_or_product_acceptance(self):
        rows = {row['id']: row for row in self.inventory['inventory']['exchanges']}
        for exchange, parent in [('bybiteu', 'bybit'), ('gateeu', 'gate'), ('myokx', 'okx'),
                                 ('okxus', 'okx'), ('binanceus', 'binance'), ('binancecoinm', 'binance')]:
            row = rows[exchange]
            self.assertEqual(row['canonicalId'], exchange)
            self.assertIsNone(row['aliasOf'])
            self.assertIn(parent, row['rest']['inheritsFrom'])
            self.assertTrue(row['rest']['classEvidence'])
        assessments = {row['id']: row for row in self.inventory['assessments']}
        self.assertEqual(assessments['binanceus']['decision'], 'not_derivative')
        self.assertEqual(assessments['bybiteu']['decision'], 'pending')
        self.assertEqual(assessments['myokx']['decision'], 'pending')
        self.assertEqual(rows['binanceus']['productScopes'], [])

    def test_missing_native_prerequisites_remain_explicit_pending_not_not_easy(self):
        rows = {row['id']: row for row in self.inventory['inventory']['exchanges']}
        assessments = {row['id']: row for row in self.inventory['assessments']}
        self.assertFalse(rows['deribit']['candidatePrefilter'])
        self.assertIn({'lane': 'rest', 'capability': 'setLeverage', 'state': 'missing'}, rows['deribit']['blockers'])
        self.assertEqual(assessments['deribit']['decision'], 'pending')
        self.assertTrue(rows['okx']['candidatePrefilter'])
        self.assertEqual(assessments['okx']['decision'], 'pending')
        for row in self.inventory['assessments']:
            self.assertFalse(row['implementationVerified'])
            self.assertFalse(row['providerAcceptanceVerified'])

    def test_source_methods_profile_hashes_and_unknown_market_details(self):
        inventory = self.inventory['inventory']
        self.assertTrue(inventory['sources'])
        self.assertTrue(inventory['methods'])
        for method in inventory['methods'].values():
            self.assertIn(method['file'], inventory['sources'])
            self.assertGreaterEqual(method['endLine'], method['startLine'])
            self.assertRegex(method['sha256'], r'^[a-f0-9]{64}$')
        rows = {row['id']: row for row in inventory['exchanges']}
        self.assertEqual(rows['bybit']['profile']['version'], 1)
        self.assertRegex(rows['bybit']['profile']['sha256'], r'^[a-f0-9]{64}$')
        self.assertIsNone(rows['okx']['profile'])
        for row in rows.values():
            for document in row['documents']:
                self.assertIsNone(document['fetchedAt'])
            for scope in row['productScopes']:
                self.assertEqual(scope['evidenceStatus'], 'sdk_declared_only')
                self.assertIsNone(scope['settlement'])
                self.assertIsNone(scope['contractSize'])
                self.assertIsNone(scope['accountMode'])
                self.assertEqual(scope['quanto'], 'unknown')

    def test_inventory_rejects_missing_duplicate_forged_alias_flag_hash_and_schema(self):
        mutations = [
            lambda doc: doc['inventory']['exchanges'].pop(),
            lambda doc: doc['inventory']['exchanges'].append(copy.deepcopy(doc['inventory']['exchanges'][0])),
            lambda doc: doc['inventory']['exchanges'][0].update(aliasOf='bybit'),
            lambda doc: doc['inventory']['exchanges'][0]['rest']['has'].update(fetchBalance='emulated'),
            lambda doc: doc['inventory'].update(ccxtVersion='4.5.76'),
            lambda doc: doc['inventory'].update(sourceHash='0' * 64),
            lambda doc: doc.update(secret='forbidden'),
            lambda doc: doc['assessments'][0].update(decision='not_easy', evidence=[]),
            lambda doc: doc['assessments'][0].update(implementationVerified=True),
            lambda doc: doc['assessments'][0].update(providerAcceptanceVerified=True),
            lambda doc: doc['assessments'][0].update(decision=[]),
            lambda doc: doc['assessments'][0].update(evidence=[{'kind': [], 'path': 'docs/testing/proof.json', 'sha256': 'a' * 64}]),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                document = copy.deepcopy(self.inventory)
                mutate(document)
                with self.assertRaises(InventoryError):
                    validate_inventory(document)

    def test_complete_requires_real_independent_evidence_not_inventory_or_old_booleans(self):
        with self.assertRaisesRegex(InventoryError, 'pending|incomplete'):
            validate_complete(self.inventory)
        document = copy.deepcopy(self.inventory)
        for row in document['assessments']:
            if row['decision'] == 'pending':
                row.update(decision='not_easy', reasonCodes=['requires_review'], evidence=[{
                    'kind': 'exclusion', 'path': 'docs/testing/not-an-exclusion.json', 'sha256': 'a' * 64,
                }])
        with self.assertRaisesRegex(InventoryError, 'verifier|evidence'):
            validate_complete(document)
        with self.assertRaises(InventoryError):
            validate_complete(document, completion_verifier=lambda *_args: {'implementationVerified': True})

    def test_later_trusted_completion_hook_is_bound_and_not_an_always_failing_gate(self):
        document = copy.deepcopy(self.inventory)
        for row in document['assessments']:
            if row['decision'] == 'not_derivative':
                continue
            if row['decision'] == 'pending':
                row.update(decision='not_easy', reasonCodes=['independent_exclusion_fixture'])
            kind = 'implementation' if row['decision'] == 'existing' else 'exclusion'
            row['evidence'] = [{'kind': kind, 'path': 'tests/fixtures/injected-review-only.json', 'sha256': 'b' * 64}]

        # This injected local verifier is a unit fixture, NOT a successful provider
        # or parity review. CLI has no such hook and cannot load code from JSON.
        def fixture_verifier(assessment, expected):
            return CompletionVerdict(expected['inventoryHash'], assessment['id'], True,
                                     assessment['decision'] == 'existing')

        validate_complete(document, completion_verifier=fixture_verifier)
        with self.assertRaises(InventoryError):
            validate_complete(document, completion_verifier=lambda assessment, _expected:
                              CompletionVerdict('0' * 64, assessment['id'], True, True))
        with self.assertRaises(InventoryError):
            validate_complete(document, completion_verifier=lambda _assessment, expected:
                              CompletionVerdict(expected['inventoryHash'], 'wrong-exchange', True, True))
        with self.assertRaises(InventoryError):
            validate_complete(document, completion_verifier=lambda *_args: {'implementationVerified': True})

    def test_cli_verifies_inventory_but_refuses_complete_and_public_markets(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'inventory.json'
            fixture.write_text(json.dumps(self.inventory), encoding='utf-8')
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(main(['--offline', '--verify-inventory', str(fixture)]), 0)
                self.assertNotEqual(main(['--offline', '--verify-complete', str(fixture)]), 0)
                with self.assertRaises(SystemExit) as caught:
                    main(['--public-markets'])
                self.assertEqual(caught.exception.code, 2)
            fixture.write_text('{"schemaVersion":1,"schemaVersion":1}', encoding='utf-8')
            with self.assertRaises(InventoryError):
                load_inventory(fixture)
            fixture.write_text('{"number":NaN}', encoding='utf-8')
            with self.assertRaises(InventoryError):
                load_inventory(fixture)
            fixture.write_text(' ' * (8 * 1024 * 1024 + 1), encoding='utf-8')
            with self.assertRaises(InventoryError):
                load_inventory(fixture)

    def test_checked_in_first_manifest_matches_local_pin(self):
        manifest = ROOT.parent / 'docs/testing/ccxt-expansion-matrix.json'
        validate_inventory(load_inventory(manifest))


if __name__ == '__main__':
    unittest.main()
