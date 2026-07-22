import assert from 'assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeDb, initDb } from '../src/db.js';
import { normalizeSignalXml } from '../src/dupe_blocker.js';
import { loadEnv } from '../src/env.js';
import { classifyAiError, parseSignalToXml } from '../src/signal_parser.js';
import { SignalValidationError } from '../src/signal_schema.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'signal_golden_set.json');

function boundedCaseDelay() {
  const raw = process.env.AI_GOLDEN_CASE_DELAY_MS?.trim() || '5000';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new Error('AI_GOLDEN_CASE_DELAY_MS must be an integer between 0 and 60000.');
  }
  return value;
}

function delay(milliseconds) {
  return milliseconds <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runEvaluation() {
  loadEnv();
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('OPENROUTER_API_KEY is required for the live golden-set evaluation.');
  }
  const cases = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.ok(Array.isArray(cases) && cases.length >= 8, 'Golden set must contain at least eight cases.');
  const caseDelayMs = boundedCaseDelay();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'signal-golden-eval-'));
  const failures = [];
  const outcomes = [];

  await initDb(path.join(tempDir, 'eval.db'));
  try {
    for (const [caseIndex, testCase] of cases.entries()) {
      try {
        const parsed = await parseSignalToXml(testCase.input, testCase.template);
        if (testCase.expectedReject) {
          failures.push(`${testCase.id}: unsafe/ambiguous input was accepted`);
          outcomes.push({ id: testCase.id, passed: false, outcome: 'unexpectedly-accepted', model: parsed.provenance.model, promptSha256: parsed.provenance.promptSha256 });
          continue;
        }
        assert.strictEqual(
          normalizeSignalXml(parsed.xml),
          normalizeSignalXml(testCase.expectedXml),
          `${testCase.id}: output differs from the approved golden result`
        );
        outcomes.push({ id: testCase.id, passed: true, outcome: 'matched', model: parsed.provenance.model, promptSha256: parsed.provenance.promptSha256 });
        console.log(`PASS ${testCase.id} model=${parsed.provenance.model} prompt=${parsed.provenance.promptSha256}`);
      } catch (error) {
        if (testCase.expectedReject && error instanceof SignalValidationError) {
          outcomes.push({ id: testCase.id, passed: true, outcome: 'rejected', errorCode: error.name });
          console.log(`PASS ${testCase.id} rejected=${error.name}`);
        } else {
          const classification = classifyAiError(error);
          const statusSuffix = classification.httpStatus ? ` status=${classification.httpStatus}` : '';
          failures.push(`${testCase.id}: ${classification.code}${statusSuffix}`);
          outcomes.push({
            id: testCase.id,
            passed: false,
            outcome: 'error',
            errorCode: classification.code,
            retryable: classification.retryable,
            ...(classification.httpStatus === undefined ? {} : { httpStatus: classification.httpStatus }),
            ...(classification.providerCode === undefined ? {} : { providerCode: classification.providerCode })
          });
        }
      } finally {
        if (caseIndex < cases.length - 1) await delay(caseDelayMs);
      }
    }
  } finally {
    await closeDb();
    await rm(tempDir, { recursive: true, force: true });
  }

  const evidenceDirectory = path.resolve('reports', 'staging');
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, `ai-golden-${Date.now()}.json`);
  await writeFile(evidencePath, `${JSON.stringify({
    schemaVersion: 2,
    executedAt: new Date().toISOString(),
    passed: failures.length === 0,
    caseCount: cases.length,
    caseDelayMs,
    outcomes
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

  if (failures.length > 0) {
    throw new Error(`Golden-set gate failed:\n- ${failures.join('\n- ')}`);
  }
  console.log(`AI GOLDEN-SET GATE PASSED (${cases.length}/${cases.length}) evidence=${evidencePath}`);
}

runEvaluation().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
