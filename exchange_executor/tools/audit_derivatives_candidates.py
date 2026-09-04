"""Reproducible CCXT declarations, not an account probe or implementation attestation.

Only constructors/describe metadata and installed Python source are inspected. The
CLI has no public-markets mode. It emits JSON to stdout; it never modifies profiles,
credentials, installed dependencies, or the supplied manifest.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import inspect
import json
import re
import socket
import subprocess
import sys
from contextlib import ExitStack, contextmanager
from dataclasses import asdict, dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

import ccxt
import ccxt.async_support as ccxt_rest
import ccxt.pro as ccxt_pro
from ccxt.async_support.base.exchange import Exchange

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

def _shared_contracts():
    from ccxt_capabilities import CANDIDATE_PRO_REQUIREMENTS, CANDIDATE_REST_REQUIREMENTS, PRO_CAPABILITIES, REST_CAPABILITIES
    from ccxt_profiles import PROFILES
    return CANDIDATE_PRO_REQUIREMENTS, CANDIDATE_REST_REQUIREMENTS, PRO_CAPABILITIES, REST_CAPABILITIES, PROFILES


CANDIDATE_PRO_REQUIREMENTS, CANDIDATE_REST_REQUIREMENTS, PRO_CAPABILITIES, REST_CAPABILITIES, PROFILES = _shared_contracts()

CCXT_VERSION = '4.5.75'
PYTHON_VERSION = (3, 12)
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
REST_FLAGS = REST_CAPABILITIES + (
    'fetchMarkets', 'fetchOrder', 'fetchOrders', 'fetchClosedOrders', 'editOrder', 'cancelAllOrders',
    'fetchPositionMode', 'fetchMarginMode', 'fetchLeverage', 'fetchLeverageTiers', 'fetchMarketLeverageTiers',
    'fetchFundingHistory', 'fetchFundingRates', 'fetchLedger', 'createStopLossOrder',
    'createTakeProfitOrder', 'createOrderWithTakeProfitAndStopLoss',
)
PRODUCT_FLAGS = ('spot', 'swap', 'future', 'option')
FEATURE_FIELDS = (
    'sandbox', 'createOrder', 'createOrders', 'fetchMyTrades', 'fetchOrder', 'fetchOrders',
    'fetchOpenOrders', 'fetchClosedOrders',
)
SEMANTIC_REVIEWS = (
    'identity_and_secrets', 'symbol_and_product', 'account_mode_and_admission', 'entry_and_protection',
    'ownership_and_reconciliation', 'history', 'lifecycle', 'money_and_risk', 'errors_and_streams', 'cross_layer',
)
DECISIONS = {'existing', 'eligible', 'not_easy', 'not_derivative', 'pending'}


class InventoryError(ValueError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def capability_state(value: Any) -> str:
    if value is True:
        return 'native'
    if value == 'emulated':
        return 'emulated'
    if value is None or value is False:
        return 'missing'
    raise InventoryError('Unexpected CCXT has value; no truthiness capability inference is permitted.')


def _assert_pin() -> None:
    if sys.version_info[:2] != PYTHON_VERSION:
        raise InventoryError('The inventory requires the explicit Python 3.12 runtime.')
    if ccxt.__version__ != CCXT_VERSION or version('ccxt') != CCXT_VERSION:
        raise InventoryError('The installed CCXT package is not pinned 4.5.75.')


def _network_forbidden(*_args: Any, **_kwargs: Any) -> None:
    raise InventoryError('Offline inventory attempted network, credentials, markets, or a child process.')


@contextmanager
def offline_guard():
    # Defense in depth for accidental future constructor changes, not an OS sandbox.
    targets = [(socket.socket, name) for name in ('connect', 'connect_ex', 'send', 'sendall', 'sendto')]
    targets += [(socket, 'getaddrinfo'), (socket, 'create_connection'), (subprocess, 'Popen')]
    targets += [(Exchange, name) for name in ('fetch', 'load_markets', 'check_required_credentials')]
    with ExitStack() as stack:
        for owner, name in targets:
            stack.enter_context(patch.object(owner, name, _network_forbidden))
        yield


class SourceIndex:
    def __init__(self) -> None:
        self.package = Path(ccxt.__file__).resolve().parent
        self.files: dict[str, dict[str, Any]] = {}
        self.methods: dict[str, dict[str, Any]] = {}
        self.contents: dict[str, bytes] = {}

    def file(self, path: Path) -> str:
        path = path.resolve()
        if path.is_relative_to(self.package):
            key = f'ccxt/{path.relative_to(self.package).as_posix()}'
        elif path.is_relative_to(ROOT):
            key = f'exchange_executor/{path.relative_to(ROOT).as_posix()}'
        else:
            raise InventoryError('Source evidence is outside the installed CCXT or scoped executor directory.')
        if key not in self.files:
            data = path.read_bytes()
            self.files[key] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            self.contents[key] = data
        return key

    def method(self, method: Any) -> str | None:
        if not inspect.isfunction(method):
            return None
        source_path = inspect.getsourcefile(method)
        if source_path is None:
            raise InventoryError('A Python implementation method has no inspectable source.')
        key = self.file(Path(source_path))
        reference = f'{key}:{method.__qualname__}'
        if reference not in self.methods:
            lines, first = inspect.getsourcelines(method)
            last = first + len(lines) - 1
            original = b''.join(self.contents[key].splitlines(keepends=True)[first - 1:last])
            self.methods[reference] = {'file': key, 'startLine': first, 'endLine': last,
                                       'sha256': hashlib.sha256(original).hexdigest()}
        return reference

    def class_evidence(self, klass: type) -> list[str]:
        return [self.file(Path(inspect.getfile(parent))) for parent in klass.__mro__
                if parent.__module__.startswith('ccxt.')]


def _snake_case(name: str) -> str:
    return re.sub(r'([A-Z])', r'_\1', name).lower()


def _declarations(client: Any, names: tuple[str, ...], sources: SourceIndex) -> dict[str, Any]:
    if client is None:
        return {'available': False, 'has': {key: None for key in names},
                'states': {key: 'missing' for key in names}, 'declared': [], 'methods': {},
                'classEvidence': [], 'inheritsFrom': []}
    klass = type(client)
    raw = {name: client.has.get(name) for name in names}
    method_names = {name: _snake_case(name) for name in names}
    method_names.update(describe='describe', parseMarket='parse_market', parseOrder='parse_order', parseTrade='parse_trade')
    methods = {name: sources.method(getattr(klass, method, None)) for name, method in method_names.items()}
    return {
        'available': True, 'has': raw, 'states': {name: capability_state(value) for name, value in raw.items()},
        'declared': sorted(name for name in names if name in client.has),
        'methods': {name: reference for name, reference in methods.items() if reference is not None},
        'classEvidence': sources.class_evidence(klass),
        'inheritsFrom': [parent.__name__ for parent in klass.__mro__[1:]
                         if parent.__module__.startswith(('ccxt.async_support.', 'ccxt.pro.'))
                         and parent.__name__ != 'Exchange'],
    }


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return sorted({text for child in value.values() for text in _strings(child)})
    if isinstance(value, list):
        return sorted({text for child in value for text in _strings(child)})
    return []


def _hosts(client: Any) -> dict[str, Any]:
    return {'hostname': getattr(client, 'hostname', None),
            'live': _strings(client.urls.get('api')), 'testnet': _strings(client.urls.get('test')),
            'demo': _strings(client.urls.get('demo')), 'evidenceStatus': 'sdk_declared_only',
            'productApplicability': 'unknown', 'reachable': None}


def _product_scopes(client: Any) -> list[dict[str, Any]]:
    result = []
    for product in ('swap', 'future'):
        if client.has.get(product) is not True:
            continue
        declared = (client.features or {}).get(product) or {}
        subtypes = [name for name in ('linear', 'inverse') if isinstance(declared.get(name), dict)]
        for subtype in subtypes or ['unknown']:
            details = declared.get(subtype, {})
            result.append({
                'product': product, 'settlementType': subtype, 'evidenceStatus': 'sdk_declared_only',
                'features': {name: details[name] for name in FEATURE_FIELDS if name in details},
                'settlement': None, 'contractSize': None, 'expiry': None, 'quanto': 'unknown',
                'accountMode': None, 'modes': 'unknown', 'feeCurrencies': None, 'fundingCurrencies': None,
                'unresolvedDimensions': ['actual_markets', 'quantity_and_price_limits', 'settlement',
                                         'contract_size', 'expiry_lifecycle', 'quanto', 'account_mode',
                                         'live_testnet_product_scope', 'fee_and_funding_currencies'],
            })
    return result


def _profile(exchange: str) -> dict[str, Any] | None:
    profile = PROFILES.get(exchange)
    if profile is None:
        return None
    return {'version': profile.profile_version, 'sha256': digest(asdict(profile)),
            'declarations': asdict(profile), 'evidenceStatus': 'local_profile_declaration_only'}


def _credential_allowlist(sources: SourceIndex) -> list[str]:
    key = sources.file(ROOT / 'ccxt_registry.py')
    tree = ast.parse(sources.contents[key])
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name)
                and target.id == 'CREDENTIAL_ALLOWLIST' for target in statement.targets):
            return sorted(ast.literal_eval(statement.value))
    raise InventoryError('The existing credential field allowlist could not be read without executing it.')


def _blockers(rest: dict[str, Any], pro: dict[str, Any]) -> list[dict[str, str]]:
    result = []
    for lane, declarations, requirements in [('rest', rest, CANDIDATE_REST_REQUIREMENTS),
                                            ('pro', pro, CANDIDATE_PRO_REQUIREMENTS)]:
        result.extend({'lane': lane, 'capability': name, 'state': declarations['states'][name]}
                      for name in requirements if declarations['states'][name] != 'native')
    return result


def _exchange(exchange: str, sources: SourceIndex, credential_allowlist: list[str]) -> dict[str, Any]:
    rest_client = getattr(ccxt_rest, exchange)({'enableRateLimit': True})
    pro_client = getattr(ccxt_pro, exchange)({'enableRateLimit': True}) if exchange in ccxt_pro.exchanges else None
    rest = _declarations(rest_client, REST_FLAGS, sources)
    pro = _declarations(pro_client, PRO_CAPABILITIES, sources)
    blockers = _blockers(rest, pro)
    products = {name: rest_client.has.get(name) for name in PRODUCT_FLAGS}
    for raw in products.values():
        capability_state(raw)
    credentials = dict(rest_client.requiredCredentials)
    if any(type(value) is not bool for value in credentials.values()):
        raise InventoryError('Unexpected requiredCredentials schema.')
    unsupported = sorted(key for key, required in credentials.items() if required and key not in credential_allowlist)
    return {
        'id': exchange, 'canonicalId': exchange, 'aliasOf': None,
        'declaredAlias': rest_client.alias, 'name': rest_client.name, 'countries': rest_client.countries,
        'rest': rest, 'pro': pro, 'productFlags': products, 'productScopes': _product_scopes(rest_client),
        'credentialSchema': credentials, 'unsupportedCredentialFields': unsupported,
        'defaults': {name: rest_client.options.get(name) for name in ('defaultType', 'defaultSubType', 'defaultSettle')},
        'precisionMode': rest_client.precisionMode, 'staticLimits': rest_client.limits,
        'hosts': {'rest': _hosts(rest_client), 'pro': _hosts(pro_client) if pro_client is not None else None},
        'documents': [{'url': url, 'fetchedAt': None, 'evidenceStatus': 'sdk_url_only'}
                      for url in _strings(rest_client.urls.get('doc'))],
        'profile': _profile(exchange), 'blockers': blockers,
        'candidatePrefilter': (products['swap'] is True or products['future'] is True)
                             and not blockers and not unsupported,
        'semanticReviewRequired': list(SEMANTIC_REVIEWS),
    }


def _initial_assessment(row: dict[str, Any]) -> dict[str, Any]:
    decision, reason = 'pending', 'provider_semantics_not_reviewed'
    if row['profile'] is not None:
        decision, reason = 'existing', 'existing_profile_requires_new_bound_parity_evidence'
    elif all(row['productFlags'][name] is False for name in ('swap', 'future', 'option')):
        decision, reason = 'not_derivative', 'pinned_sdk_explicitly_declares_no_derivatives'
    elif not row['productScopes']:
        reason = 'product_scope_unknown'
    return {'id': row['id'], 'decision': decision, 'reasonCodes': [reason], 'evidence': [],
            'implementationVerified': False, 'providerAcceptanceVerified': False}


def build_inventory() -> dict[str, Any]:
    _assert_pin()
    with offline_guard():
        sources = SourceIndex()
        for name in ('ccxt_profiles.py', 'ccxt_capabilities.py', 'tools/audit_derivatives_candidates.py'):
            sources.file(ROOT / name)
        for module in (ccxt, ccxt_rest, ccxt_pro):
            sources.file(Path(module.__file__))
        credentials = _credential_allowlist(sources)
        rows = [_exchange(exchange, sources, credentials) for exchange in sorted(ccxt_rest.exchanges)]
        inventory = {
            'ccxtVersion': CCXT_VERSION, 'pythonVersion': list(PYTHON_VERSION), 'mode': 'offline',
            'restIds': sorted(ccxt_rest.exchanges), 'proIds': sorted(ccxt_pro.exchanges),
            'requirements': {'rest': list(CANDIDATE_REST_REQUIREMENTS), 'pro': list(CANDIDATE_PRO_REQUIREMENTS),
                             'strategyDependentRest': ['createOrders'], 'credentialFields': credentials},
            'exchanges': rows, 'sources': sources.files, 'methods': sources.methods,
            'sourceHash': digest(sources.files),
        }
        return {'schemaVersion': 1, 'inventory': inventory, 'inventoryHash': digest(inventory),
                'assessments': [_initial_assessment(row) for row in rows]}


def _exact_keys(value: Any, expected: set[str], name: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise InventoryError(f'{name} has missing or unknown fields.')


def _safe_evidence_reference(reference: Any) -> None:
    _exact_keys(reference, {'kind', 'path', 'sha256'}, 'Evidence reference')
    if not isinstance(reference['kind'], str) or reference['kind'] not in ('implementation', 'exclusion', 'provider'):
        raise InventoryError('Unknown evidence kind.')
    path = reference['path']
    if not isinstance(path, str) or not re.fullmatch(r'[A-Za-z0-9_./-]{1,240}', path):
        raise InventoryError('Invalid repository-relative evidence path.')
    if path.startswith('/') or any(part in ('', '.', '..') for part in path.split('/')):
        raise InventoryError('Evidence cannot escape its repository scope.')
    if not isinstance(reference['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', reference['sha256']):
        raise InventoryError('Invalid evidence SHA256.')


def _validate_decision(assessment: dict[str, Any], exchange: dict[str, Any]) -> None:
    decision = assessment['decision']
    if not isinstance(decision, str) or decision not in DECISIONS:
        raise InventoryError('Unknown candidate decision.')
    if decision == 'not_derivative' and not all(exchange['productFlags'][name] is False
                                               for name in ('swap', 'future', 'option')):
        raise InventoryError('Unknown or derivative products cannot be excluded as spot-only.')
    if decision == 'existing' and exchange['profile'] is None:
        raise InventoryError('Existing decision has no actual local profile.')
    if decision == 'eligible' and not exchange['productScopes']:
        raise InventoryError('Eligible decision has no declared derivative product scope.')
    if decision == 'not_easy' and not any(item['kind'] == 'exclusion' for item in assessment['evidence']):
        raise InventoryError('Technical exclusion requires independent evidence, not missing review.')


def _validate_assessment(value: Any, exchange: dict[str, Any]) -> None:
    _exact_keys(value, {'id', 'decision', 'reasonCodes', 'evidence', 'implementationVerified',
                        'providerAcceptanceVerified'}, 'Assessment')
    if value['id'] != exchange['id']:
        raise InventoryError('Assessment identity/ordering differs from the full inventory.')
    reasons = value['reasonCodes']
    if not isinstance(reasons, list) or not 1 <= len(reasons) <= 32:
        raise InventoryError('A bounded concrete assessment reason is required.')
    if any(not isinstance(item, str) or not re.fullmatch(r'[a-z0-9_]{1,160}', item) for item in reasons):
        raise InventoryError('Invalid assessment reason code.')
    evidence = value['evidence']
    if not isinstance(evidence, list) or len(evidence) > 32:
        raise InventoryError('Invalid evidence references.')
    for reference in evidence:
        _safe_evidence_reference(reference)
    # These are the inventory's claims, never outputs from the later trusted verifier.
    if value['implementationVerified'] is not False or value['providerAcceptanceVerified'] is not False:
        raise InventoryError('Inventory declarations cannot self-certify implementation or provider acceptance.')
    _validate_decision(value, exchange)


def validate_inventory(document: Any) -> None:
    _exact_keys(document, {'schemaVersion', 'inventory', 'inventoryHash', 'assessments'}, 'Inventory manifest')
    if type(document['schemaVersion']) is not int or document['schemaVersion'] != 1:
        raise InventoryError('Unsupported inventory schema version.')
    expected = build_inventory()
    if canonical(document['inventory']) != canonical(expected['inventory']):
        raise InventoryError('Inventory differs from installed pinned declarations, IDs, methods, or source hashes.')
    if document['inventoryHash'] != expected['inventoryHash']:
        raise InventoryError('Inventory hash does not bind the actual source inventory.')
    assessments = document['assessments']
    if not isinstance(assessments, list) or len(assessments) != len(expected['assessments']):
        raise InventoryError('Assessments must cover each installed ID exactly once.')
    for assessment, exchange in zip(assessments, expected['inventory']['exchanges'], strict=True):
        _validate_assessment(assessment, exchange)


@dataclass(frozen=True)
class CompletionVerdict:
    """Issued only by trusted caller code after genuine evidence/review verification.

    A JSON object, a format-only verifier, or manifest booleans cannot issue this
    capability. Root composes the independent 009.2 verifier/acceptance checks later.
    This is local completion only; provider/account acceptance is never inferred.
    """
    inventory_hash: str
    exchange_id: str
    decision_verified: bool
    implementation_verified: bool


def validate_complete(document: Any, *, completion_verifier: Callable[..., CompletionVerdict] | None = None) -> None:
    validate_inventory(document)
    pending = [row['id'] for row in document['assessments'] if row['decision'] == 'pending']
    if pending:
        raise InventoryError(f'Expansion incomplete: pending decisions for {", ".join(pending)}.')
    for assessment, exchange in zip(document['assessments'], document['inventory']['exchanges'], strict=True):
        if assessment['decision'] == 'not_derivative':
            continue  # Explicit false product declarations already independently reconstructed.
        if assessment['decision'] in ('existing', 'eligible') and not any(
                item['kind'] == 'implementation' for item in assessment['evidence']):
            raise InventoryError('Completion is missing original implementation evidence references.')
        if completion_verifier is None:
            raise InventoryError('Completion requires a trusted independent evidence verifier; declarations are insufficient.')
        verdict = completion_verifier(assessment, {'inventoryHash': document['inventoryHash'], 'exchange': exchange,
                                                 'sourceFiles': document['inventory']['sources']})
        if not isinstance(verdict, CompletionVerdict):
            raise InventoryError('Completion verifier returned no trusted typed evidence verdict.')
        if (verdict.inventory_hash != document['inventoryHash'] or verdict.exchange_id != exchange['id']
                or verdict.decision_verified is not True):
            raise InventoryError('Completion evidence verdict does not bind this inventory and decision.')
        if assessment['decision'] in ('existing', 'eligible'):
            if exchange['profile'] is None or verdict.implementation_verified is not True:
                raise InventoryError('Eligible/existing profile lacks verified implementation evidence.')


def _unique_object(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in items:
        if key in result:
            raise InventoryError('Duplicate JSON keys in inventory.')
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise InventoryError('Nonfinite JSON values are forbidden.')


def load_inventory(path: Path) -> Any:
    with path.open('rb') as handle:
        data = handle.read(MAX_MANIFEST_BYTES + 1)
    if len(data) > MAX_MANIFEST_BYTES:
        raise InventoryError('Inventory exceeds its bounded JSON size.')
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (ValueError, UnicodeDecodeError, RecursionError) as error:
        raise InventoryError('Invalid strict inventory JSON.') from error


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', default=True, help='Only supported mode; also the default.')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--verify-inventory', type=Path)
    group.add_argument('--verify-complete', type=Path)
    args = parser.parse_args(arguments)
    try:
        path = args.verify_inventory or args.verify_complete
        if path is None:
            print(json.dumps(build_inventory(), ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False))
        else:
            document = load_inventory(path)
            if args.verify_complete:
                from ccxt_candidate_reviews import trusted_completion_verifier
                validate_complete(document, completion_verifier=trusted_completion_verifier(document, CompletionVerdict))
            else:
                validate_inventory(document)
            print(f'Offline inventory verified: {len(document["inventory"]["restIds"])} pinned REST IDs; no provider acceptance.')
        return 0
    except (InventoryError, OSError, TypeError, ValueError) as error:
        print(f'Inventory verification failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
