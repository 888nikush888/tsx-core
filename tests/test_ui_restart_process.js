import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ADMIN, VIEWER, COMMANDS, commandRequest } from './fixtures/ui_restart_fixture.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-restart-process-'));
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('tsx-restart-process-')) throw new Error('Unsafe process fixture cleanup.');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
const bounded = promise => Promise.race([promise, delay(10_000, null, { ref: false }).then(() => { throw new Error('Isolated process timed out.'); })]);

function launch(directory, mode) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(repository, 'tests/fixtures/ui_restart_child.js'), directory, mode], {
    cwd: repository, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      DASHBOARD_AUTH_MODE: 'token', DASHBOARD_ADMIN_TOKEN: ADMIN, DASHBOARD_VIEWER_TOKEN: VIEWER,
      CONFIG_PATH: path.join(repository, 'config.json.example'), LOG_DIR: path.join(directory, 'logs'), NODE_ENV: 'test',
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    },
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const messages = []; const waiters = new Map();
  child.on('message', message => { messages.push(message); waiters.get(message.type)?.(message); });
  const exited = once(child, 'exit').then(([code, signal]) => { children.delete(child); return { code, signal }; });
  const wait = type => {
    const prior = messages.find(message => message.type === type);
    return bounded(prior ? Promise.resolve(prior) : Promise.race([
      new Promise(resolve => waiters.set(type, resolve)),
      exited.then(() => { throw new Error(`Child exited before ${type}: ${output}`); }),
    ]));
  };
  return { child, wait, exited, output: () => output };
}

async function readiness(process, previousInstance) {
  const ready = await process.wait('ready');
  const response = await fetch(`http://127.0.0.1:${ready.port}/api/recovery`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(response.status, 200);
  const observed = await response.json();
  assert.equal(observed.startup.phase, 'ready', 'Replacement operator control plane has passed its isolated startup checks.');
  assert.equal(observed.startup.routingReady, false, 'Restart observation never implicitly enables routing/trading.');
  assert.equal(ready.canEnter, false);
  assert.equal(ready.providerConnections, 0);
  if (previousInstance) assert.notEqual(observed.serverInstanceId, previousInstance);
  assert.equal(observed.serverInstanceId, ready.instanceId);
  return ready;
}

async function verifyReplacement(directory, command, id, instance, expectedState, effects) {
  const replacement = launch(directory, 'replacement');
  const ready = await readiness(replacement, instance);
  const response = await fetch(`http://127.0.0.1:${ready.port}${command.route}`, commandRequest(command, id));
  assert.equal(response.status, 202);
  const replay = await response.json();
  assert.equal(replay.job.state, expectedState);
  assert.equal(replay.restartScheduled, false);
  assert.equal(replay.job.instanceId, instance);
  assert.equal(await readFile(path.join(directory, 'effects.log'), 'utf8'), effects, 'Replacement replay cannot repeat the irreversible command.');
  await delay(600);
  assert.equal(replacement.child.exitCode, null, 'A prior-generation receipt must not create a restart loop.');
  replacement.child.send({ type: 'stop' });
  assert.equal((await bounded(replacement.exited)).code, 0, replacement.output());
}

async function testRealRestart(command, mode, index) {
  const directory = path.join(root, `normal-${index}`); await mkdir(directory);
  const initial = launch(directory, mode); const ready = await readiness(initial);
  const id = `process-restart-job-${index}`;
  const options = commandRequest(command, id);
  if (mode === 'disconnect') {
    const client = http.request(`http://127.0.0.1:${ready.port}${command.route}`, options);
    client.on('error', () => {}); client.end(options.body);
    await initial.wait('entered');
    client.destroy();
    initial.child.send({ type: 'release' });
  } else {
    const response = await fetch(`http://127.0.0.1:${ready.port}${command.route}`, options);
    assert.equal(response.status, command.status); await response.json();
  }
  assert.equal((await bounded(initial.exited)).code, 0, initial.output());
  assert.equal(await readFile(path.join(directory, 'shutdown.log'), 'utf8'), ready.instanceId + '\n', 'The production shutdown coordinator runs once before real process exit.');
  const effects = await readFile(path.join(directory, 'effects.log'), 'utf8');
  assert.equal(effects, command.kind + '\n');
  const expected = mode === 'reset' ? 'first-run' : mode === 'restore' ? 'restored' : 'preserved';
  assert.equal(await readFile(path.join(directory, 'state.txt'), 'utf8'), expected);
  await verifyReplacement(directory, command, id, ready.instanceId, 'succeeded', effects);
}

async function testCrashBoundary(mode, expectedState) {
  const directory = path.join(root, mode); await mkdir(directory);
  const initial = launch(directory, mode); const ready = await readiness(initial);
  const command = COMMANDS[1]; const id = `process-${mode}`;
  const pending = fetch(`http://127.0.0.1:${ready.port}${command.route}`, commandRequest(command, id)).catch(() => null);
  await initial.wait('boundary');
  initial.child.kill('SIGKILL');
  await bounded(initial.exited); await pending;
  const effects = await readFile(path.join(directory, 'effects.log'), 'utf8');
  assert.equal(effects, 'backup-restore\n');
  await verifyReplacement(directory, command, id, ready.instanceId, expectedState, effects);
}

async function testShutdownFailure() {
  const directory = path.join(root, 'shutdown-failure'); await mkdir(directory);
  const child = launch(directory, 'shutdown-failure'); const ready = await readiness(child);
  child.child.send({ type: 'stop' }); child.child.send({ type: 'stop' });
  assert.equal((await bounded(child.exited)).code, 1);
  assert.equal(await readFile(path.join(directory, 'shutdown.log'), 'utf8'), ready.instanceId + '\n');
}

try {
  for (const [index, mode] of ['restart', 'restore', 'reset'].entries()) await testRealRestart(COMMANDS[index], mode, index);
  await testRealRestart(COMMANDS[1], 'disconnect', 3);
  await testCrashBoundary('crash-after-receipt', 'succeeded');
  await testCrashBoundary('crash-before-receipt', 'unknown');
  await testShutdownFailure();
  console.log('Real isolated child-process restart/restore/reset, disconnected restore, crash boundaries, new-generation HTTP readiness and no implicit trading/replay passed.');
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => once(child, 'exit')));
  await rm(root, { recursive: true, force: true });
}
