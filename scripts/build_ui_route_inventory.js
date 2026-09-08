import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'src/web_server.ts'), 'utf8');
const tree = ts.createSourceFile('web_server.ts', source, ts.ScriptTarget.Latest, true);
const definitions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) definitions.set(node.name.text, node.getText(tree));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) definitions.set(node.name.text, node.initializer?.getText(tree) ?? '');
  ts.forEachChild(node, visit);
}
visit(tree);
const variants = {
  'GET /api/trading': 'view=overview: current global counts/runtime; view=accounts: 30-row active account cursor page; view=cockpit: bounded activity metadata; omitted view retains legacy builder compatibility',
  'GET /api/mcp': 'view=operator: independent agentsCursor|proposalsCursor|sessionsCursor|actionsCursor, proposalsStatus and selected agentId; omitted view retains compatibility',
  'POST /api/control': 'action=start|stop',
  'POST /api/trading/runtime': 'action=execution|live uses enabled=true|false; action=kill-switch uses active=true|false and reason when activating; live/release require exact written confirmation',
  'POST /api/access-tokens': 'role=admin|viewer; newly issued credential is returned only once',
  'POST /api/telegram-login': 'answer to current prompt: phoneNumber|emailAddress|emailCode|authCode|password|name|otherDeviceConfirmation',
  'POST /api/trading/accounts': 'mode=paper|testnet|live; certified exchange/mode; credentials separate',
  'POST /api/trading/accounts/state': 'enabled=true|false',
  'POST /api/trading/accounts/kill-switch/release': 'confirmation=RELEASE ACCOUNT KILL SWITCH; fresh reconciliation and identity proof required',
  'POST /api/trading/emergency-flatten': 'accountId optional; exact confirmation from trading snapshot; market reduction requires ownership proof',
  'POST /api/trading/paper': 'accountId, balance configuration and markets; content revision for each',
  'DELETE /api/workflow/resources': 'operation=archive|delete; resourceId family or id version; permanent deletion requires family ID and stronger confirmation',
  'POST /api/workflow/resources/publish': 'publishDependencies=false|true; true binds publicationHash and baseEditRevision',
  'POST /api/workflow/models': 'kind=strategy|schema|contract; action=attach|publish|archive|delete|enable|disable; schema only supports attach, delete, enable, disable',
  'GET /api/workflow/models': 'kind=strategy|schema|contract; list or original id detail',
  'GET /api/workflow/objects': 'kind=resources|revisions|paths; list or original id detail',
  'POST /api/workflow/history/impact': 'direction=undo|redo; baseRevisionId',
  'POST /api/workflow/history/apply': 'direction=undo|redo; exact baseRevisionId and impact confirmation',
  'GET /api/trading/objects': 'kind=accounts|positions|orders|operations|incidents|reconciliations|risk-events; status dimension belongs to kind',
  'GET /api/trading/intents/relations': 'kind=orders|fills|money|events; exact intentId',
  'GET /api/signals/ingress/relations': 'kind=albums|members|plans|signals|attempts|runs|branches|fallbacks|candidates|intents|tasks; exact original work id',
  'GET /api/trading/risk/adaptive': 'kind=states|evaluations|paths|sources|legacy|legacy-evaluations; source evaluation id; paths require stateKey',
  'GET /api/trading/accounts/evidence': 'kind=overview|reservations|history; exact accountId',
  'POST /api/mcp/runtime': 'mode=active|standby|disabled; active and disabled require their specific confirmation',
  'GET /api/ui/search': 'kind=all|accounts|ingress|signals|intents|resources|incidents|settings; text only in X-UI-Search header',
};
const adminReads = new Set(['GET /api/workflow/history', 'GET /api/mcp', 'GET /api/mcp/proposals/detail', 'GET /api/setup-bundle/review']);
const recoveryText = definitions.get('recoveryAllowsRoute');
const recovery = new Set([...recoveryText.matchAll(/'(GET|POST|DELETE) (\/api\/[^']+)'/g)].map(match => `${match[1]} ${match[2]}`));
const routes = [...definitions.get('API_ROUTES').matchAll(/\['((?:GET|POST|DELETE) \/api\/[^']+)', ([^\r\n]+)\],/g)].map(match => {
  const route = match[1]; const handler = match[2];
  const body = definitions.get(handler.split('(')[0]);
  if (!body) throw new Error(`Missing handler source: ${handler}`);
  const confirmations = [...body.matchAll(/requireConfirmation\(\s*context,\s*'([^']+)'/g)].map(value => value[1]);
  return { route, handler, handlerSha256: createHash('sha256').update(body.replaceAll('\r\n', '\n')).digest('hex'),
    role: !route.startsWith('GET ') || adminReads.has(route) ? 'admin' : 'viewer',
    recoveryAllowed: recovery.has(route), confirmationHeaders: [...new Set(confirmations)],
    inputVariants: variants[route] ?? 'Single route contract; object identifiers, validated payload and query filters remain authoritative in the referenced handler.' };
});
const inventory = { contractVersion: 1, source: 'src/web_server.ts API_ROUTES', routes,
  bootstrap: [
    { route: 'GET /api/bootstrap/status', boundary: 'Public configuration status; never grants a local session.' },
    { route: 'POST /api/bootstrap', boundary: 'Only before durable auth is configured; allowed origin plus direct loopback or one-time bootstrap proof.' },
    { route: 'POST /api/local-session', boundary: 'Direct trusted loopback and allowed origin; configured installations require an existing durable admin bearer. Separate bounded recovery bootstrap exception.' },
  ] };
const generated = `// Generated by scripts/build_ui_route_inventory.js; edit mappings and validators, then regenerate.\nexport const UI_ROUTE_INVENTORY = [\n${routes.map(row => `  ${JSON.stringify(row)},`).join('\n')}\n];\n`;
const outputs = [['src/ui_route_inventory.ts', generated], ['docs/ui-next/inventory/api-routes.json', `${JSON.stringify(inventory, null, 2)}\n`]];
for (const [file, content] of outputs) {
  const absolute = path.join(root, file);
  if (process.argv.includes('--check')) {
    if (await readFile(absolute, 'utf8') !== content) throw new Error(`${file} is stale; regenerate and review the contract mapping.`);
  } else await writeFile(absolute, content);
}
console.log(`UI route inventory: ${routes.length} authenticated routes and 3 bootstrap/session boundaries.`);
