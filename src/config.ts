import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withManagedConfigurationWrite, withManagedConfigurationWriteSync } from './backup_generation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function configurationPathFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CONFIG_PATH?.trim() || path.join(__dirname, '../config.json'));
}

export const configPath = configurationPathFromEnvironment();

function serializedConfig(cfg: Config): string {
  const validated = validateConfig(structuredClone(cfg));
  return `${JSON.stringify(validated, null, 2)}\n`;
}

function temporaryConfigPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`
  );
}

function syncParentDirectorySync(destination: string): void {
  let directory: number | undefined;
  try {
    directory = fs.openSync(path.dirname(destination), 'r');
    fs.fsyncSync(directory);
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

async function syncParentDirectory(destination: string): Promise<void> {
  let directory: fsPromises.FileHandle | undefined;
  try {
    directory = await fsPromises.open(path.dirname(destination), 'r');
    await directory.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await directory?.close();
  }
}

export interface Config {
  apiId: number;
  sourceChannels: string[];
  targetChannel: string;
  forwardOptions: {
    sendCopy: boolean;
    removeCaption: boolean;
    maxConcurrency?: number;
    forwardToTarget?: boolean;
    queueTimeoutSeconds?: number;
  };
  filters: {
    allowedKeywords?: string[];
    blockedKeywords: string[];
    allowedTypes: string[];
    regexPatterns: string[];
  };
  sourceFilters: Record<string, { regexPatterns?: string[] }>;
  sourceAliases: Record<string, string>;
  xmlParsing: {
    enabled: boolean;
    externalDataPolicyAccepted: boolean;
    saveToFile: boolean;
    forwardXmlToTarget: boolean;
    signalsDir: string;
    sourceTemplates: Record<string, string>;
    primaryModel: string;
    fallbackModel: string;
    timeout?: number;
    aiLimits: {
      maxInputChars: number;
      maxOutputTokens: number;
      primaryAttempts: number;
      fallbackAttempts: number;
      dailyRequestLimit: number;
      dailyTokenLimit: number;
      requestTimeoutMs: number;
      backoffMs: number;
    };
  };
  dupeBlocker: {
    enabled: boolean;
    cooldownHours: number;
  };
}

export interface SourceResolution {
  configured: string;
  canonicalId: string;
}

export interface CanonicalizedSourceConfig {
  config: Config;
  changed: boolean;
}

export const DEFAULT_CONFIG: Config = {
  apiId: 0,
  sourceChannels: [],
  targetChannel: "",
  forwardOptions: {
    sendCopy: false,
    removeCaption: false,
    maxConcurrency: 2,
    forwardToTarget: true,
    queueTimeoutSeconds: 60
  },
  filters: {
    blockedKeywords: [],
    allowedTypes: [],
    regexPatterns: []
  },
  sourceFilters: {},
  sourceAliases: {},
  xmlParsing: {
    enabled: false,
    externalDataPolicyAccepted: false,
    saveToFile: false,
    forwardXmlToTarget: false,
    signalsDir: './signals',
    sourceTemplates: {},
    primaryModel: 'google/gemini-flash-1.5',
    fallbackModel: 'anthropic/claude-3-haiku',
    aiLimits: {
      maxInputChars: 12_000,
      maxOutputTokens: 1_200,
      primaryAttempts: 2,
      fallbackAttempts: 1,
      dailyRequestLimit: 200,
      dailyTokenLimit: 250_000,
      requestTimeoutMs: 30_000,
      backoffMs: 500
    }
  },
  dupeBlocker: {
    enabled: false,
    cooldownHours: 24
  }
};

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function remapSourceScopedValues<T>(
  values: Record<string, T>,
  resolutionByConfigured: Map<string, string>,
  canonicalIds: Set<string>,
  fieldName: string
): Record<string, T> {
  const remapped: Record<string, T> = {};
  for (const [sourceKey, value] of Object.entries(values || {})) {
    const canonicalId = resolutionByConfigured.get(sourceKey)
      || (canonicalIds.has(sourceKey) ? sourceKey : undefined);
    if (!canonicalId) {
      throw new Error(`${fieldName}["${sourceKey}"] does not match a configured Telegram source.`);
    }
    if (canonicalId in remapped && !sameJsonValue(remapped[canonicalId], value)) {
      throw new Error(`${fieldName} contains conflicting values for canonical source ${canonicalId}.`);
    }
    remapped[canonicalId] = value;
  }
  return remapped;
}

function validateSourceResolutions(
  sourceChannels: string[],
  resolutions: SourceResolution[]
): { resolutionByConfigured: Map<string, string>; canonicalIds: Set<string> } {
  if (resolutions.length !== sourceChannels.length) {
    throw new Error('Every configured Telegram source must have exactly one resolution.');
  }
  const configuredSources = new Set(sourceChannels);
  if (configuredSources.size !== sourceChannels.length) {
    throw new Error('Duplicate configured Telegram sources are not allowed.');
  }

  const resolutionByConfigured = new Map<string, string>();
  const canonicalIds = new Set<string>();
  for (const resolution of resolutions) {
    const configured = String(resolution.configured || '').trim();
    const canonicalId = String(resolution.canonicalId || '').trim();
    if (!configuredSources.has(configured)) {
      throw new Error(`Resolution for unknown Telegram source ${configured || '<empty>'}.`);
    }
    if (resolutionByConfigured.has(configured)) {
      throw new Error(`Telegram source ${configured} was resolved more than once.`);
    }
    if (!/^-?\d+$/.test(canonicalId)) {
      throw new Error(`Telegram source ${configured} resolved to an invalid numeric chat id.`);
    }
    if (canonicalIds.has(canonicalId)) {
      throw new Error(`Multiple configured Telegram sources resolve to canonical chat id ${canonicalId}.`);
    }
    resolutionByConfigured.set(configured, canonicalId);
    canonicalIds.add(canonicalId);
  }
  for (const configured of sourceChannels) {
    if (!resolutionByConfigured.has(configured)) {
      throw new Error(`Telegram source ${configured} was not resolved.`);
    }
  }
  return { resolutionByConfigured, canonicalIds };
}

export function canonicalizeResolvedSources(
  input: Config,
  resolutions: SourceResolution[]
): CanonicalizedSourceConfig {
  const config = structuredClone(input);
  const { resolutionByConfigured, canonicalIds } = validateSourceResolutions(
    config.sourceChannels,
    resolutions
  );

  config.sourceFilters = remapSourceScopedValues(
    config.sourceFilters,
    resolutionByConfigured,
    canonicalIds,
    'sourceFilters'
  );
  config.sourceAliases = remapSourceScopedValues(
    config.sourceAliases,
    resolutionByConfigured,
    canonicalIds,
    'sourceAliases'
  );
  config.xmlParsing.sourceTemplates = remapSourceScopedValues(
    config.xmlParsing.sourceTemplates,
    resolutionByConfigured,
    canonicalIds,
    'xmlParsing.sourceTemplates'
  );

  for (const [configured, canonicalId] of resolutionByConfigured) {
    if (configured.startsWith('@') && !config.sourceAliases[canonicalId]) {
      config.sourceAliases[canonicalId] = configured;
    }
  }
  config.sourceChannels = input.sourceChannels.map(source => resolutionByConfigured.get(source)!);

  return {
    config,
    changed: JSON.stringify(config) !== JSON.stringify(input)
  };
}

/**
 * Validates the target channel format without using hardcoded magic strings.
 * Ensures the value is a valid Telegram ID (numeric) or a public username (starts with @).
 */
export function isValidTargetChannel(channel: unknown): boolean {
  if (typeof channel !== 'string') return false;
  const clean = channel.trim();
  if (!clean) return false;
  
  const isNumeric = /^-?\d+$/.test(clean);
  const isUsername = /^@\w{5,32}$/.test(clean);
  return isNumeric || isUsername;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeApiId(cfg: Record<string, any>): void {
  if (cfg.apiId === undefined) return;
  const parsed = Number(cfg.apiId);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn(`[WARN] Invalid apiId "${cfg.apiId}" in config.json. Resetting to 0.`);
    cfg.apiId = 0;
    return;
  }
  cfg.apiId = parsed;
}

function normalizeForwardOptions(cfg: Record<string, any>): void {
  if (!isRecord(cfg.forwardOptions)) cfg.forwardOptions = {};
  const maxConcurrency = Number(cfg.forwardOptions.maxConcurrency);
  cfg.forwardOptions.maxConcurrency =
    Number.isSafeInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 100
      ? maxConcurrency
      : DEFAULT_CONFIG.forwardOptions.maxConcurrency;
  const queueTimeoutSeconds = Number(cfg.forwardOptions.queueTimeoutSeconds);
  cfg.forwardOptions.queueTimeoutSeconds =
    Number.isFinite(queueTimeoutSeconds) &&
    queueTimeoutSeconds >= 0 &&
    queueTimeoutSeconds <= 86_400
      ? Math.floor(queueTimeoutSeconds)
      : DEFAULT_CONFIG.forwardOptions.queueTimeoutSeconds;
}

function normalizeModelNames(xmlParsing: Record<string, any>): void {
  for (const key of ['primaryModel', 'fallbackModel'] as const) {
    const value = String(xmlParsing[key] || '').trim();
    xmlParsing[key] = /^[a-zA-Z0-9._:/-]{1,128}$/.test(value)
      ? value
      : DEFAULT_CONFIG.xmlParsing[key];
  }
}

function normalizeSourceTemplates(xmlParsing: Record<string, any>): void {
  if (!isRecord(xmlParsing.sourceTemplates)) {
    xmlParsing.sourceTemplates = {};
    return;
  }
  for (const [key, value] of Object.entries(xmlParsing.sourceTemplates)) {
    if (typeof value !== 'string') {
      console.warn(`[WARN] xmlParsing.sourceTemplates["${key}"] is not a string and was removed.`);
      delete xmlParsing.sourceTemplates[key];
    }
  }
}

const AI_LIMIT_RANGES: Record<keyof Config['xmlParsing']['aiLimits'], [number, number]> = {
  maxInputChars: [100, 100_000],
  maxOutputTokens: [128, 8_192],
  primaryAttempts: [1, 3],
  fallbackAttempts: [0, 2],
  dailyRequestLimit: [1, 10_000],
  dailyTokenLimit: [1_000, 100_000_000],
  requestTimeoutMs: [1_000, 300_000],
  backoffMs: [0, 10_000],
};

function normalizeAiLimits(xmlParsing: Record<string, any>): void {
  if (!isRecord(xmlParsing.aiLimits)) {
    xmlParsing.aiLimits = { ...DEFAULT_CONFIG.xmlParsing.aiLimits };
  }
  for (const [key, [minimum, maximum]] of Object.entries(AI_LIMIT_RANGES) as Array<[
    keyof Config['xmlParsing']['aiLimits'],
    [number, number],
  ]>) {
    const value = Number(xmlParsing.aiLimits[key]);
    xmlParsing.aiLimits[key] =
      Number.isSafeInteger(value) && value >= minimum && value <= maximum
        ? value
        : DEFAULT_CONFIG.xmlParsing.aiLimits[key];
  }
}

function normalizeXmlParsing(cfg: Record<string, any>): void {
  if (!isRecord(cfg.xmlParsing)) cfg.xmlParsing = structuredClone(DEFAULT_CONFIG.xmlParsing);
  normalizeModelNames(cfg.xmlParsing);
  normalizeSourceTemplates(cfg.xmlParsing);
  normalizeAiLimits(cfg.xmlParsing);
}

export function ensureQueueCoversParserTimeout(cfg: Record<string, any>): void {
  if (!isRecord(cfg.forwardOptions) || !isRecord(cfg.xmlParsing?.aiLimits)) return;
  if (cfg.xmlParsing.enabled !== true) return;
  const parserMs = Number(cfg.xmlParsing.aiLimits.requestTimeoutMs);
  const queueSeconds = Number(cfg.forwardOptions.queueTimeoutSeconds);
  if (!Number.isSafeInteger(parserMs) || !Number.isSafeInteger(queueSeconds) || queueSeconds <= 0) return;
  const minimumSeconds = Math.ceil((parserMs + 5_000) / 1000);
  if (queueSeconds < minimumSeconds) {
    console.warn(
      `[WARN] forwardOptions.queueTimeoutSeconds raised to ${minimumSeconds} so AI parser timeouts can complete.`
    );
    cfg.forwardOptions.queueTimeoutSeconds = minimumSeconds;
  }
}

function normalizeSourceFilters(cfg: Record<string, any>): void {
  if (!isRecord(cfg.sourceFilters)) {
    cfg.sourceFilters = {};
    return;
  }
  for (const [key, value] of Object.entries(cfg.sourceFilters)) {
    if (!isRecord(value)) {
      console.warn(`[WARN] sourceFilters["${key}"] is not an object and was removed.`);
      delete cfg.sourceFilters[key];
    } else if (value.regexPatterns && !Array.isArray(value.regexPatterns)) {
      console.warn(`[WARN] sourceFilters["${key}"].regexPatterns is not an array and was reset.`);
      value.regexPatterns = [];
    }
  }
}

function normalizeSourceAliases(cfg: Record<string, any>): void {
  if (!isRecord(cfg.sourceAliases)) {
    cfg.sourceAliases = {};
    return;
  }
  for (const [key, value] of Object.entries(cfg.sourceAliases)) {
    if (typeof value !== 'string') {
      console.warn(`[WARN] sourceAliases["${key}"] is not a string and was removed.`);
      delete cfg.sourceAliases[key];
    }
  }
}

function validateOptionalBoolean(container: Record<string, any>, key: string, qualifiedName: string): void {
  if (container[key] !== undefined && typeof container[key] !== 'boolean') {
    throw new Error(`${qualifiedName} must be true or false.`);
  }
}

function validateOptionalStringArray(value: unknown, qualifiedName: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${qualifiedName} must be an array of strings.`);
  }
}

