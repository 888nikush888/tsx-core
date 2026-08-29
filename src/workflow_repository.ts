import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { decimal } from './trading_decimal.js';
import { parseRegex, safeRegexTest } from './filters.js';
import { loadSignalPromptTemplate } from './signal_parser.js';
import { validateStrategyConfiguration } from './trading_strategy.js';
import type { Config } from './config.js';
import type {
  ExecutableSignal,
  StrategyConfiguration,
  TradingIntent,
  WorkflowEdge,
  WorkflowExecutionPath,
  WorkflowGraph,
  WorkflowNode,
  WorkflowResourceKind,
  WorkflowResourceVersion,
  WorkflowRevision,
  WorkflowRouteGroup,
} from './trading_types.js';

const RESOURCE_KINDS = new Set<WorkflowResourceKind>([
  'channel', 'content_filter', 'keyword_filter', 'regex', 'parser', 'schema',
  'contract', 'dedupe', 'strategy', 'sizing', 'adaptive_risk', 'account', 'output',
]);

const STAGE: Record<WorkflowResourceKind, number> = {
  channel: 0,
  content_filter: 1,
  keyword_filter: 2,
  regex: 3,
  parser: 4,
  schema: 5,
  contract: 6,
  dedupe: 7,
  strategy: 8,
  sizing: 9,
  adaptive_risk: 10,
  account: 11,
  output: 12,
};

const WORKFLOW_COLUMN_GAP = 316;
const WORKFLOW_ROW_GAP = 150;

const REQUIRED_EXECUTION_KINDS = new Set<WorkflowResourceKind>([
  'channel', 'parser', 'schema', 'contract', 'strategy', 'sizing', 'account',
]);

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
export const WORKFLOW_IMPACT_CONFIRMATION = 'ACTIVATE WORKFLOW IMPACT';

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, any>;
}

