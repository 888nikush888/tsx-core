import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import {
  createSignalContract,
  createTradingSignalSchema,
  createTradingStrategyDraft,
  listSignalContracts,
  listTradingAccounts,
  listTradingSignalSchemas,
  listTradingStrategies,
  publishSignalContractVersion,
  publishTradingStrategyVersion,
} from './trading_repository.js';
import {
  listChannelRiskPolicies,
  upsertChannelRiskPolicy,
  validateChannelRiskPolicyInput,
} from './trading_channel_risk.js';
import { validateSignalContractDefinition } from './signal_contract.js';
import { validateStrategyConfiguration } from './trading_strategy.js';
import {
  createWorkflowResourceDraft,
  getActiveWorkflow,
  listWorkflowResources,
  publishWorkflowResource,
  saveWorkflowRevision,
  WORKFLOW_IMPACT_CONFIRMATION,
} from './workflow_repository.js';
import type {
  ChannelRiskPolicy,
  SignalContractDefinition,
  StrategyConfiguration,
  TradingAccount,
  WorkflowGraph,
  WorkflowResourceKind,
} from './trading_types.js';

const SETUP_BUNDLE_VERSION = 1;
const FORBIDDEN_KEY = /^(?:api(?:hash|key|secret)|password|passphrase|privatekey|walletprivatekey|bearertoken|accesstoken|refreshtoken|authorization|credential(?:s|ref)?|tailscaleidentity|tdlibsession|openrouterapikey|backupencryptionkey)$/i;
const ROOT_KEYS = new Set([
  'schemaVersion', 'mode', 'exportedAt', 'applicationVersion', 'systemConfig',
  'workflow', 'models', 'accountReferences', 'checksum',
]);
const WORKFLOW_KINDS = new Set<WorkflowResourceKind>([
  'channel', 'content_filter', 'keyword_filter', 'regex', 'parser', 'schema', 'contract',
  'dedupe', 'strategy', 'sizing', 'adaptive_risk', 'account', 'output',
]);
const HIGH_CONFIDENCE_SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\btskey-[A-Za-z0-9-]{16,}|\bsk-[A-Za-z0-9_-]{20,}|\b\d{8,10}:[A-Za-z0-9_-]{35}\b)/;

function canonicalJson(value: unknown): string {
  const visit = (candidate: any): any => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(Object.keys(candidate)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, visit(candidate[key])]));
  };
  return JSON.stringify(visit(value));
}

function bundleHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function assertSetupBundleContainsNoSecrets(value: unknown, path = '$', depth = 0): void {
  if (depth > 40) throw new Error('Setup bundle nesting exceeds the safety limit.');
  if (typeof value === 'string' && HIGH_CONFIDENCE_SECRET_VALUE.test(value)) {
    throw new Error(`Setup bundle contains a secret-like value at '${path}'.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSetupBundleContainsNoSecrets(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(normalizedKey(key))) {
      throw new Error(`Setup bundle contains forbidden secret field '${path}.${key}'.`);
    }
    assertSetupBundleContainsNoSecrets(nested, `${path}.${key}`, depth + 1);
  }
}

export interface PortableSetupBundle {
  schemaVersion: 1;
  mode: 'replace';
  exportedAt: number;
  applicationVersion: '3.1.0';
  systemConfig: Record<string, unknown>;
  workflow: {
    graph: WorkflowGraph;
    resources: Array<{
      sourceVersionId: string;
      sourceResourceId: string;
      kind: WorkflowResourceKind;
      name: string;
      description: string;
      configuration: Record<string, unknown>;
    }>;
  };
  models: {
    contracts: Array<{
      sourceVersionId: string;
      name: string;
      description: string;
      definition: SignalContractDefinition;
    }>;
    schemas: Array<{
      sourceId: string;
      name: string;
      description: string;
      parserSchema: string;
      sourceContractVersionId: string;
      templateName: string;
      enabled: boolean;
    }>;
    strategies: Array<{
      sourceVersionId: string;
      name: string;
      description: string;
      configuration: StrategyConfiguration;
    }>;
    channelRiskPolicies: ChannelRiskPolicy[];
  };
  accountReferences: Array<{
    sourceAccountId: string;
    name: string;
    exchange: string;
    mode: string;
  }>;
  checksum: string;
}

function checksumPayload(bundle: Omit<PortableSetupBundle, 'checksum'> | PortableSetupBundle): Omit<PortableSetupBundle, 'checksum'> {
  const copy = structuredClone(bundle) as any;
  delete copy.checksum;
  return copy;
}

export async function exportPortableSetupBundle(systemConfig: Record<string, unknown>): Promise<PortableSetupBundle> {
  const active = await getActiveWorkflow();
  const allResources = await listWorkflowResources();
  const referencedIds = new Set(active?.graph.nodes.map(node => node.resourceVersionId) ?? []);
  const resources = allResources.filter(resource => referencedIds.has(resource.id));
  const strategyIds = new Set(resources
    .filter(resource => resource.kind === 'strategy')
    .map(resource => String(resource.configuration.strategyVersionId)));
  const strategies = (await listTradingStrategies())
    .filter(strategy => strategyIds.has(strategy.id))
    .map(strategy => ({
      sourceVersionId: strategy.id,
      name: strategy.name,
      description: strategy.description,
      configuration: strategy.configuration,
    }));
  const schemaIds = new Set(resources
    .filter(resource => resource.kind === 'schema')
    .map(resource => String(resource.configuration.schemaId)));
  for (const strategy of strategies) {
    strategy.configuration.allowedSignalSchemas.forEach(schemaId => schemaIds.add(schemaId));
  }
  const explicitContractIds = new Set(resources
    .filter(resource => resource.kind === 'contract')
    .map(resource => String(resource.configuration.contractVersionId)));
  const schemas = (await listTradingSignalSchemas()).filter(schema => schemaIds.has(schema.id));
  const contractVersionIds = new Set([...explicitContractIds, ...schemas.map(schema => schema.contractVersionId)]);
  const contracts = (await listSignalContracts()).flatMap(contract => contract.versions
    .filter(version => contractVersionIds.has(version.id))
    .map(version => ({
      sourceVersionId: version.id,
      name: contract.name,
      description: contract.description,
      definition: version.definition,
    })));
  const accounts = await listTradingAccounts();
  const accountIds = new Set(resources
    .filter(resource => resource.kind === 'account')
    .map(resource => String(resource.configuration.accountId)));
  const channelIds = new Set(resources
    .filter(resource => resource.kind === 'channel')
    .map(resource => String(resource.configuration.channelId)));
  const body: Omit<PortableSetupBundle, 'checksum'> = {
    schemaVersion: SETUP_BUNDLE_VERSION,
    mode: 'replace',
    exportedAt: Date.now(),
    applicationVersion: '3.1.0',
    systemConfig: structuredClone(systemConfig),
    workflow: {
      graph: active?.graph ?? { schemaVersion: 1, nodes: [], edges: [] },
      resources: resources.map(resource => ({
        sourceVersionId: resource.id,
        sourceResourceId: resource.resourceId,
        kind: resource.kind,
        name: resource.name,
        description: resource.description,
        configuration: structuredClone(resource.configuration),
      })),
    },
    models: {
      contracts,
      schemas: schemas.map(schema => ({
        sourceId: schema.id,
        name: schema.name,
        description: schema.description,
        parserSchema: schema.parserSchema,
        sourceContractVersionId: schema.contractVersionId,
        templateName: schema.templateName,
        enabled: schema.enabled,
      })),
      strategies,
      channelRiskPolicies: (await listChannelRiskPolicies()).filter(policy => channelIds.has(policy.channelId)),
    },
    accountReferences: accounts.filter(account => accountIds.has(account.id)).map(account => ({
      sourceAccountId: account.id,
      name: account.name,
      exchange: account.exchange,
      mode: account.mode,
    })),
  };
  assertSetupBundleContainsNoSecrets(body);
  return { ...body, checksum: bundleHash(body) };
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, any>;
}

function boundedString(value: unknown, label: string, maximum = 256, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validateGraphNode(nodeValue: unknown, nodeIds: Set<string>): void {
  const node = object(nodeValue, 'Setup bundle graph node');
  const id = boundedString(node.id, 'Setup bundle graph node id', 128);
  if (nodeIds.has(id) || !WORKFLOW_KINDS.has(node.kind)) {
    throw new Error('Setup bundle graph node is invalid or duplicated.');
  }
  nodeIds.add(id);
  boundedString(node.resourceVersionId, 'Setup bundle graph resource reference', 128);
  const position = object(node.position, 'Setup bundle graph node position');
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error('Setup bundle graph node position is invalid.');
  }
}

function validateGraphEdge(edgeValue: unknown, edgeIds: Set<string>, nodeIds: Set<string>): void {
  const edge = object(edgeValue, 'Setup bundle graph edge');
  const id = boundedString(edge.id, 'Setup bundle graph edge id', 128);
  if (edgeIds.has(id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
    throw new Error('Setup bundle graph edge is invalid, duplicated or dangling.');
  }
  edgeIds.add(id);
  const invalidScope = edge.channelNodeIds !== undefined && (!Array.isArray(edge.channelNodeIds)
    || edge.channelNodeIds.some((nodeId: unknown) => typeof nodeId !== 'string' || !nodeIds.has(nodeId)));
  if (invalidScope) throw new Error('Setup bundle graph edge channel scope is invalid.');
}

function validateBundleGraph(value: unknown): WorkflowGraph {
  const graph = object(value, 'Setup bundle graph');
  if (graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.nodes.length > 1_000 || graph.edges.length > 4_000) {
    throw new Error('Setup bundle graph structure is invalid.');
  }
  const nodeIds = new Set<string>();
  for (const nodeValue of graph.nodes) validateGraphNode(nodeValue, nodeIds);
  const edgeIds = new Set<string>();
  for (const edgeValue of graph.edges) validateGraphEdge(edgeValue, edgeIds, nodeIds);
  return graph as WorkflowGraph;
}

function validateBundleHeader(candidate: Record<string, any>): void {
  const unexpected = Object.keys(candidate).filter(key => !ROOT_KEYS.has(key));
  if (unexpected.length > 0) throw new Error(`Setup bundle contains unsupported root field '${unexpected[0]}'.`);
  const supported = candidate.schemaVersion === SETUP_BUNDLE_VERSION
    && candidate.mode === 'replace'
    && candidate.applicationVersion === '3.1.0';
  if (!supported) throw new Error('Setup bundle schema or version is unsupported.');
  if (!Number.isSafeInteger(candidate.exportedAt) || candidate.exportedAt < 0) {
    throw new Error('Setup bundle timestamp is invalid.');
  }
  object(candidate.systemConfig, 'Setup bundle system configuration');
}

function validateBundleResource(resourceValue: unknown, resourceVersionIds: Set<string>): void {
  const resource = object(resourceValue, 'Setup bundle resource');
  const sourceVersionId = boundedString(resource.sourceVersionId, 'Setup bundle resource version id', 128);
  if (resourceVersionIds.has(sourceVersionId) || !WORKFLOW_KINDS.has(resource.kind)) {
    throw new Error('Setup bundle resource is invalid or duplicated.');
  }
  resourceVersionIds.add(sourceVersionId);
  boundedString(resource.sourceResourceId, 'Setup bundle logical resource id', 128);
  boundedString(resource.name, 'Setup bundle resource name', 160);
  boundedString(resource.description, 'Setup bundle resource description', 2_000, true);
  object(resource.configuration, 'Setup bundle resource configuration');
}

function validateBundleWorkflow(value: unknown): WorkflowGraph {
  const workflow = object(value, 'Setup bundle workflow');
  if (!Array.isArray(workflow.resources) || workflow.resources.length > 1_000) {
    throw new Error('Setup bundle resources are invalid.');
  }
  const graph = validateBundleGraph(workflow.graph);
  const resourceVersionIds = new Set<string>();
  workflow.resources.forEach((resource: unknown) => validateBundleResource(resource, resourceVersionIds));
  if (graph.nodes.some(node => !resourceVersionIds.has(node.resourceVersionId))) {
    throw new Error('Setup bundle graph references a missing resource version.');
  }
  return graph;
}

function validateBundleContract(contractValue: unknown): void {
  const contract = object(contractValue, 'Setup bundle signal contract');
  boundedString(contract.sourceVersionId, 'Setup bundle contract version id', 128);
  boundedString(contract.name, 'Setup bundle contract name', 160);
  boundedString(contract.description, 'Setup bundle contract description', 2_000, true);
  validateSignalContractDefinition(contract.definition);
}

function validateBundleSchema(schemaValue: unknown): void {
  const schema = object(schemaValue, 'Setup bundle parser schema');
  boundedString(schema.sourceId, 'Setup bundle schema id', 128);
  boundedString(schema.name, 'Setup bundle schema name', 160);
  boundedString(schema.description, 'Setup bundle schema description', 2_000, true);
  boundedString(schema.parserSchema, 'Setup bundle parser schema type', 64);
  boundedString(schema.sourceContractVersionId, 'Setup bundle schema contract reference', 128);
  boundedString(schema.templateName, 'Setup bundle parser template', 128);
  if (typeof schema.enabled !== 'boolean') throw new Error('Setup bundle parser schema enabled state is invalid.');
}

function validateBundleStrategy(strategyValue: unknown): void {
  const strategy = object(strategyValue, 'Setup bundle strategy');
  boundedString(strategy.sourceVersionId, 'Setup bundle strategy version id', 128);
  boundedString(strategy.name, 'Setup bundle strategy name', 160);
  boundedString(strategy.description, 'Setup bundle strategy description', 2_000, true);
  validateStrategyConfiguration(strategy.configuration);
}

function uniqueModelIdentifiers(values: any[], key: string, label: string): Set<string> {
  const identifiers = new Set(values.map(value => String(value[key])));
  if (identifiers.size !== values.length) throw new Error(`Setup bundle ${label} identifiers are duplicated.`);
  return identifiers;
}

function validateBundleModels(value: unknown): void {
  const models = object(value, 'Setup bundle models');
  const collectionNames = ['contracts', 'schemas', 'strategies', 'channelRiskPolicies'];
  if (!collectionNames.every(key => Array.isArray(models[key]))) {
    throw new Error('Setup bundle model collections are invalid.');
  }
  models.contracts.forEach(validateBundleContract);
  models.schemas.forEach(validateBundleSchema);
  models.strategies.forEach(validateBundleStrategy);
  models.channelRiskPolicies.forEach(validateChannelRiskPolicyInput);
  const contractIds = uniqueModelIdentifiers(models.contracts, 'sourceVersionId', 'contract');
  const schemaIds = uniqueModelIdentifiers(models.schemas, 'sourceId', 'schema');
  uniqueModelIdentifiers(models.strategies, 'sourceVersionId', 'strategy');
  if (models.schemas.some((schema: any) => !contractIds.has(schema.sourceContractVersionId))) {
    throw new Error('Setup bundle schema references a missing contract.');
  }
  const missingStrategySchema = models.strategies.some((strategy: any) =>
    strategy.configuration.allowedSignalSchemas.some((schemaId: string) => !schemaIds.has(schemaId)));
  if (missingStrategySchema) throw new Error('Setup bundle strategy references a missing parser schema.');
}

function validateBundleAccountReference(referenceValue: unknown): void {
  const reference = object(referenceValue, 'Setup bundle account reference');
  boundedString(reference.sourceAccountId, 'Setup bundle account id', 128);
  boundedString(reference.name, 'Setup bundle account name', 160);
  boundedString(reference.exchange, 'Setup bundle account exchange', 32);
  boundedString(reference.mode, 'Setup bundle account mode', 32);
}

function validateBundleAccountReferences(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Setup bundle account references are invalid.');
  value.forEach(validateBundleAccountReference);
}

function validateBundleChecksum(candidate: Record<string, any>): void {
  if (typeof candidate.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.checksum)) {
    throw new Error('Setup bundle checksum is invalid.');
  }
  const payload = checksumPayload(candidate as PortableSetupBundle);
  assertSetupBundleContainsNoSecrets(payload);
  if (bundleHash(payload) !== candidate.checksum) throw new Error('Setup bundle checksum verification failed.');
}

export function validatePortableSetupBundle(value: unknown): PortableSetupBundle {
  const candidate = object(value, 'Setup bundle');
  validateBundleHeader(candidate);
  validateBundleWorkflow(candidate.workflow);
  validateBundleModels(candidate.models);
  validateBundleAccountReferences(candidate.accountReferences);
  validateBundleChecksum(candidate);
  return structuredClone(candidate) as PortableSetupBundle;
}

export async function suggestPortableAccountMappings(bundle: PortableSetupBundle): Promise<{
  automatic: Record<string, string>;
  unresolved: string[];
  candidates: Array<Pick<TradingAccount, 'id' | 'name' | 'exchange' | 'mode' | 'status'>>;
}> {
  const candidates = (await listTradingAccounts())
    .filter(account => account.status === 'ready')
    .map(({ id, name, exchange, mode, status }) => ({ id, name, exchange, mode, status }));
  const automatic: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const reference of bundle.accountReferences) {
    const exactId = candidates.filter(account => account.id === reference.sourceAccountId
      && account.exchange === reference.exchange && account.mode === reference.mode);
    const matching = exactId.length === 1 ? exactId : candidates.filter(account =>
      account.name === reference.name && account.exchange === reference.exchange && account.mode === reference.mode);
    if (matching.length === 1) automatic[reference.sourceAccountId] = matching[0]!.id;
    else unresolved.push(reference.sourceAccountId);
  }
  return { automatic, unresolved, candidates };
}

function importedIdentifier(type: 'c' | 's', index: number): string {
  return `i${randomUUID().replaceAll('-', '').slice(0, 25)}${type}${index}`;
}

type ImportMaps = {
  contracts: Map<string, string>;
  schemas: Map<string, string>;
  strategies: Map<string, string>;
  templates: Map<string, string>;
};

async function validateLocalAccountMappings(
  bundle: PortableSetupBundle,
  accountMappings: Record<string, string>,
): Promise<void> {
  const localAccounts = await listTradingAccounts();
  const localById = new Map(localAccounts.map(account => [account.id, account]));
  for (const reference of bundle.accountReferences) {
    const local = localById.get(accountMappings[reference.sourceAccountId]);
    const compatible = local?.status === 'ready'
      && local.exchange === reference.exchange
      && local.mode === reference.mode;
    if (!compatible) {
      throw new Error(`Account reference '${reference.name}' is not mapped to a verified compatible local account.`);
    }
  }
}

async function importContracts(bundle: PortableSetupBundle): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const [index, contract] of bundle.models.contracts.entries()) {
    const created = await createSignalContract({
      id: importedIdentifier('c', index),
      name: contract.name,
      description: contract.description,
      definition: contract.definition,
    });
    const version = created.versions.find(item => item.status === 'draft');
    if (!version) throw new Error('Imported signal contract draft was not created.');
    const published = await publishSignalContractVersion(version.id);
    result.set(contract.sourceVersionId, published.id);
  }
  return result;
}

async function importSchemas(
  bundle: PortableSetupBundle,
  contractMap: Map<string, string>,
): Promise<{ schemas: Map<string, string>; templates: Map<string, string> }> {
  const schemas = new Map<string, string>();
  const templates = new Map<string, string>();
  for (const [index, schema] of bundle.models.schemas.entries()) {
    const contractVersionId = contractMap.get(schema.sourceContractVersionId);
    if (!contractVersionId) throw new Error(`Imported schema '${schema.name}' references a missing contract.`);
    const templateName = `import-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const created = await createTradingSignalSchema({
      id: importedIdentifier('s', index),
      name: schema.name,
      description: schema.description,
      parserSchema: schema.parserSchema,
      contractVersionId,
      templateName,
      enabled: schema.enabled,
    });
    schemas.set(schema.sourceId, created.id);
    templates.set(schema.templateName, templateName);
  }
  return { schemas, templates };
}

async function importStrategies(
  bundle: PortableSetupBundle,
  schemaMap: Map<string, string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const strategy of bundle.models.strategies) {
    const configuration = structuredClone(strategy.configuration);
    configuration.allowedSignalSchemas = configuration.allowedSignalSchemas.map(id =>
      requiredMapping(schemaMap, id, `Strategy '${strategy.name}' schema`));
    const draft = await createTradingStrategyDraft({
      name: strategy.name,
      description: strategy.description,
      configuration,
    });
    const published = await publishTradingStrategyVersion(draft.id);
    result.set(strategy.sourceVersionId, published.id);
  }
  return result;
}

