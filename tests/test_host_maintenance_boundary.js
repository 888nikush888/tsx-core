import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');
const audit = JSON.parse(await read('docs/ui-next/inventory/host-maintenance-boundary.json'));
const external = JSON.parse(await read('docs/ui-next/inventory/external-operational-controls.json'));
const fields = JSON.parse(await read('docs/ui-next/inventory/operational-fields.json'));
const slice = JSON.parse(await read('docs/ui-next/inventory/operational-coverage-slice.json'));
const previousEvidence = JSON.parse(await read('docs/testing/host-maintenance-boundary-17abeb0f.json'));
const evidence = JSON.parse(await read('docs/testing/host-maintenance-boundary-drive-20260925.json'));
const archival = JSON.parse(await read('docs/testing/host-maintenance-boundary-efbcb568.json'));

assert.equal(audit.schemaVersion, 1);
assert.equal(audit.sourceRevision, '17abeb0f2655f3c05560d047cc0c8a046b92865f');
assert.equal(archival.baseRevision, 'efbcb568f247d05218f7b003e6fa58adac43953b');
assert.equal(previousEvidence.archivalEvidence, 'docs/testing/host-maintenance-boundary-efbcb568.json');
for (const changedSource of ['docs/ui-next/inventory/operational-fields.json',
  'docs/ui-next/inventory/operational-coverage-slice.json']) {
  assert.notEqual(previousEvidence.sourceSha256[changedSource], evidence.sourceSha256[changedSource],
    `${changedSource}: the pre-Drive inventory hash must not be treated as the current hash`);
}
assert.equal(audit.decision, 'design-only-no-field-promotion');
assert.ok(audit.reason.length > 40);
const auditedIds = audit.groups.flatMap(group => {
  assert.ok(group.id && group.owner && group.boundary, 'Every host group needs an owner and control boundary.');
  return group.controlIds;
});
assert.equal(new Set(auditedIds).size, auditedIds.length, 'Host controls must not be counted twice.');
assert.deepEqual(auditedIds.toSorted(), external.controls.map(control => control.id).toSorted(),
  'Every external control needs an explicit host-plane boundary.');
assert.equal(auditedIds.length, 70);
assert.ok(external.controls.every(control => control.evidenceStatus === 'unverified'),
  'A design audit must not promote external controls to UI evidence.');
const groupById = new Map(audit.groups.flatMap(group => group.controlIds.map(id => [id, group.id])));
for (const control of external.controls) {
  if (control.class === 'safety-rule') assert.equal(groupById.get(control.id), 'immutable-alert-detections');
  if (control.class === 'write-only-secret') assert.equal(groupById.get(control.id), 'host-write-only-secrets');
  if (control.class === 'write-once-secret') assert.equal(groupById.get(control.id), 'host-write-once-key');
  if (control.id.endsWith('.key')) assert.equal(groupById.get(control.id), 'tls-private-keys');
}
const deployment = fields.fields.filter(field => field.path.startsWith('deployment.'));
assert.equal(new Set(audit.deploymentGaps.map(item => item.path)).size, 6);
assert.deepEqual(audit.deploymentGaps.map(item => item.path).toSorted(), deployment.map(item => item.path).toSorted());
const bootstrap = slice.groups.find(group => group.id === 'deployment-bootstrap');
assert.deepEqual(bootstrap.paths.toSorted(), deployment.map(item => item.path).toSorted());
assert.equal(bootstrap.gap, 'host-maintenance-ui');
for (const field of deployment) {
  assert.equal(field.class, 'host-maintenance');
  assert.equal(field.evidenceStatus, 'known-gap');
  assert.equal(field.firstSliceGroup, 'deployment-bootstrap');
}
assert.ok(audit.deploymentGaps.every(item => item.boundary.length > 20));
assert.equal(previousEvidence.baseRevision, audit.sourceRevision);
assert.equal(evidence.baseRevision, 'b15b96116f3886640904cd6f5db40dff77213faa');
assert.equal(evidence.archivalEvidence, 'docs/testing/host-maintenance-boundary-17abeb0f.json');
assert.equal(evidence.audited.catalogFirstSliceStatic, previousEvidence.audited.catalogFirstSliceStatic + 3);
assert.equal(evidence.audited.slicePaths, previousEvidence.audited.slicePaths + 3);
assert.equal(evidence.audited.catalogUnverified, previousEvidence.audited.catalogUnverified);
assert.equal(evidence.audited.externalControls, auditedIds.length);
assert.equal(evidence.audited.deploymentKnownGaps, deployment.length);
assert.equal(evidence.audited.promotedFields, 0);
const statusCounts = fields.fields.reduce((counts, field) => {
  counts[field.evidenceStatus] += 1;
  return counts;
}, { 'first-slice-static': 0, 'known-gap': 0, unverified: 0 });
assert.deepEqual(statusCounts, {
  'first-slice-static': evidence.audited.catalogFirstSliceStatic,
  'known-gap': evidence.audited.catalogKnownGap,
  unverified: evidence.audited.catalogUnverified,
});
assert.equal(slice.groups.reduce((count, group) => count + group.paths.length, 0), evidence.audited.slicePaths);
const ids = external.controls.map(control => control.id);
assert.equal(ids.filter(id => id.startsWith('compose.')).length, evidence.audited.composeSubstitutions);
assert.equal(ids.filter(id => id.startsWith('tls.')).length, evidence.audited.tlsArtifacts);
assert.equal(ids.filter(id => id.startsWith('monitoring.') && !id.startsWith('monitoring.rule.')).length,
  evidence.audited.monitoringConfigurationGroups);
assert.equal(ids.filter(id => id.startsWith('monitoring.rule.')).length, evidence.audited.alertRules);
assert.equal(ids.filter(id => id.startsWith('host.') || id.startsWith('tailscale.')).length,
  evidence.audited.hostAndObservationControls);
for (const [source, expectedHash] of Object.entries(evidence.sourceSha256)) {
  assert.equal(createHash('sha256').update(await read(source)).digest('hex'), expectedHash,
    `${source}: source changed after the bounded audit`);
}

const compose = await read('docker-compose.monitoring.yml');
assert.match(compose, /\.\/monitoring\/prometheus\.yml:\/etc\/prometheus\/prometheus\.yml:ro/u);
assert.doesNotMatch(compose, /--web\.enable-lifecycle/u,
  'A future authenticated reload design requires revisiting the host boundary.');
assert.match(await read('monitoring/prometheus.yml'), /scrape_interval: 15s/u);
console.log('Host maintenance boundary passed: 70 external controls, six deployment gaps; no UI field promoted.');
