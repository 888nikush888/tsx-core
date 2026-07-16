import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RuntimeSettings {
  enterpriseMode: boolean;
  dashboardAuthMode: 'token' | 'oidc';
  dashboardLocalTrust: boolean;
  dashboardAllowedOrigin: string;
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUrl: string;
  oidcAdminRole: string;
  oidcViewerRole: string;
  oidcRoleClaim: string;
  oidcMaxTokenAgeSeconds: number;
  auditWebhookUrl: string;
  alertWebhookUrl: string;
  auditRemoteRequired: boolean;
  auditWebhookTimeoutMs: number;
  alertWebhookTimeoutMs: number;
  auditLocalMaxBytes: number;
  backupOffsiteRequired: boolean;
  backupOffsiteUrlTemplate: string;
  backupOffsiteTimeoutMs: number;
  backupIntervalMs: number;
  backupRetentionCount: number;
  dataRetentionDays: number;
  dataRetentionIntervalMs: number;
  dataRetentionBatchSize: number;
  dataMinFreeBytes: number;
  deliveryConfirmTimeoutMs: number;
  shutdownGraceMs: number;
  jsonLogging: boolean;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  enterpriseMode: false,
  dashboardAuthMode: 'token',
  dashboardLocalTrust: true,
  dashboardAllowedOrigin: '',
  oidcIssuer: '',
  oidcAudience: '',
  oidcJwksUrl: '',
  oidcAdminRole: 'forwarder-admin',
  oidcViewerRole: 'forwarder-viewer',
  oidcRoleClaim: 'roles',
  oidcMaxTokenAgeSeconds: 3_600,
  auditWebhookUrl: '',
  alertWebhookUrl: '',
  auditRemoteRequired: false,
  auditWebhookTimeoutMs: 10_000,
  alertWebhookTimeoutMs: 10_000,
  auditLocalMaxBytes: 64 * 1024 * 1024,
  backupOffsiteRequired: false,
  backupOffsiteUrlTemplate: '',
  backupOffsiteTimeoutMs: 60_000,
  backupIntervalMs: 15 * 60_000,
  backupRetentionCount: 672,
  dataRetentionDays: 90,
  dataRetentionIntervalMs: 6 * 60 * 60_000,
  dataRetentionBatchSize: 1_000,
  dataMinFreeBytes: 1024 * 1024 * 1024,
  deliveryConfirmTimeoutMs: 30_000,
  shutdownGraceMs: 30_000,
  jsonLogging: true,
};

const KEYS = new Set(Object.keys(DEFAULT_RUNTIME_SETTINGS));
const BOOLEAN_SETTING_NAMES = [
  'enterpriseMode',
  'dashboardLocalTrust',
  'auditRemoteRequired',
  'backupOffsiteRequired',
  'jsonLogging',
] as const;

type RuntimeSettingsRecord = Record<string, unknown>;

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function text(value: unknown, name: string, maximum = 2048): string {
  if (typeof value !== 'string' || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function webUrl(value: unknown, name: string, required = false): string {
  const normalized = text(value, name);
  if (!normalized) {
    if (required) throw new Error(`${name} is required.`);
    return '';
  }
  const candidate = normalized.replace('{artifact}', 'artifact');
  const parsed = new URL(candidate);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`${name} must not contain credentials or a fragment.`);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS except for loopback testing.`);
  }
  return normalized;
}

function identifier(value: unknown, name: string): string {
  const normalized = text(value, name, 256);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function webOrigin(value: unknown): string {
  const normalized = webUrl(value, 'dashboardAllowedOrigin');
  if (!normalized) return '';
  const parsed = new URL(normalized);
  if (parsed.pathname !== '/' || parsed.search) {
    throw new Error('dashboardAllowedOrigin must contain only scheme, host and optional port.');
  }
  return parsed.origin;
}

function mergeRuntimeSettings(input: unknown): RuntimeSettingsRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Runtime settings must be a JSON object.');
  const source = input as RuntimeSettingsRecord;
  const unknown = Object.keys(source).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Unknown runtime setting(s): ${unknown.join(', ')}.`);
  return { ...DEFAULT_RUNTIME_SETTINGS, ...source } as RuntimeSettingsRecord;
}

function validateBooleanSettings(settings: RuntimeSettingsRecord): void {
  for (const name of BOOLEAN_SETTING_NAMES) {
    if (typeof settings[name] !== 'boolean') throw new Error(`${name} must be true or false.`);
  }
}

function validatedDashboardAuthMode(value: unknown): RuntimeSettings['dashboardAuthMode'] {
  if (value !== 'token' && value !== 'oidc') throw new Error('dashboardAuthMode must be token or oidc.');
  return value;
}

function validateEnterpriseProfile(
  settings: RuntimeSettingsRecord,
  enterprise: boolean,
  dashboardAuthMode: RuntimeSettings['dashboardAuthMode']
): void {
  if (enterprise && dashboardAuthMode !== 'oidc') throw new Error('Enterprise mode requires OIDC dashboard authentication.');
  if (enterprise && settings.dashboardLocalTrust !== false) throw new Error('Enterprise mode must disable trusted local dashboard startup.');
  if (enterprise && settings.auditRemoteRequired !== true) throw new Error('Enterprise mode requires remote audit delivery.');
  if (enterprise && settings.backupOffsiteRequired !== true) throw new Error('Enterprise mode requires off-site backup replication.');
}

