import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ajvRequire = createRequire(require.resolve('ajv'));
const uri = ajvRequire('uri-js');

test('Ajv URI handling does not decode malformed UTF-8 into path or header delimiters', () => {
  const cases = [
    'https://schemas.example.test/%E0%40%2E',
    'https://schemas.example.test/%E0%40%0D%E0%40%0A',
  ];
  for (const input of cases) {
    for (const options of [{}, { iri: true, unicodeSupport: true }]) {
      const parsed = uri.parse(input, options);
      assert.equal(uri.normalize(input, options), input);
      assert.equal(uri.serialize(parsed, options), input);
      assert.ok(parsed.path?.includes('%E0%40%'));
      assert.doesNotMatch(parsed.path, /[\r\n]/u);
    }
  }
});

test('Ajv URI resolver finishes on Unicode line and paragraph separators', () => {
  const modulePath = ajvRequire.resolve('uri-js');
  const probe = `
    const uri = require(${JSON.stringify(modulePath)});
    for (const separator of ['\\u2028', '\\u2029']) {
      const expected = separator === '\\u2028' ? '%E2%80%A8' : '%E2%80%A9';
      const base = 'https://schemas.example.test/';
      if (uri.normalize(base + separator, { iri: true, unicodeSupport: true }) !== base + expected) process.exit(1);
      if (uri.resolve(base, separator) !== base + expected) process.exit(2);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  assert.equal(result.error, undefined, `URI resolver timed out: ${result.error?.message}`);
  assert.equal(result.status, 0, `URI resolver failed: ${result.stderr}`);
});

test('Ajv 6 compiles and validates external schema references through the replacement', () => {
  const Ajv = ajvRequire('ajv');
  const ajv = new Ajv({ allErrors: true });
  ajv.addSchema({
    $id: 'https://schemas.example.test/person.json',
    definitions: {
      Person: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
        required: ['name'],
      },
    },
  });
  const validate = ajv.compile({
    $ref: 'https://schemas.example.test/person.json#/definitions/Person',
  });
  assert.equal(validate({ name: 'Alice' }), true);
  assert.equal(validate({ name: '' }), false);
  assert.equal(uri.resolve('https://schemas.example.test/a/b/c', '../../person.json'),
    'https://schemas.example.test/person.json');
});

test('Ajv URI resolution preserves RFC 3986 relative-reference behavior', () => {
  const base = 'http://a/b/c/d;p?q';
  const references = [
    ['g', 'http://a/b/c/g'],
    ['./g', 'http://a/b/c/g'],
    ['../g', 'http://a/b/g'],
    ['../../g', 'http://a/g'],
    ['?y', 'http://a/b/c/d;p?y'],
    ['#s', 'http://a/b/c/d;p?q#s'],
  ];
  for (const [reference, expected] of references) {
    assert.equal(uri.resolve(base, reference), expected);
  }
});
