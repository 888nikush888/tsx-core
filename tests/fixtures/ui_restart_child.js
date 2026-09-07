import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startWebServer, stopWebServer } from '../../src/web_server.js';
import { createProcessRestartRequest } from '../../src/ui_restart_coordinator.js';
import { createRestartFixture, deferred } from './ui_restart_fixture.js';

const [directory, mode] = process.argv.slice(2);
globalThis.fetch = async () => { throw new Error('External/provider requests are disabled in the isolated restart fixture.'); };
const fixture = await createRestartFixture(directory);
const { app, store, controls, authority } = fixture;
const originalWork = { restart: app.stopForwarding, restore: app.restoreBackup, reset: app.performFactoryReset };
const checkpoint = async action => {
  const result = await action();
  await fs.writeFile(path.join(directory, 'state.txt'), mode === 'reset' ? 'first-run' : mode === 'restore' ? 'restored' : 'preserved');
  return result;
};
app.stopForwarding = () => checkpoint(originalWork.restart);
app.restoreBackup = () => checkpoint(originalWork.restore);
app.performFactoryReset = () => checkpoint(originalWork.reset);

if (mode === 'crash-after-receipt') {
  const run = store.runRestart.bind(store);
  store.runRestart = async (...args) => {
    await run(...args);
    process.send({ type: 'boundary', boundary: 'after-durable-receipt-before-restart' });
    return new Promise(() => {});
  };
}
if (mode === 'crash-before-receipt') {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to.endsWith('.json') && JSON.parse(await fs.readFile(from, 'utf8')).restart) {
      process.send({ type: 'boundary', boundary: 'after-command-before-durable-receipt' });
      await new Promise(() => {});
    }
    return rename(from, to);
  };
}
if (mode === 'disconnect') {
  const release = deferred(); controls.barrier = release.promise;
  void controls.entered.promise.then(() => process.send({ type: 'entered' }));
  process.on('message', message => { if (message.type === 'release') release.resolve(); });
}
if (mode === 'stalled-response') {
  controls.blockAudit = async event => {
    if (event.phase === 'completed') await new Promise(() => {});
  };
}
if (mode.startsWith('stalled-flush')) {
  app.auditTrail.flush = async () => {
    if (mode === 'stalled-flush-existing-error') process.exitCode = 23;
    await new Promise(() => {});
  };
}

app.requestRestart = createProcessRestartRequest(async () => {
  await fs.appendFile(path.join(directory, 'shutdown.log'), store.processInstanceId + '\n');
  process.send({ type: 'shutdown-started' });
  await stopWebServer();
  await app.auditTrail.flush?.();
  if (mode === 'shutdown-failure') throw new Error('Isolated shutdown failure.');
  await fs.writeFile(path.join(directory, 'shutdown-finished'), 'graceful');
}, mode.startsWith('stalled') ? 1_000 : 60_000);
const server = startWebServer(0, app);
server.once('listening', () => process.send({ type: 'ready', port: server.address().port, instanceId: store.processInstanceId,
  startup: authority.snapshot(), canEnter: authority.canEnter(), providerConnections: 0 }));
process.on('message', message => {
  if (message.type === 'stop') app.requestRestart();
});