function assertKnownKeys(container: Record<string, any>, allowed: readonly string[], qualifiedName: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(container).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`Unknown ${qualifiedName} field(s): ${unknown.join(', ')}.`);
}

function validateSideEffectContracts(cfg: Record<string, any>): void {
  assertKnownKeys(cfg, [
    'apiId', 'apiHash', 'sourceChannels', 'targetChannel', 'forwardOptions', 'filters',
    'sourceFilters', 'sourceAliases', 'xmlParsing', 'dupeBlocker',
  ], 'configuration');
  validateOptionalStringArray(cfg.sourceChannels, 'sourceChannels');
  if (cfg.targetChannel !== undefined && typeof cfg.targetChannel !== 'string') {
    throw new Error('targetChannel must be a string.');
  }
  if (isRecord(cfg.forwardOptions)) {
    assertKnownKeys(cfg.forwardOptions, [
      'sendCopy', 'removeCaption', 'maxConcurrency', 'forwardToTarget', 'queueTimeoutSeconds',
    ], 'forwardOptions');
    validateOptionalBoolean(cfg.forwardOptions, 'sendCopy', 'forwardOptions.sendCopy');
    validateOptionalBoolean(cfg.forwardOptions, 'removeCaption', 'forwardOptions.removeCaption');
    validateOptionalBoolean(cfg.forwardOptions, 'forwardToTarget', 'forwardOptions.forwardToTarget');
  }
  if (isRecord(cfg.xmlParsing)) {
    assertKnownKeys(cfg.xmlParsing, [
      'enabled', 'externalDataPolicyAccepted', 'saveToFile', 'forwardXmlToTarget', 'signalsDir', 'sourceTemplates',
      'primaryModel', 'fallbackModel', 'timeout', 'aiLimits',
    ], 'xmlParsing');
    validateOptionalBoolean(cfg.xmlParsing, 'enabled', 'xmlParsing.enabled');
    validateOptionalBoolean(cfg.xmlParsing, 'externalDataPolicyAccepted', 'xmlParsing.externalDataPolicyAccepted');
    validateOptionalBoolean(cfg.xmlParsing, 'saveToFile', 'xmlParsing.saveToFile');
    validateOptionalBoolean(cfg.xmlParsing, 'forwardXmlToTarget', 'xmlParsing.forwardXmlToTarget');
  }
  if (isRecord(cfg.dupeBlocker)) {
    assertKnownKeys(cfg.dupeBlocker, ['enabled', 'cooldownHours'], 'dupeBlocker');
    validateOptionalBoolean(cfg.dupeBlocker, 'enabled', 'dupeBlocker.enabled');
  }
  if (isRecord(cfg.filters)) {
    assertKnownKeys(cfg.filters, ['allowedKeywords', 'blockedKeywords', 'allowedTypes', 'regexPatterns'], 'filters');
    validateOptionalStringArray(cfg.filters.allowedKeywords, 'filters.allowedKeywords');
    validateOptionalStringArray(cfg.filters.blockedKeywords, 'filters.blockedKeywords');
    validateOptionalStringArray(cfg.filters.allowedTypes, 'filters.allowedTypes');
    validateOptionalStringArray(cfg.filters.regexPatterns, 'filters.regexPatterns');
  }
}

