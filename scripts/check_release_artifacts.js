import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function coreReleaseViolations(manifest, changelog, license) {
  const violations = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
    violations.push('package version is not valid Semantic Versioning');
  }
  if (manifest.license !== 'MIT') violations.push('package license must be MIT');
  const escapedVersion = String(manifest.version).replaceAll('.', String.raw`\.`);
  if (!new RegExp(String.raw`^## \[${escapedVersion}\] - \d{4}-\d{2}-\d{2}$`, 'm').test(changelog)) {
    violations.push(`CHANGELOG has no dated section for ${manifest.version}`);
  }
  violations.push(...licenseTextViolations(license));
  return violations;
}

function licenseTextViolations(license) {
  const violations = [];
  if (!/^MIT License\r?\n/.test(license)) violations.push('LICENSE is not an MIT license text');
  if (!license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) violations.push('LICENSE is missing the MIT warranty disclaimer');
  return violations;
}

function lockVersionMatches(lock, version) {
  return lock.version === version && lock.packages?.['']?.version === version;
}

function lockVersionViolations(lock, version, label) {
  if (!lock) return [];
  if (lockVersionMatches(lock, version)) return [];
  return [`${label} lockfile version must match the release package version`];
}

function versionAlignmentViolations(manifest, frontendManifest, backendLock, frontendLock) {
  const violations = [];
  if (frontendManifest && frontendManifest.version !== manifest.version) {
    violations.push('frontend package version must match the release package version');
  }
  violations.push(...lockVersionViolations(backendLock, manifest.version, 'backend'));
  violations.push(...lockVersionViolations(frontendLock, manifest.version, 'frontend'));
  return violations;
}

export function validateReleaseArtifacts({ manifest, frontendManifest, backendLock, frontendLock, changelog, license }) {
  return [
    ...coreReleaseViolations(manifest, changelog, license),
    ...versionAlignmentViolations(manifest, frontendManifest, backendLock, frontendLock),
  ];
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const [manifest, frontendManifest, backendLock, frontendLock, changelog, license] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'frontend', 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'frontend', 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    readFile(path.join(root, 'LICENSE'), 'utf8'),
  ]);
  const artifacts = { manifest, frontendManifest, backendLock, frontendLock, changelog, license };
  const violations = validateReleaseArtifacts(artifacts);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`RELEASE ARTIFACT VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Release artifact gate passed (version ${artifacts.manifest.version}, MIT, changelog entry present).`);
  }
}
