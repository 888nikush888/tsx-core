import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const catalog = JSON.parse(await read('docs/ui-next/inventory/parameters.json')).parameters;
const firstSlice = JSON.parse(await read('docs/ui-next/inventory/operational-coverage-slice.json'));
const fields = JSON.parse(await read('docs/ui-next/inventory/operational-fields.json'));
const external = JSON.parse(await read('docs/ui-next/inventory/external-operational-controls.json'));
const runtimeSource = await read('src/runtime_settings.ts');
const runtimeBlock = runtimeSource.split('const ENVIRONMENT_MAPPING:')[1]?.split('};')[0] ?? '';
const runtimeEnvironment = new Map([...runtimeBlock.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*): '([A-Z][A-Z0-9_]*)',/gm)]
  .map(match => [`runtime.${match[1]}`, match[2]]));

const allowedClasses = new Set([
  'runtime-editable', 'create-only', 'versioned-draft', 'write-only-secret',
  'issued-secret', 'read-only-evidence', 'host-maintenance', 'immutable-gate', 'derived-draft',
]);
const allowedStatuses = new Set(['unverified', 'first-slice-static', 'known-gap']);
const immutableGates = new Set([
  'strategy.exits.closeRemainderAtLastTarget',
  'strategy.safety.requireProtectiveStop',
  'resource.parser.saveToFile',
]);
const createOnly = new Set(['account.name', 'account.exchange', 'account.mode', 'schema.id', 'contract.id']);
const issuedSecrets = new Set(['secrets.dashboardToken', 'secrets.viewerServiceToken', 'secrets.mcpAgentToken']);
const derivedDraft = new Set(['graph.nodes[].id', 'graph.edges[].id', 'graph.schemaVersion']);
const requiredSafetyAlerts = new Set([
  'ForwarderMetricsMissing', 'ForwarderUnknownDelivery', 'ForwarderDatabaseUnavailable',
  'ForwarderTelegramDisconnected', 'ForwarderBackupUnhealthy', 'ForwarderDiskCapacityUnsafe',
  'ForwarderPendingTaskStale', 'ForwarderAuditTrailUnhealthy', 'ForwarderClockDriftUnsafe',
  'TradingUnknownOrder', 'TradingUnprotectedPosition', 'TradingKillSwitchActive',
  'TradingReconciliationStale',
]);
const firstSliceByPath = new Map(firstSlice.groups.flatMap(group => group.paths.map(name => [name, group])));

function expectedClass(parameter) {
  const name = parameter.path;
  if (derivedDraft.has(name)) return 'derived-draft';
  if (immutableGates.has(name)) return 'immutable-gate';
  if (name.startsWith('deployment.')) return 'host-maintenance';
  if (issuedSecrets.has(name)) return 'issued-secret';
  if (name.startsWith('secrets.')) return parameter.editable ? 'write-only-secret' : 'read-only-evidence';
  if (createOnly.has(name)) return 'create-only';
  if (!parameter.editable) return 'read-only-evidence';
  if (/^(strategy|resource|schema|contract|graph)\./.test(name)) return 'versioned-draft';
  return 'runtime-editable';
}

function verifyFieldProvenance(field, parameter) {
  assert.ok(allowedStatuses.has(field.evidenceStatus), `${field.path}: unknown or unproven evidence status`);
  assert.equal(field.catalogEditable, parameter.editable, `${field.path}: stale editability snapshot`);
    if (derivedDraft.has(field.path)) {
      assert.equal(parameter.editable, true, `${field.path}: catalog metadata conflict needs review`);
      assert.equal(field.metadataConflict,
        'Catalog marks editable, but the builder generates this field; no direct field editor is proven.',
        `${field.path}: generated field must remain an explicit catalog conflict`);
    } else assert.ok(!('metadataConflict' in field), `${field.path}: invented metadata conflict`);
    if (field.path.startsWith('runtime.')) assert.equal(field.runtimeEnvironmentName, runtimeEnvironment.get(field.path),
      `${field.path}: runtime environment mapping drift`);
    else assert.ok(!('runtimeEnvironmentName' in field), `${field.path}: invented runtime environment mapping`);
    assert.ok(!('uiVerified' in field) && !('e2eVerified' in field), `${field.path}: unproven UI claim`);
    const group = firstSliceByPath.get(field.path);
    if (group) {
      assert.equal(field.firstSliceGroup, group.id, `${field.path}: wrong first-slice proof reference`);
      assert.equal(field.evidenceStatus, group.class === 'host-bootstrap' ? 'known-gap' : 'first-slice-static',
        `${field.path}: first-slice evidence drift`);
    } else {
      assert.equal(field.firstSliceGroup, null, `${field.path}: invented first-slice group`);
      assert.equal(field.evidenceStatus, 'unverified', `${field.path}: unproven field promoted`);
    }
}