/**
 * Validates and sanitizes config properties.
 */
export function validateConfig(cfg: any): Config {
  if (!isRecord(cfg)) throw new Error('Configuration root must be a JSON object.');
  validateSideEffectContracts(cfg);
  normalizeApiId(cfg);
  delete cfg.apiHash;
  normalizeForwardOptions(cfg);
  normalizeXmlParsing(cfg);
  ensureQueueCoversParserTimeout(cfg);
  normalizeSourceFilters(cfg);
  normalizeSourceAliases(cfg);
  return cfg as Config;
}

/**
 * Merges defaults into loaded configuration.
 */
export function mergeConfigDefaults(cfg: any): Config {
  const merged = {
    ...DEFAULT_CONFIG,
    ...cfg,
    forwardOptions: {
      ...DEFAULT_CONFIG.forwardOptions,
      ...cfg?.forwardOptions
    },
    filters: {
      ...DEFAULT_CONFIG.filters,
      ...cfg?.filters
    },
    sourceFilters: {
      ...DEFAULT_CONFIG.sourceFilters,
      ...cfg?.sourceFilters
    },
    sourceAliases: {
      ...DEFAULT_CONFIG.sourceAliases,
      ...cfg?.sourceAliases
    },
    xmlParsing: {
      ...DEFAULT_CONFIG.xmlParsing,
      ...cfg?.xmlParsing,
      sourceTemplates: {
        ...DEFAULT_CONFIG.xmlParsing?.sourceTemplates,
        ...cfg?.xmlParsing?.sourceTemplates
      },
      aiLimits: {
        ...DEFAULT_CONFIG.xmlParsing.aiLimits,
        ...cfg?.xmlParsing?.aiLimits
      }
    },
    dupeBlocker: {
      ...DEFAULT_CONFIG.dupeBlocker,
      ...cfg?.dupeBlocker
    }
  };
  return validateConfig(merged);
}