function requiredMapping(mapping: Map<string, string>, source: unknown, label: string): string {
  const result = mapping.get(String(source));
  if (!result) throw new Error(`${label} references a missing imported object.`);
  return result;
}

function remapResourceConfiguration(
  resource: PortableSetupBundle['workflow']['resources'][number],
  accountMappings: Record<string, string>,
  maps: ImportMaps,
): Record<string, unknown> {
  const configuration: Record<string, any> = structuredClone(resource.configuration);
  if (resource.kind === 'account') {
    const accountId = accountMappings[String(configuration.accountId)];
    if (!accountId) throw new Error(`Workflow account '${resource.name}' has no local mapping.`);
    configuration.accountId = accountId;
  }
  if (resource.kind === 'contract') {
    configuration.contractVersionId = requiredMapping(maps.contracts, configuration.contractVersionId, 'Workflow contract');
  }
  if (resource.kind === 'schema') {
    configuration.schemaId = requiredMapping(maps.schemas, configuration.schemaId, 'Workflow schema');
  }
  if (resource.kind === 'strategy') {
    configuration.strategyVersionId = requiredMapping(maps.strategies, configuration.strategyVersionId, 'Workflow strategy');
  }
  if (resource.kind === 'parser' && configuration.templateName) {
    configuration.templateName = maps.templates.get(String(configuration.templateName)) ?? configuration.templateName;
  }
  return configuration;
}