function verifyFieldClassInvariants(field, parameter) {
    if (immutableGates.has(field.path)) {
      assert.equal(field.class, 'immutable-gate', `${field.path}: hard gate reclassified`);
      assert.equal(parameter.editable, false, `${field.path}: hard gate became editable`);
    } else if (field.class === 'immutable-gate') {
      assert.fail(`${field.path}: undocumented immutable gate`);
    }
    if (field.class === 'host-maintenance') assert.ok(field.path.startsWith('deployment.'), `${field.path}: host class drift`);
    if (field.class === 'write-only-secret') assert.ok(parameter.editable && parameter.secret,
      `${field.path}: write-only-secret metadata drift`);
    if (field.class === 'issued-secret') assert.ok(!parameter.editable && parameter.secret,
      `${field.path}: issued-secret metadata drift`);
    if (['runtime-editable', 'create-only', 'versioned-draft'].includes(field.class)) {
      assert.equal(parameter.editable, true, `${field.path}: editable class contradicts catalog`);
    }
    if (field.class === 'read-only-evidence') assert.equal(parameter.editable, false,
      `${field.path}: read-only class contradicts catalog`);
}

function verifyCatalog(parameters, inventory) {
  const source = new Map();
  for (const parameter of parameters) {
    assert.ok(typeof parameter.path === 'string' && parameter.path, 'catalog path required');
    assert.ok(!source.has(parameter.path), `${parameter.path}: duplicate catalog path`);
    source.set(parameter.path, parameter);
  }
  const classified = new Set();
  for (const field of inventory.fields) {
    assert.ok(typeof field.path === 'string' && field.path, 'inventory path required');
    assert.ok(!classified.has(field.path), `${field.path}: duplicate field classification`);
    classified.add(field.path);
    const parameter = source.get(field.path);
    assert.ok(parameter, `${field.path}: unknown catalog field`);
    assert.ok(allowedClasses.has(field.class), `${field.path}: unknown class`);
    assert.equal(field.class, expectedClass(parameter), `${field.path}: lifecycle class drift`);
    verifyFieldProvenance(field, parameter);
    verifyFieldClassInvariants(field, parameter);
  }
  assert.deepEqual([...classified].sort(), [...source.keys()].sort(), 'Catalog and field classification differ');
  return { catalogCount: source.size, classifiedCount: classified.size };
}

