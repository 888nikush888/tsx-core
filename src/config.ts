import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const configPath = path.join(__dirname, '../config.json');

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
  // apiId strikt validieren: muss eine positive, sichere Ganzzahl sein
  if (cfg.apiId !== undefined) {
    const parsed = parseInt(cfg.apiId, 10);
    if (isNaN(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
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
export function readConfigSync(): Config {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return DEFAULT_CONFIG;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return mergeConfigDefaults(parsed);
  } catch {
    console.error("Fehler beim Lesen der config.json. Erstelle neue Konfiguration...");
    return mergeConfigDefaults({});
  }
}

/**
 * Reads config asynchronously.
 */
export async function readConfig(): Promise<Config> {
  try {
    await fsPromises.access(configPath);
  } catch {
    await fsPromises.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return DEFAULT_CONFIG;
  }
  try {
    const raw = await fsPromises.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return mergeConfigDefaults(parsed);
  } catch {
    console.error("Fehler beim Lesen der config.json. Erstelle neue Konfiguration...");
    return mergeConfigDefaults({});
  }
}

/**
 * Writes config asynchronously.
 */
export async function writeConfig(cfg: Config): Promise<void> {
  try {
    const validated = validateConfig(cfg);
    await fsPromises.writeFile(configPath, JSON.stringify(validated, null, 2), 'utf-8');
  } catch (error: any) {
    console.error("Fehler beim Speichern der config.json:", error.message);
  }
}

/**
 * Writes config synchronously.
 */
export function writeConfigSync(cfg: Config): void {
  try {
    const validated = validateConfig(cfg);
    fs.writeFileSync(configPath, JSON.stringify(validated, null, 2), 'utf-8');
  } catch (error: any) {
    console.error("Fehler beim Speichern der config.json:", error.message);
  }
}
