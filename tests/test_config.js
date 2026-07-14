import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  canonicalizeResolvedSources,
  readConfig,
  readConfigSync,
  writeConfig,
  writeConfigSync
} from '../src/config.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-config-'));

try {
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
