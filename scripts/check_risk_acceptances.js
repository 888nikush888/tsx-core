import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptanceDirectory = path.join(root, 'docs', 'risk-acceptances');
const requiredFields = ['id', 'owner', 'approver', 'created', 'expires', 'scope', 'gate'];
const requiredSections = ['Risk', 'Evidence', 'Compensating controls', 'Exit criteria'];

export function validateRiskAcceptance(content, now = new Date()) {
  const errors = [];
  const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontMatter) return ['missing YAML front matter'];

  const fields = Object.fromEntries(
    frontMatter[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z-]+):\s*(.+?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );
  for (const field of requiredFields) {
    if (!fields[field]) errors.push(`missing field: ${field}`);
  }

  const created = new Date(fields.created);
  const expires = new Date(fields.expires);
  if (!Number.isFinite(created.getTime())) errors.push('created must be an ISO date');
  if (!Number.isFinite(expires.getTime())) errors.push('expires must be an ISO date');
  if (Number.isFinite(created.getTime()) && Number.isFinite(expires.getTime())) {
    if (expires <= created) errors.push('expires must be later than created');
    if (expires.getTime() - created.getTime() > 30 * 24 * 60 * 60 * 1000) {
      errors.push('acceptance duration must not exceed 30 days');
    }
    if (expires <= now) errors.push('risk acceptance is expired');
  }

  for (const section of requiredSections) {
    if (!new RegExp(String.raw`^## ${section}\s*$`, 'm').test(content))
      errors.push(`missing section: ${section}`);
  }
  return errors;
}

export async function checkRiskAcceptances(now = new Date()) {
  const files = (await readdir(acceptanceDirectory))
    .filter((file) => /^RA-.+\.md$/.test(file))
    .sort();
  const violations = [];
  for (const file of files) {
    const errors = validateRiskAcceptance(
      await readFile(path.join(acceptanceDirectory, file), 'utf8'),
      now
    );
    violations.push(...errors.map((error) => `${file}: ${error}`));
  }
  return { files, violations };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const { files, violations } = await checkRiskAcceptances();
  if (violations.length > 0) {
    for (const violation of violations) console.error(`RISK ACCEPTANCE VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Risk-acceptance gate passed (${files.length} active record(s), 0 invalid records).`
    );
  }
}
