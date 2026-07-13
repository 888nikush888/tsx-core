import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateReleaseArtifacts({ manifest, changelog, license }) {
  const violations = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
    violations.push('package version is not valid Semantic Versioning');
  }
  if (manifest.license !== 'MIT') violations.push('package license must be MIT');
  const escapedVersion = String(manifest.version).replaceAll('.', '\\.');
  if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
    violations.push(`CHANGELOG has no dated section for ${manifest.version}`);
  }
  if (!license.startsWith('MIT License\n')) violations.push('LICENSE is not an MIT license text');
  if (!license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    violations.push('LICENSE is missing the MIT warranty disclaimer');
  }
  return violations;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const artifacts = {
    manifest: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')),
    changelog: await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    license: await readFile(path.join(root, 'LICENSE'), 'utf8'),
  };
  const violations = validateReleaseArtifacts(artifacts);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`RELEASE ARTIFACT VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Release artifact gate passed (version ${artifacts.manifest.version}, MIT, changelog entry present).`);
  }
}
