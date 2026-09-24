CREATE TABLE IF NOT EXISTS incident_deliveries (
  delivery_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'retryable', 'unknown', 'delivered')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retry_after INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS incident_deliveries_expiry
  ON incident_deliveries (state, expires_at);