async function importWorkflowResources(
  bundle: PortableSetupBundle,
  accountMappings: Record<string, string>,
  maps: ImportMaps,
): Promise<{ resourceMap: Map<string, string>; importedResourceIds: string[] }> {
  const resourceMap = new Map<string, string>();
  const importedResourceIds: string[] = [];
  for (const resource of bundle.workflow.resources) {
    const draft = await createWorkflowResourceDraft({
      resourceId: randomUUID(),
      kind: resource.kind,
      name: resource.name,
      description: resource.description,
      configuration: remapResourceConfiguration(resource, accountMappings, maps),
    });
    const published = await publishWorkflowResource(draft.id);
    resourceMap.set(resource.sourceVersionId, published.id);
    importedResourceIds.push(published.id);
  }
  return { resourceMap, importedResourceIds };
}

function remapImportedGraph(bundle: PortableSetupBundle, resourceMap: Map<string, string>): WorkflowGraph {
  const graph = structuredClone(bundle.workflow.graph);
  graph.nodes = graph.nodes.map(node => ({
    ...node,
    resourceVersionId: requiredMapping(resourceMap, node.resourceVersionId, `Workflow node '${node.id}'`),
  }));
  return graph;
}

async function archiveReplacedResources(importedResourceIds: string[]): Promise<void> {
  if (importedResourceIds.length === 0) return;
  const placeholders = importedResourceIds.map(() => '?').join(',');
  await getDatabase().run(
    `UPDATE workflow_resource_versions SET status = 'archived', archived_at = ?
     WHERE status = 'published' AND id NOT IN (${placeholders})`,
    [Date.now(), ...importedResourceIds],
  );
}

