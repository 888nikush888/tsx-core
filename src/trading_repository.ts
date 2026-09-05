import { randomUUID } from 'node:crypto';
import { getDatabase, isForeignKeyConstraint, withDatabaseTransaction } from './db.js';
import { constantTimeStringEqual } from './secure_compare.js';
import { signalContractDefinitionSha256, validateSignalContractDefinition } from './signal_contract.js';
import { addDecimal, addSignedDecimal, decimal, multiplyExactSignedDecimal } from './trading_decimal.js';
import { moneyLedgerSnapshot } from './trading_money_ledger.js';
import { projectAllFillAccounting } from './trading_fill_accounting.js';
import { closedMoneyStatistics } from './trading_money_reporting.js';
import { analyticsPositionMoneyRow, recordTradingExecutionEvent } from './trading_telemetry.js';
import type { MoneyValue } from './trading_money_value.js';
import { recordTradingNotificationBestEffort } from './trading_notifications.js';
import {
  createStrategyVersion,
  signalSchemaIdentifier,
  strategyConfigurationForNewVersion,
  strategyConfigurationSha256,
  validateStrategyConfiguration,
} from './trading_strategy.js';
import type {
  ExecutableSignal,
  ExecutableSignalSchemaContract,
  TradingAccount,
  TradingAccountMode,
  TradingAccountStatus,
  TradingExchange,
  TradingIntent,
  TradingOverview,
  TradingRoute,
  TradingRuntimeState,
  StrategyConfiguration,
  SignalContractDefinition,
  SignalContract,
  SignalContractVersion,
  TradingStrategyVersion,
  TradingSignalSchema,
} from './trading_types.js';
import { tradingExchangeId } from './trading_types.js';
import { clearWorkflowBuilderHistory } from './workflow_repository.js';
import { countUnprovedProtection } from './trading_protection_projection.js';

function boolean(value: unknown): boolean {
  return Number(value) === 1;
}

function numeric(value: unknown, fallback = 0): number {
  return value === null || value === undefined ? fallback : Number(value);
}

