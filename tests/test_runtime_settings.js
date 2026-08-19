import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RUNTIME_SETTINGS,
  ManagedRuntimeSettingsStore,
  managedRuntimeSettingsFromEnvironment,
  validateRuntimeSettings,
} from '../src/runtime_settings.js';
import { retentionPolicyFromEnvironment } from '../src/retention.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'forwarder-runtime-settings-'));
try {
  const env = {};
  const filePath = path.join(directory, 'runtime-settings.json');
  const store = new ManagedRuntimeSettingsStore(filePath, env);
  await store.initialize();
  assert.deepEqual(store.snapshot(), DEFAULT_RUNTIME_SETTINGS);
  store.applyToEnvironment();
  assert.equal(env.ENTERPRISE_MODE, 'false');
  assert.equal(env.DASHBOARD_LOCAL_TRUST, 'true');
  assert.equal(env.DASHBOARD_ALLOWED_ORIGIN, undefined);
  assert.equal(env.TRADING_ISOLATE_UNAVAILABLE_MARKET_FAILURES, 'false');

  const standalone = { ...store.snapshot(), shutdownGraceMs: 45_000, backupIntervalMs: 60_000 };
  await store.set(standalone);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).shutdownGraceMs, 45_000);
  const reloaded = new ManagedRuntimeSettingsStore(filePath, {});
  await reloaded.initialize();
  assert.equal(reloaded.snapshot().backupIntervalMs, 60_000);

  assert.throws(
    () => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, enterpriseMode: true }),
    /requires OIDC/
  );
  const enterprise = validateRuntimeSettings({
    ...DEFAULT_RUNTIME_SETTINGS,
    enterpriseMode: true,
    dashboardAuthMode: 'oidc',
    dashboardLocalTrust: false,
    oidcIssuer: 'https://identity.example.com',
    oidcAudience: 'forwarder',
    oidcJwksUrl: 'https://identity.example.com/jwks',
    auditWebhookUrl: 'https://audit.example.com/events',
    alertWebhookUrl: 'https://incident.example.com/alerts',
    auditRemoteRequired: true,
    backupOffsiteUrlTemplate: 'https://backup.example.com/{artifact}',
    backupOffsiteRequired: true,
    backupOffsiteRetentionDays: 30,
  });
  assert.equal(enterprise.enterpriseMode, true);
  assert.throws(
    () => validateRuntimeSettings({ ...enterprise, backupOffsiteUrlTemplate: 'https://backup.example.com/static' }),
    /exactly one \{artifact\}/
  );
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, unexpected: true }), /Unknown runtime setting/);
  assert.throws(() => validateRuntimeSettings(null), /JSON object/);
  assert.throws(() => validateRuntimeSettings([]), /JSON object/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, enterpriseMode: 'true' }), /true or false/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAuthMode: 'basic' }), /token, oidc or tailscale/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardLocalTrust: 'yes' }), /true or false/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, auditRemoteRequired: 'yes' }), /true or false/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, backupOffsiteRequired: 'yes' }), /true or false/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, jsonLogging: 'yes' }), /true or false/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, isolateUnavailableMarketFailures: 'yes' }), /true or false/);
  assert.throws(() => validateRuntimeSettings({ ...enterprise, dashboardLocalTrust: true }), /disable trusted local/);
  assert.throws(() => validateRuntimeSettings({ ...enterprise, auditRemoteRequired: false }), /remote audit/);
  assert.throws(() => validateRuntimeSettings({ ...enterprise, backupOffsiteRequired: false }), /off-site backup/);
  assert.throws(() => validateRuntimeSettings({ ...enterprise, backupOffsiteRetentionDays: 29 }), /30 days/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, backupOffsiteMaxRecoveryBytes: 1024 * 1024 - 1 }), /backupOffsiteMaxRecoveryBytes/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAuthMode: 'oidc' }), /oidcIssuer is required/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAllowedOrigin: 'https://user@example.com' }), /credentials/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAllowedOrigin: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAllowedOrigin: 'https://example.com/path' }), /scheme, host/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAllowedOrigin: 'https://example.com/#fragment' }), /fragment/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, oidcAudience: 'invalid\naudience' }), /invalid/);
  assert.equal(
    validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dashboardAllowedOrigin: 'http://127.0.0.1:8080' })
      .dashboardAllowedOrigin,
    'http://127.0.0.1:8080'
  );
  const tailscale = validateRuntimeSettings({
    ...DEFAULT_RUNTIME_SETTINGS,
    dashboardAuthMode: 'tailscale',
    dashboardLocalTrust: false,
    tailscaleServeTrustedProxy: true,
    dashboardAllowedOrigin: 'https://tsx-core.example-tailnet.ts.net',
    tailscaleAdminUsers: 'Operator@Example.com',
    tailscaleViewerUsers: 'observer@example.com',
  });
  assert.equal(tailscale.tailscaleAdminUsers, 'operator@example.com');
  assert.equal(tailscale.dashboardAllowedOrigin, 'https://tsx-core.example-tailnet.ts.net');
  assert.throws(
    () => validateRuntimeSettings({ ...tailscale, tailscaleServeTrustedProxy: false }),
    /trusted Serve proxy/,
  );
  assert.throws(
    () => validateRuntimeSettings({ ...tailscale, dashboardAllowedOrigin: 'https://dashboard.example.com' }),
    /\*\.ts\.net/,
  );
  assert.throws(
    () => validateRuntimeSettings({ ...tailscale, tailscaleViewerUsers: 'operator@example.com' }),
    /both administrator and viewer/,
  );
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, oidcRoleClaim: 'invalid claim' }), /roleClaim/i);
  assert.throws(
    () => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, oidcAdminRole: 'same', oidcViewerRole: 'same' }),
    /must be different/
  );
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 999 }), /between 1000 and 120000/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 120001 }), /between 1000 and 120000/);
  assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 1.5 }), /integer/);

  const retentionBoundary = {
    ...DEFAULT_RUNTIME_SETTINGS,
    dataRetentionIntervalMs: 300_000,
    dataRetentionBatchSize: 100,
    dataMinFreeBytes: 64 * 1024 * 1024,
  };
  await store.set(retentionBoundary);
  store.applyToEnvironment();
  assert.deepEqual(retentionPolicyFromEnvironment(env), {
    retentionDays: retentionBoundary.dataRetentionDays,
    intervalMs: retentionBoundary.dataRetentionIntervalMs,
    batchSize: retentionBoundary.dataRetentionBatchSize,
    minFreeBytes: retentionBoundary.dataMinFreeBytes,
  });
  assert.throws(
    () => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dataRetentionIntervalMs: 299_999 }),
    /dataRetentionIntervalMs/
  );
  assert.throws(
    () => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dataRetentionBatchSize: 99 }),
    /dataRetentionBatchSize/
  );
  assert.throws(
    () => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dataRetentionBatchSize: 10_001 }),
    /dataRetentionBatchSize/
  );
  assert.throws(
    () => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, dataMinFreeBytes: 64 * 1024 * 1024 - 1 }),
    /dataMinFreeBytes/
  );

  const derived = managedRuntimeSettingsFromEnvironment({ RUNTIME_SETTINGS_PATH: path.join(directory, 'derived.json') });
  await derived.initialize();
  assert.deepEqual(derived.snapshot(), DEFAULT_RUNTIME_SETTINGS);
  const invalidFileStore = new ManagedRuntimeSettingsStore(directory, {});
  await assert.rejects(invalidFileStore.initialize(), /small regular file/);

  const corruptedPath = path.join(directory, 'corrupted-runtime-settings.json');
  await writeFile(corruptedPath, '{not valid JSON');
  const recoveryStore = new ManagedRuntimeSettingsStore(corruptedPath, {});
  await recoveryStore.initialize({ recoverInvalidFile: true });
  assert.equal(recoveryStore.recoveryStatus().active, true);
  assert.equal(recoveryStore.snapshot().dashboardLocalTrust, false, 'Recovery defaults must not silently enable trusted local startup.');
  await recoveryStore.set(DEFAULT_RUNTIME_SETTINGS);
  assert.equal(recoveryStore.recoveryStatus().active, false);
  assert.deepEqual(JSON.parse(await readFile(corruptedPath, 'utf8')), DEFAULT_RUNTIME_SETTINGS);

  await store.reset();
  assert.deepEqual(store.snapshot(), DEFAULT_RUNTIME_SETTINGS);
  console.log('Managed runtime settings tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
