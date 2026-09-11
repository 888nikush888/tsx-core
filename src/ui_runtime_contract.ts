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

const RUNTIME_GROUP_PREFIXES: ReadonlyArray<[string, string]> = [
  ['backup', 'Backups / Offsite'], ['data', 'Aufbewahrung'],
];
const RUNTIME_GROUP_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^(dashboard|tailscale|oidc|enterprise)/, 'Authentifizierung'],
  [/^(audit|alert)/, 'Audit / Benachrichtigungen'],
];

export function runtimeFieldGroup(key: string): string {
  for (const [prefix, group] of RUNTIME_GROUP_PREFIXES) if (key.startsWith(prefix)) return group;
  for (const [pattern, group] of RUNTIME_GROUP_PATTERNS) if (pattern.test(key)) return group;
  if (key === 'jsonLogging') return 'Beobachtbarkeit';
  return 'Laufzeit';
}

const RUNTIME_UNIT_SUFFIXES: ReadonlyArray<[string, string]> = [
  ['Ms', 'ms'], ['Seconds', 's'], ['Days', 'Tage'], ['Bytes', 'Bytes'],
];

export function runtimeFieldUnit(key: string): string | null {
  for (const [suffix, unit] of RUNTIME_UNIT_SUFFIXES) if (key.endsWith(suffix)) return unit;
  if (/Count$|BatchSize$/.test(key)) return 'Anzahl';
  return null;
}
