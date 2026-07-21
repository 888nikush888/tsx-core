import { fileURLToPath } from 'node:url';
import path from 'node:path';

const immutableReference = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

export function validateDeploymentImages(environment) {
  const violations = [];
  const images = [
    ['FORWARDER_IMAGE', environment.FORWARDER_IMAGE?.trim()],
  ];
  for (const [name, value] of images) {
    if (!value || !immutableReference.test(value)) {
      violations.push(`${name} must be a registry image pinned by a 64-character sha256 digest`);
    }
  }
  return violations;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const violations = validateDeploymentImages(process.env);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`DEPLOYMENT IMAGE VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log('The production forwarder image is registry-published and digest-pinned.');
  }
}
