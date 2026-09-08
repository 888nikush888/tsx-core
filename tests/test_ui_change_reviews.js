import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { createMcpAgent, createMcpProposal, getMcpProposal, setMcpRuntimeMode, connectMcpSession, recordMcpAgentAction } from '../src/mcp_repository.js';
import { uiMcpSnapshot } from '../src/ui_mcp_reads.js';
import { createWorkflowResourceDraft, getActiveWorkflow, updateWorkflowResourceDraft } from '../src/workflow_repository.js';
import { uiMcpProposalReview, approveReviewedMcpProposal } from '../src/ui_mcp_review.js';
import { reviewHash, redactReview } from '../src/ui_change_review.js';
import { setupContentReview, uiSetupCurrentState } from '../src/ui_setup_review.js';
import { uiReviewTree } from '../src/ui_review_tree.js';
import { saveUiWorkflowDraft, getUiWorkflowDraft, activateUiWorkflowDraft } from '../src/ui_workflow_drafts.js';
import { uiWorkflowDetail, uiWorkflowPage } from '../src/ui_workflow_reads.js';
import { uiResourcePublication, publishUiResourceWithDependency } from '../src/ui_resource_publication.js';
import { uiSearch } from '../src/ui_search.js';
import { uiEffectiveParameters } from '../src/ui_effective_parameters.js';
import { uiModelPage, uiModelDetail, mutateUiModel } from '../src/ui_workflow_models.js';
import { createTradingStrategyDraft, listTradingStrategies, getTradingStrategyVersion, createSignalContractDraftVersion, listSignalContracts, updateSignalContractDraft, updateTradingAccountConfiguration } from '../src/trading_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-review-'));
function testCanonicalReviewOrder() {
  // Fixed expected bytes preserve the pre-audit UTF-16 ordering across locales,
  // including integer-like keys, non-ASCII keys, nested objects and array order.
  const canonical = '{"2":"two","10":"ten","Z":null,"a":[{"A":false,"z":0}],"ä":"accent","😀":"emoji"}';
  const value = { '😀': 'emoji', 'ä': 'accent', a: [{ z: 0, A: false }], Z: null, '10': 'ten', '2': 'two' };
  const expected = createHash('sha256').update(canonical).digest('hex');
  assert.equal(reviewHash(value), expected);
  assert.equal(reviewHash(Object.fromEntries(Object.entries(value).reverse())), expected);
  assert.notEqual(reviewHash({ ...value, a: [{ z: 0, A: false }, null] }), expected);
}
function testReviewCredentialRedaction() {
  // Empty usernames/passwords are still credentials and must never reach reviews.
  for (const userinfo of ['user:pass', 'u:p:a', ':u:p', 'u:p:', ':::', ':pass', 'user:', '::', ':']) {
    for (const personalData of [true, false]) {
      assert.equal(redactReview(`HTTPS://${userinfo}@example.invalid/x`, 0, personalData), 'HTTPS://[redigiert]@example.invalid/x');
    }
  }
  for (const userinfo of ['user', 'user%3Aname']) {
    const source = `https://${userinfo}@example.invalid/x`;
    assert.equal(redactReview(source, 0, false), source);
  }
  assert.deepEqual(redactReview({ links: ['http://:pass@example.invalid', 'https://user:@example.invalid'] }),
    { links: ['http://[redigiert]@example.invalid', 'https://[redigiert]@example.invalid'] });
  for (const suffix of ['@example.invalid', '']) {
    const source = 'https://' + ':'.repeat(100000) + suffix;
    const expected = suffix ? 'https://[redigiert]@example.invalid' : source;
    assert.equal(redactReview(source, 0, false), expected);
  }
  const protectedFields = ['password', 'api_key', 'rawResponse', 'sourceText', 'token', 'serviceToken', 'tokenSha256'];
  const original = Object.fromEntries(protectedFields.map(key => [key, 'PRIVATE_TEST_VALUE']));
  assert.deepEqual(redactReview({ ...original, zero: 0, empty: '', flag: false, absent: null }, 0, false),
    { ...Object.fromEntries(protectedFields.map(key => [key, '[redigiert]'])), zero: 0, empty: '', flag: false, absent: null });
}
testReviewCredentialRedaction();
function testBoundedReviewTree() {
  const root = { library: Array.from({ length: 35 }, (_, index) => ({ id: `original-${index}`, value: false, tier: null, amount: '0.000000000000001' })), text: '🎯'.repeat(10001), password: 'PRIVATE_REVIEW_VALUE' };
  const query = new URLSearchParams({ path: '["library"]' }); const first = uiReviewTree(root, query, 'review-1');
  const second = uiReviewTree(root, new URLSearchParams({ path: '["library"]', cursor: first.nextCursor }), 'review-1');
  assert.equal(first.entries.length, 30); assert.equal(second.entries.length, 5); assert.equal(first.total, 35);
  const object = uiReviewTree(root, new URLSearchParams({ path: '["library","34"]' }), 'review-1');
  assert.equal(object.entries.find(row => row.key === 'value').value, false); assert.equal(object.entries.find(row => row.key === 'tier').value, null);
  assert.equal(object.entries.find(row => row.key === 'amount').value, '0.000000000000001');
  const initial = uiReviewTree(root, new URLSearchParams(), 'review-1'); assert.equal(initial.entries.find(row => row.key === 'password').expandable, false);
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE_REVIEW_VALUE/);
  assert.throws(() => uiReviewTree(root, new URLSearchParams({ path: '["password"]' }), 'review-1'), /unavailable/);
  assert.throws(() => uiReviewTree(root, new URLSearchParams({ path: '["__proto__"]' }), 'review-1'), /unavailable/);
  assert.throws(() => uiReviewTree(root, new URLSearchParams({ path: '["library"]', cursor: first.nextCursor }), 'review-2'), /match/);
  let cursor; let text = '';
  do { const result = uiReviewTree(root, new URLSearchParams({ path: '["text"]', ...(cursor ? { cursor } : {}) }), 'review-1'); text += result.text; cursor = result.nextCursor; } while (cursor);
  assert.equal(text, root.text, 'Review text slices must not split or lose Unicode original data.');
  const large = setupContentReview({ content: { workflow: root }, library: { resources: ['x'.repeat(300000)] } }, { systemConfig: {}, workflow: {}, models: {}, accountReferences: [] });
  assert.equal(large.paged, true); assert.ok(Buffer.byteLength(JSON.stringify(large)) < 2000); assert.equal(large.existingLibrary, undefined);
}
async function testMcpMetadata(agent, resource) {
  for (let index = 0; index < 33; index++) {
    await createMcpAgent({ name: `Metadata ${index}`, permissions: ['system.read'] });
    await createMcpProposal({ agentId: agent.id, action: 'workflow.resource_update', payload: { id: resource.id, name: `Proposed ${index}`, configuration: resource.configuration } });
    await connectMcpSession({ id: `metadata-session-${index}`, agentId: agent.id, clientName: 'Browser fixture', clientVersion: '1' });
    await recordMcpAgentAction({ agentId: agent.id, toolName: 'workflow.read', permission: 'workflow.read', outcome: 'succeeded', request: { secret: 'PRIVATE_ORIGINAL_REQUEST' }, result: { secret: 'PRIVATE_ORIGINAL_RESULT', text: 'x'.repeat(40000) }, startedAt: Date.now() });
  }
  const original = await getDatabase().all('SELECT id,status,expires_at FROM mcp_agent_proposals');
  const first = await uiMcpSnapshot(new URLSearchParams());
  for (const kind of ['agents', 'proposals', 'sessions', 'actions']) {
    assert.equal(first[kind].length, 30); assert.equal(first.pages[kind].hasMore, true);
    const next = await uiMcpSnapshot(new URLSearchParams({ [`${kind}Cursor`]: first.pages[kind].nextCursor, agentId: agent.id }));
    assert.ok(next[kind].length >= 3); assert.equal(next.pages[kind].hasMore, false);
    assert.equal(new Set([...first[kind], ...next[kind]].map(row => row.id)).size, 30 + next[kind].length);
    assert.equal(next.selectedAgent.id, agent.id, 'Selected agent remains readable outside the current agent page.');
    assert.equal(next.pages[kind].observedAt, first.pages[kind].observedAt);
  }
  assert.equal(first.activeSessionCount, 33); assert.doesNotMatch(JSON.stringify(first), /PRIVATE_ORIGINAL_|payload|resultJson|requestJson|preflight/);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 100000);
  await assert.rejects(uiMcpSnapshot(new URLSearchParams({ proposalsCursor: first.pages.agents.nextCursor })), /match/);
  await assert.rejects(uiMcpSnapshot(new URLSearchParams({ proposalsCursor: first.pages.proposals.nextCursor, proposalsStatus: 'all' })), /match/);
  assert.deepEqual(await getDatabase().all('SELECT id,status,expires_at FROM mcp_agent_proposals'), original, 'Metadata reads never expire or execute proposals.');
}
if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('tsx-ui-review-')) throw new Error('Unsafe fixture cleanup.');
try {
  testCanonicalReviewOrder();
  testBoundedReviewTree();
  await initDb(path.join(directory, 'fixture.db')); await seedTradingFixtures();
  const configuredAccount = await updateTradingAccountConfiguration('paper-default', { capabilities: { supportsZero: 0, enabled: false }, lastReconciledAt: 0 });
  const preservedAccount = await updateTradingAccountConfiguration('paper-default', {});
  assert.deepEqual(preservedAccount.capabilities, configuredAccount.capabilities, 'Omission must preserve the original capability evidence.');
  assert.equal(preservedAccount.lastReconciledAt, 0, 'Zero is an explicit timestamp, not a missing value.');
  const clearedAccount = await updateTradingAccountConfiguration('paper-default', { capabilities: null, lastReconciledAt: null });
  assert.equal(clearedAccount.capabilities, null, 'Explicit null must clear capability evidence.');
  assert.equal(clearedAccount.lastReconciledAt, null, 'Explicit null must clear reconciliation evidence.');
  await setMcpRuntimeMode('active', 'test:setup');
  const { agent } = await createMcpAgent({ name: 'Review agent', permissions: ['workflow.read', 'workflow.write'] });
  const resource = await createWorkflowResourceDraft({ kind: 'channel', name: 'Initial', configuration: { channelId: 'review-channel' } });
  const proposal = await createMcpProposal({ agentId: agent.id, action: 'workflow.resource_update', payload: { id: resource.id, name: 'Requested', configuration: resource.configuration } });
  const initial = await uiMcpProposalReview(proposal.id);
  assert.equal(initial.before.name, 'Initial'); assert.equal(initial.requested.name, 'Requested');
  assert.equal(initial.reviewHash, (await uiMcpProposalReview(proposal.id)).reviewHash, 'Read clocks must not invalidate unchanged content.');
  await updateWorkflowResourceDraft(resource.id, { name: 'Concurrent', configuration: resource.configuration, baseEditRevision: 0 });
  await assert.rejects(approveReviewedMcpProposal(proposal.id, 'test:admin', initial.reviewHash), /MCP_REVIEW_CONFLICT/);
  assert.equal((await getMcpProposal(proposal.id)).status, 'pending');
  const fresh = await uiMcpProposalReview(proposal.id);
  assert.equal(fresh.before.name, 'Concurrent'); assert.notEqual(fresh.reviewHash, initial.reviewHash);
  assert.equal((await approveReviewedMcpProposal(proposal.id, 'test:admin', fresh.reviewHash)).status, 'approved');
  await testMcpMetadata(agent, resource);
  const privatePayload = redactReview({ nested: { apiKey: 'PRIVATE_KEY', token: 'PRIVATE_TOKEN', password: 'PRIVATE_PASSWORD' }, dailyTokenLimit: 25000, maxOutputTokens: 1000, falseValue: false, nullable: null, zero: 0, blank: '' });
  assert.doesNotMatch(JSON.stringify(privatePayload), /PRIVATE_/); assert.equal(privatePayload.dailyTokenLimit, 25000);
  assert.equal(privatePayload.maxOutputTokens, 1000); assert.equal(privatePayload.falseValue, false); assert.equal(privatePayload.nullable, null); assert.equal(privatePayload.zero, 0); assert.equal(privatePayload.blank, '');

  const config = { targetChannel: 'before' }; const base = await uiSetupCurrentState(config);
  assert.equal(reviewHash(base), reviewHash(await uiSetupCurrentState(config)), 'Export timestamps must not invalidate setup previews.');
  await createWorkflowResourceDraft({ kind: 'channel', name: 'Unbound draft', configuration: { channelId: 'unbound' } });
  assert.notEqual(reviewHash(base), reviewHash(await uiSetupCurrentState(config)), 'Replacement preview must bind unbound drafts as well as the active graph.');

  const active = await getActiveWorkflow(); const graph = { schemaVersion: 3, nodes: [], edges: [] };
  const saved = await saveUiWorkflowDraft({ id: 'operator', baseVersion: null, baseRevisionId: active?.id ?? null, graph }, 'test:admin');
  const input = { baseRevisionId: active?.id ?? null, graph, actorId: 'test:admin', confirmation: 'ACTIVATE WORKFLOW IMPACT', history: { mode: 'record', label: 'Reviewed activation' } };
  await assert.rejects(activateUiWorkflowDraft(input, { id: 'operator', version: saved.version + 1 }), /GRAPH_DRAFT_VERSION_CONFLICT/);
  const changedGraph = { ...graph, nodes: [{ id: 'node-1', resourceVersionId: resource.id, position: { x: 0, y: 0 } }] };
  await assert.rejects(activateUiWorkflowDraft({ ...input, graph: changedGraph }, { id: 'operator', version: saved.version }), /GRAPH_DRAFT_VERSION_CONFLICT|node/);
  assert.deepEqual(await getActiveWorkflow(), active, 'Stale draft binding must not mutate the active revision.');
  const activated = await activateUiWorkflowDraft(input, { id: 'operator', version: saved.version });
  assert.equal(activated.draft.baseRevisionId, activated.workflow.id); assert.equal(activated.draft.version, saved.version + 1);
  await assert.rejects(activateUiWorkflowDraft(input, { id: 'operator', version: saved.version }), /GRAPH_DRAFT_VERSION_CONFLICT/);
  await closeDb(); await initDb(path.join(directory, 'fixture.db'));
  assert.equal((await getUiWorkflowDraft('operator')).baseRevisionId, (await getActiveWorkflow()).id, 'The activated base and draft commit durably together.');
  const published = (await listTradingStrategies()).find(item => item.status === 'published');
  const effective = uiEffectiveParameters({ workflowRevisionId: 'pinned-revision', channelId: 'source-channel', accountId: 'original-account', effectiveConfiguration: {
    strategyConfiguration: { schemaVersion: 4, sizing: { defaultLeverage: 5, riskPerTradePercent: '0.123456789123456789', maximumLeverage: 10 }, safety: { enabled: false, maxDailyLoss: null } },
    resources: { sizing: { defaultLeverage: 5, riskPerTradePercent: '0.123456789123456789', maximumLeverage: 10 } },
  } }, { id: 'original-strategy', configuration: { sizing: { defaultLeverage: 3, riskPerTradePercent: '1', maximumLeverage: 20 }, safety: { enabled: false, maxDailyLoss: null } } }, { id: 'original-sizing', resourceId: 'sizing-family', configuration: { defaultLeverage: 5, riskPerTradePercent: '0.123456789123456789' } });
  const leverage = effective.find(item => item.field === 'sizing.defaultLeverage');
  assert.equal(leverage.value, 5); assert.equal(leverage.strategyValue, 3); assert.equal(leverage.sourceVersionId, 'original-sizing'); assert.equal(leverage.unit, '×'); assert.equal(leverage.overridesStrategy, true);
  assert.equal(effective.find(item => item.field === 'sizing.maximumLeverage').source, 'Standard der Positionsgrößen-Validierung');
  assert.equal(effective.find(item => item.field === 'sizing.riskPerTradePercent').value, '0.123456789123456789');
  assert.equal(effective.find(item => item.field === 'safety.enabled').value, false); assert.equal(effective.find(item => item.field === 'safety.maxDailyLoss').strategyValuePresent, true);
  assert.equal(effective.find(item => item.field === 'schemaVersion').sourceVersionId, null); assert.ok(effective.every(item => item.scope.includes('pinned-revision') && item.scope.includes('original-account')));
  const model = await createTradingStrategyDraft({ name: 'Publication model', configuration: published.configuration });
  const wrapper = await createWorkflowResourceDraft({ kind: 'strategy', name: 'Publication wrapper', configuration: { strategyVersionId: model.id } });
  const publication = await uiResourcePublication(wrapper.id);
  assert.equal(publication.dependency.status, 'draft');
  await assert.rejects(publishUiResourceWithDependency(wrapper.id, 99, publication.publicationHash), /changed/);
  assert.equal((await getTradingStrategyVersion(model.id)).status, 'draft', 'Dependency publication rolls back if resource CAS fails.');
  const result = await publishUiResourceWithDependency(wrapper.id, 0, publication.publicationHash);
  assert.equal(result.dependency.status, 'published'); assert.equal(result.resource.status, 'published');
  const parent = (await listSignalContracts())[0]; const source = parent.versions.find(version => version.status === 'published');
  const contractDraft = await createSignalContractDraftVersion(parent.id, source.id);
  const changedDefinition = structuredClone(contractDraft.definition); changedDefinition.targets.maximumItems = 19;
  await updateSignalContractDraft({ contractId: parent.id, versionId: contractDraft.id, name: parent.name, definition: changedDefinition, baseDefinitionSha256: contractDraft.definitionSha256 });
  await assert.rejects(updateSignalContractDraft({ contractId: parent.id, versionId: contractDraft.id, name: parent.name, definition: contractDraft.definition, baseDefinitionSha256: contractDraft.definitionSha256 }), /CONTRACT_DRAFT_CONFLICT/);
  const detail = await uiWorkflowDetail('resources', wrapper.id); assert.equal(detail.publication.dependency.id, model.id);
  assert.equal(await uiWorkflowDetail('resources', 'missing'), null);
  assert.equal((await uiWorkflowDetail('revisions', activated.workflow.id)).integrityVerified, true);
  assert.equal((await uiWorkflowPage('paths', new URLSearchParams())).entries.length, 0);
  for (let index = 0; index < 103; index++) await createWorkflowResourceDraft({ kind: 'channel', name: `Page ${index}`, configuration: { channelId: `channel-${index}` } });
  const first = await uiWorkflowPage('resources', new URLSearchParams({ resourceKind: 'channel', limit: '100' }));
  assert.equal(first.entries.length, 100); assert.equal(first.hasMore, true);
  const next = await uiWorkflowPage('resources', new URLSearchParams({ resourceKind: 'channel', limit: '100', cursor: first.nextCursor }));
  assert.ok(next.entries.length >= 3); assert.equal(next.observedAt, first.observedAt);
  assert.equal(new Set([...first.entries, ...next.entries].map(entry => entry.id)).size, first.entries.length + next.entries.length);
  await assert.rejects(uiWorkflowPage('resources', new URLSearchParams({ limit: '100', cursor: first.nextCursor })), /match/);
  const search = (await uiSearch('Page', 'resources')).groups[0];
  assert.equal(search.entries.length, 20); assert.equal(search.hasMore, true);
  const nextSearch = (await uiSearch('Page', 'resources', search.nextCursor)).groups[0];
  assert.equal(nextSearch.observedAt, search.observedAt);
  assert.equal(new Set([...search.entries, ...nextSearch.entries].map(item => item.id)).size, 40);
  assert.ok(search.entries.every(item => item.url.startsWith('/workflows/resources/')));
  assert.doesNotMatch(JSON.stringify(search), /configuration|definition|PRIVATE_/);
  await assert.rejects(uiSearch('Other', 'resources', search.nextCursor), /match/);
  await assert.rejects(uiSearch('anything', 'constructor'), /Unsupported/);
  assert.equal((await uiSearch('%%', 'resources')).groups[0].entries.length, 0, 'Search treats wildcards literally.');
  assert.ok((await uiSearch('requestTimeout', 'settings')).groups[0].entries.some(item => item.url.includes('setting=ai.requestTimeoutMs')));
  const orphan = await createTradingStrategyDraft({ name: 'Recoverable standalone strategy', configuration: model.configuration });
  const orphanReview = await uiModelDetail('strategy', orphan.id);
  assert.equal(orphanReview.resourceCount, 0); assert.equal(orphanReview.model.status, 'draft');
  const attached = await mutateUiModel({ kind: 'strategy', id: orphan.id, action: 'attach', reviewHash: orphanReview.reviewHash });
  assert.equal(attached.resource.configuration.strategyVersionId, orphan.id); assert.equal(attached.resource.status, 'draft');
  assert.equal((await getTradingStrategyVersion(orphan.id)).status, 'draft', 'Recovery attaches exactly the accepted model without publishing or creating another model.');
  await assert.rejects(mutateUiModel({ kind: 'strategy', id: orphan.id, action: 'attach', reviewHash: orphanReview.reviewHash }), /MODEL_REVIEW_CONFLICT/);
  const orphanFresh = await uiModelDetail('strategy', orphan.id); assert.equal(orphanFresh.resourceCount, 1);
  await assert.rejects(mutateUiModel({ kind: 'strategy', id: orphan.id, action: 'delete', reviewHash: orphanFresh.reviewHash }), /Retained resource/);
  const publishedModel = await mutateUiModel({ kind: 'strategy', id: orphan.id, action: 'publish', reviewHash: orphanFresh.reviewHash });
  assert.equal(publishedModel.model.status, 'published');
  for (let index = 0; index < 102; index++) await createTradingStrategyDraft({ name: `Unbound model ${index}`, configuration: model.configuration });
  const modelsPage = await uiModelPage('strategy', new URLSearchParams({ limit: '100' }));
  const modelsNext = await uiModelPage('strategy', new URLSearchParams({ limit: '100', cursor: modelsPage.nextCursor }));
  assert.equal(modelsPage.entries.length, 100); assert.ok(modelsNext.entries.length > 2); assert.equal(modelsNext.observedAt, modelsPage.observedAt);
  assert.equal(new Set([...modelsPage.entries, ...modelsNext.entries].map(item => item.id)).size, 100 + modelsNext.entries.length);
  assert.ok(modelsPage.entries.every(item => !('configuration' in item))); await assert.rejects(uiModelPage('contract', new URLSearchParams({ limit: '100', cursor: modelsPage.nextCursor })), /match/);
  const contractsPage = await uiModelPage('contract', new URLSearchParams()); assert.ok(contractsPage.entries.every(item => typeof item.name === 'string'));
  const schemasPage = await uiModelPage('schema', new URLSearchParams()); assert.ok(schemasPage.entries.length > 0);
  const schemaDetail = await uiModelDetail('schema', schemasPage.entries[0].id); assert.ok(schemaDetail.model.definition);
  const disabledSchema = await mutateUiModel({ kind: 'schema', id: schemaDetail.model.id, action: 'disable', reviewHash: schemaDetail.reviewHash });
  assert.equal(disabledSchema.model.enabled, false);
  await assert.rejects(mutateUiModel({ kind: 'schema', id: schemaDetail.model.id, action: 'enable', reviewHash: schemaDetail.reviewHash }), /MODEL_REVIEW_CONFLICT/);
  const disabledReview = await uiModelDetail('schema', schemaDetail.model.id);
  const enabledSchema = await mutateUiModel({ kind: 'schema', id: schemaDetail.model.id, action: 'enable', reviewHash: disabledReview.reviewHash });
  assert.equal(enabledSchema.model.enabled, true);
  const enabledReview = await uiModelDetail('schema', schemaDetail.model.id);
  await assert.rejects(mutateUiModel({ kind: 'schema', id: schemaDetail.model.id, action: 'publish', reviewHash: enabledReview.reviewHash }), /Unsupported model action/);
  for (const [action, status] of [['publish', 'published'], ['archive', 'archived']]) {
    const review = await uiModelDetail('contract', contractDraft.id);
    const changed = await mutateUiModel({ kind: 'contract', id: contractDraft.id, action, reviewHash: review.reviewHash });
    assert.equal(changed.model.status, status);
    assert.equal((await getActiveWorkflow()).id, activated.workflow.id, 'A model lifecycle change never activates another workflow.');
  }
  const archivedReview = await uiModelDetail('contract', contractDraft.id);
  assert.equal((await mutateUiModel({ kind: 'contract', id: contractDraft.id, action: 'delete', reviewHash: archivedReview.reviewHash })).deleted, true);
  const unusedDraft = await createSignalContractDraftVersion(parent.id, source.id);
  const unusedReview = await uiModelDetail('contract', unusedDraft.id);
  assert.equal((await mutateUiModel({ kind: 'contract', id: unusedDraft.id, action: 'delete', reviewHash: unusedReview.reviewHash })).deleted, true);
  assert.equal(await uiModelDetail('strategy', 'missing'), null); await assert.rejects(uiModelPage('constructor', new URLSearchParams()), /Unsupported/);
  console.log('MCP/setup review, graph/model atomicity, standalone model recovery and bounded libraries passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
