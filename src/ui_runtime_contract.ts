/** Pure field contracts, consumed by validators and operator metadata. */
export const RUNTIME_INTEGER_RANGES = {
  oidcMaxTokenAgeSeconds: [60, 86_400], auditWebhookTimeoutMs: [1_000, 30_000],
  alertWebhookTimeoutMs: [1_000, 60_000], auditLocalMaxBytes: [1_048_576, 1_073_741_824],
  backupOffsiteTimeoutMs: [1_000, 300_000], backupOffsiteMaxRecoveryBytes: [1_048_576, 8_589_934_592],
  backupOffsiteRetentionDays: [0, 3_650], backupIntervalMs: [60_000, 900_000],
  backupRetentionCount: [1, 10_000], dataRetentionDays: [1, 3_650],
  dataRetentionIntervalMs: [300_000, 86_400_000], dataRetentionBatchSize: [100, 10_000],
  dataMinFreeBytes: [67_108_864, 1_099_511_627_776], deliveryConfirmTimeoutMs: [1_000, 300_000],
  shutdownGraceMs: [1_000, 120_000],
} as const;

export function runtimeFieldGroup(key: string): string {
  if (/^(dashboard|tailscale|oidc|enterprise)/.test(key)) return 'Authentifizierung';
  if (/^backup/.test(key)) return 'Backups / Offsite';
  if (/^data/.test(key)) return 'Aufbewahrung';
  if (/^(audit|alert)/.test(key)) return 'Audit / Benachrichtigungen';
  if (key === 'jsonLogging') return 'Beobachtbarkeit';
  return 'Laufzeit';
}

export function runtimeFieldUnit(key: string): string | null {
  if (key.endsWith('Ms')) return 'ms';
  if (key.endsWith('Seconds')) return 's';
  if (key.endsWith('Days')) return 'Tage';
  if (key.endsWith('Bytes')) return 'Bytes';
  if (/Count$|BatchSize$/.test(key)) return 'Anzahl';
  return null;
}
