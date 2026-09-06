// These reduced fixtures mark M9/M16 as applied, so their real old tables must exist
// before M46 rebuilds them. Do not synthesize M46 columns or economic/provenance rows.
async function completeLegacyAdaptiveFixture(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS trading_channel_risk_evaluations (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, policy_version INTEGER NOT NULL,
      week_started_at INTEGER NOT NULL, week_ended_at INTEGER NOT NULL,
      closed_trades INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL,
      realized_pnl TEXT NOT NULL, starting_equity TEXT NOT NULL, return_percent TEXT NOT NULL,
      previous_tier INTEGER NOT NULL, recommended_tier INTEGER NOT NULL, applied_tier INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('hold', 'increase', 'decrease', 'block')),
      reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(channel_id, policy_version, week_started_at)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_risk_evaluation_week
      ON trading_channel_risk_evaluations(channel_id, week_started_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_adaptive_risk_state (
      state_key TEXT PRIMARY KEY CHECK(length(state_key) = 64), channel_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
      resource_id TEXT NOT NULL, current_tier INTEGER NOT NULL CHECK(current_tier >= 0), locked_tier INTEGER,
      blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)), block_reason TEXT,
      policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64), updated_at INTEGER NOT NULL,
      UNIQUE(channel_id, account_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS workflow_adaptive_risk_evaluations (
      id TEXT PRIMARY KEY,
      state_key TEXT NOT NULL REFERENCES workflow_adaptive_risk_state(state_key) ON DELETE RESTRICT,
      policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64),
      week_started_at INTEGER NOT NULL, week_ended_at INTEGER NOT NULL,
      closed_trades INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL,
      realized_pnl TEXT NOT NULL, starting_equity TEXT NOT NULL, return_percent TEXT NOT NULL,
      previous_tier INTEGER NOT NULL, recommended_tier INTEGER NOT NULL, applied_tier INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('hold', 'increase', 'decrease', 'block')),
      reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(state_key, policy_sha256, week_started_at)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_adaptive_risk_evaluations
      ON workflow_adaptive_risk_evaluations(state_key, week_ended_at DESC);
  `);
}

/** Completes reduced v18-v24 fixtures with omitted real earlier schemas. */
export async function completeLegacyIngressFixture(database) {
  await completeLegacyAdaptiveFixture(database);
  await completeLegacyUiSources(database);
  await database.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, chat_id TEXT, message_id INTEGER, xml_content TEXT, normalized_content TEXT,
      created_at INTEGER, template_name TEXT, schema_name TEXT, prompt_sha256 TEXT, model TEXT,
      provider_request_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, parser_version TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_tasks (
      id TEXT PRIMARY KEY, type TEXT, chat_id TEXT, message_id INTEGER, message_ids TEXT, media_group_id TEXT,
      added_at INTEGER, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, last_error TEXT,
      config_json TEXT, result_json TEXT
    );
    CREATE TABLE IF NOT EXISTS incoming_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, message_id INTEGER, sender TEXT, text TEXT,
      type TEXT, status TEXT, created_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_chat_message ON incoming_messages(chat_id, message_id);
    CREATE TABLE IF NOT EXISTS ai_usage_daily (
      usage_day TEXT PRIMARY KEY, request_count INTEGER NOT NULL DEFAULT 0,
      used_tokens INTEGER NOT NULL DEFAULT 0, reserved_tokens INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_revisions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS workflow_signal_runs (
      id TEXT PRIMARY KEY, source_signal_id TEXT, workflow_revision_id TEXT
    );
    CREATE TABLE IF NOT EXISTS trading_fills (
      id TEXT PRIMARY KEY, order_id TEXT, account_id TEXT, exchange_fill_id TEXT, price TEXT, quantity TEXT,
      fee TEXT, fee_asset TEXT, filled_at INTEGER, raw_json TEXT
    );
  `);
  const additions = {
    signals: { chat_id: 'TEXT', message_id: 'INTEGER' },
    workflow_signal_runs: { source_signal_id: 'TEXT', workflow_revision_id: 'TEXT' },
    trading_trade_intents: { account_id: 'TEXT' },
    trading_orders: { account_id: 'TEXT', intent_id: 'TEXT', filled_quantity: 'TEXT', quantity: 'TEXT', role: 'TEXT',
      side: 'TEXT', reduce_only: 'INTEGER', provider_symbol: 'TEXT' },
    trading_positions: { intent_id: 'TEXT', account_id: 'TEXT', realized_pnl: 'TEXT' },
  };
  for (const [table, columns] of Object.entries(additions)) {
    const present = new Set((await database.all(`PRAGMA table_info(${table})`)).map(column => column.name));
    for (const [column, definition] of Object.entries(columns)) {
      if (!present.has(column)) await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

// M47/M48 extend these pre-existing tables; reduced historical fixtures must include them.
async function completeLegacyUiSources(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS trading_equity_snapshots (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
      equity TEXT NOT NULL, available_balance TEXT NOT NULL, unrealized_pnl TEXT NOT NULL, margin_used TEXT NOT NULL,
      observed_at INTEGER NOT NULL, bucket_minute INTEGER NOT NULL, UNIQUE(account_id, bucket_minute)
    );
    CREATE TABLE IF NOT EXISTS workflow_resource_versions (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
      kind TEXT NOT NULL CHECK(kind IN ('channel','content_filter','keyword_filter','regex','parser','schema','contract','dedupe','strategy','sizing','adaptive_risk','account','output')),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80), description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
      status TEXT NOT NULL CHECK(status IN ('draft','published','archived')), configuration_json TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256) = 64), created_at INTEGER NOT NULL,
      published_at INTEGER, archived_at INTEGER, UNIQUE(resource_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_resource_versions ON workflow_resource_versions(kind, resource_id, version DESC);
  `);
}
