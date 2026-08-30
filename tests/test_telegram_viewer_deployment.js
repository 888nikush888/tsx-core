import assert from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const forwarder = await readFile(path.join(root, 'src', 'forwarder.ts'), 'utf8');
const viewerDirectory = path.join(root, 'src', 'telegram_viewer');
const viewerSource = (await Promise.all(
  (await readdir(viewerDirectory)).filter(name => name.endsWith('.ts'))
    .map(name => readFile(path.join(viewerDirectory, name), 'utf8')),
)).join('\n');

function service(name, next) {
  const start = compose.indexOf(`\n  ${name}:`);
  const end = next ? compose.indexOf(`\n  ${next}:`, start + 1) : compose.indexOf('\nvolumes:', start + 1);
  assert.ok(start >= 0 && end > start, `${name} service must exist`);
  return compose.slice(start, end);
}

const forwarderService = service('forwarder', 'exchange-executor');
const executorService = service('exchange-executor', 'mcp-server');
const mcpService = service('mcp-server', 'telegram-viewer');
const viewerService = service('telegram-viewer');

assert.match(compose, /^networks:\s*$/m);
assert.match(compose, /^[ ]{2}core-network:\s*$/m);
assert.match(compose, /^[ ]{2}viewer-network:\s*$/m);
assert.match(forwarderService, /networks:\s*\n\s+- core-network\s*\n\s+- viewer-network/);
assert.match(executorService, /networks:\s*\n\s+- core-network/);
assert.doesNotMatch(executorService, /viewer-network/);
assert.match(mcpService, /networks:\s*\n\s+- core-network/);
assert.doesNotMatch(mcpService, /viewer-network/);
assert.match(viewerService, /networks:\s*\n\s+- viewer-network/);
assert.doesNotMatch(viewerService, /core-network/);
assert.doesNotMatch(viewerService, /^\s+ports:/m, 'Viewer must not publish a host port');
assert.match(viewerService, /command:\s*\["dist\/telegram_viewer\/runtime\.js"\]/);
assert.match(viewerService, /telegram_viewer_secrets:\/app\/secrets:ro/);
assert.match(viewerService, /telegram_viewer_state:\/app\/state/);
assert.match(viewerService, /TELEGRAM_VIEWER_STATE_DB:\s*["']?\/app\/state\/viewer_state\.db["']?/);
assert.match(viewerService, /\/healthz/);
assert.doesNotMatch(viewerService, /forwarder_secrets|EXCHANGE_EXECUTOR|MCP_/);
assert.match(viewerService, /condition:\s*service_healthy/);
assert.match(viewerService, /read_only:\s*true/);
assert.match(viewerService, /no-new-privileges:true/);
assert.match(viewerService, /cap_drop:\s*\n\s+- ALL/);
assert.match(forwarderService, /telegram_viewer_secrets:\/app\/telegram_viewer_secrets/);
assert.doesNotMatch(forwarderService, /depends_on:[\s\S]*exchange-executor/, 'Forwarder startup must not depend on executor health');
assert.match(compose, /^[ ]{2}telegram_viewer_secrets:\s*$/m);
assert.match(compose, /^[ ]{2}telegram_viewer_state:\s*$/m);
assert.match(dockerfile, /\/runtime\/app\/state/);
assert.match(dockerfile, /\/runtime\/app\/telegram_viewer_secrets/);
assert.strictEqual(packageJson.scripts['start:telegram-viewer'], 'node dist/telegram_viewer/runtime.js');
assert.match(forwarder, /telegramViewerSettingsFromEnvironment/);
assert.match(forwarder, /telegramViewerSecretStoreFromEnvironment/);
assert.doesNotMatch(viewerSource, /from ['"]\.\.\/(trading_engine|trading_runtime|ccxt_exchange|mcp_|trading_credentials)/);
assert.doesNotMatch(viewerSource, /credential_ref|MANAGED_SECRET_DIR|EXCHANGE_EXECUTOR_URL/);

console.log('TELEGRAM VIEWER DEPLOYMENT BOUNDARIES PASSED');
