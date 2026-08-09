import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptanceDirectory = path.join(root, 'docs', 'risk-acceptances');
const requiredFields = ['id', 'owner', 'approver', 'created', 'expires', 'scope', 'gate'];
const requiredSections = ['Risk', 'Evidence', 'Compensating controls', 'Exit criteria'];
const MINIMUM_REMAINING_VALIDITY_MS = 24 * 60 * 60 * 1000;
const PLACEHOLDER_SECTION = /^(?:tbd|todo|n\/?a|none|pending|not decided|to be decided|placeholder|[-–—]|\[\s*\])\.?$/i;

function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(':');
        if (separator < 1) return null;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        return /^[a-z-]+$/.test(key) && value ? [key, value] : null;
      })
      .filter(Boolean)
  );
}

function validateDates(fields, now) {
  const errors = [];
  const created = new Date(fields.created);
  const expires = new Date(fields.expires);
  const createdValid = Number.isFinite(created.getTime());
  const expiresValid = Number.isFinite(expires.getTime());
  if (!createdValid) errors.push('created must be an ISO date');
  if (!expiresValid) errors.push('expires must be an ISO date');
  if (!createdValid || !expiresValid) return errors;
  if (created > now) errors.push('created must not be in the future');
  if (expires <= created) errors.push('expires must be later than created');
  if (expires.getTime() - created.getTime() > 30 * 24 * 60 * 60 * 1000) {
    errors.push('acceptance duration must not exceed 30 days');
  }
  if (expires <= now) errors.push('risk acceptance is expired');
  if (expires > now && expires.getTime() - now.getTime() < MINIMUM_REMAINING_VALIDITY_MS) {
    errors.push('risk acceptance must retain at least 24 hours of validity');
  }
  return errors;
}

function sectionBody(content, section) {
  const heading = new RegExp(String.raw`^## ${section}\s*$`, 'm').exec(content);
  if (!heading) return null;
  const remainder = content.slice(heading.index + heading[0].length).replace(/^\r?\n/, '');
  const nextHeading = remainder.search(/^##\s+/m);
  return (nextHeading < 0 ? remainder : remainder.slice(0, nextHeading)).trim();
}

function hasConcreteSectionContent(body) {
  const normalized = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*[-*+]\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const alphanumericCharacters = normalized.match(/[\p{L}\p{N}]/gu) || [];
  return normalized.length >= 12
    && alphanumericCharacters.length >= 8
    && !PLACEHOLDER_SECTION.test(normalized);
}

export function validateRiskAcceptance(content, now = new Date()) {
  const fields = parseFrontMatter(content);
  if (!fields) return ['missing YAML front matter'];
  const errors = [];
  for (const field of requiredFields) {
    if (!fields[field]) errors.push(`missing field: ${field}`);
  }
  if (fields.owner?.toLowerCase() === fields.approver?.toLowerCase()) {
    errors.push('owner and approver must differ');
  }
  errors.push(...validateDates(fields, now));

  for (const section of requiredSections) {
    const body = sectionBody(content, section);
    if (body === null) {
      errors.push(`missing section: ${section}`);
    } else if (!hasConcreteSectionContent(body)) {
      errors.push(`section must contain concrete content: ${section}`);
    }
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
