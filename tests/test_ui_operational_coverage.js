import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(await readFile(path.join(root, 'docs/ui-next/inventory/operational-coverage-slice.json'), 'utf8'));
const source = new Map(JSON.parse(await readFile(path.join(root, 'docs/ui-next/inventory/parameters.json'), 'utf8')).parameters
  .map(parameter => [parameter.path, parameter]));
const routes = JSON.parse(await readFile(path.join(root, 'docs/ui-next/inventory/api-routes.json'), 'utf8')).routes;
const auditedPrefixes = ['runtime.', 'account.', 'viewer.', 'deployment.'];
const immutableGate = 'strategy.safety.requireProtectiveStop';
const accountCreateOnly = new Set(['account.name', 'account.exchange', 'account.mode']);
const accountRuntimeEditable = new Set(['account.enabled', 'account.maxConcurrentPositions']);

function validateClass(name, group, parameter) {
  if (name.startsWith('runtime.') || accountRuntimeEditable.has(name)) assert.equal(group.class, 'runtime-editable', `${name}: class drift`);
  if (name.startsWith('viewer.')) assert.equal(group.class, name === 'viewer.display.timeFormat' ? 'read-only-evidence' : 'runtime-editable', `${name}: viewer class drift`);
  if (accountCreateOnly.has(name)) assert.equal(group.class, 'create-only', `${name}: class drift`);
  if (name.startsWith('account.') && !accountCreateOnly.has(name) && !accountRuntimeEditable.has(name)) {
    assert.equal(group.class, 'read-only-evidence', `${name}: class drift`);
  }
  if (name.startsWith('deployment.')) assert.equal(group.class, 'host-bootstrap', `${name}: class drift`);
  if (name === immutableGate) assert.equal(group.class, 'immutable-gate', `${name}: class drift`);
  if (['runtime-editable', 'create-only', 'versioned-draft'].includes(group.class)) {
    assert.equal(parameter.editable, true, `${name}: editability drift`);
  }
  else assert.equal(parameter.editable, false, `${name}: must not be a direct editable field`);
}

function expectedVersionedAuditAction(route) {
  if (route.startsWith('POST /api/trading/')) {
    return `trading.${route.slice('POST /api/trading/'.length).replaceAll('/', '.')}.post`;
  }
  if (route.startsWith('POST /api/workflow/')) {
    return `dashboard.workflow.${route.slice('POST /api/workflow/'.length).replaceAll('/', '.')}.post`;
  }
  throw new Error(`${route}: unsupported versioned mutation route`);
}

function validateVersionedEvidence(name, group) {
  for (const key of ['uiRoute', 'uiControl', 'backendValidator', 'effect']) {
    assert.ok(group[key], `${name}: undocumented versioned ${key}`);
  }
  for (const key of ['mutationRoutes', 'auditActions', 'contractTests']) {
    assert.ok(Array.isArray(group[key]) && group[key].length > 0,
      `${name}: undocumented versioned ${key}`);
  }
  assert.equal(group.mutationRoutes.length, group.auditActions.length,
    `${name}: every versioned mutation must identify its audit action`);
  assert.deepEqual(group.auditActions, group.mutationRoutes.map(expectedVersionedAuditAction),
    `${name}: versioned mutation audit mapping drift`);
  assert.ok(!group.mutationRoute && !group.auditAction,
    `${name}: versioned publication must not be presented as a direct runtime edit`);
}

