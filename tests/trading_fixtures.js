import { getDatabase } from '../src/db.js';
import { BUILTIN_SIGNAL_CONTRACTS } from '../src/signal_contract.js';
import {
  createSignalContract,
  createTradingSignalSchema,
  createTradingStrategyDraft,
  listSignalContracts,
  listTradingStrategies,
  publishSignalContractVersion,
  publishTradingStrategyVersion,
} from '../src/trading_repository.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';

/**
 * Installs deterministic domain fixtures for tests that exercise populated
 * trading workflows. Production startup deliberately never calls this helper.
 */
export async function seedTradingFixtures(now = Date.now()) {
  const existingContracts = new Set((await listSignalContracts()).map(contract => contract.id));
  for (const contract of BUILTIN_SIGNAL_CONTRACTS) {
    if (existingContracts.has(contract.id)) continue;
    await createSignalContract({
      id: contract.id,
      name: contract.name,
      description: contract.description,
      definition: structuredClone(contract.definition),
    }, now);
    await publishSignalContractVersion(`${contract.id}:v1`, now);
  }

  const database = getDatabase();
  const schemaCount = Number((await database.get('SELECT COUNT(*) AS count FROM trading_signal_schemas'))?.count || 0);
  if (schemaCount === 0) {
    for (const contract of BUILTIN_SIGNAL_CONTRACTS) {
      await createTradingSignalSchema({
        id: contract.id,
        name: contract.name,
        description: contract.description,
        contractVersionId: `${contract.id}:v1`,
        templateName: contract.id === 'standard' ? 'default' : contract.id,
        enabled: true,
      }, now);
    }
  }

  if ((await listTradingStrategies()).length === 0) {
    const strategy = await createTradingStrategyDraft({
      name: 'Adaptive Signal',
      description: 'Deterministic populated-state test fixture.',
      configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
    });
    await publishTradingStrategyVersion(strategy.id, now);
  }

  await database.run(
    `INSERT OR IGNORE INTO trading_accounts (
       id, name, exchange, mode, status, enabled, credential_ref,
       last_verified_at, last_error, created_at, updated_at
     ) VALUES ('paper-default', 'Paper Trading', 'paper', 'paper', 'ready', 1, NULL, ?, NULL, ?, ?)`,
    [now, now, now],
  );
  await database.run(
    `INSERT OR IGNORE INTO trading_paper_accounts (
       account_id, equity, available_balance, realized_pnl, updated_at
     ) VALUES ('paper-default', '10000', '10000', '0', ?)`,
    [now],
  );
}