function excludedIdentifiers(column: string, values: string[]): { clause: string; parameters: string[] } {
  if (values.length === 0) return { clause: '', parameters: [] };
  return {
    clause: ` WHERE ${column} NOT IN (${values.map(() => '?').join(',')})`,
    parameters: values,
  };
}

async function retireReplacedModels(maps: ImportMaps): Promise<void> {
  const database = getDatabase();
  const strategies = excludedIdentifiers('id', [...maps.strategies.values()]);
  const schemas = excludedIdentifiers('id', [...maps.schemas.values()]);
  const contracts = excludedIdentifiers('id', [...maps.contracts.values()]);
  const now = Date.now();
  await database.run('UPDATE trading_routes SET enabled = 0 WHERE enabled = 1');
  await database.run(
    `UPDATE trading_strategy_versions SET status = 'archived'${strategies.clause}`,
    strategies.parameters,
  );
  await database.run(
    `UPDATE trading_signal_schemas SET enabled = 0, updated_at = ?${schemas.clause}`,
    [now, ...schemas.parameters],
  );
  await database.run(
    `UPDATE trading_signal_contract_versions
     SET status = 'archived', archived_at = COALESCE(archived_at, ?)${contracts.clause}`,
    [now, ...contracts.parameters],
  );
  await database.run('DELETE FROM trading_channel_risk_policies');
}

