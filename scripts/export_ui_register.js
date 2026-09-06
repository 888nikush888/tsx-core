import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_ROUTE_INVENTORY } from '../src/ui_route_inventory.js';
import { uiCapabilityGroup } from '../src/ui_capabilities.js';
import { uiParameterCatalog } from '../src/ui_parameter_catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parameters = uiParameterCatalog();
const capabilities = UI_ROUTE_INVENTORY.map(entry => {
  const { paths: _paths, ...mapping } = uiCapabilityGroup(entry.route);
  return { ...entry, ...mapping };
});
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const markdown = '# UI Next capability and parameter register\n\n'
  + 'Contract version 1. Generated from explicit product mappings and registered handlers. '
  + 'The source plan’s companion matrices were not supplied. Counts here describe the current implementation. '
  + 'Test references identify relevant fixtures; they do not claim real provider acceptance or that every variant has an independent browser test.\n\n'
  + 'Frontend availability is advisory. Authentication, audit, startup, identity, freshness, ownership and object-specific checks remain authoritative at execution. '
  + 'Bootstrap/session exceptions are recorded separately in inventory/api-routes.json. P3 host maintenance and manual single-trade execution remain outside Core parity.\n\n'
  + '| Registered route | Role | UI entry | Scope / effect | Boundary | Contract evidence |\n|---|---|---|---|---|---|\n'
  + capabilities.map(entry => '| ' + [entry.route, entry.role, entry.href, entry.scope + '. ' + entry.effect,
    entry.boundary ?? 'Operator surface', entry.contractTests.join(', ')].map(cell).join(' | ') + ' |').join('\n')
  + '\n\n## Parameter contracts\n\nFull typed contracts, defaults, null/empty semantics, units, consumers, effects and editability are in [parameters.json](inventory/parameters.json) and in the running UI under Betrieb & Sicherheit → Aktionen & Parameter. '
  + 'Stored/current values belong to the linked object view. Defaults are not current installation values. Published originals, secrets and deployment inputs retain their own boundaries.\n\n'
  + '| Family | Registered fields |\n|---|---:|\n'
  + [...new Set(parameters.map(entry => entry.path.split('.')[0]))].map(family => '| ' + family + ' | ' + parameters.filter(entry => entry.path.startsWith(family + '.')).length + ' |').join('\n') + '\n';
const outputs = [
  ['docs/ui-next/inventory/capabilities.json', JSON.stringify({ contractVersion: 1, capabilities }, null, 2) + '\n'],
  ['docs/ui-next/inventory/parameters.json', JSON.stringify({ contractVersion: 1, parameters }, null, 2) + '\n'],
  ['docs/ui-next/REGISTER.md', markdown],
];
for (const [file, content] of outputs) {
  const absolute = path.join(root, file);
  if (process.argv.includes('--check')) {
    if (await readFile(absolute, 'utf8') !== content) throw new Error(file + ' is stale; regenerate and review.');
  } else await writeFile(absolute, content);
}
console.log('UI register: ' + capabilities.length + ' routes; ' + parameters.length + ' parameter contracts.');