function nullableNumeric(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') throw new TypeError(`Stored ${label} must be a JSON string.`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}

function strategyFromRow(row: any): TradingStrategyVersion {
  const storedConfiguration = parseJson<StrategyConfiguration>(row.configuration_json, 'strategy configuration');
  const hash = strategyConfigurationSha256(storedConfiguration);
  if (!constantTimeStringEqual(hash, row.configuration_sha256)) {
    throw new Error(`Strategy version ${row.id} failed its integrity check.`);
  }
  const configuration = validateStrategyConfiguration(storedConfiguration);
  return {
    id: String(row.id),
    strategyId: String(row.strategy_id),
    version: Number(row.version),
    name: String(row.name),
    description: String(row.description || ''),
    status: row.status,
    configuration,
    configurationSha256: hash,
    createdAt: Number(row.created_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
  };
}

function accountFromRow(row: any): TradingAccount {
  const capabilities = row.capabilities_json
    ? parseJson<Record<string, unknown>>(row.capabilities_json, 'account capabilities')
    : null;
  return {
    id: String(row.id),
    name: String(row.name),
    exchange: row.exchange,
    mode: row.mode,
    status: row.status,
    enabled: boolean(row.enabled),
    credentialRef: row.credential_ref || null,
    externalAccountId: row.external_account_id || null,
    credentialGeneration: row.credential_generation || null,
    maxConcurrentPositions: Number(row.max_concurrent_positions ?? 20),
    killSwitchActive: boolean(row.kill_switch_active),
    killSwitchReason: row.kill_switch_reason || null,
    capabilities,
    lastVerifiedAt: row.last_verified_at === null ? null : Number(row.last_verified_at),
    lastReconciledAt: row.last_reconciled_at === null || row.last_reconciled_at === undefined
      ? null
      : Number(row.last_reconciled_at),
    lastError: row.last_error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function routeFromRow(row: any): TradingRoute {
  return {
    channelId: String(row.channel_id),
    strategyVersionId: String(row.strategy_version_id),
    accountId: String(row.account_id),
    enabled: boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function runtimeFromRow(row: any): TradingRuntimeState {
  if (!row) throw new Error('Trading runtime state is missing.');
  return {
    executionEnabled: boolean(row.execution_enabled),
    liveTradingEnabled: boolean(row.live_trading_enabled),
    killSwitchActive: boolean(row.kill_switch_active),
    killSwitchReason: row.kill_switch_reason || null,
    updatedAt: Number(row.updated_at),
  };
}

function intentFromRow(row: any): TradingIntent {
  return {
    id: String(row.id),
    sourceSignalId: String(row.source_signal_id),
    rootSourceSignalId: String(row.root_source_signal_id ?? row.source_signal_id),
    signalRunId: row.signal_run_id || null,
    workflowRevisionId: row.workflow_revision_id || null,
    executionPathId: row.execution_path_id || null,
    channelId: String(row.channel_id),
    strategyVersionId: String(row.strategy_version_id),
    accountId: String(row.account_id),
    exchange: row.exchange,
    mode: row.mode,
    symbol: String(row.symbol),
    side: row.side,
    status: row.status,
    signal: parseJson(row.signal_json, 'trade signal'),
    plan: row.plan_json ? parseJson(row.plan_json, 'trade plan') : null,
    blockReason: row.block_reason || null,
    error: row.last_error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function transaction<T>(operation: () => Promise<T>): Promise<T> {
  return withDatabaseTransaction(() => operation());
}

async function insertStrategy(strategy: TradingStrategyVersion): Promise<void> {
  await getDatabase().run(
    `INSERT INTO trading_strategy_versions (
       id, strategy_id, version, name, description, status, configuration_json,
       configuration_sha256, created_at, published_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      strategy.id,
      strategy.strategyId,
      strategy.version,
      strategy.name,
      strategy.description,
      strategy.status,
      JSON.stringify(strategy.configuration),
      strategy.configurationSha256,
      strategy.createdAt,
      strategy.publishedAt,
    ],
  );
}

function contractMetadata(input: { name: unknown; description?: unknown }): { name: string; description: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!name || name.length > 80) throw new Error('Signal contract name must contain between 1 and 80 characters.');
  if (description.length > 500) throw new Error('Signal contract description must not exceed 500 characters.');
  return { name, description };
}

function contractVersionIdentifier(value: unknown, label = 'Signal contract version identifier'): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}:v[1-9]\d{0,8}$/.test(value.trim())) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

export async function listSignalContracts(): Promise<SignalContract[]> {
  const [contracts, versions] = await Promise.all([
    getDatabase().all<any[]>('SELECT * FROM trading_signal_contracts ORDER BY archived, name, id'),
    getDatabase().all<any[]>('SELECT * FROM trading_signal_contract_versions ORDER BY contract_id, version DESC'),
  ]);
  const byContract = new Map<string, SignalContractVersion[]>();
  for (const row of versions) {
    const version = contractVersionFromRow(row);
    byContract.set(version.contractId, [...(byContract.get(version.contractId) ?? []), version]);
  }
  return contracts.map(row => ({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    archived: boolean(row.archived),
    versions: byContract.get(String(row.id)) ?? [],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function getSignalContractVersion(id: string): Promise<SignalContractVersion | null> {
  const row = await getDatabase().get<any>(
    'SELECT * FROM trading_signal_contract_versions WHERE id = ?',
    [contractVersionIdentifier(id)],
  );
  return row ? contractVersionFromRow(row) : null;
}

export async function createSignalContract(input: {
  id: unknown;
  name: unknown;
  description?: unknown;
  definition: unknown;
}, now = Date.now()): Promise<SignalContract> {
  const id = signalSchemaIdentifier(input.id, 'Signal contract identifier');
  const metadata = contractMetadata(input);
  const definition = validateSignalContractDefinition(input.definition);
  return transaction(async () => {
    await getDatabase().run(
      `INSERT INTO trading_signal_contracts (
         id, name, description, archived, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, ?)`,
      [id, metadata.name, metadata.description, now, now],
    );
    await getDatabase().run(
      `INSERT INTO trading_signal_contract_versions (
         id, contract_id, version, status, definition_json, definition_sha256,
         created_at, published_at, archived_at
       ) VALUES (?, ?, 1, 'draft', ?, ?, ?, NULL, NULL)`,
      [`${id}:v1`, id, JSON.stringify(definition), signalContractDefinitionSha256(definition), now],
    );
    return (await listSignalContracts()).find(contract => contract.id === id)!;
  });
}

export async function createSignalContractDraftVersion(
  contractId: unknown,
  sourceVersionId: unknown,
  now = Date.now(),
): Promise<SignalContractVersion> {
  const id = signalSchemaIdentifier(contractId, 'Signal contract identifier');
  const sourceId = contractVersionIdentifier(sourceVersionId);
  return transaction(async () => {
    const sourceRow = await getDatabase().get<any>(
      'SELECT * FROM trading_signal_contract_versions WHERE id = ? AND contract_id = ?',
      [sourceId, id],
    );
    if (!sourceRow) throw new Error('Source signal contract version does not exist.');
    const existingDraft = await getDatabase().get(
      `SELECT id FROM trading_signal_contract_versions WHERE contract_id = ? AND status = 'draft'`,
      [id],
    );
    if (existingDraft) throw new Error('Signal contract already has an editable draft version.');
    const latest = await getDatabase().get<{ version: number }>(
      'SELECT MAX(version) AS version FROM trading_signal_contract_versions WHERE contract_id = ?',
      [id],
    );
    const version = Number(latest?.version || 0) + 1;
    const definition = contractVersionFromRow(sourceRow).definition;
    const versionId = `${id}:v${version}`;
    await getDatabase().run(
      `INSERT INTO trading_signal_contract_versions (
         id, contract_id, version, status, definition_json, definition_sha256,
         created_at, published_at, archived_at
       ) VALUES (?, ?, ?, 'draft', ?, ?, ?, NULL, NULL)`,
      [versionId, id, version, JSON.stringify(definition), signalContractDefinitionSha256(definition), now],
    );
    return contractVersionFromRow(await getDatabase().get(
      'SELECT * FROM trading_signal_contract_versions WHERE id = ?',
      [versionId],
    ));
  });
}

export async function updateSignalContractDraft(input: {
  contractId: unknown;
  versionId: unknown;
  name: unknown;
  description?: unknown;
  definition: unknown;
}, now = Date.now()): Promise<SignalContractVersion> {
  const contractId = signalSchemaIdentifier(input.contractId, 'Signal contract identifier');
  const versionId = contractVersionIdentifier(input.versionId);
  const metadata = contractMetadata(input);
  const definition = validateSignalContractDefinition(input.definition);
  return transaction(async () => {
    const result = await getDatabase().run(
      `UPDATE trading_signal_contract_versions
       SET definition_json = ?, definition_sha256 = ?
       WHERE id = ? AND contract_id = ? AND status = 'draft'`,
      [JSON.stringify(definition), signalContractDefinitionSha256(definition), versionId, contractId],
    );
    if (Number(result.changes || 0) !== 1) throw new Error('Only an existing draft contract version can be edited.');
    await getDatabase().run(
      'UPDATE trading_signal_contracts SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      [metadata.name, metadata.description, now, contractId],
    );
    return contractVersionFromRow(await getDatabase().get(
      'SELECT * FROM trading_signal_contract_versions WHERE id = ?',
      [versionId],
    ));
  });
}

export async function publishSignalContractVersion(versionId: unknown, now = Date.now()): Promise<SignalContractVersion> {
  const id = contractVersionIdentifier(versionId);
  const result = await getDatabase().run(
    `UPDATE trading_signal_contract_versions SET status = 'published', published_at = ?
     WHERE id = ? AND status = 'draft'`,
    [now, id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only an existing draft contract version can be published.');
  return contractVersionFromRow(await getDatabase().get(
    'SELECT * FROM trading_signal_contract_versions WHERE id = ?',
    [id],
  ));
}

export async function archiveSignalContractVersion(versionId: unknown, now = Date.now()): Promise<SignalContractVersion> {
  const id = contractVersionIdentifier(versionId);
  return transaction(async () => {
    const used = await getDatabase().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_signal_schemas
       WHERE contract_version_id = ? AND enabled = 1`,
      [id],
    );
    if (Number(used?.count || 0) > 0) {
      throw new Error('Enabled signal schema profiles must be moved before archiving this contract version.');
    }
    const result = await getDatabase().run(
      `UPDATE trading_signal_contract_versions SET status = 'archived', archived_at = ?
       WHERE id = ? AND status = 'published'`,
      [now, id],
    );
    if (Number(result.changes || 0) !== 1) throw new Error('Only a published contract version can be archived.');
    const archived = contractVersionFromRow(await getDatabase().get(
      'SELECT * FROM trading_signal_contract_versions WHERE id = ?',
      [id],
    ));
    await clearWorkflowBuilderHistory('published signal contract archived', now);
    return archived;
  });
}

async function signalContractVersionDeletionTarget(
  id: string,
): Promise<{ contractId: string; status: string } | null> {
  const row = await getDatabase().get<{ contract_id: string; status: string }>(
    'SELECT contract_id, status FROM trading_signal_contract_versions WHERE id = ?',
    [id],
  );
  return row ? { contractId: row.contract_id, status: row.status } : null;
}

async function removeSignalContractVersionRecord(id: string, contractId: string): Promise<void> {
  await getDatabase().run('DELETE FROM trading_signal_contract_versions WHERE id = ?', [id]);
  const remaining = await getDatabase().get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM trading_signal_contract_versions WHERE contract_id = ?',
    [contractId],
  );
  if (Number(remaining?.count || 0) === 0) {
    await getDatabase().run('DELETE FROM trading_signal_contracts WHERE id = ?', [contractId]);
  }
}

export async function deleteSignalContractDraft(versionId: unknown): Promise<boolean> {
  const id = contractVersionIdentifier(versionId);
  return transaction(async () => {
    const row = await signalContractVersionDeletionTarget(id);
    if (!row) return false;
    if (row.status !== 'draft') throw new Error('Published or archived contract versions cannot be deleted.');
    await removeSignalContractVersionRecord(id, row.contractId);
    return true;
  });
}

export async function deleteSignalContractVersion(versionId: unknown): Promise<boolean> {
  const id = contractVersionIdentifier(versionId);
  return transaction(async () => {
    const row = await signalContractVersionDeletionTarget(id);
    if (!row) return false;
    if (row.status === 'draft') {
      throw new Error('Draft contract versions must be deleted through the draft deletion action.');
    }
    const references = await getDatabase().get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trading_signal_schemas WHERE contract_version_id = ?',
      [id],
    );
    if (Number(references?.count || 0) > 0) {
      throw new Error('Signal schema profiles must be moved or deleted before deleting this contract version.');
    }
    await removeSignalContractVersionRecord(id, row.contractId);
    await clearWorkflowBuilderHistory('published signal contract deleted');
    return true;
  });
}

export async function duplicateSignalContract(input: {
  sourceVersionId: unknown;
  id: unknown;
  name: unknown;
  description?: unknown;
}, now = Date.now()): Promise<SignalContract> {
  const sourceId = contractVersionIdentifier(input.sourceVersionId);
  const source = await getDatabase().get<any>(
    'SELECT * FROM trading_signal_contract_versions WHERE id = ?',
    [sourceId],
  );
  if (!source) throw new Error('Source signal contract version does not exist.');
  return createSignalContract({
    id: input.id,
    name: input.name,
    description: input.description,
    definition: contractVersionFromRow(source).definition,
  }, now);
}

export async function listTradingSignalSchemas(): Promise<TradingSignalSchema[]> {
  const rows = await getDatabase().all<any[]>(
    `SELECT schema.*,
            version.definition_json AS contract_definition_json,
            version.definition_sha256 AS contract_definition_sha256
     FROM trading_signal_schemas AS schema
     LEFT JOIN trading_signal_contract_versions AS version ON version.id = schema.contract_version_id
     ORDER BY schema.enabled DESC, schema.name, schema.id`,
  );
  return rows.map(signalSchemaFromRow);
}

export async function getTradingSignalSchemaForTemplate(templateName?: string): Promise<TradingSignalSchema | null> {
  const normalized = templateName?.trim() || 'default';
  const row = await getDatabase().get(
    `SELECT schema.*,
            version.definition_json AS contract_definition_json,
            version.definition_sha256 AS contract_definition_sha256
     FROM trading_signal_schemas AS schema
     LEFT JOIN trading_signal_contract_versions AS version ON version.id = schema.contract_version_id
     WHERE schema.template_name = ? COLLATE NOCASE AND schema.enabled = 1
       AND (schema.contract_version_id IS NULL OR version.status = 'published')`,
    [normalized],
  );
  return row ? signalSchemaFromRow(row) : null;
}

export async function createTradingSignalSchema(input: {
  id: unknown;
  name: unknown;
  description?: unknown;
  parserSchema?: unknown;
  contractVersionId?: unknown;
  definition?: unknown;
  templateName: unknown;
  enabled: unknown;
}, now = Date.now()): Promise<TradingSignalSchema> {
  const validated = await signalSchemaInput(input, true);
  await getDatabase().run(
    `INSERT INTO trading_signal_schemas (
       id, name, description, parser_schema, contract_version_id, template_name,
       definition_json, definition_sha256, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      validated.id, validated.name, validated.description, validated.parserSchema,
      validated.contractVersionId, validated.templateName,
      JSON.stringify(validated.definition), validated.definitionSha256,
      validated.enabled ? 1 : 0, now, now,
    ],
  );
  const row = await getDatabase().get(
    `SELECT schema.*,
            version.definition_json AS contract_definition_json,
            version.definition_sha256 AS contract_definition_sha256
     FROM trading_signal_schemas AS schema
     LEFT JOIN trading_signal_contract_versions AS version ON version.id = schema.contract_version_id
     WHERE schema.id = ?`,
    [validated.id],
  );
  return signalSchemaFromRow(row);
}

export async function updateTradingSignalSchema(id: string, input: {
  name: unknown;
  description?: unknown;
  parserSchema?: unknown;
  contractVersionId?: unknown;
  definition?: unknown;
  templateName: unknown;
  enabled: unknown;
}, now = Date.now()): Promise<TradingSignalSchema> {
  const normalizedId = signalSchemaIdentifier(id);
  const current = await getDatabase().get<any>(
    `SELECT parser_schema, contract_version_id, definition_json
     FROM trading_signal_schemas WHERE id = ?`,
    [normalizedId],
  );
  if (!current) throw new Error('Signal schema does not exist.');
  const validated = await signalSchemaInput({
    ...input,
    parserSchema: input.parserSchema ?? current.parser_schema,
    contractVersionId: input.contractVersionId === undefined
      ? current.contract_version_id
      : input.contractVersionId,
    definition: input.definition === undefined
      ? parseJson(current.definition_json, 'signal schema definition')
      : input.definition,
  }, false);
  return transaction(async () => {
    await assertSignalSchemaNotActivelyRouted(normalizedId);
    const result = await getDatabase().run(
      `UPDATE trading_signal_schemas
       SET name = ?, description = ?, parser_schema = ?, contract_version_id = ?,
           template_name = ?, definition_json = ?, definition_sha256 = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      [
        validated.name, validated.description, validated.parserSchema, validated.contractVersionId, validated.templateName,
        JSON.stringify(validated.definition), validated.definitionSha256,
        validated.enabled ? 1 : 0, now, normalizedId,
      ],
    );
    if (Number(result.changes || 0) !== 1) throw new Error('Signal schema does not exist.');
    const row = await getDatabase().get(
      `SELECT schema.*,
              version.definition_json AS contract_definition_json,
              version.definition_sha256 AS contract_definition_sha256
       FROM trading_signal_schemas AS schema
       LEFT JOIN trading_signal_contract_versions AS version ON version.id = schema.contract_version_id
       WHERE schema.id = ?`,
      [normalizedId],
    );
    return signalSchemaFromRow(row);
  });
}

export async function deleteTradingSignalSchema(id: string): Promise<boolean> {
  const normalizedId = signalSchemaIdentifier(id);
  return transaction(async () => {
    await assertSignalSchemaNotActivelyRouted(normalizedId);
    const result = await getDatabase().run('DELETE FROM trading_signal_schemas WHERE id = ?', [normalizedId]);
    const deleted = Number(result.changes || 0) === 1;
    if (deleted) await clearWorkflowBuilderHistory('signal schema deleted');
    return deleted;
  });
}

export async function listTradingStrategies(): Promise<TradingStrategyVersion[]> {
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_strategy_versions ORDER BY name, version DESC');
  return rows.map(strategyFromRow);
}

export async function getTradingStrategyVersion(id: string): Promise<TradingStrategyVersion | null> {
  const row = await getDatabase().get('SELECT * FROM trading_strategy_versions WHERE id = ?', [id]);
  return row ? strategyFromRow(row) : null;
}

export async function createTradingStrategyDraft(input: {
  strategyId?: string;
  name: string;
  description?: string;
  configuration: unknown;
}): Promise<TradingStrategyVersion> {
  return transaction(async () => {
    let version = 1;
    if (input.strategyId) {
      const latest = await getDatabase().get<{ version: number }>(
        'SELECT MAX(version) AS version FROM trading_strategy_versions WHERE strategy_id = ?',
        [input.strategyId],
      );
      if (!latest?.version) throw new Error('Cannot create a version for an unknown strategy.');
      version = Number(latest.version) + 1;
    }
    const strategy = createStrategyVersion({ ...input, version });
    await assertSignalSchemasAvailable(strategy.configuration);
    await insertStrategy(strategy);
    return strategy;
  });
}

export async function updateTradingStrategyDraft(id: string, input: {
  name: string;
  description?: string;
  configuration: unknown;
}): Promise<TradingStrategyVersion> {
  const configuration = strategyConfigurationForNewVersion(input.configuration);
  await assertSignalSchemasAvailable(configuration);
  const name = input.name?.trim();
  const description = input.description?.trim() || '';
  if (!name || name.length > 80) throw new Error('Strategy name must contain between 1 and 80 characters.');
  if (description.length > 500) throw new Error('Strategy description must not exceed 500 characters.');
  const result = await getDatabase().run(
    `UPDATE trading_strategy_versions
     SET name = ?, description = ?, configuration_json = ?, configuration_sha256 = ?
     WHERE id = ? AND status = 'draft'`,
    [name, description, JSON.stringify(configuration), strategyConfigurationSha256(configuration), id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only an existing draft strategy version can be edited.');
  return (await getTradingStrategyVersion(id))!;
}

export async function publishTradingStrategyVersion(id: string, now = Date.now()): Promise<TradingStrategyVersion> {
  const existing = await getTradingStrategyVersion(id);
  if (existing?.status !== 'draft') throw new Error('Only an existing draft strategy version can be published.');
  await assertSignalSchemasAvailable(existing.configuration);
  const result = await getDatabase().run(
    `UPDATE trading_strategy_versions SET status = 'published', published_at = ?
     WHERE id = ? AND status = 'draft'`,
    [now, id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only an existing draft strategy version can be published.');
  return (await getTradingStrategyVersion(id))!;
}

export async function listTradingAccounts(): Promise<TradingAccount[]> {
  const rows = await getDatabase().all<any[]>(
    'SELECT * FROM trading_accounts WHERE retired_at IS NULL ORDER BY name, created_at',
  );
  return rows.map(accountFromRow);
}

function validateTradingAccountInput(input: {
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  credentialRef?: string;
  initialBalance?: unknown;
  maxConcurrentPositions?: unknown;
}): { name: string; paper: boolean; credentialRef: string | null; initialBalance: string | null; maxConcurrentPositions: number } {
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new Error('Account name must contain between 1 and 80 characters.');
  const paper = validateTradingAccountType(input.exchange, input.mode);
  const credentialRef = validateTradingAccountCredentials(input, paper);
  const initialBalance = validateTradingAccountBalance(input.initialBalance, paper);
  const maxConcurrentPositions = input.maxConcurrentPositions === undefined
    ? 20
    : Number(input.maxConcurrentPositions);
  if (!Number.isSafeInteger(maxConcurrentPositions) || maxConcurrentPositions < 1 || maxConcurrentPositions > 20) {
    throw new Error('Account maximum concurrent positions must be an integer between 1 and 20.');
  }
  return { name, paper, credentialRef, initialBalance, maxConcurrentPositions };
}

function validateTradingAccountType(exchange: TradingExchange, mode: TradingAccountMode): boolean {
  tradingExchangeId(exchange);
  if (!['paper', 'testnet', 'live'].includes(mode)) throw new Error('Unsupported account mode.');
  const paper = exchange === 'paper';
  if (paper !== (mode === 'paper')) throw new Error('Paper mode may only be used with the paper exchange.');
  return paper;
}

function validateTradingAccountCredentials(
  input: { credentialRef?: string; initialBalance?: unknown },
  paper: boolean,
): string | null {
  const credentialRef = input.credentialRef?.trim() || null;
  if (!paper && !credentialRef) throw new Error('Exchange accounts require a credential reference.');
  if (!paper && input.initialBalance !== undefined) throw new Error('Only paper accounts accept an initial balance.');
  return credentialRef;
}

function validateTradingAccountBalance(initialBalance: unknown, paper: boolean): string | null {
  if (paper && (initialBalance === undefined || initialBalance === null || initialBalance === '')) {
    throw new Error('Paper accounts require an explicitly entered initial balance.');
  }
  if (!paper) return null;
  if (typeof initialBalance !== 'string' && typeof initialBalance !== 'number') {
    throw new TypeError('Paper account initial balance must be a decimal string or number.');
  }
  const serializedBalance = typeof initialBalance === 'number' ? String(initialBalance) : initialBalance;
  return decimal(serializedBalance, { positive: true });
}

export async function createTradingAccount(input: {
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  credentialRef?: string;
  initialBalance?: unknown;
  maxConcurrentPositions?: number;
}, now = Date.now()): Promise<TradingAccount> {
  const { name, paper, credentialRef, initialBalance, maxConcurrentPositions } = validateTradingAccountInput(input);
  const id = randomUUID();
  await transaction(async () => {
    await getDatabase().run(
      `INSERT INTO trading_accounts (
         id, name, exchange, mode, status, enabled, credential_ref,
         max_concurrent_positions, kill_switch_active, last_verified_at,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
      [id, name, input.exchange, input.mode, paper ? 'ready' : 'unverified', paper ? 1 : 0,
        credentialRef, maxConcurrentPositions, paper ? now : null, now, now],
    );
    if (paper) {
      await getDatabase().run(
        `INSERT INTO trading_paper_accounts (
           account_id, equity, available_balance, realized_pnl, updated_at
         ) VALUES (?, ?, ?, '0', ?)`,
        [id, initialBalance, initialBalance, now],
      );
    }
  });
  return accountFromRow(await getDatabase().get('SELECT * FROM trading_accounts WHERE id = ?', [id]));
}

type TradingAccountStateUpdate = {
    status: TradingAccountStatus;
    enabled: boolean;
    error?: string | null;
    verifiedAt?: number | null;
    externalAccountId?: string | null;
    credentialGeneration?: string | null;
};

function validateAccountStateUpdate(state: TradingAccountStateUpdate): void {
  if (!['unverified', 'ready', 'disabled', 'error', 'degraded'].includes(state.status)) throw new Error('Unsupported account status.');
  if (state.enabled && state.status !== 'ready') throw new Error('Only a verified ready account can be enabled.');
  const externalAccountId = state.externalAccountId?.trim() || null;
  if (externalAccountId && (externalAccountId.length > 256 || /[\x00-\x1f\x7f]/.test(externalAccountId))) {
    throw new Error('External account identity must contain at most 256 printable characters.');
  }
  if (state.credentialGeneration != null && !/^[a-f0-9]{64}$/.test(state.credentialGeneration)) {
    throw new Error('Credential generation must be a verified executor binding.');
  }
}

export async function updateTradingAccountState(id: string, state: TradingAccountStateUpdate): Promise<TradingAccount> {
  validateAccountStateUpdate(state);
  return withDatabaseTransaction(() => updateTradingAccountStateOwned(id, state));
}

async function updateTradingAccountStateOwned(id: string, state: TradingAccountStateUpdate): Promise<TradingAccount> {
  const result = await getDatabase().run(
    `UPDATE trading_accounts
     SET status = ?, enabled = ?, last_error = ?, last_verified_at = ?,
         external_account_id = CASE WHEN ? = 1 THEN ? ELSE external_account_id END,
         credential_generation = CASE WHEN ? = 1 THEN ? ELSE credential_generation END,
         updated_at = ?
     WHERE id = ? AND retired_at IS NULL`,
    [
      state.status,
      state.enabled ? 1 : 0,
      state.error || null,
      state.verifiedAt ?? null,
      Object.hasOwn(state, 'externalAccountId') ? 1 : 0,
      state.externalAccountId?.trim() || null,
      Object.hasOwn(state, 'credentialGeneration') ? 1 : 0,
      state.credentialGeneration ?? null,
      Date.now(),
      id,
    ],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Trading account does not exist.');
  const account = await getTradingAccount(id);
  if (!account) throw new Error('Trading account changed while its state was updated.');
  return account;
}

type TradingAccountConfigurationUpdate = {
  maxConcurrentPositions?: unknown;
  killSwitchActive?: unknown;
  killSwitchReason?: unknown;
  capabilities?: Record<string, unknown> | null;
  lastReconciledAt?: number | null;
};

function accountPositionLimit(value: unknown, fallback: number): number {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('Account maximum concurrent positions must be an integer between 1 and 20.');
  }
  return limit;
}

function accountKillSwitch(
  input: TradingAccountConfigurationUpdate,
  current: TradingAccount,
): { active: boolean; reason: string | null } {
  const active = input.killSwitchActive === undefined ? current.killSwitchActive : input.killSwitchActive;
  if (typeof active !== 'boolean') throw new Error('Account kill-switch state must be boolean.');
  const reason = input.killSwitchReason === undefined
    ? (active ? current.killSwitchReason : null)
    : (typeof input.killSwitchReason === 'string' ? input.killSwitchReason.trim() || null : null);
  if (active && !reason) throw new Error('Account kill-switch activation requires a reason.');
  return { active, reason };
}

function accountCapabilitiesJson(value: Record<string, unknown> | null | undefined, current: TradingAccount): string | null {
  const capabilities = value === undefined ? current.capabilities : value;
  const serialized = capabilities === null ? null : JSON.stringify(capabilities);
  if (serialized && serialized.length > 100_000) throw new Error('Account capabilities payload is too large.');
  return serialized;
}

function accountReconciledAt(value: number | null | undefined, current: TradingAccount): number | null {
  const timestamp = value === undefined ? current.lastReconciledAt : value;
  if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp < 0)) {
    throw new Error('Account reconciliation timestamp is invalid.');
  }
  return timestamp;
}

export async function updateTradingAccountConfiguration(
  id: string,
  input: TradingAccountConfigurationUpdate,
): Promise<TradingAccount> {
  return withDatabaseTransaction(() => updateTradingAccountConfigurationOwned(id, input));
}

async function updateTradingAccountConfigurationOwned(
  id: string,
  input: TradingAccountConfigurationUpdate,
): Promise<TradingAccount> {
  const current = await getTradingAccount(id);
  if (!current) throw new Error('Trading account does not exist.');
  const maxConcurrentPositions = accountPositionLimit(input.maxConcurrentPositions, current.maxConcurrentPositions);
  const killSwitch = accountKillSwitch(input, current);
  const capabilitiesJson = accountCapabilitiesJson(input.capabilities, current);
  const lastReconciledAt = accountReconciledAt(input.lastReconciledAt, current);
  const updatedAt = Date.now();
  const update = await getDatabase().run(
    `UPDATE trading_accounts SET max_concurrent_positions = ?, kill_switch_active = ?,
       kill_switch_reason = ?, capabilities_json = ?, last_reconciled_at = ?, updated_at = ?
     WHERE id = ? AND retired_at IS NULL`,
    [maxConcurrentPositions, killSwitch.active ? 1 : 0, killSwitch.reason, capabilitiesJson,
      lastReconciledAt, updatedAt, id],
  );
  if (update.changes !== 1) throw new Error('Trading account changed or was retired before its configuration update.');
  if (!current.killSwitchActive && killSwitch.active) {
    await recordTradingNotificationBestEffort({
      dedupeKey: `account-kill-switch:${id}:${updatedAt}`,
      eventType: 'kill_switch_activated',
      accountId: id,
      exchange: current.exchange,
      mode: current.mode,
      occurredAt: updatedAt,
      details: { scope: 'account', reason: killSwitch.reason, accountName: current.name },
    });
  }
  const updated = await getTradingAccount(id);
  if (!updated) throw new Error('Trading account disappeared during its configuration update.');
  return updated;
}

export async function listTradingRoutes(): Promise<TradingRoute[]> {
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_routes ORDER BY channel_id');
  return rows.map(routeFromRow);
}

export async function setTradingRoute(input: {
  channelId: string;
  strategyVersionId: string;
  accountId: string;
  enabled: boolean;
}, now = Date.now()): Promise<TradingRoute> {
  const channelId = input.channelId?.trim();
  if (!channelId || channelId.length > 128) throw new Error('A valid channel identifier is required.');
  await transaction(async () => {
    const strategy = await getDatabase().get<{ status: string; configuration_json: string }>(
      'SELECT status, configuration_json FROM trading_strategy_versions WHERE id = ?',
      [input.strategyVersionId],
    );
    if (strategy?.status !== 'published') throw new Error('Routes must pin a published immutable strategy version.');
    const configuration = validateStrategyConfiguration(
      parseJson(strategy.configuration_json, 'strategy configuration'),
    );
    await assertSignalSchemasAvailable(configuration);
    const account = await getDatabase().get<{ status: string; enabled: number }>(
      'SELECT status, enabled FROM trading_accounts WHERE id = ?',
      [input.accountId],
    );
    if (!account) throw new Error('Trading account does not exist.');
    if (input.enabled && (account.status !== 'ready' || !boolean(account.enabled))) {
      throw new Error('An enabled route requires an enabled, verified account.');
    }
    await getDatabase().run(
      `INSERT INTO trading_routes (
         channel_id, strategy_version_id, account_id, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         strategy_version_id = excluded.strategy_version_id,
         account_id = excluded.account_id,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [channelId, input.strategyVersionId, input.accountId, input.enabled ? 1 : 0, now, now],
    );
  });
  return routeFromRow(await getDatabase().get('SELECT * FROM trading_routes WHERE channel_id = ?', [channelId]));
}

export async function deleteTradingRoute(channelId: string): Promise<boolean> {
  const active = await getDatabase().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM trading_trade_intents
     WHERE channel_id = ? AND status IN ('pending', 'planned', 'submitting', 'monitoring', 'unknown')`,
    [channelId],
  );
  if (Number(active?.count || 0) > 0) throw new Error('Route cannot be deleted while it owns active or unresolved trades.');
  const result = await getDatabase().run('DELETE FROM trading_routes WHERE channel_id = ?', [channelId]);
  return Number(result.changes || 0) === 1;
}

export async function getTradingRuntimeState(): Promise<TradingRuntimeState> {
  return runtimeFromRow(await getDatabase().get('SELECT * FROM trading_runtime_state WHERE singleton_id = 1'));
}

export async function updateTradingRuntimeState(input: Partial<Pick<TradingRuntimeState,
  'executionEnabled' | 'liveTradingEnabled' | 'killSwitchActive' | 'killSwitchReason'
>>): Promise<TradingRuntimeState> {
  const current = await getTradingRuntimeState();
  const next = { ...current, ...input, updatedAt: Date.now() };
  if (next.killSwitchActive && !next.killSwitchReason?.trim()) throw new Error('Kill switch activation requires a reason.');
  if (next.killSwitchActive) next.executionEnabled = false;
  await getDatabase().run(
    `UPDATE trading_runtime_state SET
       execution_enabled = ?, live_trading_enabled = ?, kill_switch_active = ?,
       kill_switch_reason = ?, updated_at = ? WHERE singleton_id = 1`,
    [next.executionEnabled ? 1 : 0, next.liveTradingEnabled ? 1 : 0, next.killSwitchActive ? 1 : 0, next.killSwitchReason, next.updatedAt],
  );
  if (!current.killSwitchActive && next.killSwitchActive) {
    await recordTradingExecutionEvent({
      eventType: 'kill_switch_activated',
      occurredAt: next.updatedAt,
      details: { reason: next.killSwitchReason || 'unspecified' },
    });
  }
  return getTradingRuntimeState();
}

export async function createTradingIntent(input: {
  sourceSignalId: string;
  channelId: string;
  signal: ExecutableSignal;
}): Promise<TradingIntent | null> {
  return transaction(async () => {
    const route = await getDatabase().get<any>(
      `SELECT route.*, strategy.status AS strategy_status,
              account.exchange, account.mode, account.status AS account_status, account.enabled AS account_enabled,
              runtime.execution_enabled, runtime.live_trading_enabled, runtime.kill_switch_active
       FROM trading_routes AS route
       JOIN trading_strategy_versions AS strategy ON strategy.id = route.strategy_version_id
       JOIN trading_accounts AS account ON account.id = route.account_id
       JOIN trading_runtime_state AS runtime ON runtime.singleton_id = 1
       WHERE route.channel_id = ?`,
      [input.channelId],
    );
    if (!route || !boolean(route.enabled)) return null;
    let status: TradingIntent['status'] = 'pending';
    let blockReason: string | null = null;
    if (route.strategy_status !== 'published') blockReason = 'STRATEGY_NOT_PUBLISHED';
    else if (route.account_status !== 'ready' || !boolean(route.account_enabled)) blockReason = 'ACCOUNT_NOT_READY';
    else if (boolean(route.kill_switch_active)) blockReason = 'KILL_SWITCH_ACTIVE';
    else if (!boolean(route.execution_enabled)) blockReason = 'EXECUTION_DISABLED';
    else if (route.mode === 'live' && !boolean(route.live_trading_enabled)) blockReason = 'LIVE_TRADING_DISABLED';
    const signalSchema = await getDatabase().get<{ enabled: number }>(
      'SELECT enabled FROM trading_signal_schemas WHERE id = ?',
      [input.signal.schema],
    );
    if (!blockReason && (!signalSchema || !boolean(signalSchema.enabled))) {
      blockReason = 'SIGNAL_SCHEMA_UNAVAILABLE';
    }
    if (blockReason) status = 'blocked';
    const id = randomUUID();
    const now = Date.now();
    await getDatabase().run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id,
         exchange, mode, symbol, side, status, signal_json, plan_json,
         block_reason, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      [
        id, input.sourceSignalId, input.sourceSignalId, input.channelId, route.strategy_version_id, route.account_id,
        route.exchange, route.mode, input.signal.symbol, input.signal.action, status,
        JSON.stringify(input.signal), blockReason, now, now,
      ],
    );
    return intentFromRow(await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [id]));
  });
}

export async function listTradingIntents(limit = 100): Promise<TradingIntent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Intent limit must be between 1 and 1000.');
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_trade_intents ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows.map(intentFromRow);
}

export async function getTradingIntent(id: string): Promise<TradingIntent | null> {
  const row = await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [id]);
  return row ? intentFromRow(row) : null;
}

export async function getTradingAccount(id: string): Promise<TradingAccount | null> {
  const row = await getDatabase().get(
    'SELECT * FROM trading_accounts WHERE id = ? AND retired_at IS NULL',
    [id],
  );
  return row ? accountFromRow(row) : null;
}

export async function getTradingOverview(): Promise<TradingOverview> {
  const [runtime, counts, reconciliation] = await Promise.all([
    getTradingRuntimeState(),
    getDatabase().get<any>(`SELECT
      (SELECT COUNT(*) FROM trading_accounts WHERE retired_at IS NULL) AS accounts,
      (CASE WHEN EXISTS (SELECT 1 FROM workflow_active_revision WHERE singleton_id = 1)
        THEN (SELECT COUNT(*) FROM workflow_execution_paths AS path
              JOIN workflow_active_revision AS active ON active.revision_id = path.workflow_revision_id
              WHERE active.singleton_id = 1 AND path.enabled = 1)
        ELSE (SELECT COUNT(*) FROM trading_routes WHERE enabled = 1)
       END) AS routes,
      (SELECT COUNT(*) FROM trading_positions WHERE status IN ('opening', 'open', 'closing', 'emergency')) AS positions,
      (SELECT COUNT(*) FROM trading_trade_intents WHERE status IN ('pending', 'planned', 'submitting', 'monitoring')) AS intents,
      (SELECT COUNT(*) FROM trading_orders WHERE status = 'unknown') AS unknown_orders`),
    getDatabase().get<{ latest: number | null }>(
      `SELECT MAX(completed_at) AS latest FROM trading_reconciliation_runs WHERE status = 'succeeded'`,
    ),
  ]);
  return {
    runtime,
    accountCount: Number(counts?.accounts || 0),
    enabledRouteCount: Number(counts?.routes || 0),
    openPositionCount: Number(counts?.positions || 0),
    pendingIntentCount: Number(counts?.intents || 0),
    unknownOrderCount: Number(counts?.unknown_orders || 0),
    latestReconciliationAt: reconciliation?.latest === null || reconciliation?.latest === undefined
      ? null
      : Number(reconciliation.latest),
  };
}

export async function listTradingActivity(limit = 200): Promise<{
  orders: Array<Record<string, unknown>>;
  fills: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  riskEvents: Array<Record<string, unknown>>;
  reconciliations: Array<Record<string, unknown>>;
  paperAccounts: Array<Record<string, unknown>>;
  paperMarkets: Array<Record<string, unknown>>;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Activity limit must be between 1 and 1000.');
  }
  const database = getDatabase();
  const [orders, fills, positions, riskEvents, reconciliations, paperAccounts, paperMarkets] = await Promise.all([
    database.all<any[]>(
      `SELECT id, intent_id AS intentId, account_id AS accountId, client_order_id AS clientOrderId,
              exchange_order_id AS exchangeOrderId, role, side, order_type AS orderType, status,
              price, trigger_price AS triggerPrice, quantity, filled_quantity AS filledQuantity,
              reduce_only AS reduceOnly, last_error AS error, created_at AS createdAt, updated_at AS updatedAt
       FROM trading_orders ORDER BY updated_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, order_id AS orderId, account_id AS accountId, exchange_fill_id AS exchangeFillId,
              provider_symbol AS providerSymbol, remote_fill_key AS remoteFillKey, identity_status AS identityStatus,
              price, quantity, fee, fee_asset AS feeAsset, filled_at AS filledAt
       FROM trading_fills ORDER BY filled_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, intent_id AS intentId, account_id AS accountId, strategy_version_id AS strategyVersionId,
              channel_id AS channelId, symbol, side, status, quantity,
              average_entry_price AS averageEntryPrice, stop_price AS stopPrice,
              ledger_realized_pnl AS realizedPnl, ledger_realized_value_json AS realizedPnlValueJson,
              CASE WHEN EXISTS(SELECT 1 FROM trading_accounting_pending pending WHERE pending.intent_id=trading_positions.intent_id)
                THEN 'unresolved' ELSE accounting_status END AS accountingStatus, reporting_currency AS reportingCurrency,
              opened_at AS openedAt, closed_at AS closedAt, updated_at AS updatedAt
       FROM trading_positions ORDER BY updated_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, severity, code, account_id AS accountId, intent_id AS intentId,
              details_json AS detailsJson, created_at AS createdAt, acknowledged_at AS acknowledgedAt
       FROM trading_risk_events ORDER BY created_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, account_id AS accountId, status, last_error AS error,
              started_at AS startedAt, completed_at AS completedAt
       FROM trading_reconciliation_runs ORDER BY started_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT account_id AS accountId, equity, available_balance AS availableBalance,
              realized_pnl AS realizedPnl, updated_at AS updatedAt FROM trading_paper_accounts ORDER BY account_id`),
    database.all<any[]>(
      `SELECT account_id AS accountId, symbol, mark_price AS markPrice, price_tick AS priceTick,
              quantity_step AS quantityStep, minimum_quantity AS minimumQuantity,
              minimum_notional AS minimumNotional, max_leverage AS maxLeverage,
              updated_at AS updatedAt FROM trading_paper_markets ORDER BY account_id, symbol`),
  ]);
  return {
    orders: orders.map(row => ({ ...row, reduceOnly: boolean(row.reduceOnly) })),
    fills,
    positions: positions.map(row => {
      const position = analyticsPositionMoneyRow(row);
      delete position.realizedPnlValueJson;
      return position;
    }),
    riskEvents: riskEvents.map(row => ({
      ...row,
      details: parseJson(row.detailsJson, 'risk event details'),
      detailsJson: undefined,
    })),
    reconciliations,
    paperAccounts,
    paperMarkets,
  };
}

export type TradingAnalyticsWindow = '24h' | '7d' | '30d' | 'all';

export interface TradingWindowAnalytics {
  realizedPnl: string | null;
  realizedPnlValue: MoneyValue | null;
  grossProfit: string | null;
  grossLoss: string | null;
  grossProfitValue: MoneyValue | null;
  grossLossValue: MoneyValue | null;
  closedRealizedPnl: string | null;
  closedRealizedPnlValue: MoneyValue | null;
  closedReportingCurrency: string | null;
  closedAccountingStatus: 'complete' | 'unresolved';
  reportingCurrency: string | null;
  accountingStatus: 'complete' | 'unresolved';
  pricePnl: string | null;
  funding: string | null;
  signedFees: string | null;
  pricePnlValue: MoneyValue | null;
  fundingValue: MoneyValue | null;
  signedFeesValue: MoneyValue | null;
  valuedSubtotalByCurrency: Record<string, string | null>;
  valuedSubtotalValuesByCurrency: Record<string, MoneyValue>;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  uncertainOutcomeCount: number;
  fills: number;
  volume: string | null;
  volumeByAsset: Record<string, string>;
  fees: Record<string, string>;
  intents: number;
  completedIntents: number;
  rejectedIntents: number;
  riskEvents: number;
  criticalRiskEvents: number;
}

export interface TradingAccountAnalytics {
  accountId: string;
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  windows: Record<TradingAnalyticsWindow, TradingWindowAnalytics>;
}

function emptyTradingWindow(): TradingWindowAnalytics {
  return {
    realizedPnl: null, grossProfit: null, grossLoss: null, reportingCurrency: null, accountingStatus: 'unresolved',
    realizedPnlValue: null, grossProfitValue: null, grossLossValue: null, closedRealizedPnl: null, closedRealizedPnlValue: null,
    closedReportingCurrency: null, closedAccountingStatus: 'unresolved', uncertainOutcomeCount: 0,
    pricePnlValue: null, fundingValue: null, signedFeesValue: null, valuedSubtotalByCurrency: {}, valuedSubtotalValuesByCurrency: {},
    pricePnl: null, funding: null, signedFees: null, closedTrades: 0, wins: 0, losses: 0, breakeven: 0,
    fills: 0, volume: null, volumeByAsset: {}, fees: {}, intents: 0, completedIntents: 0,
    rejectedIntents: 0, riskEvents: 0, criticalRiskEvents: 0,
  };
}

function signalSchemaFromRow(row: any): TradingSignalSchema {
  const definition = validateSignalContractDefinition(parseJson(row.definition_json, 'signal schema definition'));
  const definitionHash = signalContractDefinitionSha256(definition);
  if (!constantTimeStringEqual(definitionHash, String(row.definition_sha256))) {
    throw new Error(`Signal schema ${row.id} failed its integrity check.`);
  }
  const contractDefinition = row.contract_definition_json
    ? validateSignalContractDefinition(parseJson(row.contract_definition_json, 'fallback signal contract definition'))
    : null;
  if (contractDefinition) {
    const contractHash = signalContractDefinitionSha256(contractDefinition);
    if (!constantTimeStringEqual(contractHash, String(row.contract_definition_sha256))) {
      throw new Error(`Signal schema ${row.id} references a fallback contract that failed its integrity check.`);
    }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    parserSchema: row.parser_schema,
    definition,
    definitionSha256: definitionHash,
    contractVersionId: row.contract_version_id === null ? null : String(row.contract_version_id),
    contractDefinition,
    templateName: String(row.template_name),
    enabled: boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function contractVersionFromRow(row: any): SignalContractVersion {
  const definition = validateSignalContractDefinition(parseJson(row.definition_json, 'signal contract definition'));
  const hash = signalContractDefinitionSha256(definition);
  if (!constantTimeStringEqual(hash, String(row.definition_sha256))) {
    throw new Error(`Signal contract version ${row.id} failed its integrity check.`);
  }
  return {
    id: String(row.id),
    contractId: String(row.contract_id),
    version: Number(row.version),
    status: row.status,
    definition,
    definitionSha256: hash,
    createdAt: Number(row.created_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

function signalSchemaText(input: {
  name?: unknown;
  description?: unknown;
  templateName?: unknown;
}): { name: string; description: string; templateName: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const templateName = typeof input.templateName === 'string' ? input.templateName.trim() : '';
  if (!name || name.length > 80) throw new Error('Signal schema name must contain between 1 and 80 characters.');
  if (description.length > 500) throw new Error('Signal schema description must not exceed 500 characters.');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateName)) throw new Error('Signal schema template name is invalid.');
  return { name, description, templateName };
}

function requestedParserContract(value: unknown): ExecutableSignalSchemaContract | undefined {
  if (value === undefined) return undefined;
  if (value === 'standard' || value === 'cryptodanielvip' || value === 'loma') return value;
  throw new Error('Signal schema parser contract is unsupported.');
}

async function publishedContractVersion(contractVersionId: string): Promise<{
  contract_id: string;
  definition_json: string;
  definition_sha256: string;
}> {
  const version = await getDatabase().get<{
    contract_id: string;
    status: string;
    definition_json: string;
    definition_sha256: string;
  }>(
    `SELECT contract_id, status, definition_json, definition_sha256
     FROM trading_signal_contract_versions WHERE id = ?`,
    [contractVersionId],
  );
  if (version?.status !== 'published') {
    throw new Error('Signal schema must reference a published signal contract version.');
  }
  return version;
}

function executableParserContract(contractId: string): ExecutableSignalSchemaContract {
  if (contractId === 'cryptodanielvip' || contractId === 'loma') return contractId;
  return 'standard';
}

async function signalSchemaInput(input: {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  parserSchema?: unknown;
  contractVersionId?: unknown;
  definition?: unknown;
  templateName?: unknown;
  enabled?: unknown;
}, requireId: boolean): Promise<{
  id?: string;
  name: string;
  description: string;
  parserSchema: ExecutableSignalSchemaContract;
  contractVersionId: string | null;
  definition: SignalContractDefinition;
  definitionSha256: string;
  templateName: string;
  enabled: boolean;
}> {
  const id = requireId ? signalSchemaIdentifier(input.id) : undefined;
  const { name, description, templateName } = signalSchemaText(input);
  const requestedParserSchema = requestedParserContract(input.parserSchema);
  if (typeof input.enabled !== 'boolean') throw new Error('Signal schema enabled state must be boolean.');
  const contractVersionId = input.contractVersionId
    ? contractVersionIdentifier(input.contractVersionId)
    : input.definition === undefined && requestedParserSchema
      ? `${requestedParserSchema}:v1`
      : null;
  const version = contractVersionId
    ? await publishedContractVersion(contractVersionId)
    : null;
  if (input.definition === undefined && !version) {
    throw new Error('Signal schema definition is required when no fallback contract is selected.');
  }
  const definition = validateSignalContractDefinition(
    input.definition === undefined
      ? parseJson(version!.definition_json, 'fallback signal contract definition')
      : input.definition,
  );
  const definitionSha256 = signalContractDefinitionSha256(definition);
  if (version && input.definition === undefined
    && !constantTimeStringEqual(definitionSha256, version.definition_sha256)) {
    throw new Error('Signal schema fallback contract failed its integrity check.');
  }
  return {
    id,
    name,
    description,
    parserSchema: requestedParserSchema ?? (version ? executableParserContract(version.contract_id) : 'standard'),
    contractVersionId,
    definition,
    definitionSha256,
    templateName,
    enabled: input.enabled,
  };
}

async function assertSignalSchemasAvailable(configuration: StrategyConfiguration): Promise<void> {
  const rows = await getDatabase().all<Array<{ id: string; enabled: number }>>(
    `SELECT id, enabled FROM trading_signal_schemas
     WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(configuration.allowedSignalSchemas)],
  );
  const available = new Set(rows.filter(row => boolean(row.enabled)).map(row => row.id));
  const unavailable = configuration.allowedSignalSchemas.filter(id => !available.has(id));
  if (unavailable.length > 0) {
    throw new Error(`Strategy references unavailable signal schemas: ${unavailable.join(', ')}.`);
  }
}

async function assertSignalSchemaNotActivelyRouted(id: string): Promise<void> {
  const route = await getDatabase().get<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM trading_routes AS route
     JOIN trading_strategy_versions AS strategy ON strategy.id = route.strategy_version_id
     JOIN json_each(strategy.configuration_json, '$.allowedSignalSchemas') AS schema
     WHERE route.enabled = 1 AND schema.value = ?`,
    [id],
  );
  if (Number(route?.count || 0) > 0) {
    throw new Error('Signal schema cannot be changed or deleted while an enabled route uses it.');
  }
}

function windowLedgerFields(ledger: Awaited<ReturnType<typeof moneyLedgerSnapshot>>) {
  const currency = ledger.reportingCurrency;
  return { realizedPnl: ledger.amount, realizedPnlValue: ledger.value, reportingCurrency: currency,
    accountingStatus: ledger.valuationStatus === 'valued' ? 'complete' : 'unresolved',
    pricePnl: ledger.pricePnl, signedFees: ledger.fees, funding: ledger.funding,
    pricePnlValue: ledger.pricePnlValue, signedFeesValue: ledger.feesValue, fundingValue: ledger.fundingValue,
    valuedSubtotalByCurrency: currency ? { [currency]: ledger.valuedSubtotal } : {},
    valuedSubtotalValuesByCurrency: currency ? { [currency]: ledger.valuedSubtotalValue } : {} };
}

async function tradingAnalyticsWindow(since: number | null, until: number): Promise<Map<string, TradingWindowAnalytics>> {
  const database = getDatabase();
  const parameters = [since ?? 0, until];
  const [positions, fills, intents, risks] = await Promise.all([
    database.all<any[]>(
      `SELECT position.account_id AS accountId, ledger_realized_pnl AS realizedPnl, reporting_currency AS reportingCurrency,
         ledger_realized_value_json AS realizedPnlValueJson,
         CASE WHEN pending.intent_id IS NOT NULL THEN 'unresolved' ELSE accounting_status END AS accountingStatus
       FROM trading_positions position LEFT JOIN trading_accounting_pending pending ON pending.intent_id=position.intent_id
       WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?`, parameters),
    database.all<any[]>(
      `SELECT account_id AS accountId, fee_asset AS feeAsset, fee, price, quantity,
        json_extract(accounting_json, '$.settlementAsset') AS settlementAsset
       FROM trading_fills WHERE filled_at >= ? AND filled_at < ?`, parameters),
    database.all<any[]>(
      `SELECT account_id AS accountId, COUNT(*) AS intents,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedIntents,
              SUM(CASE WHEN status IN ('blocked', 'failed', 'unknown') THEN 1 ELSE 0 END) AS rejectedIntents
       FROM trading_trade_intents WHERE created_at >= ? AND created_at < ?
       GROUP BY account_id`, parameters),
    database.all<any[]>(
      `SELECT account_id AS accountId, COUNT(*) AS riskEvents,
              SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS criticalRiskEvents
       FROM trading_risk_events WHERE account_id IS NOT NULL AND created_at >= ? AND created_at < ?
       GROUP BY account_id`, parameters),
  ]);
  const result = new Map<string, TradingWindowAnalytics>();
  const metrics = (accountId: unknown) => {
    if (typeof accountId !== 'string' && typeof accountId !== 'number') {
      throw new TypeError('Trading analytics account ID must be a string or number.');
    }
    const id = String(accountId);
    const current = result.get(id) ?? emptyTradingWindow();
    result.set(id, current);
    return current;
  };
  const accounts = await database.all<Array<{ id: string }>>('SELECT id FROM trading_accounts');
  for (const account of accounts) {
    const ledger = await moneyLedgerSnapshot(account.id, since ?? 0, until);
    const closed = closedMoneyStatistics(positions.filter(row => row.accountId === account.id).map(analyticsPositionMoneyRow));
    Object.assign(metrics(account.id), closed, {
      closedRealizedPnl: closed.realizedPnl, closedRealizedPnlValue: closed.realizedPnlValue,
      closedReportingCurrency: closed.reportingCurrency, closedAccountingStatus: closed.accountingStatus,
      ...windowLedgerFields(ledger),
    });
  }
  for (const row of fills) {
    const current = metrics(row.accountId);
    current.fills += 1;
    const settlement = String(row.settlementAsset ?? 'UNKNOWN');
    current.volumeByAsset[settlement] = addDecimal(current.volumeByAsset[settlement] ?? '0', multiplyExactSignedDecimal(row.price, row.quantity));
    const asset = String(row.feeAsset || 'UNKNOWN').toUpperCase();
    current.fees[asset] = addSignedDecimal(current.fees[asset] ?? '0', row.fee);
  }
  for (const current of result.values()) current.volume = Object.keys(current.volumeByAsset).length === 1
    && current.volumeByAsset.UNKNOWN === undefined ? Object.values(current.volumeByAsset)[0]! : null;
  for (const row of intents) Object.assign(metrics(row.accountId), {
    intents: numeric(row.intents), completedIntents: numeric(row.completedIntents),
    rejectedIntents: numeric(row.rejectedIntents),
  });
  for (const row of risks) Object.assign(metrics(row.accountId), {
    riskEvents: numeric(row.riskEvents), criticalRiskEvents: numeric(row.criticalRiskEvents),
  });
  return result;
}

export async function getTradingAnalytics(now = Date.now()): Promise<{
  generatedAt: number;
  accounts: TradingAccountAnalytics[];
}> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Trading analytics timestamp is invalid.');
  await projectAllFillAccounting();
  const windows: Array<[TradingAnalyticsWindow, number | null]> = [
    ['24h', now - 24 * 60 * 60 * 1_000],
    ['7d', now - 7 * 24 * 60 * 60 * 1_000],
    ['30d', now - 30 * 24 * 60 * 60 * 1_000],
    ['all', null],
  ];
  const [accounts, snapshots] = await Promise.all([
    listTradingAccounts(),
    Promise.all(windows.map(([, since]) => tradingAnalyticsWindow(since, now + 1))),
  ]);
  return {
    generatedAt: now,
    accounts: accounts.map(account => ({
      accountId: account.id,
      name: account.name,
      exchange: account.exchange,
      mode: account.mode,
      windows: Object.fromEntries(windows.map(([window], index) => [
        window, snapshots[index].get(account.id) ?? emptyTradingWindow(),
      ])) as Record<TradingAnalyticsWindow, TradingWindowAnalytics>,
    })),
  };
}

export async function acknowledgeTradingRiskEvent(id: string, now = Date.now()): Promise<boolean> {
  const result = await getDatabase().run(
    'UPDATE trading_risk_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?',
    [now, id],
  );
  return Number(result.changes || 0) === 1;
}

export async function archiveTradingStrategyVersion(id: string): Promise<TradingStrategyVersion> {
  return transaction(async () => {
    const activeRoute = await getDatabase().get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM trading_routes WHERE strategy_version_id = ? AND enabled = 1', [id],
    );
    if (Number(activeRoute?.count || 0) > 0) throw new Error('An active routed strategy version cannot be archived.');
    const result = await getDatabase().run(
      "UPDATE trading_strategy_versions SET status = 'archived' WHERE id = ? AND status = 'published'", [id],
    );
    if (Number(result.changes || 0) !== 1) throw new Error('Only a published strategy version can be archived.');
    const archived = (await getTradingStrategyVersion(id))!;
    await clearWorkflowBuilderHistory('published trading strategy archived');
    return archived;
  });
}

export async function deleteTradingStrategyVersion(id: string): Promise<boolean> {
  return transaction(async () => {
    const existing = await getDatabase().get<{ id: string }>(
      'SELECT id FROM trading_strategy_versions WHERE id = ?', [id],
    );
    if (!existing) return false;

    const references = await getDatabase().get<any>(
      `SELECT
         (SELECT COUNT(*) FROM trading_routes WHERE strategy_version_id = ?) AS routes,
         (SELECT COUNT(*) FROM trading_trade_intents WHERE strategy_version_id = ?) AS intents,
         (SELECT COUNT(*) FROM trading_positions WHERE strategy_version_id = ?) AS positions`,
      [id, id, id],
    );
    if (Number(references?.intents || 0) > 0 || Number(references?.positions || 0) > 0) {
      throw new Error('Strategy deletion is blocked because retained trade history references this version. Archive it instead.');
    }
    if (Number(references?.routes || 0) > 0) {
      throw new Error('Strategy deletion requires all channel routes using this version to be removed first.');
    }
    const result = await getDatabase().run('DELETE FROM trading_strategy_versions WHERE id = ?', [id]);
    const deleted = Number(result.changes || 0) === 1;
    if (deleted) await clearWorkflowBuilderHistory('published trading strategy deleted');
    return deleted;
  });
}

function assertTradingAccountRemovalSafe(references: Record<string, unknown>): void {
  if (numeric(references.routes) > 0 || numeric(references.active_paths) > 0) {
    throw new Error('Account removal requires all routes to be removed and all active Builder paths using this account to be removed first.');
  }
  if (numeric(references.active_intents) > 0 || numeric(references.active_positions) > 0) {
    throw new Error('Account removal is refused while active or unresolved trades still reference this account.');
  }
}

export async function deleteTradingAccount(id: string): Promise<boolean> {
  return transaction(async () => {
    const existing = await getDatabase().get<{ id: string }>(
      'SELECT id FROM trading_accounts WHERE id = ? AND retired_at IS NULL',
      [id],
    );
    if (!existing) return false;
    const references = await getDatabase().get<any>(
      `SELECT
         (SELECT COUNT(*) FROM trading_routes WHERE account_id = ?) AS routes,
         (SELECT COUNT(*) FROM workflow_execution_paths AS path
            JOIN workflow_active_revision AS active ON active.revision_id = path.workflow_revision_id
            WHERE active.singleton_id = 1 AND path.account_id = ?) AS active_paths,
         (SELECT COUNT(*) FROM trading_trade_intents
            WHERE account_id = ? AND status IN ('pending', 'planned', 'submitting', 'monitoring', 'unknown')) AS active_intents,
         (SELECT COUNT(*) FROM trading_positions
            WHERE account_id = ? AND status IN ('opening', 'open', 'closing', 'emergency') AND quantity <> '0') AS active_positions`,
      [id, id, id, id],
    );
    assertTradingAccountRemovalSafe(references || {});
    let result;
    try {
      result = await getDatabase().run('DELETE FROM trading_accounts WHERE id = ?', [id]);
    } catch (error) {
      if (isForeignKeyConstraint(error)) {
        result = await getDatabase().run(
          `UPDATE trading_accounts
           SET status = 'disabled', enabled = 0, external_account_id = NULL,
               kill_switch_active = 0, kill_switch_reason = NULL,
               last_error = NULL, retired_at = ?, updated_at = ?
           WHERE id = ? AND retired_at IS NULL`,
          [Date.now(), Date.now(), id],
        );
      } else {
        throw error;
      }
    }
    const deleted = Number(result.changes || 0) === 1;
    if (deleted) await clearWorkflowBuilderHistory('trading account deleted');
    return deleted;
  });
}

export async function getTradingOperationalSnapshot(): Promise<{
  executionEnabled: boolean;
  liveTradingEnabled: boolean;
  killSwitchActive: boolean;
  enabledRoutes: number;
  openPositions: number;
  pendingIntents: number;
  unknownOrders: number;
  unprotectedPositions: number;
  unacknowledgedCriticalRiskEvents: number;
  intentCount: number;
  fillCount: number;
  latestReconciliationAt: number | null;
}> {
  const [runtime, values] = await Promise.all([
    getTradingRuntimeState(),
    getDatabase().get<any>(`SELECT
      (CASE WHEN EXISTS (SELECT 1 FROM workflow_active_revision WHERE singleton_id = 1)
        THEN (SELECT COUNT(*) FROM workflow_execution_paths AS path
              JOIN workflow_active_revision AS active ON active.revision_id = path.workflow_revision_id
              WHERE active.singleton_id = 1 AND path.enabled = 1)
        ELSE (SELECT COUNT(*) FROM trading_routes WHERE enabled = 1)
       END) AS enabled_routes,
      (SELECT COUNT(*) FROM trading_positions WHERE status IN ('opening', 'open', 'closing', 'emergency') AND quantity <> '0') AS open_positions,
      (SELECT COUNT(*) FROM trading_trade_intents WHERE status IN ('pending', 'planned', 'submitting', 'monitoring')) AS pending_intents,
      (SELECT COUNT(*) FROM trading_orders WHERE status = 'unknown') AS unknown_orders,
      (SELECT COUNT(*) FROM trading_risk_events WHERE severity = 'critical' AND acknowledged_at IS NULL) AS critical_risk,
      (SELECT COUNT(*) FROM trading_trade_intents) AS intent_count,
      (SELECT COUNT(*) FROM trading_fills) AS fill_count,
      (SELECT MAX(completed_at) FROM trading_reconciliation_runs WHERE status = 'succeeded') AS latest_reconciliation`),
  ]);
  return {
    executionEnabled: runtime.executionEnabled,
    liveTradingEnabled: runtime.liveTradingEnabled,
    killSwitchActive: runtime.killSwitchActive,
    enabledRoutes: numeric(values?.enabled_routes),
    openPositions: numeric(values?.open_positions),
    pendingIntents: numeric(values?.pending_intents),
    unknownOrders: numeric(values?.unknown_orders),
    unprotectedPositions: await countUnprovedProtection(),
    unacknowledgedCriticalRiskEvents: numeric(values?.critical_risk),
    intentCount: numeric(values?.intent_count),
    fillCount: numeric(values?.fill_count),
    latestReconciliationAt: nullableNumeric(values?.latest_reconciliation),
  };
}
