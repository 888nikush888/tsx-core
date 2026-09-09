import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiskAcceptance } from './check_risk_acceptances.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
const version = '1.1307.1';
const httpAcceptanceFile = 'docs/risk-acceptances/RA-2026-09-08-internal-http.md';
const httpAcceptanceHash = '7b5076bdd1d9e4dd40ddf44d5096310f0fd0ccb6466c32a602a48d68b76634ff';
const httpRiskPaths = new Map([
  ['438c84b9-ea83-4e9d-8bdc-d2032e31ae59', 'src/web_server.ts'],
  ['d75bc03c-19a7-4475-809c-525e9240e836', 'src/metrics.ts'],
  ['15b62184-5d10-4c9f-8c45-36cebd259223', 'src/alert_relay.ts'],
  ['75310963-3f26-40a8-b6da-3e8ab4d6c57b', 'src/telegram_viewer/health_server.ts'],
]);
const verifiedAcceptances = new WeakSet();

export async function loadHttpRiskAcceptance(root, now = new Date()) {
  let bytes = undefined;
  try {
    bytes = await readFile(path.join(root, httpAcceptanceFile));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  requireEvidence(sha256(bytes) === httpAcceptanceHash, 'Owner acceptance differs from the authorized record.');
  requireEvidence(validateRiskAcceptance(bytes.toString('utf8'), now).length === 0, 'Owner acceptance is invalid or expired.');
  const capability = Object.freeze({ record: httpAcceptanceFile });
  verifiedAcceptances.add(capability);
  return capability;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function sourcePath(value) {
  requireEvidence(typeof value === 'string' && value.length > 0, 'Missing source path.');
  requireEvidence(!/[\\:\x00-\x1f\x7f%]/u.test(value), 'Invalid source path.');
  requireEvidence(value.split('/').every(segment => segment && segment !== '.' && segment !== '..'), 'Unsafe source path.');
  return value;
}

function physicalPaths(result) {
  requireEvidence(Array.isArray(result.locations) && result.locations.length > 0, 'Missing finding location.');
  requireEvidence(result.relatedLocations === undefined || Array.isArray(result.relatedLocations), 'Invalid related locations.');
  requireEvidence(result.codeFlows === undefined || (Array.isArray(result.codeFlows) && result.codeFlows.length > 0), 'Invalid code flows.');
  const locations = [...result.locations, ...(result.relatedLocations ?? [])];
  for (const flow of result.codeFlows ?? []) {
    requireEvidence(Array.isArray(flow.threadFlows) && flow.threadFlows.length > 0, 'Missing thread flows.');
    for (const thread of flow.threadFlows) {
      requireEvidence(Array.isArray(thread.locations) && thread.locations.length > 0, 'Missing thread locations.');
      for (const step of thread.locations) locations.push(step.location);
    }
  }
  return new Set(locations.map(location => sourcePath(location?.physicalLocation?.artifactLocation?.uri)));
}

function fingerprintCommitment(fingerprints) {
  requireEvidence(fingerprints && !Array.isArray(fingerprints) && typeof fingerprints === 'object', 'Missing fingerprints.');
  const keys = Object.keys(fingerprints).sort();
  requireEvidence(keys.length > 0 && keys.every(key => typeof fingerprints[key] === 'string' && fingerprints[key].length > 0), 'Invalid fingerprints.');
  return JSON.stringify(keys.map(key => [key, fingerprints[key]]));
}

export function evidenceDigest(result) {
  return sha256(JSON.stringify({ locations: result.locations,
    relatedLocations: result.relatedLocations ?? [], codeFlows: result.codeFlows ?? [] }));
}

function findingIdentity(result) {
  const fingerprints = result.fingerprints;
  const id = fingerprints?.['snyk/asset/finding/v1'];
  requireEvidence(typeof id === 'string' && id.length > 0 && fingerprints.identity === id, 'Ambiguous finding identity.');
  return id;
}

function validateInvocation(invocation, resultCount) {
  requireEvidence(invocation.executionSuccessful === undefined || invocation.executionSuccessful === true, 'SARIF reports incomplete or invalid execution.');
  requireEvidence(invocation.exitCode === undefined || invocation.exitCode === 0 || invocation.exitCode === 1, 'SARIF reports a scanner error.');
  requireEvidence(invocation.exitCode !== 1 || resultCount > 0, 'SARIF findings exit has no finding evidence.');
  for (const key of ['toolExecutionNotifications', 'toolConfigurationNotifications']) {
    const notifications = invocation[key] ?? [];
    requireEvidence(Array.isArray(notifications) && notifications.every(note => note.level !== 'error'), 'SARIF reports an execution or configuration error.');
  }
}

function validateRun(run) {
  requireEvidence(run.tool?.driver?.name === 'SnykCode' && run.tool.driver.version === version, 'Unexpected scanner identity.');
  requireEvidence(Array.isArray(run.results), 'Missing SARIF results.');
  requireEvidence(run.invocations === undefined || Array.isArray(run.invocations), 'Invalid SARIF invocations.');
  for (const invocation of run.invocations ?? []) validateInvocation(invocation, run.results.length);
}

function scanResults(sarif, scannerExit) {
  requireEvidence(scannerExit === 0 || scannerExit === 1, 'Scanner did not complete successfully.');
  requireEvidence(sarif?.version === '2.1.0' && Array.isArray(sarif.runs) && sarif.runs.length > 0, 'Invalid SARIF evidence.');
  sarif.runs.forEach(validateRun);
  const results = sarif.runs.flatMap(run => run.results);
  requireEvidence(results.length > 0 || scannerExit === 0, 'Scanner findings exit has no findings evidence.');
  const identities = results.map(findingIdentity);
  results.forEach(physicalPaths);
  requireEvidence(new Set(identities).size === identities.length, 'Duplicate finding identities.');
  return results;
}

function reviewedEntries(review) {
  requireEvidence(review?.schemaVersion === 1 && review.scannerVersion === version
    && /^[a-f0-9]{40}$/u.test(review.reviewedRevision) && hashPattern.test(review.sarifSha256)
    && Array.isArray(review.entries), 'Invalid independent review evidence.');
  const entries = new Map();
  for (const entry of review.entries) {
    requireEvidence(typeof entry.findingId === 'string' && !entries.has(entry.findingId), 'Duplicate or missing review identity.');
    requireEvidence(typeof entry.rationale === 'string' && entry.rationale.trim().length >= 40, 'Missing individual review rationale.');
    sourcePath(entry.path);
    requireEvidence(hashPattern.test(entry.reviewedSourceSha256) && Array.isArray(entry.contextPaths), 'Missing source or context bindings.');
    requireEvidence(hashPattern.test(entry.evidenceSha256), 'Missing reviewed flow evidence.');
    fingerprintCommitment(entry.fingerprints);
    entries.set(entry.findingId, entry);
  }
  return entries;
}

function sourceBindings(entry) {
  const bindings = new Map([[entry.path, entry.reviewedSourceSha256]]);
  for (const context of entry.contextPaths) {
    const file = sourcePath(context.path);
    requireEvidence(hashPattern.test(context.sha256), 'Invalid context source hash.');
    requireEvidence(!bindings.has(file) || bindings.get(file) === context.sha256, 'Conflicting source bindings.');
    bindings.set(file, context.sha256);
  }
  return bindings;
}

function isHttpRiskAccepted(entry, acceptance) {
  return entry?.disposition === 'open' && verifiedAcceptances.has(acceptance)
    && entry.ruleId === 'javascript/HttpToHttps' && httpRiskPaths.get(entry.findingId) === entry.path;
}

async function checkReviewedFinding(result, entry, readSource, acceptance) {
  const accepted = isHttpRiskAccepted(entry, acceptance);
  if (!entry || (entry.disposition !== 'false-positive' && !accepted)) return 'unreviewed-or-open';
  if (entry.ruleId !== result.ruleId || entry.path !== sourcePath(result.locations[0].physicalLocation.artifactLocation.uri)) {
    return 'identity-changed';
  }
  if (fingerprintCommitment(entry.fingerprints) !== fingerprintCommitment(result.fingerprints)
    || entry.evidenceSha256 !== evidenceDigest(result)) return 'reviewed-flow-changed';
  const bindings = sourceBindings(entry);
  for (const file of physicalPaths(result)) {
    if (!bindings.has(file)) return 'unreviewed-dataflow-source';
  }
  for (const [file, hash] of bindings) {
    if (sha256(await readSource(file)) !== hash) return 'reviewed-source-changed';
  }
  return accepted ? 'accepted-risk' : 'reviewed-false-positive';
}

export async function evaluateSnykCode({ sarif, scannerExit, review, readSource, acceptance }) {
  requireEvidence(acceptance === undefined || verifiedAcceptances.has(acceptance), 'Unverified risk acceptance.');
  const results = scanResults(sarif, scannerExit);
  const entries = results.length ? reviewedEntries(review) : new Map();
  const findings = [];
  for (const result of results) {
    const id = findingIdentity(result);
    findings.push({ findingId: id, ruleId: result.ruleId,
      disposition: await checkReviewedFinding(result, entries.get(id), readSource, acceptance) });
  }
  const reviewedFalsePositives = findings.filter(finding => finding.disposition === 'reviewed-false-positive').length;
  const acceptedRisks = findings.filter(finding => finding.disposition === 'accepted-risk').length;
  const remaining = results.length - reviewedFalsePositives - acceptedRisks;
  return { resultCount: results.length, reviewedFalsePositives, acceptedRisks,
    remaining, disposition: remaining ? 'findings' : 'clean', findings };
}

async function runCli(args) {
  requireEvidence(args.length === 4, 'Expected SARIF, scanner exit, review and output paths.');
  const [sarifFile, exitText, reviewFile, outputFile] = args;
  requireEvidence(/^[01]$/u.test(exitText), 'Invalid scanner exit evidence.');
  const root = await realpath(process.cwd());
  const sarif = JSON.parse(await readFile(sarifFile, 'utf8'));
  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  const readSource = async file => {
    const resolved = await realpath(path.join(root, sourcePath(file)));
    requireEvidence(resolved.startsWith(`${root}${path.sep}`), 'Source leaves the checked-out repository.');
    return readFile(resolved);
  };
  const acceptance = await loadHttpRiskAcceptance(root);
  const result = await evaluateSnykCode({ sarif, scannerExit: Number(exitText), review, readSource, acceptance });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Snyk Code: ${result.resultCount} results, ${result.reviewedFalsePositives} individually reviewed false positives, ${result.acceptedRisks} owner-accepted risks, ${result.remaining} unresolved.`);
  return result.remaining ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch {
    console.error('Snyk Code review evidence is invalid or unavailable; verification failed closed.');
    process.exitCode = 2;
  }
}
