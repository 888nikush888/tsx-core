import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyEnvContent, resolveSecretFiles, validateTelegramApiId } from '../src/env.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-env-test-'));
try {
  const env = { EXISTING: 'orchestrator-value' };
  applyEnvContent('EXISTING=file-value\nNEW_VALUE="value=with=equals"\ninvalid-key=x\n', env);
  assert.equal(env.EXISTING, 'orchestrator-value', 'Process environment must override .env');
  assert.equal(env.NEW_VALUE, 'value=with=equals');
  assert.equal(env['invalid-key'], undefined);

  const secretPath = path.join(root, 'admin-token');
  await writeFile(secretPath, `${'a'.repeat(64)}\n`, { encoding: 'utf8', mode: 0o600 });
  const secretEnv = { DASHBOARD_ADMIN_TOKEN_FILE: secretPath };
  resolveSecretFiles(secretEnv);
  assert.equal(secretEnv.DASHBOARD_ADMIN_TOKEN, 'a'.repeat(64));
  assert.equal(secretEnv.DASHBOARD_ADMIN_TOKEN_FILE, undefined, 'Secret file reference must be consumed');

  assert.throws(
    () => resolveSecretFiles({ OPENROUTER_API_KEY: 'direct', OPENROUTER_API_KEY_FILE: secretPath }),
    /cannot both be configured/
  );
  const multilinePath = path.join(root, 'multiline-secret');
  await writeFile(multilinePath, 'first\nsecond\n', 'utf8');
  assert.throws(
    () => resolveSecretFiles({ TELEGRAM_API_HASH_FILE: multilinePath }),
    /exactly one non-empty secret line/
  );
  assert.throws(
    () => resolveSecretFiles({ DASHBOARD_VIEWER_TOKEN_FILE: path.join(root, 'missing') }),
    /ENOENT/
  );

  const emptyPath = path.join(root, 'empty-secret');
  await writeFile(emptyPath, '', 'utf8');
  assert.throws(
    () => resolveSecretFiles({ ALERT_RELAY_TOKEN_FILE: emptyPath }),
    /non-empty regular file/
  );

  const previousApiId = process.env.TELEGRAM_API_ID;
  try {
    process.env.TELEGRAM_API_ID = '-1';
    validateTelegramApiId();
    assert.equal(process.env.TELEGRAM_API_ID, undefined);
    process.env.TELEGRAM_API_ID = ' 42 ';
    validateTelegramApiId();
    assert.equal(process.env.TELEGRAM_API_ID, '42');
  } finally {
    if (previousApiId === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = previousApiId;
  }

  console.log('ALL FILE-BACKED SECRET TESTS PASSED!');
} finally {
  await rm(root, { recursive: true, force: true });
}