function validatedBackupUrl(settings: RuntimeSettingsRecord, enterprise: boolean): string {
  const required = enterprise || settings.backupOffsiteRequired === true;
  const backupUrl = webUrl(settings.backupOffsiteUrlTemplate, 'backupOffsiteUrlTemplate', required);
  if (backupUrl && (backupUrl.match(/\{artifact\}/g) || []).length !== 1) {
    throw new Error('backupOffsiteUrlTemplate must contain exactly one {artifact} placeholder.');
  }
  return backupUrl;
}

interface ValidatedOidcSettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
  roleClaim: string;
}

function validatedOidcSettings(
  settings: RuntimeSettingsRecord,
  enterprise: boolean,
  dashboardAuthMode: RuntimeSettings['dashboardAuthMode']
): ValidatedOidcSettings {
  const required = enterprise || dashboardAuthMode === 'oidc';
  const roleClaim = identifier(settings.oidcRoleClaim, 'oidcRoleClaim');
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(roleClaim)) throw new Error('oidcRoleClaim is invalid.');
  if (required) {
    return {
      issuer: webUrl(settings.oidcIssuer, 'oidcIssuer', true),
      audience: identifier(settings.oidcAudience, 'oidcAudience'),
      jwksUrl: webUrl(settings.oidcJwksUrl, 'oidcJwksUrl', true),
      roleClaim,
    };
  }
  return {
    issuer: text(settings.oidcIssuer, 'oidcIssuer'),
    audience: text(settings.oidcAudience, 'oidcAudience', 256),
    jwksUrl: text(settings.oidcJwksUrl, 'oidcJwksUrl'),
    roleClaim,
  };
}