/**
 * Reads config synchronously.
 */
export function readConfigSync(destination = configPath): Config {
  try {
    const raw = fs.readFileSync(destination, 'utf-8');
    const parsed = JSON.parse(raw);
    return mergeConfigDefaults(parsed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      writeConfigSync(DEFAULT_CONFIG, destination);
      return mergeConfigDefaults({});
    }
    throw new Error(`Failed to read configuration from ${destination}: ${error.message}`, { cause: error });
  }
}

/**
 * Reads config asynchronously.
 */
export async function readConfig(destination = configPath): Promise<Config> {
  try {
    const raw = await fsPromises.readFile(destination, 'utf-8');
    const parsed = JSON.parse(raw);
    return mergeConfigDefaults(parsed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      await writeConfig(DEFAULT_CONFIG, destination);
      return mergeConfigDefaults({});
    }
    throw new Error(`Failed to read configuration from ${destination}: ${error.message}`, { cause: error });
  }
}

/**
 * Writes config asynchronously.
 */
export async function writeConfig(cfg: Config, destination = configPath): Promise<void> {
  const content = serializedConfig(cfg);
  await withManagedConfigurationWrite(destination, destination, content, () => writeConfigFile(content, destination));
}

async function writeConfigFile(content: string, destination: string): Promise<void> {
  const temporary = temporaryConfigPath(destination);
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsPromises.rename(temporary, destination);
    await syncParentDirectory(destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Writes config synchronously.
 */
export function writeConfigSync(cfg: Config, destination = configPath): void {
  const content = serializedConfig(cfg);
  withManagedConfigurationWriteSync(destination, destination, content, () => writeConfigFileSync(content, destination));
}

function writeConfigFileSync(content: string, destination: string): void {
  const temporary = temporaryConfigPath(destination);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf-8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    syncParentDirectorySync(destination);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError: any) {
      if (cleanupError?.code !== 'ENOENT') console.error(`Failed to remove temporary config ${temporary}: ${cleanupError.message}`);
    }
    throw error;
  }
}
