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
  // skipcq: JS-W1042 - Node's assertion API validates the argument count; the explicit expected argument is required.
  assert.equal(env.DASHBOARD_ALLOWED_ORIGIN, undefined);
  assert.equal(env.TRADING_ISOLATE_UNAVAILABLE_MARKET_FAILURES, 'false');
  assert.equal(env.CLOCK_MAX_DRIFT_MS, '1000');

  const legacyEnvironment = { CLOCK_MAX_DRIFT_MS: '450' };
  const legacyPath = path.join(directory, 'legacy-runtime-settings.json');
  await writeFile(legacyPath, JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 45_000, clockMaxDriftMs: undefined }));
  const legacyStore = new ManagedRuntimeSettingsStore(legacyPath, legacyEnvironment);
  await legacyStore.initialize();
  assert.equal(legacyStore.snapshot().clockMaxDriftMs, 450, 'Upgrade must preserve the existing host clock limit.');
  assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).clockMaxDriftMs, 450,
    'Upgrade must persist the inherited threshold before startup.');
  assert.equal(legacyStore.snapshot().shutdownGraceMs, 45_000, 'Migration must retain other runtime settings.');
  const withoutHostAfterMigration = {};
  const migratedRestart = new ManagedRuntimeSettingsStore(legacyPath, withoutHostAfterMigration);
  await migratedRestart.initialize();
  migratedRestart.applyToEnvironment();
  assert.equal(withoutHostAfterMigration.CLOCK_MAX_DRIFT_MS, '450',
    'Losing the old host variable after migration must not relax the guard on restart.');
  legacyStore.applyToEnvironment();
  assert.equal(legacyEnvironment.CLOCK_MAX_DRIFT_MS, '450');
  await legacyStore.set({ clockMaxDriftMs: 500 });
  assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).clockMaxDriftMs, 500);
  assert.equal(legacyStore.describe().active.clockMaxDriftMs, 450, 'Saving cannot change the active guard before restart.');
  const restartedLegacyStore = new ManagedRuntimeSettingsStore(legacyPath, legacyEnvironment);
  await restartedLegacyStore.initialize();
  restartedLegacyStore.applyToEnvironment();
  assert.equal(legacyEnvironment.CLOCK_MAX_DRIFT_MS, '500', 'A restart applies the saved bounded limit.');
  const newHostEnvironment = { CLOCK_MAX_DRIFT_MS: '350' };
  const newHostStore = new ManagedRuntimeSettingsStore(path.join(directory, 'new-host-runtime-settings.json'), newHostEnvironment);
  await newHostStore.initialize();
  assert.equal(newHostStore.snapshot().clockMaxDriftMs, 350, 'First startup must retain a valid host clock limit.');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'new-host-runtime-settings.json'), 'utf8')).clockMaxDriftMs, 350);
  const invalidLegacyPath = path.join(directory, 'invalid-legacy-clock.json');
  await writeFile(invalidLegacyPath, JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, clockMaxDriftMs: undefined }));
  const invalidLegacy = new ManagedRuntimeSettingsStore(invalidLegacyPath, { CLOCK_MAX_DRIFT_MS: '9000' });
  await invalidLegacy.initialize({ recoverInvalidFile: true });
  assert.equal(invalidLegacy.recoveryStatus().active, true,
    'An unsafe legacy host limit must require recovery instead of silently becoming 1000ms.');
  assert.match(invalidLegacy.recoveryStatus().reason, /CLOCK_MAX_DRIFT_MS must be an integer between 100 and 5000/);
  const writeFailurePath = path.join(directory, 'clock-migration-write-failure.json');
  await writeFile(writeFailurePath, JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, clockMaxDriftMs: undefined }));
  const failedMigration = new ManagedRuntimeSettingsStore(writeFailurePath, { CLOCK_MAX_DRIFT_MS: '450' });
  failedMigration.writeFile = async () => { throw new Error('simulated migration write failure'); };
  await failedMigration.initialize({ recoverInvalidFile: true });
  assert.equal(failedMigration.recoveryStatus().active, true,
    'A failed migration write must enter recovery rather than start with a relaxed guard.');
  assert.equal(failedMigration.snapshot().clockMaxDriftMs, 450,
    'Recovery must retain a valid legacy clock threshold while entries remain blocked.');
  assert.equal(JSON.parse(await readFile(writeFailurePath, 'utf8')).clockMaxDriftMs, undefined,
    'A failed migration must leave the old source unchanged.');
  const missingDuringWritePath = path.join(directory, 'clock-migration-enoent-write.json');
  const originalSettings = { ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 60_000, clockMaxDriftMs: undefined };
  await writeFile(missingDuringWritePath, JSON.stringify(originalSettings));
  const missingDuringWrite = new ManagedRuntimeSettingsStore(missingDuringWritePath, { CLOCK_MAX_DRIFT_MS: '450' });
  missingDuringWrite.writeFile = async () => {
    const error = new Error('simulated ENOENT during migration write');
    error.code = 'ENOENT';
    throw error;
  };
  await missingDuringWrite.initialize({ recoverInvalidFile: true });
  assert.equal(missingDuringWrite.recoveryStatus().active, true,
    'An ENOENT during migration write must not be mistaken for a missing original file.');
  assert.deepEqual(JSON.parse(await readFile(missingDuringWritePath, 'utf8')), JSON.parse(JSON.stringify(originalSettings)),
    'The legacy file and unrelated runtime values must survive migration write failure.');
  const explicitManaged = new ManagedRuntimeSettingsStore(legacyPath, { CLOCK_MAX_DRIFT_MS: '9000' });
  await explicitManaged.initialize();
  explicitManaged.applyToEnvironment();
  assert.equal(explicitManaged.snapshot().clockMaxDriftMs, 500,
    'An explicit managed setting takes precedence over a stale host variable.');

  const fixedPropertyEnv = {};
  Object.defineProperty(fixedPropertyEnv, 'DASHBOARD_ALLOWED_ORIGIN', {
    value: 'https://retained.example.invalid', writable: true, configurable: false, enumerable: true,
  });
  const fixedPropertyStore = new ManagedRuntimeSettingsStore(path.join(directory, 'fixed-property.json'), fixedPropertyEnv);
  await fixedPropertyStore.initialize();
  assert.throws(() => fixedPropertyStore.applyToEnvironment(), TypeError);
  assert.equal(fixedPropertyEnv.DASHBOARD_ALLOWED_ORIGIN, 'https://retained.example.invalid');
  assert.equal(fixedPropertyStore.describe().active, null,
    'A failed environment update must not report unapplied runtime settings as active.');

  const standalone = { ...store.snapshot(), shutdownGraceMs: 45_000, backupIntervalMs: 60_000 };
  await store.set(standalone);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).shutdownGraceMs, 45_000);
  const reloaded = new ManagedRuntimeSettingsStore(filePath, {});
  await reloaded.initialize();
  assert.equal(reloaded.snapshot().backupIntervalMs, 60_000);
  const before = store.describe();
  assert.equal(before.active.shutdownGraceMs, DEFAULT_RUNTIME_SETTINGS.shutdownGraceMs);
  assert.equal(before.restartRequired, true);
  assert.equal(before.parameters.length, 36);
  const clockParameter = before.parameters.find(parameter => parameter.path === 'clockMaxDriftMs');
  assert.deepEqual(clockParameter.range, [100, 5_000]);
  assert.equal(clockParameter.environmentName, 'CLOCK_MAX_DRIFT_MS');
  assert.equal(clockParameter.requiresRestart, true);
  const concurrent = await Promise.allSettled([
    store.set({ shutdownGraceMs: 50_000 }, before.revision),
    store.set({ shutdownGraceMs: 60_000 }, before.revision),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().backupIntervalMs, 60_000, 'Partial runtime updates retain untouched settings.');
  assert.equal(store.describe().active.shutdownGraceMs, DEFAULT_RUNTIME_SETTINGS.shutdownGraceMs, 'Saving does not pretend to apply startup settings.');

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
    'https://127.0.0.1:8080'
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
  for (const invalidClockLimit of [99, 5_001, 500.5, '500', null, false]) {
    assert.throws(() => validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, clockMaxDriftMs: invalidClockLimit }), /clockMaxDriftMs must be an integer between 100 and 5000/);
  }
  assert.equal(validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, clockMaxDriftMs: 100 }).clockMaxDriftMs, 100);
  assert.equal(validateRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, clockMaxDriftMs: 5_000 }).clockMaxDriftMs, 5_000);

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
