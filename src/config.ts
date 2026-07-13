import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const configPath = path.join(__dirname, '../config.json');

export interface Config {
  apiId: number;
  apiHash: string;
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
    timeout?: number;
  };
  dupeBlocker: {
    enabled: boolean;
    cooldownHours: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  apiId: 0,
  apiHash: "YOUR_API_HASH_HERE",
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
    sourceTemplates: {}
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
  
  // apiHash validieren: muss 32-stelliger Hex-String sein (oder Platzhalter)
  if (cfg.apiHash && cfg.apiHash !== 'YOUR_API_HASH_HERE') {
    const trimmedHash = String(cfg.apiHash).trim();
    if (!/^[a-f0-9]{32}$/i.test(trimmedHash)) {
      console.warn(`[WARN] apiHash hat kein gültiges Format (32 hex chars erwartet). Aktuell: "${trimmedHash.slice(0, 40)}..."`);
    } else {
      cfg.apiHash = trimmedHash;
    }
  }

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