function normalizedJson(value: unknown): string {
  const visit = (candidate: any): any => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(Object.keys(candidate)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, visit(candidate[key])]));
  };
  return JSON.stringify(visit(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(normalizedJson(value)).digest('hex');
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') throw new Error(`Stored ${label} is not JSON.`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}

function stringValue(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be a bounded string array.`);
  }
  const values = value.map(item => item.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
  return values;
}

type ResourceConfiguration = Record<string, any>;
type ResourceValidator = (value: ResourceConfiguration) => Record<string, unknown>;

function validateRegexConfiguration(value: ResourceConfiguration): Record<string, unknown> {
  const patterns = stringArray(value.patterns, 'Regex patterns', 100);
  for (const pattern of patterns) {
    try { parseRegex(pattern); } catch (error) { throw new Error(`Invalid regex pattern: ${pattern}`, { cause: error }); }
  }
  const mode = value.mode ?? 'all';
  if (!['all', 'any'].includes(mode)) throw new Error('Regex mode must be all or any.');
  return { ...value, patterns, mode };
}

function validateParserConfiguration(value: ResourceConfiguration): Record<string, unknown> {
  const timeoutMs = Number(value.timeoutMs ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 120_000) {
    throw new Error('Parser timeout must be between 2000 and 120000 milliseconds.');
  }
  if (value.saveToFile === true) throw new Error('Workflow parsers may not save signals to files.');
  if (value.prompt !== undefined && (typeof value.prompt !== 'string'
    || !value.prompt.trim() || value.prompt.trim().length > 50_000)) {
    throw new Error('Parser prompt must contain between 1 and 50000 characters.');
  }
  return {
    ...value,
    templateName: stringValue(value.templateName ?? 'default', 'Parser template name', 128),
    ...(value.primaryModel ? { primaryModel: stringValue(value.primaryModel, 'Primary parser model', 128) } : {}),
    ...(value.fallbackModel ? { fallbackModel: stringValue(value.fallbackModel, 'Fallback parser model', 128) } : {}),
    ...(value.prompt !== undefined ? { prompt: value.prompt.trim() } : {}),
    timeoutMs,
    saveToFile: false,
  };
}

function validateSizingConfiguration(value: ResourceConfiguration): Record<string, unknown> {
  const positionSizingMode = value.positionSizingMode ?? 'equity_percent_margin';
  if (!['risk_percent', 'equity_percent_notional', 'equity_percent_margin'].includes(positionSizingMode)) {
    throw new Error('Sizing mode is unsupported.');
  }
  const baseline = decimal(value.riskPerTradePercent, { positive: true, max: '10' });
  const maximum = decimal(value.maxAdaptiveRiskPercent ?? baseline, { positive: true, max: '10' });
  if (Number(maximum) < Number(baseline)) {
    throw new Error('Maximum adaptive risk must not be below the baseline sizing percentage.');
  }
  const maxLeverage = Number(value.maxLeverage ?? 1);
  if (!Number.isSafeInteger(maxLeverage) || maxLeverage < 1 || maxLeverage > 50) {
    throw new Error('Maximum leverage must be between 1 and 50.');
  }
  const defaultLeverage = value.defaultLeverage === undefined ? maxLeverage : Number(value.defaultLeverage);
  if (!Number.isSafeInteger(defaultLeverage) || defaultLeverage < 1 || defaultLeverage > 50) {
    throw new Error('Default leverage must be between 1 and 50.');
  }
  if (defaultLeverage > maxLeverage) {
    throw new Error('Default leverage must not exceed maximum leverage.');
  }
  return {
    ...value,
    positionSizingMode,
    riskPerTradePercent: baseline,
    maxAdaptiveRiskPercent: maximum,
    maxPositionNotional: decimal(value.maxPositionNotional ?? '1000000000', { positive: true }),
    defaultLeverage,
    maxLeverage,
  };
}

function boundedInteger(candidate: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} is invalid.`);
  return parsed;
}

function adaptiveRiskTiers(value: ResourceConfiguration): Array<{ riskPercent: string }> {
  const rawTiers = value.tiers ?? [{ riskPercent: '5' }];
  if (!Array.isArray(rawTiers) || rawTiers.length < 1 || rawTiers.length > 20) {
    throw new Error('Adaptive risk requires between one and twenty tiers.');
  }
  const tiers = rawTiers.map((tier, index) => {
    const candidate = object(tier, `Adaptive-risk tier ${index + 1}`);
    return { riskPercent: decimal(candidate.riskPercent, { positive: true, max: '10' }) };
  });
  tiers.forEach((tier, index) => {
    if (index > 0 && Number(tier.riskPercent) <= Number(tiers[index - 1]!.riskPercent)) {
      throw new Error('Adaptive-risk tiers must increase strictly.');
    }
  });
  return tiers;
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
}

function adaptiveRiskMode(value: unknown): string {
  const mode = value ?? 'automatic';
  if (!['fixed', 'shadow', 'automatic'].includes(String(mode))) throw new Error('Adaptive-risk mode is invalid.');
  return String(mode);
}

function optionalAdaptiveTier(value: unknown, tierCount: number): number | null {
  if (value === null || value === undefined) return null;
  return boundedInteger(value, 'Adaptive-risk locked tier', 0, tierCount - 1);
}

function weakChannelAction(value: unknown): string {
  const action = value ?? 'reduce';
  if (!['none', 'reduce', 'block'].includes(String(action))) throw new Error('Adaptive-risk weak-channel action is invalid.');
  return String(action);
}

function validateAdaptiveRiskConfiguration(value: ResourceConfiguration): Record<string, unknown> {
  optionalBoolean(value.enabled, 'Adaptive-risk enabled state');
  optionalBoolean(value.manuallyBlocked, 'Adaptive-risk manual block');
  const mode = adaptiveRiskMode(value.mode);
  const tiers = adaptiveRiskTiers(value);
  const startingTier = boundedInteger(value.startingTier ?? value.currentTier ?? 0, 'Adaptive-risk starting tier', 0, tiers.length - 1);
  const lockedTier = optionalAdaptiveTier(value.lockedTier, tiers.length);
  const action = weakChannelAction(value.weakChannelAction);
  return {
    ...value,
    enabled: value.enabled !== false,
    mode,
    tiers,
    startingTier,
    lockedTier,
    lookbackWeeks: boundedInteger(value.lookbackWeeks ?? 1, 'Adaptive-risk lookback weeks', 1, 12),
    minimumClosedTrades: boundedInteger(value.minimumClosedTrades ?? 5, 'Adaptive-risk minimum closed trades', 1, 1_000),
    lossThresholdPercent: decimal(value.lossThresholdPercent ?? '2', { positive: true, max: '100' }),
    profitThresholdPercent: decimal(value.profitThresholdPercent ?? '2', { positive: true, max: '100' }),
    weakChannelAction: action,
    weakWeeksBeforeBlock: boundedInteger(value.weakWeeksBeforeBlock ?? 3, 'Adaptive-risk weak weeks', 1, 52),
    manuallyBlocked: value.manuallyBlocked === true,
  };
}

function validateDedupeConfiguration(value: ResourceConfiguration): Record<string, unknown> {
  const cooldownHours = Number(value.cooldownHours ?? 24);
  if (!Number.isFinite(cooldownHours) || cooldownHours < 0 || cooldownHours > 8_760) {
    throw new Error('Dedupe cooldown must be between 0 and 8760 hours.');
  }
  return { ...value, enabled: value.enabled !== false, cooldownHours };
}

function validateOutputConfiguration(value: ResourceConfiguration): Record<string, unknown> {
  const mode = value.mode ?? 'audit_only';
  if (!['audit_only', 'telegram_xml', 'telegram_original', 'none'].includes(mode)) {
    throw new Error('Workflow output mode is invalid.');
  }
  return { ...value, mode };
}

const RESOURCE_VALIDATORS: Partial<Record<WorkflowResourceKind, ResourceValidator>> = {
  channel: value => ({ ...value, channelId: stringValue(value.channelId, 'Channel identifier') }),
  content_filter: value => ({ ...value, allowedTypes: stringArray(value.allowedTypes ?? ['text'], 'Allowed content types', 20) }),
  keyword_filter: value => ({
    ...value,
    allowedKeywords: stringArray(value.allowedKeywords ?? [], 'Allowed keywords'),
    blockedKeywords: stringArray(value.blockedKeywords ?? [], 'Blocked keywords'),
  }),
  regex: validateRegexConfiguration,
  parser: validateParserConfiguration,
  schema: value => ({ ...value, schemaId: stringValue(value.schemaId, 'Signal schema identifier', 64) }),
  contract: value => ({ ...value, contractVersionId: stringValue(value.contractVersionId, 'Contract version identifier', 64) }),
  strategy: value => ({ ...value, strategyVersionId: stringValue(value.strategyVersionId, 'Strategy version identifier', 64) }),
  sizing: validateSizingConfiguration,
  adaptive_risk: validateAdaptiveRiskConfiguration,
  account: value => ({ ...value, accountId: stringValue(value.accountId, 'Account identifier', 64) }),
  dedupe: validateDedupeConfiguration,
  output: validateOutputConfiguration,
};

function validateResourceConfiguration(kind: WorkflowResourceKind, input: unknown): Record<string, unknown> {
  const value = object(input, `${kind} configuration`);
  if (JSON.stringify(value).length > 100_000) throw new Error('Workflow resource configuration is too large.');
  return RESOURCE_VALIDATORS[kind]?.(value) ?? value;
}

function resourceFromRow(row: any): WorkflowResourceVersion {
  const configuration = parseJson<Record<string, unknown>>(row.configuration_json, 'workflow resource configuration');
  if (sha256(configuration) !== row.configuration_sha256) throw new Error(`Workflow resource ${row.id} failed its integrity check.`);
  return {
    id: String(row.id), resourceId: String(row.resource_id), version: Number(row.version), kind: row.kind,
    name: String(row.name), description: String(row.description || ''), status: row.status,
    configuration, configurationSha256: String(row.configuration_sha256), createdAt: Number(row.created_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

function pathFromRow(row: any): WorkflowExecutionPath {
  return {
    id: String(row.id), workflowRevisionId: String(row.workflow_revision_id), pathKey: String(row.path_key),
    channelId: String(row.channel_id), accountId: String(row.account_id),
    strategyVersionId: String(row.strategy_version_id), parserResourceVersionId: row.parser_resource_version_id || null,
    schemaResourceVersionId: row.schema_resource_version_id || null,
    contractResourceVersionId: row.contract_resource_version_id || null,
    sizingResourceVersionId: row.sizing_resource_version_id || null,
    adaptiveRiskResourceVersionId: row.adaptive_risk_resource_version_id || null,
    routeGroupKey: String(row.route_group_key || row.path_key),
    fallbackRank: Number(row.fallback_rank || 0),
    nodeIds: parseJson<string[]>(row.node_ids_json, 'workflow path nodes'),
    effectiveConfiguration: parseJson<Record<string, unknown>>(row.effective_configuration_json, 'workflow path configuration'),
    enabled: Number(row.enabled) === 1, createdAt: Number(row.created_at),
  };
}

export async function listWorkflowResources(kind?: WorkflowResourceKind): Promise<WorkflowResourceVersion[]> {
  const rows = kind
    ? await getDatabase().all<any[]>('SELECT * FROM workflow_resource_versions WHERE kind = ? ORDER BY resource_id, version DESC', [kind])
    : await getDatabase().all<any[]>('SELECT * FROM workflow_resource_versions ORDER BY kind, resource_id, version DESC');
  return rows.map(resourceFromRow);
}

export async function createWorkflowResourceDraft(input: {
  resourceId?: string;
  kind: WorkflowResourceKind;
  name: string;
  description?: string;
  configuration: unknown;
}, now = Date.now()): Promise<WorkflowResourceVersion> {
  if (!RESOURCE_KINDS.has(input.kind)) throw new Error('Unsupported workflow resource kind.');
  const name = stringValue(input.name, 'Workflow resource name', 80);
  const description = String(input.description ?? '').trim();
  if (description.length > 500) throw new Error('Workflow resource description must not exceed 500 characters.');
  const configuration = validateResourceConfiguration(input.kind, input.configuration);
  const resourceId = input.resourceId ? stringValue(input.resourceId, 'Workflow resource identifier', 128) : randomUUID();
  const latest = await getDatabase().get<{ version: number }>(
    'SELECT MAX(version) AS version FROM workflow_resource_versions WHERE resource_id = ?', [resourceId],
  );
  const version = Number(latest?.version || 0) + 1;
  const id = randomUUID();
  await getDatabase().run(
    `INSERT INTO workflow_resource_versions (
       id, resource_id, version, kind, name, description, status, configuration_json,
       configuration_sha256, created_at, published_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, NULL)`,
    [id, resourceId, version, input.kind, name, description, normalizedJson(configuration), sha256(configuration), now],
  );
  return resourceFromRow(await getDatabase().get('SELECT * FROM workflow_resource_versions WHERE id = ?', [id]));
}

export async function updateWorkflowResourceDraft(id: string, input: {
  name: string;
  description?: string;
  configuration: unknown;
}): Promise<WorkflowResourceVersion> {
  const existingRow = await getDatabase().get<any>('SELECT * FROM workflow_resource_versions WHERE id = ?', [id]);
  if (!existingRow || existingRow.status !== 'draft') throw new Error('Only a workflow resource draft can be edited.');
  const name = stringValue(input.name, 'Workflow resource name', 80);
  const description = String(input.description ?? '').trim();
  if (description.length > 500) throw new Error('Workflow resource description must not exceed 500 characters.');
  const configuration = validateResourceConfiguration(existingRow.kind, input.configuration);
  await getDatabase().run(
    `UPDATE workflow_resource_versions SET name = ?, description = ?, configuration_json = ?, configuration_sha256 = ?
     WHERE id = ? AND status = 'draft'`,
    [name, description, normalizedJson(configuration), sha256(configuration), id],
  );
  return resourceFromRow(await getDatabase().get('SELECT * FROM workflow_resource_versions WHERE id = ?', [id]));
}

export async function publishWorkflowResource(id: string, now = Date.now()): Promise<WorkflowResourceVersion> {
  const existing = await getDatabase().get<any>('SELECT * FROM workflow_resource_versions WHERE id = ?', [id]);
  if (!existing || existing.status !== 'draft') throw new Error('Only a workflow resource draft can be published.');
  validateResourceConfiguration(existing.kind, parseJson(existing.configuration_json, 'workflow resource configuration'));
  await getDatabase().run(
    `UPDATE workflow_resource_versions SET status = 'published', published_at = ? WHERE id = ? AND status = 'draft'`,
    [now, id],
  );
  return resourceFromRow(await getDatabase().get('SELECT * FROM workflow_resource_versions WHERE id = ?', [id]));
}

export async function archiveWorkflowResource(id: string, now = Date.now()): Promise<WorkflowResourceVersion> {
  const active = await getActiveWorkflow();
  if (active?.graph.nodes.some(node => node.resourceVersionId === id)) {
    throw new Error('The active workflow must stop referencing this resource before it can be archived.');
  }
  const result = await getDatabase().run(
    `UPDATE workflow_resource_versions SET status = 'archived', archived_at = ? WHERE id = ? AND status = 'published'`,
    [now, id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only a published workflow resource can be archived.');
  return resourceFromRow(await getDatabase().get('SELECT * FROM workflow_resource_versions WHERE id = ?', [id]));
}

export async function archiveWorkflowResourceFamily(
  resourceId: string,
  now = Date.now(),
): Promise<WorkflowResourceVersion[]> {
  const logicalId = stringValue(resourceId, 'Workflow resource identifier', 128);
  return withDatabaseTransaction(async database => {
    const rows = await database.all<any[]>(
      `SELECT * FROM workflow_resource_versions
       WHERE resource_id = ? AND status = 'published'
       ORDER BY version`,
      [logicalId],
    );
    if (rows.length === 0) throw new Error('No published workflow resource versions can be archived.');
    const publishedIds = new Set(rows.map(row => String(row.id)));
    const active = await getActiveWorkflow();
    if (active?.graph.nodes.some(node => publishedIds.has(node.resourceVersionId))) {
      throw new Error('The active workflow must stop referencing this resource before it can be archived.');
    }
    const result = await database.run(
      `UPDATE workflow_resource_versions
       SET status = 'archived', archived_at = ?
       WHERE resource_id = ? AND status = 'published'`,
      [now, logicalId],
    );
    if (Number(result.changes || 0) !== rows.length) {
      throw new Error('The workflow resource family changed while it was being archived.');
    }
    return (await database.all<any[]>(
      'SELECT * FROM workflow_resource_versions WHERE resource_id = ? ORDER BY version',
      [logicalId],
    )).filter(row => publishedIds.has(String(row.id))).map(resourceFromRow);
  });
}

export async function deleteWorkflowResourceDraft(id: string): Promise<boolean> {
  const result = await getDatabase().run(
    `DELETE FROM workflow_resource_versions WHERE id = ? AND status = 'draft'`, [id],
  );
  return Number(result.changes || 0) === 1;
}

function workflowEdgeKind(edge: Record<string, any>, id: string, schemaVersion: 1 | 2): WorkflowEdge['kind'] {
  const kind = edge.kind === undefined && schemaVersion === 1 ? undefined : edge.kind;
  if (schemaVersion === 2 && kind !== 'flow' && kind !== 'account_fallback') {
    throw new Error(`Workflow edge ${id} must declare flow or account_fallback kind.`);
  }
  if (schemaVersion === 1 && kind !== undefined && kind !== 'flow') {
    throw new Error(`Workflow edge ${id} kind is unavailable in schema version 1.`);
  }
  return kind;
}

function workflowEdgeChannelScope(
  edge: Record<string, any>,
  id: string,
  nodesById: Map<string, WorkflowNode>,
  kind: WorkflowEdge['kind'],
): string[] | undefined {
  if (edge.channelNodeIds === undefined) {
    if (kind === 'account_fallback') {
      throw new Error(`Account fallback edge ${id} must be scoped to at least one origin channel.`);
    }
    return undefined;
  }
  const channelNodeIds = stringArray(edge.channelNodeIds, `Workflow edge ${id} channel scope`, 1_000);
  if (channelNodeIds.length === 0 || channelNodeIds.some(channelNodeId => !IDENTIFIER.test(channelNodeId))) {
    throw new Error(`Workflow edge ${id} channel scope must contain at least one valid channel node identifier.`);
  }
  if (channelNodeIds.some(channelNodeId => nodesById.get(channelNodeId)?.kind !== 'channel')) {
    throw new Error(`Workflow edge ${id} channel scope must reference channel nodes in this graph.`);
  }
  return channelNodeIds.sort((left, right) => left.localeCompare(right));
}

function normalizeWorkflowEdge(input: {
  candidate: unknown;
  schemaVersion: 1 | 2;
  nodeIds: Set<string>;
  nodesById: Map<string, WorkflowNode>;
  edgeIds: Set<string>;
  pairs: Set<string>;
}): WorkflowEdge {
  const edge = object(input.candidate, 'Workflow edge');
  const id = stringValue(edge.id, 'Workflow edge identifier');
  const source = stringValue(edge.source, 'Workflow edge source');
  const target = stringValue(edge.target, 'Workflow edge target');
  const kind = workflowEdgeKind(edge, id, input.schemaVersion);
  const pair = `${source}\0${target}`;
  if (!IDENTIFIER.test(id) || input.edgeIds.has(id) || input.pairs.has(pair)) {
    throw new Error(`Workflow edge ${id} is invalid or duplicated.`);
  }
  if (!input.nodeIds.has(source) || !input.nodeIds.has(target) || source === target) {
    throw new Error(`Workflow edge ${id} references an invalid endpoint.`);
  }
  if (kind === 'account_fallback'
    && (input.nodesById.get(source)?.kind !== 'account' || input.nodesById.get(target)?.kind !== 'account')) {
    throw new Error(`Account fallback edge ${id} must connect two exchange account nodes.`);
  }
  const channelNodeIds = workflowEdgeChannelScope(edge, id, input.nodesById, kind);
  input.edgeIds.add(id);
  input.pairs.add(pair);
  return { id, source, target, ...(kind ? { kind } : {}), ...(channelNodeIds ? { channelNodeIds } : {}) };
}

function validateGraph(input: unknown): WorkflowGraph {
  const value = object(input, 'Workflow graph');
  if (![1, 2].includes(value.schemaVersion) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('Workflow graph contract is invalid.');
  }
  if (value.nodes.length > 1_000 || value.edges.length > 5_000) throw new Error('Workflow graph exceeds its size limit.');
  const nodeIds = new Set<string>();
  const nodes: WorkflowNode[] = value.nodes.map((candidate: unknown) => {
    const node = object(candidate, 'Workflow node');
    const id = stringValue(node.id, 'Workflow node identifier');
    if (!IDENTIFIER.test(id) || nodeIds.has(id)) throw new Error(`Workflow node identifier '${id}' is invalid or duplicated.`);
    nodeIds.add(id);
    if (!RESOURCE_KINDS.has(node.kind)) throw new Error(`Workflow node ${id} has an unsupported kind.`);
    const position = object(node.position, `Workflow node ${id} position`);
    if (![position.x, position.y].every(Number.isFinite)) throw new Error(`Workflow node ${id} position is invalid.`);
    return {
      id, kind: node.kind, resourceVersionId: stringValue(node.resourceVersionId, 'Resource version identifier', 64),
      position: { x: Number(position.x), y: Number(position.y) },
    };
  });
  for (const kind of RESOURCE_KINDS) {
    nodes
      .filter(node => node.kind === kind)
      .sort((left, right) => left.position.y - right.position.y || left.id.localeCompare(right.id))
      .forEach((node, index) => {
        node.position = { x: STAGE[kind] * WORKFLOW_COLUMN_GAP, y: index * WORKFLOW_ROW_GAP };
      });
  }
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  const edges: WorkflowEdge[] = value.edges.map((candidate: unknown) => normalizeWorkflowEdge({
    candidate, schemaVersion: value.schemaVersion, nodeIds, nodesById, edgeIds, pairs,
  }));
  return { schemaVersion: value.schemaVersion, nodes, edges };
}

type CompiledDraftPath = Omit<WorkflowExecutionPath, 'workflowRevisionId' | 'createdAt'>;

export interface WorkflowImpactPath {
  channelId: string;
  accountId: string;
  strategyVersionId: string;
  enabled: boolean;
  nodeIds: string[];
}

export interface WorkflowImpact {
  added: WorkflowImpactPath[];
  changed: WorkflowImpactPath[];
  removed: WorkflowImpactPath[];
  destructive: boolean;
  warnings: string[];
  confirmation: typeof WORKFLOW_IMPACT_CONFIRMATION | null;
}

function publicPath(path: Pick<WorkflowExecutionPath,
  'channelId' | 'accountId' | 'strategyVersionId' | 'enabled' | 'nodeIds'
>): WorkflowImpactPath {
  return {
    channelId: path.channelId,
    accountId: path.accountId,
    strategyVersionId: path.strategyVersionId,
    enabled: path.enabled,
    nodeIds: [...path.nodeIds],
  };
}

function pathIdentity(path: Pick<WorkflowExecutionPath, 'channelId' | 'accountId' | 'nodeIds'>): string {
  return normalizedJson({ channelId: path.channelId, accountId: path.accountId, nodeIds: path.nodeIds });
}

function pathDefinition(path: Pick<WorkflowExecutionPath,
  'strategyVersionId' | 'enabled' | 'effectiveConfiguration'
>): string {
  return sha256({
    strategyVersionId: path.strategyVersionId,
    enabled: path.enabled,
    effectiveConfiguration: path.effectiveConfiguration,
  });
}

function workflowImpact(
  current: WorkflowExecutionPath[],
  candidate: CompiledDraftPath[],
  warnings: string[],
): WorkflowImpact {
  const before = new Map(current.map(path => [pathIdentity(path), path]));
  const after = new Map(candidate.map(path => [pathIdentity(path), path]));
  const added: WorkflowImpactPath[] = [];
  const changed: WorkflowImpactPath[] = [];
  const removed: WorkflowImpactPath[] = [];
  for (const [identity, path] of after) {
    const previous = before.get(identity);
    if (!previous) added.push(publicPath(path));
    else if (pathDefinition(previous) !== pathDefinition(path)) changed.push(publicPath(path));
  }
  for (const [identity, path] of before) {
    if (!after.has(identity)) removed.push(publicPath(path));
  }
  // Every executable-path change can alter future exchange side effects.
  // New paths therefore require the same explicit activation phrase as
  // changed or removed paths; disconnected/inert editor changes remain safe.
  const destructive = added.length > 0 || changed.length > 0 || removed.length > 0;
  return {
    added,
    changed,
    removed,
    destructive,
    warnings,
    confirmation: destructive ? WORKFLOW_IMPACT_CONFIRMATION : null,
  };
}

async function loadWorkflowResources(graph: WorkflowGraph): Promise<Map<string, WorkflowResourceVersion>> {
  const resourceRows = graph.nodes.length < 1 ? [] : await getDatabase().all<any[]>(
    `SELECT * FROM workflow_resource_versions WHERE id IN (${graph.nodes.map(() => '?').join(',')})`,
    graph.nodes.map(node => node.resourceVersionId),
  );
  const resources = new Map<string, WorkflowResourceVersion>(resourceRows.map(row => [String(row.id), resourceFromRow(row)]));
  const placedResourceIds = new Map<string, string>();
  const placedBehaviors = new Map<string, { nodeId: string; name: string }>();
  for (const node of graph.nodes) {
    const resource = resources.get(node.resourceVersionId);
    if (!resource || resource.status !== 'published') throw new Error(`Node ${node.id} must reference a published resource version.`);
    if (resource.kind !== node.kind) throw new Error(`Node ${node.id} kind does not match its resource.`);
    const existingNodeId = placedResourceIds.get(resource.resourceId);
    if (existingNodeId) {
      throw new Error(
        `Workflow resource '${resource.name}' may only be placed once (nodes ${existingNodeId} and ${node.id}).`,
      );
    }
    placedResourceIds.set(resource.resourceId, node.id);
    const behaviorKey = `${resource.kind}:${resource.configurationSha256}`;
    const existingBehavior = placedBehaviors.get(behaviorKey);
    if (existingBehavior) {
      throw new Error(
        `Workflow resources '${existingBehavior.name}' and '${resource.name}' have identical behavior and may only be placed once ` +
        `(nodes ${existingBehavior.nodeId} and ${node.id}).`,
      );
    }
    placedBehaviors.set(behaviorKey, { nodeId: node.id, name: resource.name });
  }
  return resources;
}

function buildWorkflowTopology(graph: WorkflowGraph): {
  nodes: Map<string, WorkflowNode>;
  adjacency: Map<string, WorkflowEdge[]>;
  indegree: Map<string, number>;
} {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const adjacency = new Map<string, WorkflowEdge[]>();
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (edge.kind === 'account_fallback') continue;
    const source = nodes.get(edge.source)!;
    const target = nodes.get(edge.target)!;
    if (STAGE[source.kind] >= STAGE[target.kind]) {
      throw new Error(`Connection ${edge.id} must move from an earlier processing column to a later one.`);
    }
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  return { nodes, adjacency, indegree };
}

function edgeAppliesToChannel(edge: WorkflowEdge, channelNodeId: string): boolean {
  return !edge.channelNodeIds || edge.channelNodeIds.includes(channelNodeId);
}

function ordinaryAccountNodesForChannel(
  nodes: Map<string, WorkflowNode>,
  adjacency: Map<string, WorkflowEdge[]>,
  channelNodeId: string,
): Set<string> {
  const accounts = new Set<string>();
  const visited = new Set<string>();
  const pending = [channelNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodes.get(nodeId);
    if (node?.kind === 'account') {
      accounts.add(nodeId);
      continue;
    }
    for (const edge of adjacency.get(nodeId) ?? []) {
      if (edgeAppliesToChannel(edge, channelNodeId)) pending.push(edge.target);
    }
  }
  return accounts;
}

function fallbackSuccessorsForChannel(
  graph: WorkflowGraph,
  channelNodeId: string,
  ordinaryAccounts: Set<string>,
): Map<string, string> {
  const fallbackEdges = graph.edges.filter(edge =>
    edge.kind === 'account_fallback' && edge.channelNodeIds?.includes(channelNodeId));
  const successors = new Map<string, string>();
  const predecessors = new Map<string, string>();
  for (const edge of fallbackEdges) {
    if (successors.has(edge.source)) {
      throw new Error(`Account fallback for channel ${channelNodeId} must be linear; ${edge.source} has more than one successor.`);
    }
    if (predecessors.has(edge.target)) {
      throw new Error(`Account fallback for channel ${channelNodeId} must be linear; ${edge.target} has more than one predecessor.`);
    }
    successors.set(edge.source, edge.target);
    predecessors.set(edge.target, edge.source);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error(`Account fallback chain for channel ${channelNodeId} contains a cycle.`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const target = successors.get(nodeId);
    if (target) visit(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of successors.keys()) visit(nodeId);
  for (const edge of fallbackEdges) {
    if (ordinaryAccounts.has(edge.target)) {
      throw new Error(`Account ${edge.target} cannot be both a direct route and a fallback candidate for channel ${channelNodeId}.`);
    }
    if (!ordinaryAccounts.has(edge.source) && !predecessors.has(edge.source)) {
      throw new Error(`Account fallback chain for channel ${channelNodeId} must start at a directly connected account.`);
    }
  }
  return successors;
}

function assertAcyclicWorkflow(nodeCount: number, adjacency: Map<string, WorkflowEdge[]>, indegree: Map<string, number>): void {
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!; visited += 1;
    for (const edge of adjacency.get(id) ?? []) {
      const target = edge.target;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited !== nodeCount) throw new Error('Workflow graph must not contain cycles.');
}

interface WorkflowCompileContext {
  nodes: Map<string, WorkflowNode>;
  adjacency: Map<string, WorkflowEdge[]>;
  resources: Map<string, WorkflowResourceVersion>;
  paths: CompiledDraftPath[];
  routeGroups: WorkflowRouteGroup[];
  fallbackByChannel: Map<string, Map<string, string>>;
  warnings: string[];
}

async function loadCompiledPathDependencies(
  configs: Record<string, any>,
  accountId: string,
  strategyVersionId: string,
): Promise<{ account: any; baseStrategy: StrategyConfiguration }> {
  const schemaId = String(configs.schema.schemaId);
  const [account, strategy, schema, contract] = await Promise.all([
    getDatabase().get<any>('SELECT id, enabled, status FROM trading_accounts WHERE id = ?', [accountId]),
    getDatabase().get<any>('SELECT status, configuration_json FROM trading_strategy_versions WHERE id = ?', [strategyVersionId]),
    getDatabase().get<any>('SELECT enabled FROM trading_signal_schemas WHERE id = ?', [schemaId]),
    getDatabase().get<any>('SELECT status FROM trading_signal_contract_versions WHERE id = ?', [configs.contract.contractVersionId]),
  ]);
  if (!account) throw new Error(`Workflow account ${accountId} does not exist.`);
  if (strategy?.status !== 'published') throw new Error(`Workflow strategy ${strategyVersionId} is not published.`);
  if (!schema || Number(schema.enabled) !== 1) throw new Error(`Workflow signal schema ${schemaId} is unavailable.`);
  if (contract?.status !== 'published') throw new Error('Workflow contract node must reference a published contract.');
  const baseStrategy = validateStrategyConfiguration(parseJson(strategy.configuration_json, 'strategy configuration'));
  if (!baseStrategy.allowedSignalSchemas.includes(schemaId)) {
    throw new Error('Workflow strategy does not allow the selected signal schema. Publish a compatible strategy version first.');
  }
  return { account, baseStrategy };
}

function compiledEffectiveConfiguration(
  baseStrategy: StrategyConfiguration,
  configs: Record<string, any>,
): Record<string, unknown> {
  const normalizedSizing = validateSizingConfiguration(configs.sizing);
  const normalizedConfigs = { ...configs, sizing: normalizedSizing };
  const effectiveStrategy: StrategyConfiguration = {
    ...baseStrategy,
    schemaVersion: 4,
    sizing: { ...baseStrategy.sizing, ...normalizedSizing },
    safety: { ...baseStrategy.safety, maxConcurrentPositions: undefined },
  };
  delete effectiveStrategy.safety.maxConcurrentPositions;
  return { resources: normalizedConfigs, strategyConfiguration: validateStrategyConfiguration(effectiveStrategy) };
}

function resourceVersionForKind(byKind: Map<WorkflowResourceKind, WorkflowNode>, kind: WorkflowResourceKind): string | null {
  const node = byKind.get(kind);
  return node ? node.resourceVersionId : null;
}

async function compileTerminalLineage(
  terminalLineage: string[],
  accountNodeId: string,
  channelNodeId: string,
  context: WorkflowCompileContext,
): Promise<void> {
  const primaryAccountIndex = terminalLineage.indexOf(accountNodeId);
  const prefix = terminalLineage.slice(0, primaryAccountIndex);
  const suffix = terminalLineage.slice(primaryAccountIndex + 1);
  const accountNodeIds = [accountNodeId];
  const successors = context.fallbackByChannel.get(channelNodeId) ?? new Map<string, string>();
  while (successors.has(accountNodeIds.at(-1)!)) accountNodeIds.push(successors.get(accountNodeIds.at(-1)!)!);
  const primaryNodes = terminalLineage.map(id => context.nodes.get(id)!);
  const present = new Set(primaryNodes.map(item => item.kind));
  const missing = [...REQUIRED_EXECUTION_KINDS].filter(kind => !present.has(kind));
  if (missing.length > 0) {
    context.warnings.push(`Path ending at ${accountNodeId} is inert; missing: ${missing.join(', ')}.`);
    return;
  }
  const primaryConfigs = Object.fromEntries(primaryNodes
    .map(item => [item.kind, context.resources.get(item.resourceVersionId)!.configuration]));
  const channelId = String((primaryConfigs.channel as any).channelId);
  const strategyVersionId = String((primaryConfigs.strategy as any).strategyVersionId);
  const routeGroupKey = sha256({ channelNodeId, terminalLineage, accountNodeIds });
  const candidates: WorkflowRouteGroup['candidates'] = [];
  for (let rank = 0; rank < accountNodeIds.length; rank += 1) {
    const candidateNodeIds = [...prefix, ...accountNodeIds.slice(0, rank + 1), ...suffix];
    const pathNodes = candidateNodeIds.map(id => context.nodes.get(id)!);
    const byKind = new Map(pathNodes.map(item => [item.kind, item]));
    const configs = Object.fromEntries(pathNodes
      .map(item => [item.kind, context.resources.get(item.resourceVersionId)!.configuration]));
    const accountId = String((configs.account as any).accountId);
    const { account, baseStrategy } = await loadCompiledPathDependencies(configs, accountId, strategyVersionId);
    const effectiveConfiguration = compiledEffectiveConfiguration(baseStrategy, configs);
    const id = randomUUID();
    const path: CompiledDraftPath = {
      id,
      pathKey: sha256({ routeGroupKey, rank, candidateNodeIds, channelId, accountId, strategyVersionId }),
      channelId,
      accountId,
      strategyVersionId,
      parserResourceVersionId: resourceVersionForKind(byKind, 'parser'),
      schemaResourceVersionId: resourceVersionForKind(byKind, 'schema'),
      contractResourceVersionId: resourceVersionForKind(byKind, 'contract'),
      sizingResourceVersionId: resourceVersionForKind(byKind, 'sizing'),
      adaptiveRiskResourceVersionId: resourceVersionForKind(byKind, 'adaptive_risk'),
      routeGroupKey,
      fallbackRank: rank,
      nodeIds: candidateNodeIds,
      effectiveConfiguration,
      enabled: Number(account.enabled) === 1 && account.status === 'ready',
    };
    context.paths.push(path);
    candidates.push({ pathId: id, accountId, accountNodeId: accountNodeIds[rank], rank, enabled: path.enabled });
  }
  context.routeGroups.push({
    key: routeGroupKey,
    channelId,
    channelNodeId,
    primaryPathId: candidates[0].pathId,
    candidates,
  });
}

async function walkWorkflowPaths(
  context: WorkflowCompileContext,
  nodeId: string,
  lineage: string[],
  channelNodeId: string,
): Promise<void> {
  const node = context.nodes.get(nodeId)!;
  const nextLineage = [...lineage, nodeId];
  if (node.kind === 'account') {
    const outputTargets = (context.adjacency.get(node.id) ?? [])
      .filter(edge => edgeAppliesToChannel(edge, channelNodeId))
      .map(edge => edge.target)
      .filter(target => context.nodes.get(target)?.kind === 'output');
    if (outputTargets.length > 1) throw new Error(`Exchange account node ${node.id} may connect to at most one output node.`);
    const terminalLineages = outputTargets.length > 0
      ? outputTargets.map(target => [...nextLineage, target])
      : [nextLineage];
    for (const terminalLineage of terminalLineages) {
      await compileTerminalLineage(terminalLineage, node.id, channelNodeId, context);
    }
    return;
  }
  const targets = (context.adjacency.get(nodeId) ?? [])
    .filter(edge => edgeAppliesToChannel(edge, channelNodeId))
    .map(edge => edge.target);
  if (targets.length === 0) context.warnings.push(`Node ${nodeId} is not connected to an exchange account for channel ${channelNodeId} and is inert.`);
  for (const target of targets) await walkWorkflowPaths(context, target, nextLineage, channelNodeId);
}

function assertConsistentTelegramOutputs(paths: CompiledDraftPath[]): void {
  const telegramOutputModes = new Map<string, Set<string>>();
  for (const path of paths) {
    const resources = object(path.effectiveConfiguration.resources, 'Compiled workflow resources');
    const mode = String((resources.output as any)?.mode ?? 'audit_only');
    if (mode !== 'telegram_xml' && mode !== 'telegram_original') continue;
    const modes = telegramOutputModes.get(path.channelId) ?? new Set<string>();
    modes.add(mode);
    telegramOutputModes.set(path.channelId, modes);
  }
  for (const [channelId, modes] of telegramOutputModes) {
    if (modes.size > 1) {
      throw new Error(`Channel ${channelId} cannot forward both XML and original Telegram messages in one active workflow.`);
    }
  }
}

async function compileWorkflow(graph: WorkflowGraph): Promise<{
  paths: CompiledDraftPath[];
  routeGroups: WorkflowRouteGroup[];
  warnings: string[];
}> {
  const resources = await loadWorkflowResources(graph);
  const { nodes, adjacency, indegree } = buildWorkflowTopology(graph);
  assertAcyclicWorkflow(graph.nodes.length, adjacency, indegree);

  const warnings: string[] = [];
  const paths: CompiledDraftPath[] = [];
  const routeGroups: WorkflowRouteGroup[] = [];
  const channelNodes = graph.nodes.filter(node => node.kind === 'channel');
  const fallbackByChannel = new Map<string, Map<string, string>>();
  for (const channel of channelNodes) {
    const ordinaryAccounts = ordinaryAccountNodesForChannel(nodes, adjacency, channel.id);
    fallbackByChannel.set(channel.id, fallbackSuccessorsForChannel(graph, channel.id, ordinaryAccounts));
  }
  const context = { nodes, adjacency, resources, paths, routeGroups, fallbackByChannel, warnings };
  for (const channel of channelNodes) await walkWorkflowPaths(context, channel.id, [], channel.id);
  if (channelNodes.length === 0 && graph.nodes.length > 0) warnings.push('No channel node is present; the workflow is inert.');
  assertConsistentTelegramOutputs(paths);
  return { paths, routeGroups, warnings: [...new Set(warnings)] };
}

export async function saveWorkflowRevision(input: {
  baseRevisionId: string | null;
  graph: unknown;
  actorId: string;
  confirmation?: string | null;
}, now = Date.now()): Promise<WorkflowRevision> {
  const graph = validateGraph(input.graph);
  const compiled = await compileWorkflow(graph);
  const actorId = stringValue(input.actorId, 'Workflow actor identifier', 128);
  return withDatabaseTransaction(async () => {
    const active = await getDatabase().get<{ revision_id: string }>('SELECT revision_id FROM workflow_active_revision WHERE singleton_id = 1');
    const activeId = active?.revision_id ?? null;
    if (activeId !== input.baseRevisionId) throw new Error('WORKFLOW_REVISION_CONFLICT');
    const activePaths = activeId
      ? (await getDatabase().all<any[]>(
          'SELECT * FROM workflow_execution_paths WHERE workflow_revision_id = ? ORDER BY path_key',
          [activeId],
        )).map(pathFromRow)
      : [];
    const impact = workflowImpact(activePaths, compiled.paths, compiled.warnings);
    if (impact.destructive && input.confirmation !== WORKFLOW_IMPACT_CONFIRMATION) {
      throw new Error('WORKFLOW_IMPACT_CONFIRMATION_REQUIRED');
    }
    const latest = await getDatabase().get<{ revision: number }>('SELECT MAX(revision) AS revision FROM workflow_revisions');
    const revisionNumber = Number(latest?.revision || 0) + 1;
    const id = randomUUID();
    const paths: WorkflowExecutionPath[] = compiled.paths
      .map(path => ({ ...path, workflowRevisionId: id, createdAt: now }))
      .sort((left, right) => left.pathKey.localeCompare(right.pathKey));
    const compiledPayload = { paths, routeGroups: compiled.routeGroups, warnings: compiled.warnings };
    const definitionSha256 = sha256({ graph, compiled: compiledPayload });
    if (activeId) {
      await getDatabase().run(
        `UPDATE workflow_revisions SET status = 'archived', archived_at = ? WHERE id = ? AND status = 'active'`,
        [now, activeId],
      );
    }
    await getDatabase().run(
      `INSERT INTO workflow_revisions (
         id, revision, status, graph_json, compiled_json, definition_sha256,
         base_revision_id, created_by, created_at, archived_at
       ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
      [id, revisionNumber, normalizedJson(graph), normalizedJson(compiledPayload), definitionSha256, activeId, actorId, now],
    );
    for (const path of paths) {
      await getDatabase().run(
        `INSERT INTO workflow_execution_paths (
           id, workflow_revision_id, path_key, channel_id, account_id, strategy_version_id,
           parser_resource_version_id, schema_resource_version_id, contract_resource_version_id,
           sizing_resource_version_id, adaptive_risk_resource_version_id, node_ids_json,
           effective_configuration_json, route_group_key, fallback_rank, enabled, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [path.id, id, path.pathKey, path.channelId, path.accountId, path.strategyVersionId,
          path.parserResourceVersionId, path.schemaResourceVersionId, path.contractResourceVersionId,
          path.sizingResourceVersionId, path.adaptiveRiskResourceVersionId, normalizedJson(path.nodeIds),
          normalizedJson(path.effectiveConfiguration), path.routeGroupKey, path.fallbackRank,
          path.enabled ? 1 : 0, now],
      );
    }
    await getDatabase().run(
      `INSERT INTO workflow_active_revision (singleton_id, revision_id, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET revision_id = excluded.revision_id, updated_at = excluded.updated_at`,
      [id, now],
    );
    return {
      id, revision: revisionNumber, status: 'active', graph, compiled: compiledPayload,
      definitionSha256, baseRevisionId: activeId, createdBy: actorId, createdAt: now, archivedAt: null,
    };
  });
}

export async function previewWorkflowImpact(input: {
  baseRevisionId: string | null;
  graph: unknown;
}): Promise<WorkflowImpact> {
  const graph = validateGraph(input.graph);
  const compiled = await compileWorkflow(graph);
  const active = await getDatabase().get<{ revision_id: string }>(
    'SELECT revision_id FROM workflow_active_revision WHERE singleton_id = 1',
  );
  const activeId = active?.revision_id ?? null;
  if (activeId !== input.baseRevisionId) throw new Error('WORKFLOW_REVISION_CONFLICT');
  const activePaths = activeId
    ? (await getDatabase().all<any[]>(
        'SELECT * FROM workflow_execution_paths WHERE workflow_revision_id = ? ORDER BY path_key',
        [activeId],
      )).map(pathFromRow)
    : [];
  return workflowImpact(activePaths, compiled.paths, compiled.warnings);
}

async function ensurePublishedWorkflowResource(input: {
  resourceId: string;
  kind: WorkflowResourceKind;
  name: string;
  description: string;
  configuration: unknown;
}): Promise<WorkflowResourceVersion> {
  const configuration = validateResourceConfiguration(input.kind, input.configuration);
  const existing = await getDatabase().get<any>(
    `SELECT * FROM workflow_resource_versions
     WHERE resource_id = ? AND status = 'published'
     ORDER BY version DESC LIMIT 1`,
    [input.resourceId],
  );
  if (existing && existing.configuration_sha256 === sha256(configuration)) return resourceFromRow(existing);
  const draft = await createWorkflowResourceDraft({
    resourceId: input.resourceId,
    kind: input.kind,
    name: input.name.slice(0, 80),
    description: input.description.slice(0, 500),
    configuration,
  });
  return publishWorkflowResource(draft.id);
}

interface LegacyResourceDefinition {
  kind: WorkflowResourceKind;
  name: string;
  configuration: Record<string, unknown>;
}

async function loadLegacyWorkflowInputs(): Promise<{ routes: any[]; schemas: any[]; policies: Map<string, any> }> {
  const routes = await getDatabase().all<any[]>(
    `SELECT route.channel_id, route.strategy_version_id, route.account_id,
            strategy.name AS strategy_name, strategy.configuration_json,
            account.name AS account_name
     FROM trading_routes AS route
     JOIN trading_strategy_versions AS strategy ON strategy.id = route.strategy_version_id
     JOIN trading_accounts AS account ON account.id = route.account_id
     WHERE route.enabled = 1 AND strategy.status = 'published'
     ORDER BY route.channel_id, route.account_id`,
  );
  const schemas = await getDatabase().all<any[]>(
    `SELECT id, name, template_name, contract_version_id
     FROM trading_signal_schemas WHERE enabled = 1 ORDER BY id`,
  );
  const policies = new Map((await getDatabase().all<any[]>(
    'SELECT * FROM trading_channel_risk_policies ORDER BY channel_id',
  )).map(row => [String(row.channel_id), row]));
  return { routes, schemas, policies };
}

function selectLegacySchema(schemas: any[], templateName: string, strategy: StrategyConfiguration): any | null {
  const allowedSchemas = new Set(strategy.allowedSignalSchemas);
  return schemas.find(candidate => candidate.template_name === templateName && allowedSchemas.has(candidate.id))
    ?? schemas.find(candidate => allowedSchemas.has(candidate.id))
    ?? null;
}

function legacyAdaptiveRiskDefinition(alias: string, policy: any): LegacyResourceDefinition[] {
  if (!policy) return [];
  return [{
    kind: 'adaptive_risk',
    name: `Adaptives Risiko · ${alias}`,
    configuration: {
      enabled: true,
      mode: policy.mode,
      tiers: parseJson(policy.tiers_json, 'legacy adaptive risk tiers'),
      startingTier: Number(policy.current_tier),
      lockedTier: policy.locked_tier === null ? null : Number(policy.locked_tier),
      lookbackWeeks: Number(policy.lookback_weeks),
      minimumClosedTrades: Number(policy.minimum_closed_trades),
      lossThresholdPercent: String(policy.loss_threshold_percent),
      profitThresholdPercent: String(policy.profit_threshold_percent),
      weakChannelAction: policy.weak_channel_action,
      weakWeeksBeforeBlock: Number(policy.weak_weeks_before_block),
      manuallyBlocked: Number(policy.manually_blocked) === 1 || Number(policy.blocked) === 1,
    },
  }];
}

function legacyOutputMode(config: Config): 'telegram_xml' | 'telegram_original' | 'audit_only' {
  if (!config.forwardOptions?.forwardToTarget) return 'audit_only';
  return config.xmlParsing.forwardXmlToTarget ? 'telegram_xml' : 'telegram_original';
}

function legacyResourceDefinitions(input: {
  config: Config;
  route: any;
  channelId: string;
  alias: string;
  strategy: StrategyConfiguration;
  schema: any;
  templateName: string;
  prompt: string;
  policy: any;
}): LegacyResourceDefinition[] {
  const { config, route, channelId, alias, strategy, schema, templateName, prompt, policy } = input;
  const sourcePatterns = config.sourceFilters?.[channelId]?.regexPatterns;
  const regexPatterns = Array.isArray(sourcePatterns) ? sourcePatterns : (config.filters.regexPatterns || []);
  return [
    { kind: 'channel', name: `Kanal · ${alias}`, configuration: { channelId } },
    {
      kind: 'content_filter', name: `Inhalt · ${alias}`,
      configuration: { allowedTypes: config.filters.allowedTypes?.length ? config.filters.allowedTypes : ['text'] },
    },
    {
      kind: 'keyword_filter', name: `Schlüsselwörter · ${alias}`,
      configuration: {
        allowedKeywords: config.filters.allowedKeywords || [],
        blockedKeywords: config.filters.blockedKeywords || [],
      },
    },
    { kind: 'regex', name: `Regex · ${alias}`, configuration: { patterns: regexPatterns, mode: 'all' } },
    {
      kind: 'parser', name: `Parser · ${alias}`,
      configuration: {
        templateName,
        prompt,
        timeoutMs: Math.min(120_000, Math.max(2_000, config.xmlParsing.aiLimits.requestTimeoutMs || 30_000)),
        saveToFile: false,
      },
    },
    { kind: 'schema', name: `Schema · ${schema.name}`, configuration: { schemaId: schema.id } },
    { kind: 'contract', name: `Vertrag · ${schema.name}`, configuration: { contractVersionId: schema.contract_version_id } },
    {
      kind: 'dedupe', name: `Duplikatschutz · ${alias}`,
      configuration: { enabled: config.dupeBlocker.enabled, cooldownHours: config.dupeBlocker.cooldownHours },
    },
    { kind: 'strategy', name: `Strategie · ${route.strategy_name}`, configuration: { strategyVersionId: route.strategy_version_id } },
    { kind: 'sizing', name: `Sizing · ${route.account_name}`, configuration: strategy.sizing },
    ...legacyAdaptiveRiskDefinition(alias, policy),
    { kind: 'account', name: `Börsenkonto · ${route.account_name}`, configuration: { accountId: route.account_id } },
    { kind: 'output', name: `Ausgabe · ${alias}`, configuration: { mode: legacyOutputMode(config) } },
  ];
}

async function materializeLegacyPath(
  definitions: LegacyResourceDefinition[],
  route: any,
  channelId: string,
  pathIndex: number,
): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }> {
  const nodes: WorkflowNode[] = [];
  for (const [stageIndex, definition] of definitions.entries()) {
    const resource = await ensurePublishedWorkflowResource({
      resourceId: `legacy:${definition.kind}:${channelId}:${route.account_id}`,
      kind: definition.kind,
      name: definition.name,
      description: 'Automatisch und verlustfrei aus dem bisherigen Kanal-Routing übernommen.',
      configuration: definition.configuration,
    });
    nodes.push({
      id: randomUUID(),
      kind: definition.kind,
      resourceVersionId: resource.id,
      position: { x: stageIndex * 280, y: pathIndex * 190 },
    });
  }
  const edges = nodes.slice(1).map((node, index) => ({
    id: randomUUID(), source: nodes[index]!.id, target: node.id,
  }));
  return { nodes, edges };
}

export async function migrateLegacyTradingRoutesToWorkflow(
  config: Config,
  actorId = 'system:legacy-workflow-migration',
): Promise<{ migrated: boolean; paths: number; skipped: string[] }> {
  if (await getActiveWorkflow()) return { migrated: false, paths: 0, skipped: [] };
  const { routes, schemas, policies } = await loadLegacyWorkflowInputs();
  if (routes.length === 0) return { migrated: false, paths: 0, skipped: [] };
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const skipped: string[] = [];
  let pathCount = 0;

  for (const route of routes) {
    const channelId = String(route.channel_id);
    const strategy = validateStrategyConfiguration(parseJson(route.configuration_json, 'legacy strategy configuration'));
    const templateName = config.xmlParsing.sourceTemplates?.[channelId] || 'default';
    const schema = selectLegacySchema(schemas, templateName, strategy);
    if (!schema) {
      skipped.push(`${channelId}: no enabled signal schema allowed by strategy ${route.strategy_version_id}`);
      continue;
    }
    const prompt = await loadSignalPromptTemplate(templateName);
    const alias = config.sourceAliases?.[channelId] || channelId;
    const definitions = legacyResourceDefinitions({
      config, route, channelId, alias, strategy, schema, templateName: prompt.templateName,
      prompt: prompt.promptTemplate, policy: policies.get(channelId),
    });
    const path = await materializeLegacyPath(definitions, route, channelId, pathCount);
    nodes.push(...path.nodes);
    edges.push(...path.edges);
    pathCount += 1;
  }
  if (pathCount === 0) return { migrated: false, paths: 0, skipped };
  await saveWorkflowRevision({
    baseRevisionId: null,
    graph: { schemaVersion: 1, nodes, edges },
    actorId,
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  return { migrated: true, paths: pathCount, skipped };
}

export async function getActiveWorkflow(): Promise<WorkflowRevision | null> {
  const row = await getDatabase().get<any>(
    `SELECT revision.* FROM workflow_revisions AS revision
     JOIN workflow_active_revision AS active ON active.revision_id = revision.id
     WHERE active.singleton_id = 1`,
  );
  if (!row) return null;
  const graph = parseJson<WorkflowGraph>(row.graph_json, 'workflow graph');
  const pathRows = await getDatabase().all<any[]>(
    'SELECT * FROM workflow_execution_paths WHERE workflow_revision_id = ? ORDER BY path_key', [row.id],
  );
  const storedCompiled = parseJson<{ routeGroups?: WorkflowRouteGroup[]; warnings?: string[] }>(
    row.compiled_json,
    'compiled workflow',
  );
  const paths = pathRows.map(pathFromRow);
  if (storedCompiled.routeGroups) {
    if (sha256({ graph, compiled: { paths, routeGroups: storedCompiled.routeGroups, warnings: storedCompiled.warnings ?? [] } })
      !== row.definition_sha256) {
      throw new Error(`Workflow revision ${row.id} failed its integrity check.`);
    }
  } else {
    const legacyPaths = paths.map(({ routeGroupKey: _group, fallbackRank: _rank, ...path }) => path);
    if (sha256({ graph, compiled: { paths: legacyPaths, warnings: storedCompiled.warnings ?? [] } }) !== row.definition_sha256) {
      throw new Error(`Workflow revision ${row.id} failed its integrity check.`);
    }
  }
  const routeGroups = storedCompiled.routeGroups ?? paths.map(path => ({
    key: path.routeGroupKey,
    channelId: path.channelId,
    channelNodeId: path.nodeIds.find(nodeId => graph.nodes.find(node => node.id === nodeId)?.kind === 'channel') || '',
    primaryPathId: path.id,
    candidates: [{
      pathId: path.id,
      accountId: path.accountId,
      accountNodeId: [...path.nodeIds].reverse()
        .find(nodeId => graph.nodes.find(node => node.id === nodeId)?.kind === 'account') || '',
      rank: 0,
      enabled: path.enabled,
    }],
  }));
  const compiled = { paths, routeGroups, warnings: storedCompiled.warnings ?? [] };
  return {
    id: String(row.id), revision: Number(row.revision), status: row.status, graph, compiled,
    definitionSha256: String(row.definition_sha256), baseRevisionId: row.base_revision_id || null,
    createdBy: String(row.created_by), createdAt: Number(row.created_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

function keywordFilterReason(keywords: any, text: string): string | null {
  const normalized = text.toLocaleLowerCase('und');
  if (keywords?.blockedKeywords?.some((word: string) => normalized.includes(word.toLocaleLowerCase('und')))) {
    return 'BLOCKED_KEYWORD';
  }
  if (keywords?.allowedKeywords?.length
    && !keywords.allowedKeywords.some((word: string) => normalized.includes(word.toLocaleLowerCase('und')))) {
    return 'ALLOWED_KEYWORD_MISSING';
  }
  return null;
}

function regexAllowsInput(regex: any, text: string): boolean {
  if (!regex?.patterns?.length) return true;
  const boundedText = text.length > 8_000 ? text.slice(0, 8_000) : text;
  const matches = regex.patterns.map((pattern: string) => safeRegexTest(parseRegex(pattern), boundedText, 100));
  return regex.mode === 'any' ? matches.some(Boolean) : matches.every(Boolean);
}

function pathAllowsInput(
  path: WorkflowExecutionPath,
  text: string,
  contentType = 'text',
): { allowed: boolean; reason?: string } {
  const resources = object(path.effectiveConfiguration.resources, 'Compiled workflow resources');
  const content = resources.content_filter as any;
  if (content && !content.allowedTypes.includes(contentType)) return { allowed: false, reason: 'CONTENT_TYPE_FILTERED' };
  const keywordReason = keywordFilterReason(resources.keyword_filter, text);
  if (keywordReason) return { allowed: false, reason: keywordReason };
  if (!regexAllowsInput(resources.regex, text)) return { allowed: false, reason: 'REGEX_FILTERED' };
  return { allowed: true };
}

export async function simulateWorkflow(input: {
  channelId: string;
  text: string;
  contentType?: string;
}): Promise<Record<string, unknown>> {
  const workflow = await getActiveWorkflow();
  if (!workflow) return { active: false, paths: [], warnings: ['No active workflow revision.'] };
  const paths = workflow.compiled.paths.filter(path => path.channelId === input.channelId).map(path => ({
    id: path.id, accountId: path.accountId, strategyVersionId: path.strategyVersionId,
    enabled: path.enabled, ...pathAllowsInput(path, input.text, input.contentType),
  }));
  return { active: true, revisionId: workflow.id, revision: workflow.revision, paths, warnings: workflow.compiled.warnings };
}

export interface WorkflowSignalPlan {
  key: string;
  workflowRevisionId: string;
  executionPathIds: string[];
  templateName: string;
  prompt?: string;
  timeoutMs: number;
  primaryModel?: string;
  fallbackModel?: string;
  schemaId: string;
  contractVersionId: string;
  dedupe: { enabled: boolean; cooldownHours: number };
  outputModes: Array<'audit_only' | 'telegram_xml' | 'telegram_original' | 'none'>;
}

function signalPlanForPath(path: WorkflowExecutionPath, workflowRevisionId: string): WorkflowSignalPlan {
  const resources = object(path.effectiveConfiguration.resources, 'Compiled workflow resources');
  const parser = object(resources.parser, 'Compiled parser resource');
  const schema = object(resources.schema, 'Compiled schema resource');
  const contract = object(resources.contract, 'Compiled contract resource');
  const dedupe = resources.dedupe ? object(resources.dedupe, 'Compiled dedupe resource') : null;
  const output = resources.output ? object(resources.output, 'Compiled output resource') : null;
  const definition = {
    parserResourceVersionId: path.parserResourceVersionId,
    schemaResourceVersionId: path.schemaResourceVersionId,
    contractResourceVersionId: path.contractResourceVersionId,
    templateName: String(parser.templateName),
    prompt: parser.prompt ? String(parser.prompt) : undefined,
    timeoutMs: Number(parser.timeoutMs),
    primaryModel: parser.primaryModel ? String(parser.primaryModel) : undefined,
    fallbackModel: parser.fallbackModel ? String(parser.fallbackModel) : undefined,
    schemaId: String(schema.schemaId),
    contractVersionId: String(contract.contractVersionId),
    dedupe: {
      enabled: dedupe ? dedupe.enabled !== false : false,
      cooldownHours: Number(dedupe?.cooldownHours ?? 24),
    },
  };
  return {
    key: sha256(definition),
    workflowRevisionId,
    executionPathIds: [path.id],
    templateName: definition.templateName,
    ...(definition.prompt ? { prompt: definition.prompt } : {}),
    timeoutMs: definition.timeoutMs,
    ...(definition.primaryModel ? { primaryModel: definition.primaryModel } : {}),
    ...(definition.fallbackModel ? { fallbackModel: definition.fallbackModel } : {}),
    schemaId: definition.schemaId,
    contractVersionId: definition.contractVersionId,
    dedupe: definition.dedupe,
    outputModes: [String(output?.mode ?? 'audit_only') as WorkflowSignalPlan['outputModes'][number]],
  };
}

function mergeSignalPlan(groups: Map<string, WorkflowSignalPlan>, candidate: WorkflowSignalPlan): void {
  const existing = groups.get(candidate.key);
  if (!existing) {
    groups.set(candidate.key, candidate);
    return;
  }
  existing.executionPathIds.push(...candidate.executionPathIds);
  for (const mode of candidate.outputModes) {
    if (!existing.outputModes.includes(mode)) existing.outputModes.push(mode);
  }
}

export async function getWorkflowSignalPlans(input: {
  channelId: string;
  text: string;
  contentType: string;
}): Promise<WorkflowSignalPlan[]> {
  const workflow = await getActiveWorkflow();
  if (!workflow) return [];
  const groups = new Map<string, WorkflowSignalPlan>();
  for (const path of workflow.compiled.paths) {
    if (path.channelId !== input.channelId || !path.enabled) continue;
    if (!pathAllowsInput(path, input.text, input.contentType).allowed) continue;
    mergeSignalPlan(groups, signalPlanForPath(path, workflow.id));
  }
  return [...groups.values()].map(plan => ({
    ...plan,
    executionPathIds: [...plan.executionPathIds].sort((left, right) => left.localeCompare(right)),
    outputModes: [...plan.outputModes].sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) => left.key.localeCompare(right.key));
}

function intentFromRow(row: any): TradingIntent {
  return {
    id: String(row.id), sourceSignalId: String(row.source_signal_id), rootSourceSignalId: String(row.root_source_signal_id),
    signalRunId: row.signal_run_id || null, workflowRevisionId: row.workflow_revision_id || null,
    executionPathId: row.execution_path_id || null, channelId: String(row.channel_id),
    strategyVersionId: String(row.strategy_version_id), accountId: String(row.account_id), exchange: row.exchange,
    mode: row.mode, symbol: String(row.symbol), side: row.side, status: row.status,
    signal: parseJson(row.signal_json, 'trade signal'), plan: row.plan_json ? parseJson(row.plan_json, 'trade plan') : null,
    blockReason: row.block_reason || null, error: row.last_error || null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

type WorkflowIntentInput = {
  sourceSignalId: string;
  channelId: string;
  sourceText: string;
  signal: ExecutableSignal;
  executionPathIds?: string[];
  contentType?: string;
};

function workflowIntentBlockReason(path: WorkflowExecutionPath, account: any, runtime: any): string | null {
  if (!path.enabled || !account || account.status !== 'ready' || Number(account.enabled) !== 1) return 'ACCOUNT_NOT_READY';
  if (Number(account.kill_switch_active) === 1) return 'ACCOUNT_KILL_SWITCH_ACTIVE';
  if (Number(runtime.kill_switch_active) === 1) return 'KILL_SWITCH_ACTIVE';
  if (Number(runtime.execution_enabled) !== 1) return 'EXECUTION_DISABLED';
  if (account.mode === 'live' && Number(runtime.live_trading_enabled) !== 1) return 'LIVE_TRADING_DISABLED';
  return null;
}

async function processWorkflowIntentPath(input: {
  request: WorkflowIntentInput;
  workflow: WorkflowRevision;
  path: WorkflowExecutionPath;
  runId: string;
  runtime: any;
  now: number;
}): Promise<{ intent?: TradingIntent; branch?: Record<string, unknown> }> {
  const { request, workflow, path, runId, runtime, now } = input;
  const filter = pathAllowsInput(path, request.sourceText, request.contentType);
  if (!filter.allowed) return { branch: { pathId: path.id, status: 'filtered', reason: filter.reason } };
  const existing = await getDatabase().get<any>(
    'SELECT * FROM trading_trade_intents WHERE root_source_signal_id = ? AND execution_path_id = ?',
    [request.sourceSignalId, path.id],
  );
  if (existing) return { intent: intentFromRow(existing) };
  const account = await getDatabase().get<any>('SELECT * FROM trading_accounts WHERE id = ?', [path.accountId]);
  const blockReason = workflowIntentBlockReason(path, account, runtime);
  const status = blockReason ? 'blocked' : 'pending';
  const id = randomUUID();
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (
       id, source_signal_id, root_source_signal_id, signal_run_id, workflow_revision_id,
       execution_path_id, channel_id, strategy_version_id, account_id, exchange, mode,
       symbol, side, status, signal_json, plan_json, block_reason, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    [id, request.sourceSignalId, request.sourceSignalId, runId, workflow.id, path.id,
      request.channelId, path.strategyVersionId, path.accountId, account.exchange, account.mode,
      request.signal.symbol, request.signal.action, status, normalizedJson(request.signal), blockReason, now, now],
  );
  const intent = intentFromRow(await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [id]));
  return { intent, branch: { pathId: path.id, intentId: id, status, blockReason } };
}

async function persistFallbackRouteGroup(input: {
  request: WorkflowIntentInput;
  workflow: WorkflowRevision;
  group: WorkflowRouteGroup;
  runId: string;
  runtime: any;
  now: number;
}): Promise<{ intents: TradingIntent[]; branches: Array<Record<string, unknown>> }> {
  const { request, workflow, group, runId, runtime, now } = input;
  const pathsById = new Map(workflow.compiled.paths.map(path => [path.id, path]));
  const ordered = group.candidates
    .map(candidate => ({ candidate, path: pathsById.get(candidate.pathId) }))
    .filter((item): item is { candidate: WorkflowRouteGroup['candidates'][number]; path: WorkflowExecutionPath } => Boolean(item.path))
    .sort((left, right) => left.candidate.rank - right.candidate.rank);
  if (ordered.length !== group.candidates.length || ordered.length < 2) {
    throw new Error('Compiled fallback route group is incomplete.');
  }
  const candidateRunId = randomUUID();
  await getDatabase().run(
    `INSERT OR IGNORE INTO trading_fallback_runs (
       id, source_signal_id, workflow_revision_id, signal_run_id, route_group_key, channel_id,
       status, current_rank, selected_intent_id, stop_reason, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'probing', 0, NULL, NULL, ?, ?, NULL)`,
    [candidateRunId, request.sourceSignalId, workflow.id, runId, group.key, request.channelId, now, now],
  );
  const fallbackRun = await getDatabase().get<{ id: string; status: string }>(
    `SELECT id, status FROM trading_fallback_runs
     WHERE source_signal_id = ? AND workflow_revision_id = ? AND route_group_key = ?`,
    [request.sourceSignalId, workflow.id, group.key],
  );
  if (!fallbackRun) throw new Error('Fallback run could not be persisted.');
  for (const { candidate, path } of ordered) {
    await getDatabase().run(
      `INSERT OR IGNORE INTO trading_fallback_candidates (
         fallback_run_id, rank, execution_path_id, account_id, intent_id, status,
         error_code, details_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 'waiting', NULL, NULL, ?, ?)`,
      [fallbackRun.id, candidate.rank, path.id, path.accountId, now, now],
    );
  }
  const existing = await getDatabase().all<any[]>(
    `SELECT intent.* FROM trading_fallback_candidates AS candidate
     JOIN trading_trade_intents AS intent ON intent.id = candidate.intent_id
     WHERE candidate.fallback_run_id = ? ORDER BY candidate.rank`,
    [fallbackRun.id],
  );
  if (existing.length > 0) return { intents: existing.map(intentFromRow), branches: [] };
  const primary = ordered[0].path;
  const result = await processWorkflowIntentPath({ request, workflow, path: primary, runId, runtime, now });
  if (!result.intent) return { intents: [], branches: result.branch ? [result.branch] : [] };
  const candidateStatus = result.intent.status === 'pending' ? 'pending' : 'stopped';
  await getDatabase().run(
    `UPDATE trading_fallback_candidates
     SET intent_id = ?, status = ?, error_code = ?, updated_at = ?
     WHERE fallback_run_id = ? AND rank = 0`,
    [result.intent.id, candidateStatus, result.intent.blockReason, now, fallbackRun.id],
  );
  if (candidateStatus === 'stopped') {
    await getDatabase().run(
      `UPDATE trading_fallback_runs
       SET status = 'stopped', stop_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      [result.intent.blockReason || 'PRIMARY_ROUTE_BLOCKED', now, now, fallbackRun.id],
    );
    await getDatabase().run(
      `UPDATE trading_fallback_candidates
       SET status = 'stopped', error_code = ?, updated_at = ?
       WHERE fallback_run_id = ? AND status = 'waiting'`,
      ['PRIMARY_ROUTE_BLOCKED', now, fallbackRun.id],
    );
  }
  return {
    intents: [result.intent],
    branches: [{
      ...(result.branch ?? {}),
      routeGroupKey: group.key,
      candidateCount: ordered.length,
      mode: 'ordered_account_fallback',
    }],
  };
}

function workflowRunStatus(results: TradingIntent[], branches: Array<Record<string, unknown>>): string {
  if (!results.some(result => result.status === 'pending')) return 'blocked';
  const hasBlocked = results.some(result => result.status === 'blocked');
  const hasFiltered = branches.some(result => result.status === 'filtered');
  return hasBlocked || hasFiltered ? 'partially_blocked' : 'completed';
}

async function refreshWorkflowSignalRunFromFallback(fallbackRunId: string, now: number): Promise<void> {
  const fallbackRun = await getDatabase().get<{ signal_run_id: string }>(
    'SELECT signal_run_id FROM trading_fallback_runs WHERE id = ?',
    [fallbackRunId],
  );
  if (!fallbackRun) return;
  const runs = await getDatabase().all<Array<{ status: string; route_group_key: string; current_rank: number; stop_reason: string | null }>>(
    `SELECT status, route_group_key, current_rank, stop_reason
     FROM trading_fallback_runs WHERE signal_run_id = ? ORDER BY route_group_key`,
    [fallbackRun.signal_run_id],
  );
  const row = await getDatabase().get<{ result_json: string | null }>(
    'SELECT result_json FROM workflow_signal_runs WHERE id = ?',
    [fallbackRun.signal_run_id],
  );
  const existing = row?.result_json ? parseJson<Record<string, unknown>>(row.result_json, 'workflow signal result') : {};
  const probing = runs.some(run => run.status === 'probing');
  const blocked = runs.some(run => ['exhausted', 'stopped'].includes(run.status));
  const selected = runs.some(run => run.status === 'selected');
  const status = probing ? 'running' : blocked && selected ? 'partially_blocked' : blocked ? 'blocked' : 'completed';
  await getDatabase().run(
    `UPDATE workflow_signal_runs SET status = ?, result_json = ?, completed_at = ? WHERE id = ?`,
    [status, normalizedJson({ ...existing, fallbackRuns: runs.map(run => ({
      routeGroupKey: run.route_group_key,
      status: run.status,
      currentRank: Number(run.current_rank),
      stopReason: run.stop_reason,
    })) }), probing ? null : now, fallbackRun.signal_run_id],
  );
}

async function persistWorkflowTradingIntents(
  request: WorkflowIntentInput,
  workflow: WorkflowRevision,
  groups: WorkflowRouteGroup[],
  now: number,
): Promise<TradingIntent[]> {
  const candidateRunId = randomUUID();
  await getDatabase().run(
    `INSERT OR IGNORE INTO workflow_signal_runs (
       id, source_signal_id, workflow_revision_id, channel_id, status, input_sha256,
       result_json, error, created_at, completed_at
     ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, NULL)`,
    [candidateRunId, request.sourceSignalId, workflow.id, request.channelId, sha256(request.sourceText), now],
  );
  const run = await getDatabase().get<{ id: string }>(
    'SELECT id FROM workflow_signal_runs WHERE source_signal_id = ? AND workflow_revision_id = ?',
    [request.sourceSignalId, workflow.id],
  );
  const runId = run!.id;
  const results: TradingIntent[] = [];
  const branches: Array<Record<string, unknown>> = [];
  const runtime = await getDatabase().get<any>('SELECT * FROM trading_runtime_state WHERE singleton_id = 1');
  const pathsById = new Map(workflow.compiled.paths.map(path => [path.id, path]));
  for (const group of groups) {
    const primary = pathsById.get(group.primaryPathId);
    if (!primary) throw new Error('Compiled workflow route group references a missing primary path.');
    const filter = pathAllowsInput(primary, request.sourceText, request.contentType);
    if (!filter.allowed) {
      branches.push({ routeGroupKey: group.key, pathId: primary.id, status: 'filtered', reason: filter.reason });
      continue;
    }
    if (group.candidates.length > 1) {
      const result = await persistFallbackRouteGroup({ request, workflow, group, runId, runtime, now });
      results.push(...result.intents);
      branches.push(...result.branches);
      continue;
    }
    const result = await processWorkflowIntentPath({ request, workflow, path: primary, runId, runtime, now });
    if (result.intent) results.push(result.intent);
    if (result.branch) branches.push(result.branch);
  }
  await getDatabase().run(
    'UPDATE workflow_signal_runs SET status = ?, result_json = ?, completed_at = ? WHERE id = ?',
    [workflowRunStatus(results, branches), normalizedJson({ branches }), now, runId],
  );
  const probingFallback = await getDatabase().get<{ id: string }>(
    `SELECT id FROM trading_fallback_runs WHERE signal_run_id = ? AND status = 'probing' LIMIT 1`,
    [runId],
  );
  if (probingFallback) await refreshWorkflowSignalRunFromFallback(probingFallback.id, now);
  return results;
}

export async function createWorkflowTradingIntents(input: WorkflowIntentInput, now = Date.now()): Promise<TradingIntent[]> {
  const workflow = await getActiveWorkflow();
  if (!workflow) return [];
  const requestedPaths = input.executionPathIds ? new Set(input.executionPathIds) : null;
  const channelPaths = workflow.compiled.paths.filter(path => path.channelId === input.channelId);
  const selectedPaths = channelPaths.filter(path => !requestedPaths || requestedPaths.has(path.id));
  if (requestedPaths && selectedPaths.length !== requestedPaths.size) {
    throw new Error('Workflow execution path selection is stale or invalid.');
  }
  if (selectedPaths.length === 0) return [];
  const selectedPathIds = new Set(selectedPaths.map(path => path.id));
  const groups = workflow.compiled.routeGroups.filter(group =>
    group.channelId === input.channelId && group.candidates.some(candidate => selectedPathIds.has(candidate.pathId)));
  if (requestedPaths && groups.some(group => group.candidates.some(candidate => !requestedPaths.has(candidate.pathId)))) {
    throw new Error('Workflow execution path selection is stale or invalid because a fallback chain is incomplete.');
  }
  return withDatabaseTransaction(() => persistWorkflowTradingIntents(input, workflow, groups, now));
}

export async function advanceWorkflowFallbackOnSymbolUnavailable(
  intent: TradingIntent,
  message: string,
  now = Date.now(),
): Promise<boolean> {
  return withDatabaseTransaction(async () => {
    await getDatabase().run(
      `UPDATE trading_trade_intents
       SET status = 'blocked', block_reason = 'SYMBOL_UNAVAILABLE', last_error = ?, updated_at = ?
       WHERE id = ?`,
      [message, now, intent.id],
    );
    const current = await getDatabase().get<any>(
      `SELECT candidate.fallback_run_id, candidate.rank, run.status AS run_status,
              run.current_rank, run.created_at AS run_created_at
       FROM trading_fallback_candidates AS candidate
       JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
       WHERE candidate.intent_id = ?`,
      [intent.id],
    );
    if (!current || current.run_status !== 'probing' || Number(current.current_rank) !== Number(current.rank)) return false;
    await getDatabase().run(
      `UPDATE trading_fallback_candidates
       SET status = 'unavailable', error_code = 'SYMBOL_UNAVAILABLE', details_json = ?, updated_at = ?
       WHERE fallback_run_id = ? AND rank = ?`,
      [normalizedJson({ message, symbol: intent.symbol }), now, current.fallback_run_id, current.rank],
    );
    const next = await getDatabase().get<any>(
      `SELECT candidate.rank, candidate.execution_path_id, path.*, account.exchange, account.mode,
              account.status AS account_status, account.enabled AS account_enabled,
              account.kill_switch_active AS account_kill_switch_active
       FROM trading_fallback_candidates AS candidate
       JOIN workflow_execution_paths AS path ON path.id = candidate.execution_path_id
       JOIN trading_accounts AS account ON account.id = candidate.account_id
       WHERE candidate.fallback_run_id = ? AND candidate.rank > ?
       ORDER BY candidate.rank LIMIT 1`,
      [current.fallback_run_id, current.rank],
    );
    if (!next) {
      await getDatabase().run(
        `UPDATE trading_fallback_runs
         SET status = 'exhausted', stop_reason = 'SYMBOL_UNAVAILABLE', updated_at = ?, completed_at = ? WHERE id = ?`,
        [now, now, current.fallback_run_id],
      );
      await refreshWorkflowSignalRunFromFallback(current.fallback_run_id, now);
      return false;
    }
    const runtime = await getDatabase().get<any>('SELECT * FROM trading_runtime_state WHERE singleton_id = 1');
    const path = pathFromRow(next);
    const account = await getDatabase().get<any>('SELECT * FROM trading_accounts WHERE id = ?', [path.accountId]);
    const blockReason = workflowIntentBlockReason(path, account, runtime);
    const status = blockReason ? 'blocked' : 'pending';
    const nextIntentId = randomUUID();
    await getDatabase().run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, root_source_signal_id, signal_run_id, workflow_revision_id,
         execution_path_id, channel_id, strategy_version_id, account_id, exchange, mode,
         symbol, side, status, signal_json, plan_json, block_reason, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      [nextIntentId, intent.sourceSignalId, intent.rootSourceSignalId, intent.signalRunId,
        intent.workflowRevisionId, path.id, intent.channelId, path.strategyVersionId, path.accountId,
        account.exchange, account.mode, intent.symbol, intent.side, status, normalizedJson(intent.signal),
        blockReason, Number(current.run_created_at), now],
    );
    await getDatabase().run(
      `UPDATE trading_fallback_candidates
       SET intent_id = ?, status = ?, error_code = ?, updated_at = ?
       WHERE fallback_run_id = ? AND rank = ?`,
      [nextIntentId, status === 'pending' ? 'pending' : 'stopped', blockReason,
        now, current.fallback_run_id, next.rank],
    );
    if (status === 'pending') {
      await getDatabase().run(
        `UPDATE trading_fallback_runs SET current_rank = ?, updated_at = ? WHERE id = ?`,
        [next.rank, now, current.fallback_run_id],
      );
      await refreshWorkflowSignalRunFromFallback(current.fallback_run_id, now);
      return true;
    }
    await getDatabase().run(
      `UPDATE trading_fallback_runs
       SET status = 'stopped', current_rank = ?, stop_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      [next.rank, blockReason, now, now, current.fallback_run_id],
    );
    await getDatabase().run(
      `UPDATE trading_fallback_candidates SET status = 'stopped', error_code = ?, updated_at = ?
       WHERE fallback_run_id = ? AND status = 'waiting'`,
      [blockReason, now, current.fallback_run_id],
    );
    await refreshWorkflowSignalRunFromFallback(current.fallback_run_id, now);
    return false;
  });
}

export async function markWorkflowFallbackSelected(intentId: string, now = Date.now()): Promise<void> {
  await withDatabaseTransaction(async () => {
    const candidate = await getDatabase().get<any>(
      `SELECT candidate.fallback_run_id, candidate.rank
       FROM trading_fallback_candidates AS candidate
       JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
       WHERE candidate.intent_id = ? AND run.status = 'probing' AND run.current_rank = candidate.rank`,
      [intentId],
    );
    if (!candidate) return;
    await getDatabase().run(
      `UPDATE trading_fallback_candidates SET status = 'selected', updated_at = ?
       WHERE fallback_run_id = ? AND rank = ?`,
      [now, candidate.fallback_run_id, candidate.rank],
    );
    await getDatabase().run(
      `UPDATE trading_fallback_candidates
       SET status = 'stopped', error_code = 'NOT_NEEDED', updated_at = ?
       WHERE fallback_run_id = ? AND status = 'waiting'`,
      [now, candidate.fallback_run_id],
    );
    await getDatabase().run(
      `UPDATE trading_fallback_runs
       SET status = 'selected', selected_intent_id = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      [intentId, now, now, candidate.fallback_run_id],
    );
    await refreshWorkflowSignalRunFromFallback(candidate.fallback_run_id, now);
  });
}

export async function stopWorkflowFallback(intentId: string, reason: string, now = Date.now()): Promise<void> {
  await withDatabaseTransaction(async () => {
    const candidate = await getDatabase().get<any>(
      `SELECT candidate.fallback_run_id, candidate.rank
       FROM trading_fallback_candidates AS candidate
       JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
       WHERE candidate.intent_id = ? AND run.status = 'probing' AND run.current_rank = candidate.rank`,
      [intentId],
    );
    if (!candidate) return;
    await getDatabase().run(
      `UPDATE trading_fallback_candidates SET status = 'stopped', error_code = ?, updated_at = ?
       WHERE fallback_run_id = ? AND status IN ('pending', 'waiting')`,
      [reason, now, candidate.fallback_run_id],
    );
    await getDatabase().run(
      `UPDATE trading_fallback_runs
       SET status = 'stopped', stop_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      [reason, now, now, candidate.fallback_run_id],
    );
    await refreshWorkflowSignalRunFromFallback(candidate.fallback_run_id, now);
  });
}

export async function listWorkflowFallbackRuns(limit = 200): Promise<Array<Record<string, unknown>>> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 200;
  const runs = await getDatabase().all<any[]>(
    `SELECT run.* FROM trading_fallback_runs AS run ORDER BY run.created_at DESC LIMIT ?`,
    [boundedLimit],
  );
  const result: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    const candidates = await getDatabase().all<any[]>(
      `SELECT candidate.rank, candidate.execution_path_id, candidate.account_id, candidate.intent_id,
              candidate.status, candidate.error_code, candidate.details_json,
              account.name AS account_name, account.exchange, account.mode
       FROM trading_fallback_candidates AS candidate
       JOIN trading_accounts AS account ON account.id = candidate.account_id
       WHERE candidate.fallback_run_id = ? ORDER BY candidate.rank`,
      [run.id],
    );
    result.push({
      id: String(run.id),
      sourceSignalId: String(run.source_signal_id),
      workflowRevisionId: String(run.workflow_revision_id),
      signalRunId: String(run.signal_run_id),
      routeGroupKey: String(run.route_group_key),
      channelId: String(run.channel_id),
      channelName: null,
      status: String(run.status),
      currentRank: Number(run.current_rank),
      selectedIntentId: run.selected_intent_id || null,
      stopReason: run.stop_reason || null,
      createdAt: Number(run.created_at),
      updatedAt: Number(run.updated_at),
      completedAt: run.completed_at === null ? null : Number(run.completed_at),
      candidates: candidates.map(candidate => ({
        rank: Number(candidate.rank),
        executionPathId: String(candidate.execution_path_id),
        accountId: String(candidate.account_id),
        accountName: String(candidate.account_name),
        exchange: candidate.exchange,
        mode: candidate.mode,
        intentId: candidate.intent_id || null,
        status: String(candidate.status),
        errorCode: candidate.error_code || null,
        details: candidate.details_json ? parseJson(candidate.details_json, 'fallback candidate details') : null,
      })),
    });
  }
  return result;
}
