import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = await readFile(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8');
const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');

const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map(
  (match) => match[1]
);
assert.ok(actionReferences.length > 0, 'quality workflow must use pinned actions');
for (const reference of actionReferences) {
  assert.match(
    reference,
    /^[^@\s]+@[a-f0-9]{40}$/,
    `action reference must use a full SHA: ${reference}`
  );
}

const safeTrivyAction = 'aquasecurity/trivy-action@57a97c7e7821a5776cebc9bb87c984fa69cba8f1';
assert.equal(
  actionReferences.filter((reference) => reference === safeTrivyAction).length,
  2,
  'both Trivy steps must use the known-safe 0.35.0 action commit'
);
assert.equal((workflow.match(/^\s*version:\s*v0\.69\.3\s*$/gm) ?? []).length, 2);
assert.doesNotMatch(workflow, /^\s*version:\s*latest\s*$/m);
assert.doesNotMatch(
  workflow,
  /aquasecurity\/trivy-action@b6643a29fecd7f34b3597bc6acb0a98b03d33ff8/
);

const baseImages = [...dockerfile.matchAll(/^FROM\s+([^\s]+).*$/gm)].map((match) => match[1]);
assert.ok(baseImages.length > 0, 'Dockerfile must declare a base image');
const nodeImage = dockerfile.match(/^ARG NODE_IMAGE=([^\s]+)$/m)?.[1];
assert.ok(nodeImage, 'Dockerfile must define NODE_IMAGE');
assert.match(nodeImage, /@sha256:[a-f0-9]{64}$/, 'NODE_IMAGE must use a sha256 digest');
assert.doesNotMatch(nodeImage, /:latest(?:@|$)/, 'NODE_IMAGE must not use latest');
for (const image of baseImages) {
  assert.equal(image, '${NODE_IMAGE}', `FROM must use the pinned NODE_IMAGE argument: ${image}`);
}
assert.match(dockerfile, /apt-get upgrade -y --no-install-recommends/);
assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/);

console.log('Supply-chain pinning policy tests passed.');