function validateEvidence(name, group) {
  if (group.class === 'runtime-editable' || group.class === 'create-only') {
    for (const key of ['uiRoute', 'uiControl', 'mutationRoute', 'backendValidator', 'auditAction', 'contractTest']) {
      assert.ok(group[key], `${name}: undocumented writable ${key}`);
    }
  }
  if (group.class === 'versioned-draft') validateVersionedEvidence(name, group);
  if (group.class === 'host-bootstrap') {
    assert.equal(group.gap, 'host-maintenance-ui', `${name}: host UI gap must remain visible`);
    assert.ok(!group.mutationRoute, `${name}: host mutation must not be claimed`);
    assert.ok(group.evidence?.[name]?.detail, `${name}: exact evidence limit must be documented`);
    assert.ok(['build-value', 'presence-only', 'partial', 'absent'].includes(group.evidence[name].visibility), `${name}: unknown evidence visibility`);
  }
  if (group.class === 'immutable-gate') {
    assert.ok(!group.mutationRoute && !group.mutationRoutes && !group.uiControl,
      `${name}: gate must not have an editor`);
  }
  if (name === 'viewer.display.timeFormat') {
    assert.ok(group.uiRoute && group.uiControl && group.backendValidator, 'Fixed viewer format must remain visible and validated');
    assert.ok(!group.mutationRoute && !group.mutationRoutes,
      'Fixed viewer format must not have an editor');
  }
}

function validateCoverage(parameters, coverage) {
  const classified = new Map();
  for (const group of coverage.groups) {
    assert.ok(coverage.classes.includes(group.class), `${group.id}: unknown class`);
    assert.ok(Array.isArray(group.paths) && group.paths.length, `${group.id}: paths required`);
    for (const name of group.paths) {
      assert.ok(!classified.has(name), `${name}: duplicate coverage`);
      const parameter = parameters.get(name);
      assert.ok(parameter, `${name}: absent from parameter catalog`);
      classified.set(name, group);
      validateClass(name, group, parameter);
      validateEvidence(name, group);
    }
  }
  const expected = [...parameters.keys()].filter(name => auditedPrefixes.some(prefix => name.startsWith(prefix)) || name === immutableGate);
  const inAuditedScope = name => auditedPrefixes.some(prefix => name.startsWith(prefix)) || name === immutableGate;
  assert.deepEqual([...classified.keys()].filter(inAuditedScope).sort(), expected.sort(),
    'Undocumented parameter in audited scope');
  for (const [name, group] of classified) {
    if (!inAuditedScope(name)) assert.equal(group.class, 'versioned-draft', `${name}: unexpected class outside audited scope`);
  }
  const host = coverage.groups.find(group => group.id === 'deployment-bootstrap');
  assert.deepEqual(Object.keys(host.evidence).sort(), host.paths.slice().sort(), 'Deployment evidence must cover precisely the host fields');
  return classified;
}

assert.equal(inventory.schemaVersion, 1);
const classified = validateCoverage(source, inventory);
assert.deepEqual(
  [...classified.keys()].filter(name => name.startsWith('runtime.')).sort(),
  [...source.keys()].filter(name => name.startsWith('runtime.')).sort(),
  'Managed runtime register and UI coverage diverged',
);
assert.equal(source.get('account.credentialGeneration').type, 'string|null');
assert.equal(source.get('account.credentialGeneration').nullable, true);
assert.match(source.get('account.maxConcurrentPositions').constraints, /baseUpdatedAt/);
const hostEvidence = inventory.groups.find(group => group.id === 'deployment-bootstrap').evidence;
assert.equal(hostEvidence['deployment.VITE_BASENAME'].visibility, 'build-value');
assert.equal(hostEvidence['deployment.VITE_GTM_ID'].visibility, 'presence-only');
for (const name of ['deployment.hostPorts', 'deployment.cpu', 'deployment.memory']) assert.equal(hostEvidence[name].visibility, 'partial');
assert.equal(hostEvidence['deployment.imageDigest'].visibility, 'absent');
for (const group of inventory.groups) {
  for (const reference of [group.uiControl, group.contractTest, ...(group.contractTests ?? [])].filter(Boolean)) {
    await access(path.join(root, reference));
  }
  if (group.backendValidator) {
    const [sourcePath, symbol] = group.backendValidator.split(':');
    const validatorSource = await readFile(path.join(root, sourcePath), 'utf8');
    if (symbol) assert.ok(validatorSource.includes(symbol), `${group.id}: validator symbol missing`);
  }
  for (const mutationRoute of [group.mutationRoute, ...(group.mutationRoutes ?? [])].filter(Boolean)) {
    const route = routes.find(item => item.route === mutationRoute);
    assert.equal(route?.role, 'admin', `${group.id}: mutation must be an admin route`);
  }
}

