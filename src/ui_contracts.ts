/** Pure, versioned operator contracts. No runtime adapters, credentials or persistence. */
export const UI_CONTRACT_VERSION = 1;
export const TRADING_ACCOUNT_STATUSES = ['unverified', 'ready', 'degraded', 'disabled', 'error'] as const;
export const WORKFLOW_RESOURCE_KINDS = ['channel', 'content_filter', 'keyword_filter', 'regex', 'parser', 'schema', 'contract', 'dedupe', 'strategy', 'sizing', 'adaptive_risk', 'account', 'output'] as const;
export const JOURNAL_INTENT_STATUSES = ['pending', 'planned', 'submitting', 'monitoring', 'completed', 'blocked', 'failed', 'unknown'] as const;
export const TRADING_ORDER_STATUSES = ['created', 'submitting', 'open', 'partially_filled', 'filled', 'cancel_pending', 'cancelled', 'rejected', 'unknown'] as const;
export const AI_LIMIT_RANGES = {
  maxInputChars: [100, 100_000],
  maxOutputTokens: [128, 8_192],
  primaryAttempts: [1, 3],
  fallbackAttempts: [0, 2],
  dailyRequestLimit: [1, 10_000],
  dailyTokenLimit: [1_000, 100_000_000],
  requestTimeoutMs: [1_000, 300_000],
  backoffMs: [0, 10_000],
} satisfies Record<string, [number, number]>;
export const AI_LIMIT_LABELS: Record<keyof typeof AI_LIMIT_RANGES, [string, string]> = {
  maxInputChars: ['Maximale Eingabe', 'Zeichen'],
  maxOutputTokens: ['Maximale Ausgabe', 'Tokens'],
  primaryAttempts: ['Primärversuche', 'Versuche'],
  fallbackAttempts: ['Fallbackversuche', 'Versuche; 0 deaktiviert'],
  dailyRequestLimit: ['Tageslimit Anfragen', 'Anfragen pro UTC-Tag'],
  dailyTokenLimit: ['Tageslimit Tokens', 'Tokens pro UTC-Tag'],
  requestTimeoutMs: ['Globales Anfragezeitlimit', 'ms'],
  backoffMs: ['Pause zwischen Versuchen', 'ms; 0 ohne Pause'],
};