async function applyChannelRiskPolicies(bundle: PortableSetupBundle): Promise<void> {
  for (const policy of bundle.models.channelRiskPolicies) await upsertChannelRiskPolicy(policy);
}

export async function applyPortableSetupBundle(input: {
  bundle: PortableSetupBundle;
  accountMappings: Record<string, string>;
  actorId: string;
  beforeCommit?: () => void | Promise<void>;
}): Promise<{ workflowRevisionId: string; importedResources: number }> {
  const bundle = validatePortableSetupBundle(input.bundle);
  await validateLocalAccountMappings(bundle, input.accountMappings);
  return withDatabaseTransaction(async () => {
    const contracts = await importContracts(bundle);
    const { schemas, templates } = await importSchemas(bundle, contracts);
    const strategies = await importStrategies(bundle, schemas);
    const maps = { contracts, schemas, strategies, templates };
    const { resourceMap, importedResourceIds } = await importWorkflowResources(bundle, input.accountMappings, maps);
    const active = await getActiveWorkflow();
    const revision = await saveWorkflowRevision({
      baseRevisionId: active?.id ?? null,
      graph: remapImportedGraph(bundle, resourceMap),
      actorId: input.actorId,
      confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    });
    await archiveReplacedResources(importedResourceIds);
    await retireReplacedModels(maps);
    await applyChannelRiskPolicies(bundle);
    await input.beforeCommit?.();
    return { workflowRevisionId: revision.id, importedResources: importedResourceIds.length };
  });
}