function verifyExternal(controls, composeText, ruleText) {
  const IDs = new Set();
  const byId = new Map();
  for (const control of controls) {
    assert.ok(typeof control.id === 'string' && control.id, 'external ID required');
    assert.ok(!IDs.has(control.id), `${control.id}: duplicate external control`);
    IDs.add(control.id);
    byId.set(control.id, control);
    assert.equal(control.evidenceStatus, 'unverified', `${control.id}: unproven external UI control`);
    assert.ok(['host-maintenance', 'write-only-secret', 'write-once-secret', 'safety-rule'].includes(control.class),
      `${control.id}: invalid external class`);
    assert.ok(Array.isArray(control.source) && control.source.length, `${control.id}: source required`);
    assert.ok(control.relation, `${control.id}: relation required`);
    if (control.relatedCatalogPath) assert.ok(catalog.some(item => item.path === control.relatedCatalogPath),
      `${control.id}: unknown related catalog path`);
  }
  const composeNames = new Set([...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g)].map(match => match[1]));
  assert.deepEqual([...IDs].filter(id => id.startsWith('compose.')).map(id => id.slice(8)).sort(),
    [...composeNames].sort(), 'Compose substitutions require exact external rows');
  const environmentNames = new Set([...composeText.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map(match => match[1]));
  assert.deepEqual(external.composeEnvironmentBindings.map(binding => binding.name).sort(), [...environmentNames].sort(),
    'Compose environment wiring inventory drift');
  for (const binding of external.composeEnvironmentBindings) {
    assert.equal(binding.kind, 'fixed-container-wiring-not-an-additional-control');
    assert.ok(binding.source.length, `${binding.name}: missing Compose source`);
  }
  const alertNames = new Set([...ruleText.matchAll(/^\s+- alert: ([A-Za-z][A-Za-z0-9]+)\s*$/gm)].map(match => match[1]));
  assert.deepEqual([...IDs].filter(id => id.startsWith('monitoring.rule.')).map(id => id.slice(16)).sort(),
    [...alertNames].sort(), 'Monitoring rules require exact external rows');
  const sections = [...ruleText.matchAll(/^\s+- alert: ([A-Za-z][A-Za-z0-9]+)\s*$/gm)];
  const criticalNames = new Set();
  for (let index = 0; index < sections.length; index += 1) {
    const name = sections[index][1];
    const body = ruleText.slice(sections[index].index, sections[index + 1]?.index ?? ruleText.length);
    const item = byId.get(`monitoring.rule.${name}`);
    if (/^\s+severity: critical\s*$/m.test(body)) {
      criticalNames.add(name);
      assert.equal(item.class, 'safety-rule', `${name}: critical detection cannot be a free host edit`);
      assert.equal(item.detectionPolicy, 'immutable-expression-duration-severity', `${name}: detection policy drift`);
      assert.equal(item.deliveryControl, 'monitoring.alertmanager.receiver_url', `${name}: delivery is separate`);
      const parts = ['expr', 'for', 'severity'].map(key => {
        const line = body.split(/\r?\n/u).find(candidate => /^\s/u.test(candidate)
          && candidate.trimStart().startsWith(`${key}:`));
        const value = line?.trimStart().slice(key.length + 1).trim();
        assert.ok(value, `${name}: missing ${key} in critical detection`);
        return value;
      });
      const fingerprint = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
      assert.equal(item.detectionSourceSha256, fingerprint, `${name}: critical detection fingerprint drift`);
    } else {
      assert.equal(item.class, 'host-maintenance', `${name}: alert class drift`);
      assert.ok(!item.detectionPolicy, `${name}: invented critical detection policy`);
    }
  }
  assert.deepEqual([...criticalNames].sort(), [...requiredSafetyAlerts].sort(),
    'Critical alert set changed; review immutable detection policy before accepting this inventory');
  const tlsFiles = ['ca.pem', ...['dashboard', 'metrics', 'alert-relay', 'viewer', 'executor']
    .flatMap(service => [`${service}.crt`, `${service}.key`])];
  for (const file of tlsFiles) assert.ok(IDs.has(`tls.${file}`), `${file}: missing TLS lifecycle control`);
  assert.equal(external.tlsEnvironmentBindings.length, 12, 'TLS environment binding denominator drift');
  for (const binding of external.tlsEnvironmentBindings) {
    assert.ok(environmentNames.has(binding.name), `${binding.name}: missing Compose TLS binding`);
    assert.ok(tlsFiles.includes(binding.artifact), `${binding.name}: unknown TLS artifact`);
    const artifactPath = `/run/tsx-tls/${binding.artifact}`;
    assert.ok(composeText.split(/\r?\n/u).some(line => [
      `      ${binding.name}: ${artifactPath}`,
      `      ${binding.name}: "${artifactPath}"`,
      `      ${binding.name}: '${artifactPath}'`,
    ]
      .includes(line)),
      `${binding.name}: TLS artifact mapping drift`);
  }
  for (const id of ['host.BACKUP_DIR', 'host.BACKUP_OFFSITE_TOKEN', 'host.BACKUP_ENCRYPTION_KEY',
    'host.AUDIT_LOG_PATH', 'tailscale.serveBackend']) {
    assert.ok(IDs.has(id), `${id}: missing host control`);
  }
  assert.equal(byId.get('host.BACKUP_ENCRYPTION_KEY').class, 'write-once-secret',
    'Backup encryption key must not be rotated through an ordinary secret editor');
  assert.ok(!IDs.has('host.CLOCK_MAX_DRIFT_MS'), 'Managed clock threshold must not be double-counted as a host control.');
  return { composeCount: composeNames.size, alertCount: alertNames.size, externalCount: IDs.size };
}

