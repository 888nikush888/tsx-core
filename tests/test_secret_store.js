import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedSecretStore } from '../src/secret_store.js';
import { enterpriseMode } from '../src/runtime_profile.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'forwarder-secrets-'));
try {
  const env = {};
  const store = new ManagedSecretStore(directory, env);
  await store.initialize();
  assert.equal(store.status().telegramApiHash.configured, false);
  assert.equal(store.status().dashboardAdminToken.editable, true);
  assert.equal(store.status().dashboardViewerToken.configured, false);

  await assert.rejects(store.set({}), /At least one/);
  await assert.rejects(store.set({ unknownSecret: 'value' }), /Unknown managed secret/);
  await assert.rejects(store.set({ telegramApiHash: 'invalid' }), /32 hexadecimal/);
  await assert.rejects(store.set({ backupEncryptionKey: 'not-base64' }), /canonical base64/);
  await store.set({
    telegramApiHash: 'a'.repeat(32),
    openRouterApiKey: 'realistic-test-key-1234567890',
  });
  assert.equal(env.TELEGRAM_API_HASH, 'a'.repeat(32));
  assert.equal(store.status().openRouterApiKey.source, 'managed');
  assert.equal((await readFile(path.join(directory, 'telegram_api_hash'), 'utf8')).trim(), 'a'.repeat(32));
  await store.set({ openRouterApiKey: 'updated-realistic-test-key-1234567890' });
  assert.equal(env.OPENROUTER_API_KEY, 'updated-realistic-test-key-1234567890');

  const token = await store.createDashboardAdminToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  await assert.rejects(store.createDashboardAdminToken(), /already configured/);
  assert.equal(await store.getOrCreateDashboardAdminToken(), token);
  const rotatedAdmin = await store.rotateDashboardToken('admin');
  assert.match(rotatedAdmin, /^[a-f0-9]{64}$/);
  assert.notEqual(rotatedAdmin, token);
  const viewer = await store.rotateDashboardToken('viewer');
  assert.match(viewer, /^[a-f0-9]{64}$/);
  assert.equal(store.status().dashboardViewerToken.configured, true);
  await store.removeDashboardViewerToken();
  assert.equal(store.status().dashboardViewerToken.configured, false);
  await store.set({
    auditWebhookToken: 'audit-token-0123456789abcdef0123456789abcdef',
    alertRelayToken: 'relay-token-0123456789abcdef0123456789abcdef',
    alertWebhookToken: 'alert-token-0123456789abcdef0123456789abcdef',
    backupOffsiteToken: 'backup-token-0123456789abcdef0123456789abcdef',
    backupEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
  });
  assert.equal(store.status().backupEncryptionKey.source, 'managed');
  assert.equal(store.status().backupEncryptionKey.editable, false);
  await store.set({ backupEncryptionKey: Buffer.alloc(32, 7).toString('base64') });
  await assert.rejects(
    store.set({ backupEncryptionKey: Buffer.alloc(32, 8).toString('base64') }),
    /immutable.*unrecoverable/
  );

  const reloadedEnv = {};
  const reloaded = new ManagedSecretStore(directory, reloadedEnv);
  await reloaded.initialize();
  assert.equal(reloadedEnv.OPENROUTER_API_KEY, 'updated-realistic-test-key-1234567890');
  assert.equal(reloaded.status().dashboardAdminToken.source, 'managed');
  assert.equal(reloaded.status().auditWebhookToken.source, 'managed');

  const externalDirectory = path.join(directory, 'external');
  const externalEnv = { TELEGRAM_API_HASH: 'b'.repeat(32) };
  const external = new ManagedSecretStore(externalDirectory, externalEnv);
  await external.initialize();
  assert.equal(external.status().telegramApiHash.editable, false);
  assert.throws(() => external.assertClearable(), /externally managed secrets/);
  await assert.rejects(external.set({ telegramApiHash: 'c'.repeat(32) }), /externally managed/);
  await assert.rejects(external.clear(), /externally managed secrets/);
  const externalAdmin = new ManagedSecretStore(path.join(directory, 'external-admin'), {
    DASHBOARD_ADMIN_TOKEN: 'external-admin-token-0123456789abcdef0123456789abcdef'
  });
  await externalAdmin.initialize();
  await assert.rejects(externalAdmin.getOrCreateDashboardAdminToken(), /externally managed administrator/);
  await assert.rejects(externalAdmin.rotateDashboardToken('admin'), /externally managed/);

  await reloaded.clear();
  assert.ok(Object.values(reloaded.status()).every(status => status.source === 'missing'));
  assert.equal(reloadedEnv.DASHBOARD_ADMIN_TOKEN, undefined);

  const automatic = new ManagedSecretStore(path.join(directory, 'automatic'), {});
  await automatic.initialize();
  assert.match(await automatic.getOrCreateDashboardAdminToken(), /^[a-f0-9]{64}$/);

  await store.set({ openRouterApiKey: 'updated-again-realistic-test-key-1234567890' });
  await writeFile(path.join(directory, 'openrouter_api_key'), 'bad\nmultiline\n');
  await assert.rejects(new ManagedSecretStore(directory, {}).initialize(), /OpenRouter API key/);

  assert.equal(enterpriseMode({}), false);
  assert.equal(enterpriseMode({ ENTERPRISE_MODE: 'true' }), true);
  assert.throws(() => enterpriseMode({ ENTERPRISE_MODE: 'yes' }), /true or false/);
  console.log('Managed web secret store tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