export function validateRuntimeSettings(input: unknown): RuntimeSettings {
  const merged = mergeRuntimeSettings(input);
  validateBooleanSettings(merged);
  const enterprise = merged.enterpriseMode as boolean;
  const dashboardAuthMode = validatedDashboardAuthMode(merged.dashboardAuthMode);
  validateEnterpriseProfile(merged, enterprise, dashboardAuthMode);
  const backupUrl = validatedBackupUrl(merged, enterprise);
  const oidc = validatedOidcSettings(merged, enterprise, dashboardAuthMode);
  if (merged.oidcAdminRole === merged.oidcViewerRole) {
    throw new Error('oidcAdminRole and oidcViewerRole must be different.');
  }
  const remoteAuditRequired = enterprise || merged.auditRemoteRequired === true;
  return {
    enterpriseMode: enterprise,
    dashboardAuthMode,
    dashboardLocalTrust: merged.dashboardLocalTrust as boolean,
    dashboardAllowedOrigin: webOrigin(merged.dashboardAllowedOrigin),
    oidcIssuer: oidc.issuer,
    oidcAudience: oidc.audience,
    oidcJwksUrl: oidc.jwksUrl,
    oidcAdminRole: identifier(merged.oidcAdminRole, 'oidcAdminRole'),
    oidcViewerRole: identifier(merged.oidcViewerRole, 'oidcViewerRole'),
    oidcRoleClaim: oidc.roleClaim,
    oidcMaxTokenAgeSeconds: integer(merged.oidcMaxTokenAgeSeconds, 'oidcMaxTokenAgeSeconds', 60, 86_400),
    auditWebhookUrl: webUrl(merged.auditWebhookUrl, 'auditWebhookUrl', remoteAuditRequired),
    alertWebhookUrl: webUrl(merged.alertWebhookUrl, 'alertWebhookUrl', enterprise),
    auditRemoteRequired: merged.auditRemoteRequired as boolean,
    auditWebhookTimeoutMs: integer(merged.auditWebhookTimeoutMs, 'auditWebhookTimeoutMs', 1_000, 30_000),
    alertWebhookTimeoutMs: integer(merged.alertWebhookTimeoutMs, 'alertWebhookTimeoutMs', 1_000, 60_000),
    auditLocalMaxBytes: integer(merged.auditLocalMaxBytes, 'auditLocalMaxBytes', 1024 * 1024, 1024 * 1024 * 1024),
    backupOffsiteRequired: merged.backupOffsiteRequired as boolean,
    backupOffsiteUrlTemplate: backupUrl,
    backupOffsiteTimeoutMs: integer(merged.backupOffsiteTimeoutMs, 'backupOffsiteTimeoutMs', 1_000, 5 * 60_000),
    backupIntervalMs: integer(merged.backupIntervalMs, 'backupIntervalMs', 60_000, 15 * 60_000),
    backupRetentionCount: integer(merged.backupRetentionCount, 'backupRetentionCount', 1, 10_000),
    dataRetentionDays: integer(merged.dataRetentionDays, 'dataRetentionDays', 1, 3_650),
    dataRetentionIntervalMs: integer(merged.dataRetentionIntervalMs, 'dataRetentionIntervalMs', 300_000, 86_400_000),
    dataRetentionBatchSize: integer(merged.dataRetentionBatchSize, 'dataRetentionBatchSize', 100, 10_000),
    dataMinFreeBytes: integer(merged.dataMinFreeBytes, 'dataMinFreeBytes', 64 * 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    deliveryConfirmTimeoutMs: integer(merged.deliveryConfirmTimeoutMs, 'deliveryConfirmTimeoutMs', 1_000, 300_000),
    shutdownGraceMs: integer(merged.shutdownGraceMs, 'shutdownGraceMs', 1_000, 120_000),
    jsonLogging: merged.jsonLogging as boolean,
  };
}

const ENVIRONMENT_MAPPING: Record<keyof RuntimeSettings, string> = {
  enterpriseMode: 'ENTERPRISE_MODE',
  dashboardAuthMode: 'DASHBOARD_AUTH_MODE',
  dashboardLocalTrust: 'DASHBOARD_LOCAL_TRUST',
  dashboardAllowedOrigin: 'DASHBOARD_ALLOWED_ORIGIN',
  oidcIssuer: 'DASHBOARD_OIDC_ISSUER',
  oidcAudience: 'DASHBOARD_OIDC_AUDIENCE',
  oidcJwksUrl: 'DASHBOARD_OIDC_JWKS_URL',
  oidcAdminRole: 'DASHBOARD_OIDC_ADMIN_ROLE',
  oidcViewerRole: 'DASHBOARD_OIDC_VIEWER_ROLE',
  oidcRoleClaim: 'DASHBOARD_OIDC_ROLE_CLAIM',
  oidcMaxTokenAgeSeconds: 'DASHBOARD_OIDC_MAX_TOKEN_AGE_SECONDS',
  auditWebhookUrl: 'AUDIT_WEBHOOK_URL',
  alertWebhookUrl: 'ALERT_WEBHOOK_URL',
  auditRemoteRequired: 'AUDIT_REMOTE_REQUIRED',
  auditWebhookTimeoutMs: 'AUDIT_WEBHOOK_TIMEOUT_MS',
  alertWebhookTimeoutMs: 'ALERT_WEBHOOK_TIMEOUT_MS',
  auditLocalMaxBytes: 'AUDIT_LOCAL_MAX_BYTES',
  backupOffsiteRequired: 'BACKUP_OFFSITE_REQUIRED',
  backupOffsiteUrlTemplate: 'BACKUP_OFFSITE_URL_TEMPLATE',
  backupOffsiteTimeoutMs: 'BACKUP_OFFSITE_TIMEOUT_MS',
  backupIntervalMs: 'BACKUP_INTERVAL_MS',
  backupRetentionCount: 'BACKUP_RETENTION_COUNT',
  dataRetentionDays: 'DATA_RETENTION_DAYS',
  dataRetentionIntervalMs: 'DATA_RETENTION_INTERVAL_MS',
  dataRetentionBatchSize: 'DATA_RETENTION_BATCH_SIZE',
  dataMinFreeBytes: 'DATA_MIN_FREE_BYTES',
  deliveryConfirmTimeoutMs: 'DELIVERY_CONFIRM_TIMEOUT_MS',
  shutdownGraceMs: 'SHUTDOWN_GRACE_MS',
  jsonLogging: 'JSON_LOGGING',
};

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

export class ManagedRuntimeSettingsStore {
  private settings = structuredClone(DEFAULT_RUNTIME_SETTINGS);

  constructor(
    private readonly filePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async initialize(): Promise<void> {
    const resolved = path.resolve(this.filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
    try {
      const stats = await fs.lstat(resolved);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128 * 1024) {
        throw new Error('Runtime settings must be a small regular file.');
      }
      this.settings = validateRuntimeSettings(JSON.parse(await fs.readFile(resolved, 'utf8')));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await this.write(DEFAULT_RUNTIME_SETTINGS);
    }
  }

  snapshot(): RuntimeSettings {
    return structuredClone(this.settings);
  }

  async set(input: unknown): Promise<RuntimeSettings> {
    const candidate = validateRuntimeSettings(input);
    await this.write(candidate);
    return this.snapshot();
  }

  async reset(): Promise<void> {
    await this.write(DEFAULT_RUNTIME_SETTINGS);
  }

  applyToEnvironment(): void {
    for (const [key, environmentName] of Object.entries(ENVIRONMENT_MAPPING) as Array<[keyof RuntimeSettings, string]>) {
      const value = this.settings[key];
      if (value === '') delete this.env[environmentName];
      else this.env[environmentName] = String(value);
    }
  }

  private async write(settings: RuntimeSettings): Promise<void> {
    const destination = path.resolve(this.filePath);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
      await syncDirectory(path.dirname(destination));
      this.settings = structuredClone(settings);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function managedRuntimeSettingsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): ManagedRuntimeSettingsStore {
  return new ManagedRuntimeSettingsStore(
    env.RUNTIME_SETTINGS_PATH || path.join(process.cwd(), 'config', 'runtime-settings.json'),
    env
  );
}
