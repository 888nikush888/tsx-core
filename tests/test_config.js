import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  canonicalizeResolvedSources,
  configurationPathFromEnvironment,
  readConfig,
  readConfigSync,
  validateConfig,
  writeConfig,
  writeConfigSync
} from '../src/config.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-config-'));

try {
  const distributionConfig = validateConfig(JSON.parse(await readFile(path.resolve('config.json.example'), 'utf8')));
  assert.deepEqual(distributionConfig.sourceChannels, []);
  assert.equal(distributionConfig.targetChannel, '');
  assert.deepEqual(distributionConfig.sourceFilters, {});
  assert.deepEqual(distributionConfig.sourceAliases, {});
  assert.deepEqual(distributionConfig.xmlParsing.sourceTemplates, {});
  assert.equal(distributionConfig.xmlParsing.enabled, false);

  assert.equal(configurationPathFromEnvironment({ CONFIG_PATH: './persistent/config.json' }), path.resolve('persistent/config.json'));
  const syncPath = path.join(root, 'sync.json');
  const syncConfig = structuredClone(DEFAULT_CONFIG);
  syncConfig.apiId = 12345;
  syncConfig.apiHash = 'must-not-be-persisted';
  writeConfigSync(syncConfig, syncPath);

  const savedSync = JSON.parse(await readFile(syncPath, 'utf8'));
  assert.equal(savedSync.apiId, 12345);
  assert.equal(savedSync.apiHash, undefined);
  assert.equal(readConfigSync(syncPath).apiId, 12345);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);

  const asyncPath = path.join(root, 'async.json');
  const asyncConfig = structuredClone(DEFAULT_CONFIG);
  asyncConfig.targetChannel = '@valid_target';
  await writeConfig(asyncConfig, asyncPath);
  assert.equal((await readConfig(asyncPath)).targetChannel, '@valid_target');

  const malformedValues = structuredClone(DEFAULT_CONFIG);
  malformedValues.apiId = -7;
  malformedValues.apiHash = 'remove-me';
  malformedValues.forwardOptions = { maxConcurrency: 0, queueTimeoutSeconds: 100_000 };
  malformedValues.xmlParsing.primaryModel = '../invalid model';
  malformedValues.xmlParsing.sourceTemplates = ['not-a-map'];
  malformedValues.xmlParsing.aiLimits = [];
  malformedValues.sourceFilters = ['not-a-map'];
  malformedValues.sourceAliases = ['not-a-map'];
  const sanitized = validateConfig(malformedValues);
  assert.equal(sanitized.apiId, 0);
  assert.equal(sanitized.apiHash, undefined);
  assert.equal(sanitized.forwardOptions.maxConcurrency, DEFAULT_CONFIG.forwardOptions.maxConcurrency);
  assert.equal(sanitized.forwardOptions.queueTimeoutSeconds, DEFAULT_CONFIG.forwardOptions.queueTimeoutSeconds);

  const shortQueue = structuredClone(DEFAULT_CONFIG);
  shortQueue.forwardOptions.queueTimeoutSeconds = 10;
  shortQueue.xmlParsing.enabled = true;
  shortQueue.xmlParsing.aiLimits.requestTimeoutMs = 30_000;
  const raised = validateConfig(shortQueue);
  assert.equal(raised.forwardOptions.queueTimeoutSeconds, 35);

  const parserDisabled = structuredClone(shortQueue);
  parserDisabled.forwardOptions.queueTimeoutSeconds = 10;
  parserDisabled.xmlParsing.enabled = false;
  const untouched = validateConfig(parserDisabled);
  assert.equal(untouched.forwardOptions.queueTimeoutSeconds, 10, "queue timeout must stay operator-controlled while the AI parser is disabled");
  assert.equal(sanitized.xmlParsing.primaryModel, DEFAULT_CONFIG.xmlParsing.primaryModel);
  assert.deepEqual(sanitized.xmlParsing.sourceTemplates, {});
  assert.deepEqual(sanitized.xmlParsing.aiLimits, DEFAULT_CONFIG.xmlParsing.aiLimits);
  assert.deepEqual(sanitized.sourceFilters, {});
  assert.deepEqual(sanitized.sourceAliases, {});
  assert.throws(() => validateConfig(null), /root must be a JSON object/);
  assert.throws(
    () => validateConfig({ ...structuredClone(DEFAULT_CONFIG), xmlParsing: { ...DEFAULT_CONFIG.xmlParsing, enabled: 'false' } }),
    /xmlParsing.enabled must be true or false/
  );
  assert.throws(
    () => validateConfig({ ...structuredClone(DEFAULT_CONFIG), xmlParsing: { ...DEFAULT_CONFIG.xmlParsing, externalDataPolicyAccepted: 'yes' } }),
    /externalDataPolicyAccepted must be true or false/
  );
  assert.throws(
    () => validateConfig({ ...structuredClone(DEFAULT_CONFIG), forwardOptions: { ...DEFAULT_CONFIG.forwardOptions, forwardToTarget: 'false' } }),
    /forwardOptions.forwardToTarget must be true or false/
  );
  assert.throws(
    () => validateConfig({ ...structuredClone(DEFAULT_CONFIG), surpriseSecret: 'must-not-persist' }),
    /Unknown configuration field/
  );

  const missingPath = path.join(root, 'created-on-read.json');
  assert.deepEqual(readConfigSync(missingPath).sourceChannels, []);
  assert.equal(JSON.parse(await readFile(missingPath, 'utf8')).apiId, 0);

  const malformedPath = path.join(root, 'malformed.json');
  await writeFile(malformedPath, '{not-json', 'utf8');
  assert.throws(() => readConfigSync(malformedPath), /Failed to read configuration/);
  assert.equal(await readFile(malformedPath, 'utf8'), '{not-json');

  const unwritablePath = path.join(root, 'missing-directory', 'config.json');
  assert.throws(() => writeConfigSync(DEFAULT_CONFIG, unwritablePath));
  await assert.rejects(() => writeConfig(DEFAULT_CONFIG, unwritablePath));

  const usernameConfig = structuredClone(DEFAULT_CONFIG);
  usernameConfig.sourceChannels = ['@alpha_source', '-1002'];
  usernameConfig.sourceFilters = {
    '@alpha_source': { regexPatterns: ['LONG'] },
    '-1002': { regexPatterns: ['SHORT'] }
  };
  usernameConfig.sourceAliases = { '@alpha_source': 'Alpha' };
  usernameConfig.xmlParsing.sourceTemplates = { '@alpha_source': 'alpha-template' };
  const canonicalized = canonicalizeResolvedSources(usernameConfig, [
    { configured: '@alpha_source', canonicalId: '-1001' },
    { configured: '-1002', canonicalId: '-1002' }
  ]);
  assert.equal(canonicalized.changed, true);
  assert.deepEqual(canonicalized.config.sourceChannels, ['-1001', '-1002']);
  assert.deepEqual(canonicalized.config.sourceFilters['-1001'], { regexPatterns: ['LONG'] });
  assert.equal(canonicalized.config.sourceAliases['-1001'], 'Alpha');
  assert.equal(canonicalized.config.xmlParsing.sourceTemplates['-1001'], 'alpha-template');
  assert.equal(canonicalized.config.sourceFilters['@alpha_source'], undefined);

  const automaticAlias = structuredClone(DEFAULT_CONFIG);
  automaticAlias.sourceChannels = ['@named_source'];
  const aliased = canonicalizeResolvedSources(automaticAlias, [
    { configured: '@named_source', canonicalId: '-1003' }
  ]);
  assert.equal(aliased.config.sourceAliases['-1003'], '@named_source');

  const conflicting = structuredClone(DEFAULT_CONFIG);
  conflicting.sourceChannels = ['@alpha_source'];
  conflicting.sourceFilters = {
    '@alpha_source': { regexPatterns: ['LONG'] },
    '-1001': { regexPatterns: ['SHORT'] }
  };
  assert.throws(
    () => canonicalizeResolvedSources(conflicting, [
      { configured: '@alpha_source', canonicalId: '-1001' }
    ]),
    /conflicting values/
  );

  const staleMapping = structuredClone(DEFAULT_CONFIG);
  staleMapping.sourceChannels = ['-1001'];
  staleMapping.sourceFilters = { '-9999': { regexPatterns: ['STALE'] } };
  assert.throws(
    () => canonicalizeResolvedSources(staleMapping, [
      { configured: '-1001', canonicalId: '-1001' }
    ]),
    /does not match a configured Telegram source/
  );

  const duplicateResolution = structuredClone(DEFAULT_CONFIG);
  duplicateResolution.sourceChannels = ['@alpha_source', '@beta_source'];
  assert.throws(
    () => canonicalizeResolvedSources(duplicateResolution, [
      { configured: '@alpha_source', canonicalId: '-1001' },
      { configured: '@beta_source', canonicalId: '-1001' }
    ]),
    /resolve to canonical chat id/
  );

  console.log('ALL ATOMIC CONFIGURATION TESTS PASSED!');
} finally {
  await rm(root, { recursive: true, force: true });
}
