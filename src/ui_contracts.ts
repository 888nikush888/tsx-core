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

export interface UiParameter {
  path: string; type: string; unit: string | null; constraints: string;
  default: unknown; defaultPresent: boolean; nullable: boolean; emptyMeaning: string;
  source: string; scope: string; effect: string; requiresRestart: boolean;
  editable: boolean; secret: boolean; href: string; validator: string; consumer: string;
}

export const RESTORE_ELIGIBILITY_SCOPE = 'artifact-local-integrated-restore' as const;

export interface RestoreEligibility {
  status: 'eligible' | 'blocked' | 'unknown';
  scope: typeof RESTORE_ELIGIBILITY_SCOPE;
  checkedAt: number;
  reasons: string[];
}

export interface BackupProof {
  verifiedAt: number;
  artifactSha256: string;
  artifactCreatedAt: string;
}

export interface BackupOffsiteProof extends BackupProof {
  objectName: string;
  encryptedObjectSha256: string;
}

export interface BackupRestoreDrillProof {
  performedAt: number;
  artifactSha256: string;
  artifactCreatedAt: string;
  isolation: 'temporary-child-network-apis-disabled';
  osSandbox: false;
  runtimeDisabled: true;
}

/** Later receipts never rewrite the immutable artifact or its SHA identity. */
export interface BackupCreationEvidence {
  version: 1;
  integrityVerified: { verifiedAt: number };
  configurationCoherent: { verifiedAt: number } | null;
  offsiteVerified: null;
  restoreEligibility: RestoreEligibility;
  restoreDrill: null;
}

export interface BackupVerificationEvidence {
  artifactSha256: string;
  artifactCreatedAt: string;
  integrityVerified: BackupProof;
  configurationCoherent: BackupProof | null;
  configurationCoherenceReason: string | null;
  offsiteVerified: BackupOffsiteProof | null;
  restoreEligibility: RestoreEligibility & { artifactSha256: string };
  restoreDrill: BackupRestoreDrillProof | null;
}
