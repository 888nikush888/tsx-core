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

  await assert.rejects(store.set({ telegramApiHash: 'invalid' }), /32 hexadecimal/);
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

  const reloadedEnv = {};
  const reloaded = new ManagedSecretStore(directory, reloadedEnv);
  await reloaded.initialize();
  assert.equal(reloadedEnv.OPENROUTER_API_KEY, 'updated-realistic-test-key-1234567890');
  assert.equal(reloaded.status().dashboardAdminToken.source, 'managed');

  const externalDirectory = path.join(directory, 'external');
  const externalEnv = { TELEGRAM_API_HASH: 'b'.repeat(32) };
  const external = new ManagedSecretStore(externalDirectory, externalEnv);
  await external.initialize();
  assert.equal(external.status().telegramApiHash.editable, false);
  await assert.rejects(external.set({ telegramApiHash: 'c'.repeat(32) }), /externally managed/);

  await writeFile(path.join(directory, 'openrouter_api_key'), 'bad\nmultiline\n');
  await assert.rejects(new ManagedSecretStore(directory, {}).initialize(), /OpenRouter API key/);

  assert.equal(enterpriseMode({}), false);
  assert.equal(enterpriseMode({ ENTERPRISE_MODE: 'true' }), true);
  assert.throws(() => enterpriseMode({ ENTERPRISE_MODE: 'yes' }), /true or false/);
  console.log('Managed web secret store tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