assert.equal(fields.schemaVersion, 1);
assert.equal(external.schemaVersion, 1);
const strategySafetySlice = firstSlice.groups.find(group => group.id === 'strategy-safety');
assert.equal(strategySafetySlice.class, 'versioned-draft');
assert.deepEqual(strategySafetySlice.paths, [
  'strategy.safety.maxDailyLossMode', 'strategy.safety.maxDailyLoss',
  'strategy.safety.maxSlippagePercent', 'strategy.safety.entryOrderTtlSeconds',
], 'Only the four operator-editable safety limits belong to this slice.');
assert.deepEqual(strategySafetySlice.contractTests, [
  'frontend/tests/workflow-resource-editor.test.tsx',
  'tests/test_web_server.js', 'tests/test_workflow_builder.js',
]);
for (const testFile of strategySafetySlice.contractTests) await access(path.join(root, testFile));
const strategySizingDefaults = [
  'positionSizingMode', 'riskPerTradePercent', 'maxAdaptiveRiskPercent',
  'maxPositionNotional', 'defaultLeverage', 'maxLeverage',
];
for (const name of strategySizingDefaults) {
  const field = fields.fields.find(item => item.path === `strategy.sizing.${name}`);
  assert.equal(field.class, 'versioned-draft');
  assert.equal(field.evidenceStatus, 'unverified',
    'Strategy sizing defaults cannot be promoted while the mandatory sizing resource overrides them.');
  assert.equal(field.firstSliceGroup, null);
}
const counted = verifyCatalog(catalog, fields);
const slicePathCount = firstSlice.groups.reduce((count, group) => count + group.paths.length, 0);
assert.equal(firstSliceByPath.size, slicePathCount, 'First-slice path must occur in exactly one group.');
const statusCounts = fields.fields.reduce((counts, field) => {
  counts[field.evidenceStatus] = (counts[field.evidenceStatus] ?? 0) + 1;
  return counts;
}, { 'first-slice-static': 0, 'known-gap': 0, unverified: 0 });
const inventoryDoc = await read('docs/ui-next/inventory/OPERATIONAL_FIELD_INVENTORY.md');
const documentedCounts = inventoryDoc.match(/The current statuses are (\d+) `first-slice-static`, (\d+) `known-gap`, and \*\*(\d+) `unverified`\*\*\. The (\d+)-path slice/);
assert.ok(documentedCounts, 'Inventory status-count statement missing.');
assert.deepEqual(documentedCounts.slice(1).map(Number), [
  statusCounts['first-slice-static'], statusCounts['known-gap'], statusCounts.unverified, slicePathCount,
], 'Documented inventory counts must match the JSON rows and unique first-slice paths.');
const remainingGapCount = inventoryDoc.match(/^- (\d+) catalog paths have no field-level proof/m);
assert.equal(Number(remainingGapCount?.[1]), statusCounts.unverified,
  'The documented remaining gap count must match unverified JSON rows.');
