import { approveMcpProposal, getMcpProposal, preflightMcpAction } from './mcp_repository.js';
import { getActiveWorkflow, listWorkflowResources } from './workflow_repository.js';
import { getTradingRuntimeState, listSignalContracts, listTradingSignalSchemas, listTradingStrategies, listTradingRoutes } from './trading_repository.js';
import { listChannelRiskPolicies } from './trading_channel_risk.js';
import { withDatabaseTransaction } from './db.js';
import { redactReview, reviewHash } from './ui_change_review.js';

async function currentProposalObject(action: string, payload: Record<string, any>, active: Awaited<ReturnType<typeof getActiveWorkflow>>) {
  if (action.startsWith('workflow.')) return currentWorkflowObject(action, payload, active);
  if (action.startsWith('contracts.')) return (await listSignalContracts()).flatMap(contract => contract.versions)
    .find(version => version.id === (payload.versionId ?? payload.sourceVersionId)) ?? null;
  if (action.startsWith('schemas.')) return (await listTradingSignalSchemas()).find(schema => schema.id === payload.id) ?? null;
  if (action.startsWith('strategies.')) return (await listTradingStrategies()).find(strategy => strategy.id === payload.id) ?? null;
  if (action.startsWith('routes.')) return (await listTradingRoutes()).find(route => route.channelId === payload.channelId) ?? null;
  if (action.startsWith('risk.')) return (await listChannelRiskPolicies()).find(policy => policy.channelId === payload.channelId) ?? null;
  return getTradingRuntimeState();
}

async function currentWorkflowObject(action: string, payload: Record<string, any>, active: Awaited<ReturnType<typeof getActiveWorkflow>>) {
  if (action === 'workflow.activate') return { baseRevisionId: active?.id ?? null, graph: active?.graph ?? null };
  return (await listWorkflowResources()).find(resource => resource.id === payload.id) ?? null;
}

function affectedProposalPaths(action: string, payload: Record<string, any>, before: any, active: Awaited<ReturnType<typeof getActiveWorkflow>>) {
  const identifiers = new Set<string>();
  const collect = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((key.endsWith('Id') || key === 'id') && typeof item === 'string') identifiers.add(item);
      else if (item && typeof item === 'object') collect(item);
    }
  };
  collect(payload); collect(before);
  return (active?.compiled.paths ?? []).filter(path => action === 'workflow.activate' || action === 'trading.release_kill_switch'
    || Object.values(path).some(value => typeof value === 'string' && identifiers.has(value))
    || path.nodeIds.some(id => active!.graph.nodes.some(node => node.id === id && identifiers.has(node.resourceVersionId))));
}

// Requested fields are separate from server normalization and trade execution evidence.
function requestedProjection(action: string, payload: Record<string, any>, before: any) {
  if (action.includes('delete')) return null;
  if (action.endsWith('publish')) return { ...before, status: 'published' };
  if (action.endsWith('archive')) return { ...before, status: 'archived' };
  if (action === 'trading.release_kill_switch') return { ...before, killSwitchActive: false };
  if (action.includes('create') || action.endsWith('duplicate')) return payload;
  return { ...before, ...payload };
}

export async function uiMcpProposalReview(id: string) {
  const proposal = await getMcpProposal(id);
  if (!proposal) return null;
  const payload = proposal.payload as Record<string, any>;
  const action = proposal.action;
  const active = await getActiveWorkflow();
  const before = await currentProposalObject(action, payload, active);
  const affectedPaths = affectedProposalPaths(action, payload, before, active);
  const requested = requestedProjection(action, payload, before);
  const checkedAt = Date.now();
  const freshPreflight = await preflightMcpAction(action, payload);
  return {
    contractVersion: 1, observedAt: checkedAt,
    reviewHash: reviewHash({ proposalId: proposal.id, action, payload, before, activeRevisionId: active?.id ?? null }),
    proposal: redactReview(proposal), before: redactReview(before), requested: redactReview(requested),
    freshPreflight: redactReview(freshPreflight),
    scope: { globalEntryEffects: action === 'trading.release_kill_switch', activeRevisionId: active?.id ?? null,
      accountIds: [...new Set([...affectedPaths.map(path => path.accountId), ...(typeof payload.accountId === 'string' ? [payload.accountId] : [])])],
      paths: affectedPaths.map(path => ({ id: path.id, accountId: path.accountId, channelId: path.channelId })) },
    interpretation: 'Beantragte Felder und heutiger Objektstand. Normalisierung erfolgt bei Ausführung; keine Zusage einer Risiko- oder Handelsfreigabe. Bestehende gepinnte Trades bleiben unverändert.',
  };
}

export async function approveReviewedMcpProposal(id: string, actor: string, expectedReviewHash: unknown) {
  return withDatabaseTransaction(async () => {
    const review = await uiMcpProposalReview(id);
    if (!review || typeof expectedReviewHash !== 'string' || review.reviewHash !== expectedReviewHash) throw new Error('MCP_REVIEW_CONFLICT: Prüfinhalt geändert; neue Vorschau erforderlich.');
    return approveMcpProposal(id, actor);
  });
}
