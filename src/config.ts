import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const configPath = path.join(__dirname, '../config.json');

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
    blockedKeywords: string[];
    allowedTypes: string[];
    regexPatterns: string[];
  };
  sourceFilters: Record<string, { regexPatterns?: string[] }>;
  sourceAliases: Record<string, string>;
  xmlParsing: {
    enabled: boolean;
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
    saveToFile: true,
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
  const isUsername = /^@[a-zA-Z0-9_]{5,32}$/.test(clean);
  return isNumeric || isUsername;
}

/**
 * Validates and sanitizes config properties.
 */
export function validateConfig(cfg: any): Config {
  // 0 means not configured yet; any configured apiId must be a safe positive integer.
  if (cfg.apiId !== undefined) {
    const parsed = Number(cfg.apiId);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      console.warn(`[WARN] Ungültige apiId "${cfg.apiId}" in config.json. Setze auf 0 zurück.`);
      cfg.apiId = 0;
    } else {
      cfg.apiId = parsed;
    }
  }
  
  delete cfg.apiHash;

  if (!cfg.forwardOptions || typeof cfg.forwardOptions !== 'object') {
    cfg.forwardOptions = {};
  }
  const maxConcurrency = Number(cfg.forwardOptions.maxConcurrency);
  cfg.forwardOptions.maxConcurrency = Number.isSafeInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 100
    ? maxConcurrency
    : DEFAULT_CONFIG.forwardOptions.maxConcurrency;

  const queueTimeoutSeconds = Number(cfg.forwardOptions.queueTimeoutSeconds);
  cfg.forwardOptions.queueTimeoutSeconds = Number.isFinite(queueTimeoutSeconds) && queueTimeoutSeconds >= 0 && queueTimeoutSeconds <= 86400
    ? Math.floor(queueTimeoutSeconds)
    : DEFAULT_CONFIG.forwardOptions.queueTimeoutSeconds;

  if (cfg.xmlParsing) {
    for (const key of ['primaryModel', 'fallbackModel'] as const) {
      const value = String(cfg.xmlParsing[key] || '').trim();
      cfg.xmlParsing[key] = /^[a-zA-Z0-9._:/-]{1,128}$/.test(value)
        ? value
        : DEFAULT_CONFIG.xmlParsing[key];
    }
    // Validate xmlParsing.sourceTemplates: must be an object with string template mappings
    if (cfg.xmlParsing.sourceTemplates && typeof cfg.xmlParsing.sourceTemplates === 'object') {
      for (const [key, value] of Object.entries(cfg.xmlParsing.sourceTemplates)) {
        if (typeof value !== 'string') {
          console.warn(`[WARN] xmlParsing.sourceTemplates["${key}"] ist kein gültiger String. Wird entfernt.`);
          delete cfg.xmlParsing.sourceTemplates[key];
        }
      }
    } else {
      cfg.xmlParsing.sourceTemplates = {};
    }

    if (!cfg.xmlParsing.aiLimits || typeof cfg.xmlParsing.aiLimits !== 'object') {
      cfg.xmlParsing.aiLimits = { ...DEFAULT_CONFIG.xmlParsing.aiLimits };
    }
    const aiLimitRanges: Record<keyof Config['xmlParsing']['aiLimits'], [number, number]> = {
      maxInputChars: [100, 100_000],
      maxOutputTokens: [128, 8_192],
      primaryAttempts: [1, 3],
      fallbackAttempts: [0, 2],
      dailyRequestLimit: [1, 10_000],
      dailyTokenLimit: [1_000, 100_000_000],
      requestTimeoutMs: [1_000, 300_000],
      backoffMs: [0, 10_000]
    };
    for (const [key, [minimum, maximum]] of Object.entries(aiLimitRanges) as Array<[
      keyof Config['xmlParsing']['aiLimits'],
      [number, number]
    ]>) {
      const value = Number(cfg.xmlParsing.aiLimits[key]);
      cfg.xmlParsing.aiLimits[key] = Number.isSafeInteger(value) && value >= minimum && value <= maximum
        ? value
        : DEFAULT_CONFIG.xmlParsing.aiLimits[key];
    }
  }

  // Validate sourceFilters: must be an object with valid regexPatterns arrays
  if (cfg.sourceFilters && typeof cfg.sourceFilters === 'object') {
    for (const [key, value] of Object.entries(cfg.sourceFilters)) {
      if (!value || typeof value !== 'object') {
        console.warn(`[WARN] sourceFilters["${key}"] ist kein gültiges Objekt. Wird entfernt.`);
        delete cfg.sourceFilters[key];
      } else if ((value as any).regexPatterns && !Array.isArray((value as any).regexPatterns)) {
        console.warn(`[WARN] sourceFilters["${key}"].regexPatterns ist kein Array. Wird auf [] zurückgesetzt.`);
        (value as any).regexPatterns = [];
      }
    }
  } else {
    cfg.sourceFilters = {};
  }

  // Validate sourceAliases: must be an object with string values
  if (cfg.sourceAliases && typeof cfg.sourceAliases === 'object') {
    for (const [key, value] of Object.entries(cfg.sourceAliases)) {
      if (typeof value !== 'string') {
        console.warn(`[WARN] sourceAliases["${key}"] ist kein gültiger String. Wird entfernt.`);
        delete cfg.sourceAliases[key];
      }
    }
  } else {
    cfg.sourceAliases = {};
  }

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
  const temporary = temporaryConfigPath(destination);
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(serializedConfig(cfg), 'utf-8');
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
  const temporary = temporaryConfigPath(destination);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serializedConfig(cfg), 'utf-8');
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