assert.equal(runtimeEnvironment.size, 36, 'Managed runtime mapping denominator drift');
const clockParameter = catalog.find(item => item.path === 'runtime.clockMaxDriftMs');
assert.equal(clockParameter.constraints, '100..5000');
assert.equal(clockParameter.editable, true);
const composeText = (await Promise.all(external.composeSources.map(read))).join('\n');
const externalCounted = verifyExternal(external.controls, composeText, await read('monitoring/rules.yml'));
assert.match(await read('src/secret_store.ts'), /BACKUP_ENCRYPTION_KEY is immutable because rotating it/);
assert.match(await read('src/clock_guard.ts'), /CLOCK_MAX_DRIFT_MS must be an integer between 100 and 5000/);
for (const control of external.controls) for (const source of control.source) await access(path.join(root, source));
assert.equal(externalCounted.composeCount, 23, 'Re-audit Compose variable denominator on change');
assert.equal(externalCounted.alertCount, 18, 'Re-audit alert rule denominator on change');
assert.equal(counted.catalogCount, 312, 'Re-audit catalog denominator on change');
const expandedAggregates = ['deployment.hostPorts', 'deployment.cpu', 'deployment.memory'];
for (const name of expandedAggregates) assert.ok(catalog.some(item => item.path === name), `${name}: aggregate missing`);
const sourceScopedControlCount = counted.catalogCount - expandedAggregates.length + externalCounted.externalCount;
assert.equal(sourceScopedControlCount, 379, 'Re-audit source-scoped control-record denominator on change');

const newField = [...catalog, { path: 'runtime.newValue', editable: true, secret: false }];
assert.throws(() => verifyCatalog(newField, fields), /Catalog and field classification differ/);
const falselyVerified = structuredClone(fields);
falselyVerified.fields.find(item => item.path === 'paper.equity').evidenceStatus = 'first-slice-static';
assert.throws(() => verifyCatalog(catalog, falselyVerified), /unproven field promoted/);
const missingCompose = external.controls.filter(item => item.id !== 'compose.HOST_WEB_PORT');
const ruleText = await read('monitoring/rules.yml');
assert.throws(() => verifyExternal(missingCompose, composeText, ruleText),
  /Compose substitutions require exact external rows/);
const weakenedGate = structuredClone(fields);
weakenedGate.fields.find(item => item.path === 'strategy.safety.requireProtectiveStop').class = 'runtime-editable';
assert.throws(() => verifyCatalog(catalog, weakenedGate), /lifecycle class drift/);
const inventedGraphEditor = structuredClone(fields);
inventedGraphEditor.fields.find(item => item.path === 'graph.schemaVersion').class = 'versioned-draft';
assert.throws(() => verifyCatalog(catalog, inventedGraphEditor), /lifecycle class drift/);
const weakenedAlarm = structuredClone(external.controls);
weakenedAlarm.find(item => item.id === 'monitoring.rule.TradingUnprotectedPosition').class = 'host-maintenance';
assert.throws(() => verifyExternal(weakenedAlarm, composeText, ruleText), /critical detection cannot be a free host edit/);
const alteredDetection = ruleText.replace('tg_forwarder_trading_unprotected_positions > 0',
  'tg_forwarder_trading_unprotected_positions > 1');
assert.throws(() => verifyExternal(external.controls, composeText, alteredDetection), /critical detection fingerprint drift/);
const rotatingBackupKey = structuredClone(external.controls);
rotatingBackupKey.find(item => item.id === 'host.BACKUP_ENCRYPTION_KEY').class = 'write-only-secret';
assert.throws(() => verifyExternal(rotatingBackupKey, composeText, ruleText), /Backup encryption key must not be rotated/);
const duplicateClockControl = structuredClone(external.controls);
duplicateClockControl.push({ id: 'host.CLOCK_MAX_DRIFT_MS', family: 'host', source: ['src/clock_guard.ts'],
  relation: 'duplicate', class: 'host-maintenance', evidenceStatus: 'unverified' });
assert.throws(() => verifyExternal(duplicateClockControl, composeText, ruleText), /must not be double-counted/);

console.log(`Operational inventory passed: ${counted.classifiedCount} catalog fields, ${externalCounted.externalCount} external controls (${externalCounted.composeCount} Compose variables, ${externalCounted.alertCount} alert rules); ${sourceScopedControlCount} source-scoped control records; UI E2E remains unverified.`);
