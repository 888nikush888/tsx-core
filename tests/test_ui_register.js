import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UI_ROUTE_INVENTORY } from '../src/ui_route_inventory.js';
import { uiCapabilities, uiCapabilityGroup } from '../src/ui_capabilities.js';
import { uiParameters, uiParameterCatalog, CONFIG_PARAMETER_FIELDS } from '../src/ui_parameter_catalog.js';
import { parameterLeaves } from '../src/ui_parameter_types.js';
import { RESOURCE_PARAMETER_FIELDS, STRATEGY_PARAMETER_FIELDS, CONTRACT_PARAMETER_FIELDS } from '../src/ui_model_parameters.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { BUILTIN_SIGNAL_CONTRACTS } from '../src/signal_contract.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/runtime_settings.js';
import { AI_LIMIT_RANGES, TRADING_ACCOUNT_STATUSES, WORKFLOW_RESOURCE_KINDS } from '../src/ui_contracts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = { role: 'viewer', recovery: false, canMutate: false, mutationInProgress: false, startupPhase: 'initializing', startupReason: 'Required evidence missing' };
function assertFields(defaults, fields) {
  for (const key of parameterLeaves(defaults)) assert.ok(fields.some(field => field[0] === key), 'Unmapped default field: ' + key);
}
async function testMappings() {
  for (const args of [['scripts/build_ui_route_inventory.js', '--check'], ['--import', 'tsx', 'scripts/export_ui_register.js', '--check']]) {
    const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(new Set(UI_ROUTE_INVENTORY.map(entry => entry.route)).size, UI_ROUTE_INVENTORY.length);
  const files = new Set();
  for (const route of UI_ROUTE_INVENTORY) {
    const mapping = uiCapabilityGroup(route.route);
    assert.ok(mapping.scope && mapping.effect && mapping.href.startsWith('/'));
    assert.ok(mapping.contractTests.length && mapping.browserTests.length);
    [mapping.component, ...mapping.contractTests, ...mapping.browserTests].forEach(file => files.add(file));
    if (!route.route.startsWith('GET ')) assert.equal(route.role, 'admin');
  }
  for (const file of files) await access(path.join(root, file));
}
function testCapabilities() {
  const seen = []; let cursor = null;
  do {
    const page = uiCapabilities(new URLSearchParams({ limit: '13', ...(cursor ? { cursor } : {}) }), state);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
    seen.push(...page.entries); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, UI_ROUTE_INVENTORY.length);
  assert.equal(new Set(seen.map(entry => entry.route)).size, seen.length);
  assert.ok(seen.find(entry => entry.route === 'POST /api/trading/runtime').currentBlockers.some(value => value.includes('Administrator')));
  assert.ok(seen.find(entry => entry.route === 'POST /api/trading/runtime').currentBlockers.some(value => value.includes('Startfreigabe')));
  assert.equal(seen.find(entry => entry.route === 'GET /api/mcp').role, 'admin');
  const recovery = uiCapabilities(new URLSearchParams({ area: 'recovery' }), { ...state, role: 'admin', recovery: true });
  assert.equal(recovery.entries.find(entry => entry.route === 'POST /api/restart').currentBlockers.length, 0);
  const page = uiCapabilities(new URLSearchParams({ limit: '1' }), state);
  assert.throws(() => uiCapabilities(new URLSearchParams({ area: 'trading', limit: '1', cursor: page.nextCursor }), state));
  assert.throws(() => uiCapabilities(new URLSearchParams({ limit: '51' }), state));
}
async function testParameters() {
  const catalog = uiParameterCatalog(); const paths = catalog.map(entry => entry.path);
  assert.equal(new Set(paths).size, catalog.length);
  assertFields(DEFAULT_CONFIG, CONFIG_PARAMETER_FIELDS); assertFields(DEFAULT_STRATEGY_CONFIGURATION, STRATEGY_PARAMETER_FIELDS);
  for (const contract of BUILTIN_SIGNAL_CONTRACTS) assertFields({ ...contract.definition, additionalFields: [] }, CONTRACT_PARAMETER_FIELDS);
  assert.deepEqual(Object.keys(RESOURCE_PARAMETER_FIELDS).sort(), [...WORKFLOW_RESOURCE_KINDS].sort());
  assert.deepEqual(paths.filter(key => key.startsWith('runtime.')).sort(), Object.keys(DEFAULT_RUNTIME_SETTINGS).map(key => 'runtime.' + key).sort());
  for (const [key, range] of Object.entries(AI_LIMIT_RANGES)) assert.ok(catalog.find(entry => entry.path === 'config.xmlParsing.aiLimits.' + key).constraints.startsWith(range.join('..')));
  assert.equal(catalog.find(entry => entry.path === 'resource.adaptive_risk.lockedTier').nullable, true);
  assert.equal(catalog.find(entry => entry.path === 'strategy.safety.requireProtectiveStop').editable, false);
  assert.equal(catalog.find(entry => entry.path === 'config.xmlParsing.aiLimits.fallbackAttempts').type, 'integer');
  for (const entry of catalog.filter(item => item.secret)) assert.equal(entry.defaultPresent, false);
  const types = await readFile(path.join(root, 'src/trading_types.ts'), 'utf8');
  const statuses = [...types.match(/export type TradingAccountStatus = ([^;]+);/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...TRADING_ACCOUNT_STATUSES].sort(), statuses.sort());
  for (const entry of catalog) {
    for (const reference of [entry.validator, entry.consumer].flatMap(value => value.split('; '))) await access(path.join(root, reference.split(':')[0]));
  }
  const seen = []; let cursor = null;
  do {
    const page = uiParameters(new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 100 * 1024);
    seen.push(...page.entries); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.map(entry => entry.path), paths);
  const page = uiParameters(new URLSearchParams({ prefix: 'resource', limit: '1' }));
  assert.throws(() => uiParameters(new URLSearchParams({ prefix: 'account', limit: '1', cursor: page.nextCursor })));
}
await testMappings(); testCapabilities(); await testParameters();
console.log('UI register contracts passed: source drift, complete defaults, resource kinds, roles, blockers, references, cursor binding and bounded metadata.');
