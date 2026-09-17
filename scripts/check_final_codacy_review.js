import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEDGER = 'docs/testing/final-codacy-2026-09-17.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => String(value).replaceAll('\r\n', '\n');
const digest = value => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const safePath = value => typeof value === 'string' && /^[\w./-]+$/.test(value)
  && !path.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const substantive = value => typeof value === 'string' && value.length >= 40;
const list = value => Array.isArray(value) ? value : [];

function checkIdentity(entry, state) {
  const { problem, ids, counts, families } = state;
  if (!entry.issueId || ids.has(entry.issueId)) problem('Missing or duplicate Codacy issue identity.');
  ids.add(entry.issueId);
  if (!Object.hasOwn(counts, entry.providerStatus)) problem(`Invalid provider status: ${entry.issueId}`);
  else counts[entry.providerStatus] += 1;
  const family = families.get(entry.rule) ?? { active: 0, ignored: 0 };
  if (Object.hasOwn(family, entry.providerStatus)) family[entry.providerStatus] += 1;
  families.set(entry.rule, family);
  if (!safePath(entry.path) || !digest(entry.baselineSourceSha256)) problem(`Invalid source binding: ${entry.issueId}`);
}

function checkSemanticReview(entry, problem) {
  if (!substantive(entry.rationale)) problem(`Missing semantic rationale: ${entry.issueId}`);
  if (!Array.isArray(entry.reviewedLocations) || !Array.isArray(entry.evidence)) problem(`Missing occurrence evidence: ${entry.issueId}`);
  if (entry.finalSourceRenewal !== 'reviewed-final-source') problem(`Final semantic renewal pending: ${entry.issueId}`);
  if (!list(entry.finalSourcePaths).includes(entry.path)) problem(`Missing final source/context set: ${entry.issueId}`);
  if (!Array.isArray(entry.finalEvidence)) problem(`Missing final line evidence: ${entry.issueId}`);
  if (String(entry.disposition).startsWith('false-positive')) checkLocatedDecision(entry, problem);
  for (const evidence of list(entry.evidence)) {
    if (!list(entry.finalSourcePaths).includes(evidence.path)) problem(`Reviewed context omitted from final binding: ${entry.issueId} (${evidence.path})`);
  }
}

function checkLocatedDecision(entry, problem) {
  if (!list(entry.reviewedLocations).length) problem(`Unlocated false-positive decision: ${entry.issueId}`);
  if (!list(entry.finalEvidence).some(item => item.path === entry.path)) problem(`Missing final occurrence location: ${entry.issueId}`);
}

function checkCounts(ledger, { counts, families, problem }) {
  const inventory = ledger.counts ?? {};
  const rules = ledger.ruleCounts ?? {};
  if (ledger.entries.length !== inventory.total || counts.active !== inventory.active || counts.ignored !== inventory.ignored) problem('Inventory count mismatch.');
  for (const [rule, count] of families) {
    const expected = rules[rule] ?? {};
    if (expected.active !== count.active || expected.ignored !== count.ignored) problem(`Rule count mismatch: ${rule}`);
  }
  if (Object.keys(rules).length !== families.size) problem('Rule inventory is incomplete.');
}

function bindSource(source, { sources, problem, readSource }) {
  if (!source || !safePath(source.path) || !digest(source.normalizedSha256) || sources.has(source.path)) {
    problem('Invalid or duplicate final source binding.');
    return;
  }
  sources.set(source.path, source);
  if (!substantive(source.semanticReview)) problem(`Missing final semantic review: ${source.path}`);
  try {
    if (sha256(canonical(readSource(source.path))) !== source.normalizedSha256) problem(`Source drift requires semantic renewal: ${source.path}`);
  } catch {
    problem(`Bound source cannot be read: ${source.path}`);
  }
}

function checkLine(evidence, issueId, { sources, problem, readSource }) {
  if (!evidence || !sources.has(evidence.path) || !Number.isInteger(evidence.line) || evidence.line < 1 || !digest(evidence.normalizedLineSha256)) {
    problem(`Invalid final line evidence: ${issueId}`);
    return;
  }
  try {
    const line = canonical(readSource(evidence.path)).split('\n')[evidence.line - 1];
    if (line === undefined || sha256(line.trim()) !== evidence.normalizedLineSha256) problem(`Evidence line drift: ${issueId} (${evidence.path}:${evidence.line})`);
  } catch {
    problem(`Evidence source cannot be read: ${issueId}`);
  }
}

function checkFinalBindings(ledger, state) {
  for (const source of ledger.finalReview.sources) bindSource(source, state);
  for (const entry of state.entries) {
    for (const name of list(entry.finalSourcePaths)) {
      if (!state.sources.has(name)) state.problem(`Missing context binding: ${entry.issueId} (${name})`);
    }
    for (const evidence of list(entry.finalEvidence)) checkLine(evidence, entry.issueId, state);
  }
  for (const source of list(ledger.sources)) {
    if (!state.sources.has(source.path)) state.problem(`Baseline source omitted from final review: ${source.path}`);
  }
}

/** Validate evidence only. This function never updates a ledger or provider. */
export function checkFinalCodacyReview(ledger, readSource) {
  const problems = [];
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.entries)) return { ok: false, problems: ['Invalid Codacy review schema.'] };
  const state = {
    problems, problem: message => problems.push(message), ids: new Set(),
    counts: { active: 0, ignored: 0 }, families: new Map(), sources: new Map(), entries: [], readSource,
  };
  for (const entry of ledger.entries) {
    if (!entry || typeof entry !== 'object') { state.problem('Invalid Codacy occurrence record.'); continue; }
    state.entries.push(entry);
    checkIdentity(entry, state);
    checkSemanticReview(entry, state.problem);
  }
  checkCounts(ledger, state);
  if (ledger.finalReview?.status !== 'complete' || !Array.isArray(ledger.finalReview.sources)) {
    state.problem('Final source review is not complete. Hashes must not be renewed automatically.');
  } else checkFinalBindings(ledger, state);
  return { ok: problems.length === 0, problems, counts: state.counts, sourceCount: state.sources.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ledger = JSON.parse(readFileSync(path.join(ROOT, LEDGER), 'utf8'));
    const result = checkFinalCodacyReview(ledger, name => readFileSync(path.join(ROOT, name), 'utf8'));
    if (!result.ok) {
      for (const message of result.problems) console.error(message);
      process.exitCode = 1;
    } else console.log(`Codacy review integrity passed: ${ledger.entries.length} occurrences, ${result.sourceCount} source/context files. Provider success is a separate requirement.`);
  } catch {
    console.error('Cannot load the final Codacy review ledger.');
    process.exitCode = 1;
  }
}
