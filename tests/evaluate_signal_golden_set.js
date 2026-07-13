import assert from 'assert';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeDb, initDb } from '../src/db.js';
import { normalizeSignalXml } from '../src/dupe_blocker.js';
import { loadEnv } from '../src/env.js';
import { parseSignalToXml } from '../src/signal_parser.js';
import { SignalValidationError } from '../src/signal_schema.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'signal_golden_set.json');

async function runEvaluation() {
  loadEnv();
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('OPENROUTER_API_KEY is required for the live golden-set evaluation.');
  }
  const cases = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.ok(Array.isArray(cases) && cases.length >= 8, 'Golden set must contain at least eight cases.');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'signal-golden-eval-'));
  const failures = [];

  await initDb(path.join(tempDir, 'eval.db'));
  try {
    for (const testCase of cases) {
      try {
        const parsed = await parseSignalToXml(testCase.input, testCase.template, undefined, {
          limits: { primaryAttempts: 1, fallbackAttempts: 0 }
        });
        if (testCase.expectedReject) {
          failures.push(`${testCase.id}: unsafe/ambiguous input was accepted`);
          continue;
        }
        assert.strictEqual(
          normalizeSignalXml(parsed.xml),
          normalizeSignalXml(testCase.expectedXml),
          `${testCase.id}: output differs from the approved golden result`
        );
        console.log(`PASS ${testCase.id} model=${parsed.provenance.model} prompt=${parsed.provenance.promptSha256}`);
      } catch (error) {
        if (testCase.expectedReject && error instanceof SignalValidationError) {
          console.log(`PASS ${testCase.id} rejected=${error.message}`);
        } else {
          failures.push(`${testCase.id}: ${error.message}`);
        }
      }
    }
  } finally {
    await closeDb();
    await rm(tempDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new Error(`Golden-set gate failed:\n- ${failures.join('\n- ')}`);
  }
  console.log(`AI GOLDEN-SET GATE PASSED (${cases.length}/${cases.length})`);
}

runEvaluation().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
