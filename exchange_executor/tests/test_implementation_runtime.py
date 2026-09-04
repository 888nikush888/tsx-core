"""Baked-runtime gate tests: test pins are confined to disposable original-byte fixtures."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ccxt_certification as certification
import ccxt_certification_evidence as evidence
import verify_implementation_runtime as runtime
from ccxt_profiles import PROFILES


class ImplementationRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.executor = Path(self.temporary.name) / 'executor'
        self.sdk = Path(self.temporary.name) / 'sdk'
        self.receipts = self.executor / 'certifications'
        self.receipts.mkdir(parents=True)
        (self.sdk / 'base').mkdir(parents=True)
        for name in ('ccxt_certification.py', 'verify_implementation_runtime.py', 'adapter.py'):
            (self.executor / name).write_text(f'# original {name}\n', encoding='utf-8')
        (self.sdk / '__init__.py').write_text('# original SDK\n', encoding='utf-8')
        (self.sdk / 'base' / 'exchange.py').write_text('# original SDK base\n', encoding='utf-8')
        self.pins = {}
        self.values = {}
        for exchange, profile in PROFILES.items():
            value = {
                'schemaVersion': 2, 'kind': 'reviewed_implementation_receipt', 'exchange': exchange,
                'ccxtVersion': '4.5.75', 'profileVersion': profile.profile_version,
                'profileHash': evidence.expected_profile_hash(profile), 'sourceRevision': 'a' * 40,
                'sourceTreeHash': 'b' * 64, 'parityEvidenceHash': 'c' * 64, 'executionReportHash': 'd' * 64,
                'nodeSourcesHash': 'e' * 64, 'testSourcesHash': 'f' * 64, 'fixturesHash': 'a' * 64,
                'executorTreeHash': evidence.python_tree_hash(self.executor),
                'sdkTreeHash': evidence.python_tree_hash(self.sdk, sdk=True),
                'reviewedAt': '2026-01-01T00:00:00Z', 'providerAcceptanceVerified': False,
                'scope': {'product': 'linear_perpetual', 'positionMode': profile.position_mode,
                          'marginMode': profile.margin_mode, 'settlementAssets': list(profile.settlement_preference),
                          'modes': list(profile.modes), 'contractSizeRule': 'positive_native_base_multiplier'},
            }
            self.values[exchange] = value
            self.save(exchange, value, pin=True)
        stack = self.enterContext(ExitStack())
        stack.enter_context(patch.object(certification, 'APPROVED_IMPLEMENTATION_RECEIPTS', self.pins))
        stack.enter_context(patch.object(certification, '__file__', str(self.executor / 'ccxt_certification.py')))
        stack.enter_context(patch.object(certification.ccxt, '__file__', str(self.sdk / '__init__.py')))
        stack.enter_context(patch.object(runtime, '__file__', str(self.executor / 'verify_implementation_runtime.py')))

    def save(self, exchange, value, *, pin=False):
        raw = json.dumps(value, separators=(',', ':')).encode('utf-8')
        (self.receipts / f'{exchange}.json').write_bytes(raw)
        if pin:
            self.pins[(exchange, self.values.get(exchange, value)['profileVersion'])] = (hashlib.sha256(raw).hexdigest(),)

    def test_all_real_validator_results_are_required_without_provider_or_root_claim(self):
        self.assertEqual(sys.version_info[:2], (3, 12))
        self.assertEqual(runtime.ccxt.__version__, '4.5.75')
        with patch.object(runtime, 'certification_result', wraps=certification.certification_result) as checked:
            result = runtime.verify_implementation_runtime()
        self.assertEqual(checked.call_count, len(PROFILES))
        self.assertEqual({call.args[1] for call in checked.call_args_list}, set(PROFILES))
        for call in checked.call_args_list:
            self.assertEqual(call.args, (self.receipts, call.args[1], '4.5.75', PROFILES[call.args[1]]))
        self.assertIs(result['runtimeReceiptsVerified'], True)
        self.assertIs(result['providerAcceptanceVerified'], False)
        self.assertIs(result['rootBuildInputsVerified'], False)
        self.assertIs(result['performedGateExecution'], False)
        self.assertEqual(result['profiles'], [
            {'exchange': key, 'profileVersion': PROFILES[key].profile_version, 'implementationStatus': 'verified'}
            for key in sorted(PROFILES)
        ])
        self.assertEqual(result['verifiedProfiles'], sorted(PROFILES))
        self.assertEqual(result['quarantinedProfiles'], [])

    def test_missing_review_is_quarantined_but_bad_pin_blocks_the_inventory(self):
        for exchange, profile in PROFILES.items():
            key = (exchange, profile.profile_version)
            original = self.pins.pop(key)
            with self.subTest(exchange=exchange, change='missing'):
                result = runtime.verify_implementation_runtime()
                self.assertIn(exchange, result['quarantinedProfiles'])
                self.assertNotIn(exchange, result['verifiedProfiles'])
            self.pins[key] = ('0' * 64,)
            with self.subTest(exchange=exchange, change='wrong'), self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()
            self.pins[key] = original
        self.pins.clear()
        with self.assertRaises(runtime.RuntimeVerificationError):
            runtime.verify_implementation_runtime()

    def test_empty_malformed_and_unknown_profile_inventories_are_not_success(self):
        bybit = PROFILES['bybit']
        inventories = [{}, None, [], {'bybit': {}}, {'bybit': PROFILES['hyperliquid']},
                       {'not_a_real_ccxt_exchange': replace(bybit, id='not_a_real_ccxt_exchange')},
                       {'../bybit': replace(bybit, id='../bybit')}, {1: bybit}]
        inventories.extend({'bybit': replace(bybit, profile_version=value)} for value in (True, 0, -1, '1'))
        for inventory in inventories:
            with self.subTest(inventory=inventory), patch.object(runtime, 'PROFILES', inventory), \
                    self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()

    def test_runtime_and_profile_versions_are_not_coerced(self):
        for version in ('4.5.74', '4.5.76', None):
            with self.subTest(version=version), patch.object(runtime.ccxt, '__version__', version), \
                    self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()
        with patch.object(runtime.sys, 'version_info', (3, 13, 0)), self.assertRaises(runtime.RuntimeVerificationError):
            runtime.verify_implementation_runtime()
        changed = dict(PROFILES, bybit=replace(PROFILES['bybit'], profile_version=2))
        with patch.object(runtime, 'PROFILES', changed), self.assertRaises(runtime.RuntimeVerificationError):
            runtime.verify_implementation_runtime()

    def test_malformed_or_contradictory_status_is_not_truthy_approval(self):
        statuses = [None, True, {'valid': True}, certification.CertificationResult(False, None),
                    certification.CertificationResult(True, 'unresolved'),
                    certification.CertificationResult(1, None), certification.CertificationResult('true', None)]
        for status in statuses:
            with self.subTest(status=status), patch.object(runtime, 'certification_result', return_value=status), \
                    self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()

    def test_pinned_but_wrong_identity_scope_or_original_hash_is_rejected(self):
        mutations = [('exchange', 'hyperliquid'), ('profileVersion', True), ('profileHash', '0' * 64),
                     ('ccxtVersion', '4.5.76'), ('executorTreeHash', '0' * 64), ('sdkTreeHash', '0' * 64),
                     ('providerAcceptanceVerified', True), ('kind', 'certified')]
        for field, value in mutations:
            changed = copy.deepcopy(self.values['bybit'])
            changed[field] = value
            self.save('bybit', changed, pin=True)
            with self.subTest(field=field), self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()
        changed = copy.deepcopy(self.values['bybit'])
        changed['scope']['settlementAssets'] = ['BTC']
        self.save('bybit', changed, pin=True)
        with self.assertRaises(runtime.RuntimeVerificationError):
            runtime.verify_implementation_runtime()

    def test_actual_executor_or_sdk_source_drift_is_rejected(self):
        for file in (self.executor / 'adapter.py', self.sdk / 'base' / 'exchange.py'):
            original = file.read_bytes()
            file.write_bytes(original + b'# drift\n')
            with self.subTest(file=file.name), self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()
            file.write_bytes(original)
        self.assertIs(runtime.verify_implementation_runtime()['runtimeReceiptsVerified'], True)

    def test_installed_sdk_hardlink_is_not_hidden_by_a_valid_version_or_bytehash(self):
        original = self.sdk / 'base' / 'exchange.py'
        alias = Path(self.temporary.name) / 'sdk-alias.py'
        os.link(original, alias)
        self.assertGreater(original.stat().st_nlink, 1)
        with self.assertRaises(runtime.RuntimeVerificationError):
            runtime.verify_implementation_runtime()
        alias.unlink()
        self.assertEqual(original.stat().st_nlink, 1)
        self.assertIs(runtime.verify_implementation_runtime()['runtimeReceiptsVerified'], True)

    def test_missing_and_pinned_malformed_receipts_are_not_approval(self):
        path = self.receipts / 'bybit.json'
        path.unlink()
        with self.assertRaises(runtime.RuntimeVerificationError):
            runtime.verify_implementation_runtime()
        for raw in (b'{', b'{}', b'{"valid":true,"valid":false}', b'{"valid":true,"status":"certified"}'):
            path.write_bytes(raw)
            self.pins[('bybit', PROFILES['bybit'].profile_version)] = (hashlib.sha256(raw).hexdigest(),)
            with self.subTest(raw=raw), self.assertRaises(runtime.RuntimeVerificationError):
                runtime.verify_implementation_runtime()

    def test_cli_has_no_selection_or_approval_flags_and_redacts_unexpected_errors(self):
        for arguments in (['--exchange', 'bybit'], ['--approved', 'anything'], ['--help']):
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(runtime.sys, 'argv', ['verify_implementation_runtime.py', *arguments]), \
                    redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(runtime.main(), 1)
            self.assertEqual(stdout.getvalue(), '')
            self.assertIn('NO-GO', stderr.getvalue())
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(runtime.sys, 'argv', ['verify_implementation_runtime.py']), \
                patch.object(runtime, 'certification_result', side_effect=RuntimeError('secret-fixture-token')), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(runtime.main(), 1)
        self.assertEqual(stdout.getvalue(), '')
        self.assertNotIn('secret-fixture-token', stderr.getvalue())
        self.assertNotIn('Traceback', stderr.getvalue())

    def test_cli_success_uses_all_real_bound_fixture_receipts(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(runtime.sys, 'argv', ['verify_implementation_runtime.py']), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(runtime.main(), 0)
        self.assertEqual(stderr.getvalue(), '')
        result = json.loads(stdout.getvalue())
        self.assertEqual(len(result['profiles']), len(PROFILES))
        self.assertEqual(result['verifiedProfiles'], sorted(PROFILES))
        self.assertEqual(result['quarantinedProfiles'], [])
        self.assertIs(result['runtimeReceiptsVerified'], True)
        self.assertIs(result['providerAcceptanceVerified'], False)
        self.assertIs(result['rootBuildInputsVerified'], False)

    def test_fresh_cli_with_explicitly_empty_fixture_policy_is_no_go(self):
        # A future legitimate production approval must not break this negative
        # test. Copy actual source bytes, but use a separate empty TEST policy.
        source = Path(evidence.__file__).resolve().parent
        fixture = Path(self.temporary.name) / 'unreviewed-executor'
        fixture.mkdir()
        authority = 'ccxt_implementation_reviews.py'
        original_policy = (source / authority).read_bytes()
        for file in sorted(source.glob('*.py')):
            copied = fixture / file.name
            shutil.copyfile(file, copied)
            self.assertEqual(copied.read_bytes(), file.read_bytes())
            self.assertEqual(copied.stat().st_nlink, 1)
        (fixture / authority).write_text(
            '# Explicit isolated TEST policy; never changes production review pins.\n'
            'from types import MappingProxyType\nAPPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({})\n',
            encoding='utf-8',
        )
        cli = fixture / 'verify_implementation_runtime.py'
        outcome = subprocess.run([sys.executable, '-E', '-B', str(cli)], cwd=fixture, capture_output=True,
                                 text=True, timeout=30, check=False)
        self.assertEqual(outcome.returncode, 1)
        self.assertEqual(outcome.stdout, '')
        self.assertIn('NO-GO', outcome.stderr)
        self.assertNotIn('Traceback', outcome.stderr)
        self.assertEqual((source / authority).read_bytes(), original_policy)
        self.assertFalse((fixture / '__pycache__').exists())


if __name__ == '__main__':
    unittest.main()