const runtimeUi = await readFile(path.join(root, 'frontend/src/features/operations/runtime-parameters.tsx'), 'utf8');
assert.match(runtimeUi, /parameters\.filter\(item => item\.group === group\)\.map\(field =>/);
assert.match(runtimeUi, /field\.editable/);
assert.match(runtimeUi, /field\.path/);
const viewerUi = await readFile(path.join(root, 'frontend/src/features/telegram-viewer/telegram-viewer.tsx'), 'utf8');
assert.match(viewerUi, /TELEGRAM_NOTIFICATION_LABELS\.map/);
const notificationLabels = viewerUi.split('const TELEGRAM_NOTIFICATION_LABELS')[1]?.split('];')[0];
assert.ok(notificationLabels, 'Viewer notification controls are missing');
const notificationUiPaths = [...notificationLabels.matchAll(/\["([A-Za-z]+)",/g)].map(match => `viewer.notifications.${match[1]}`);
const notificationCatalogPaths = inventory.groups.find(group => group.id === 'telegram-viewer-settings').paths.filter(name => name.startsWith('viewer.notifications.'));
assert.deepEqual(notificationUiPaths.sort(), notificationCatalogPaths.sort(), 'Viewer notification catalog and controls differ');
for (const anchor of ['settings.enabled', 'settings.timezone', 'settings.locale', 'settings.eventPollingIntervalMs', 'allowedUsersText', 'settings.display.detailLevel', 'settings.display.pnlMode']) {
  assert.ok(viewerUi.includes(anchor), `${anchor}: viewer UI control missing`);
}
assert.match(viewerUi, /settings\.display\.timeFormat/);
assert.match(viewerUi, /disabled=\{readOnly\}/);
assert.match(viewerUi, /'If-Match': String\(form\.baseRevision\)/);
const viewerValidator = await readFile(path.join(root, 'src/telegram_viewer_settings.ts'), 'utf8');
assert.match(viewerValidator, /source\.timeFormat !== '24h'/);
assert.match(viewerValidator, /validateTelegramViewerSettings\(input\)/);
assert.match(viewerValidator, /baseRevision !== configurationRevision\(this\.settings\)/);
const server = await readFile(path.join(root, 'src/web_server.ts'), 'utf8');
assert.match(server, /'\/api\/runtime-settings': 'runtime\.settings\.update'/);
assert.match(server, /'POST \/api\/runtime-settings', postRuntimeSettingsHandler/);
assert.match(server, /trading\.\$\{target \|\| 'control'\}\.\$\{method\.toLowerCase\(\)\}/);
assert.match(server, /'\/api\/telegram-viewer\/settings': 'telegram-viewer\.settings\.update'/);
assert.match(server, /'POST \/api\/telegram-viewer\/settings', updateTelegramViewerSettingsHandler/);
for (const group of inventory.groups.filter(item => item.auditAction?.startsWith('trading.'))) {
  const expected = `trading.${group.mutationRoute.slice('POST /api/trading/'.length).replaceAll('/', '.')}.post`;
  assert.equal(group.auditAction, expected, `${group.id}: incorrect audit event name`);
}
const strategy = await readFile(path.join(root, 'src/trading_strategy.ts'), 'utf8');
assert.match(strategy, /requireProtectiveStop !== true/);
const deploymentUi = await readFile(path.join(root, 'frontend/src/features/operations/deployment.tsx'), 'utf8');
assert.match(deploymentUi, /gtmConfigured: Boolean\(import\.meta\.env\.VITE_GTM_ID\)/);
assert.doesNotMatch(deploymentUi, /imageDigest/);
const deploymentServer = await readFile(path.join(root, 'src/ui_deployment.ts'), 'utf8');
assert.match(deploymentServer, /keine Beobachtung der tatsächlichen Host-\/Compose-Zuordnung/);
assert.doesNotMatch(deploymentServer, /imageDigest/);

const additional = new Map(source);
additional.set('runtime.newOperatingValue', { path: 'runtime.newOperatingValue', editable: true });
assert.throws(() => validateCoverage(additional, inventory), /Undocumented parameter in audited scope/);
const withoutHostGap = structuredClone(inventory);
delete withoutHostGap.groups.find(group => group.id === 'deployment-bootstrap').gap;
assert.throws(() => validateCoverage(source, withoutHostGap), /host UI gap must remain visible/);
const gateEditor = structuredClone(inventory);
gateEditor.groups.find(group => group.id === 'mandatory-protective-stop').uiControl = 'frontend/src/features/operations/runtime-parameters.tsx';
assert.throws(() => validateCoverage(source, gateEditor), /gate must not have an editor/);
const gateMutation = structuredClone(inventory);
gateMutation.groups.find(group => group.id === 'mandatory-protective-stop').mutationRoute = 'POST /api/runtime-settings';
assert.throws(() => validateCoverage(source, gateMutation), /gate must not have an editor/);
const gatePluralMutation = structuredClone(inventory);
gatePluralMutation.groups.find(group => group.id === 'mandatory-protective-stop').mutationRoutes = ['POST /api/runtime-settings'];
assert.throws(() => validateCoverage(source, gatePluralMutation), /gate must not have an editor/);
const viewerPluralMutation = structuredClone(inventory);
viewerPluralMutation.groups.find(group => group.id === 'telegram-viewer-fixed-time-format').mutationRoutes = ['POST /api/runtime-settings'];
assert.throws(() => validateCoverage(source, viewerPluralMutation), /Fixed viewer format must not have an editor/);
const metadataDrift = new Map(source);
metadataDrift.set('account.enabled', { ...source.get('account.enabled'), editable: false });
assert.throws(() => validateCoverage(metadataDrift, inventory), /editability drift/);
const classDrift = structuredClone(inventory);
classDrift.groups.find(group => group.id === 'account-enable').class = 'create-only';
assert.throws(() => validateCoverage(source, classDrift), /class drift/);
const missingCreateAudit = structuredClone(inventory);
delete missingCreateAudit.groups.find(group => group.id === 'account-creation').auditAction;
assert.throws(() => validateCoverage(source, missingCreateAudit), /undocumented writable auditAction/);
const versionedDrift = new Map(source);
versionedDrift.set('strategy.safety.maxDailyLossMode', {
  ...source.get('strategy.safety.maxDailyLossMode'), editable: false,
});
assert.throws(() => validateCoverage(versionedDrift, inventory), /editability drift/);
const missingVersionedAudit = structuredClone(inventory);
delete missingVersionedAudit.groups.find(group => group.id === 'strategy-safety').auditActions;
assert.throws(() => validateCoverage(source, missingVersionedAudit), /undocumented versioned auditActions/);
const wrongVersionedAudit = structuredClone(inventory);
wrongVersionedAudit.groups.find(group => group.id === 'strategy-safety').auditActions[0] = 'dashboard.workflow.mutate.post';
assert.throws(() => validateCoverage(source, wrongVersionedAudit), /versioned mutation audit mapping drift/);
console.log(`Operational UI coverage slice passed: ${classified.size} classified parameters, ${inventory.groups.find(group => group.id === 'managed-runtime').paths.length} managed runtime controls and 22 viewer fields; six host-maintenance gaps remain explicit.`);
