import vm from 'node:vm';
import { types } from 'node:util';
import type { Config } from './config.js';
import { unknownErrorMessage } from './contract_values.js';

const regexCache = new Map<string, RegExp>();
const MAX_REGEX_CACHE_SIZE = 100;
type SourceChatId = string | number | null;
type FilterSettings = Partial<Config['filters']>;
type FilterConfiguration = Partial<Pick<Config, 'sourceFilters' | 'filters'>>;
export interface FilterMessage {
  id?: string | number;
  content?: {
    _?: string;
    text?: { text?: string };
    caption?: { text?: string };
  };
}

function regexErrorMessage(error: unknown): string {
  // VM timeout Errors belong to another realm and fail instanceof Error.
  if (types.isNativeError(error)) {
    const message = Object.getOwnPropertyDescriptor(error, 'message')?.value;
    if (typeof message === 'string') return message;
  }
  return unknownErrorMessage(error);
}

/**
 * Safely tests a regular expression against text using Node.js vm module
 * with a strict CPU timeout (e.g. 100ms) to protect against ReDoS.
 */
export function safeRegexTest(regex: RegExp, text: string, timeoutMs = 100): boolean {
  const sandbox = { result: false, regex, text };
  vm.createContext(sandbox);
  try {
    vm.runInContext('result = regex.test(text)', sandbox, { timeout: timeoutMs });
    return sandbox.result;
  } catch (err: unknown) {
    throw new Error(`Regex timeout oder Ausführungsfehler bei der Musterprüfung: ${regexErrorMessage(err)}`, { cause: err });
  }
}

/**
 * Clears the compiled regex cache. Call when config is reloaded.
 */
export function clearRegexCache(): void {
  regexCache.clear();
}

interface RegexGroupState {
  index: number;
  hasQuantifier: boolean;
  isSpecial: boolean;
}

function closesNestedQuantifier(pattern: string, index: number, openGroups: RegexGroupState[]): boolean {
  const group = openGroups.pop();
  if (!group?.hasQuantifier) return false;
  const nextChar = pattern[index + 1];
  return ['+', '*', '?', '{'].includes(nextChar);
}

class NestedQuantifierScanner {
  private readonly openGroups: RegexGroupState[] = [];
  private inCharacterClass = false;

  consume(pattern: string, index: number): boolean {
    const char = pattern[index];
    if (this.consumeCharacterClass(char)) return false;
    if (char === '(') {
      this.openGroups.push({ index, hasQuantifier: false, isSpecial: pattern[index + 1] === '?' });
      return false;
    }
    if (char === ')') return closesNestedQuantifier(pattern, index, this.openGroups);
    this.markGroupQuantified(char);
    return false;
  }

  private consumeCharacterClass(char: string): boolean {
    if (char === '[' && !this.inCharacterClass) {
      this.inCharacterClass = true;
      return true;
    }
    if (char === ']' && this.inCharacterClass) {
      this.inCharacterClass = false;
      return true;
    }
    return this.inCharacterClass;
  }

  private markGroupQuantified(char: string): void {
    if (!['+', '*', '{'].includes(char)) return;
    const group = this.openGroups.at(-1);
    if (group) group.hasQuantifier = true;
  }
}

/**
 * Checks if a pattern contains nested quantifiers (e.g. `(a+)+`) that might
 * result in exponential backtracking (ReDoS).
 *
 * Scope note: alternation-based ReDoS (e.g. `(a|aa)+`) is NOT detected here;
 * those cases are mitigated solely by the vm CPU timeout in safeRegexTest.
 */
export function hasNestedQuantifiers(pattern: string): boolean {
  const scanner = new NestedQuantifierScanner();

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (scanner.consume(pattern, i)) return true;
  }
  return false;
}

/**
 * Parses a regex pattern string (supporting /pattern/flags or plain text) safely.
 * Caches compiled RegExp objects and protects against ReDoS by checking for nested
 * quantifiers and limiting pattern length.
 */
export function parseRegex(patternStr: string): RegExp {
  const trimmed = patternStr.trim();
  const cached = regexCache.get(trimmed);
  if (cached) {
    return cached;
  }

  let pattern = trimmed;
  let flags = 'i';

  const match = /^\/(.+)\/([dgimsuy]*)$/.exec(trimmed);
  if (match) {
    pattern = match[1];
    flags = match[2];
  }

  // g/y make test() stateful via lastIndex; cached instances must stay stateless.
  flags = flags.replace(/[gy]/g, "");

  validateRegexPattern(pattern, patternStr);
  const regex = compileRegex(pattern, flags);
  cacheRegex(trimmed, regex);
  return regex;
}

function validateRegexPattern(pattern: string, patternStr: string): void {
  if (hasNestedQuantifiers(pattern)) {
    throw new Error(`ReDoS warning: Nested quantifiers or dangerous structures detected: "${patternStr}"`);
  }

  // Limit pattern length to prevent extremely complex/vulnerable patterns
  if (pattern.length > 150) {
    throw new Error(`Regex pattern exceeds maximum length of 150 characters: "${patternStr}"`);
  }

}

function compileRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err: unknown) {
    throw new Error(`Invalid regex pattern: ${unknownErrorMessage(err)}`, { cause: err });
  }
}

function cacheRegex(key: string, regex: RegExp): void {
  if (regexCache.size >= MAX_REGEX_CACHE_SIZE) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  regexCache.set(key, regex);
}

interface MessageTextAndType {
  text: string;
  type: string;
}

function messageText(content: NonNullable<FilterMessage['content']>, field: 'text' | 'caption' | null): string {
  return field ? (content[field]?.text || '') : '';
}

const MESSAGE_TYPES = new Map<string, { type: string; textField: 'text' | 'caption' | null }>([
  ['messageText', { type: 'text', textField: 'text' }],
  ['messagePhoto', { type: 'photo', textField: 'caption' }],
  ['messageVideo', { type: 'video', textField: 'caption' }],
  ['messageDocument', { type: 'document', textField: 'caption' }],
  ['messageAudio', { type: 'audio', textField: 'caption' }],
  ['messageVoiceNote', { type: 'voice', textField: 'caption' }],
  ['messageVideoNote', { type: 'video_note', textField: null }],
  ['messageAnimation', { type: 'animation', textField: 'caption' }],
  ['messageSticker', { type: 'sticker', textField: null }],
]);

/**
 * Extracts message text and type from a TDLib message object.
 */
export function getMessageTextAndType(message: FilterMessage): MessageTextAndType {
  const content = message.content;
  if (!content) return { text: '', type: 'unknown' };

  const contentType = content._;

  const mapping = MESSAGE_TYPES.get(contentType ?? '');
  if (!mapping) return { text: '', type: contentType || 'unknown' };

  const text = messageText(content, mapping.textField);
  return { text, type: mapping.type };
}

/**
 * Returns the regex patterns applicable for a given source channel.
 * Uses per-source patterns from config.sourceFilters if available,
 * otherwise falls back to global filters.regexPatterns.
 */
export function getRegexPatternsForSource(config: FilterConfiguration | null, sourceChatId: SourceChatId): string[] {
  if (sourceChatId) {
    const patterns = sourceRegexPatterns(config, sourceChatId);
    if (patterns) return patterns;
  }
  return globalRegexPatterns(config);
}

function sourceRegexPatterns(config: FilterConfiguration | null, sourceChatId: SourceChatId): string[] | null {
  const patterns = config?.sourceFilters?.[String(sourceChatId)]?.regexPatterns;
  return Array.isArray(patterns) ? patterns : null;
}

function globalRegexPatterns(config: FilterConfiguration | null): string[] {
  return config?.filters?.regexPatterns || [];
}

function containsKeyword(text: string, keywords: string[] | undefined): boolean {
  if (!keywords?.length) return false;
  const textLower = text.toLowerCase();
  return keywords.some(keyword => textLower.includes(keyword.toLowerCase()));
}

function allowsKeyword(text: string, keywords: string[] | undefined): boolean {
  return !keywords?.length || containsKeyword(text, keywords);
}

function resolveRegexPatterns(
  filters: FilterSettings,
  sourceChatId: string | number | null,
  config: FilterConfiguration | null
): string[] {
  return sourceChatId && config
    ? getRegexPatternsForSource(config, sourceChatId)
    : (filters.regexPatterns || []);
}

function matchesAllRegexPatterns(
  text: string,
  patterns: string[],
  logCallback: (msg: string) => void
): boolean {
  const safeMatchText = text.length > 8000 ? text.slice(0, 8000) : text;
  return patterns.every(pattern => {
    try {
      return safeRegexTest(parseRegex(pattern), safeMatchText, 100);
    } catch (err: unknown) {
      logCallback(`[Filter-FEHLER] Ungültiges Regex-Muster /${pattern}/: ${unknownErrorMessage(err)}`);
      return false;
    }
  });
}

/**
 * Filters the message based on configured allowed/blocked keywords, media types, and custom regex.
 * Includes text length limiting to prevent long match ReDoS execution times.
 */
export function shouldForward(
  message: FilterMessage,
  filters: FilterSettings | null,
  logCallback: (msg: string) => void = (_message: string) => undefined,
  sourceChatId: string | number | null = null,
  config: FilterConfiguration | null = null
): boolean {
  if (!filters) return true;
  return logFilterDecision(filterRejection(message, filters, sourceChatId, config, logCallback), logCallback);
}

function allowsMediaType(type: string, filters: FilterSettings): boolean {
  return !filters.allowedTypes?.length || filters.allowedTypes.includes(type);
}

function contentRejection(message: FilterMessage, filters: FilterSettings, text: string, type: string): string | null {
  if (!allowsMediaType(type, filters)) return `[Filter] Paket ${message.id} ignoriert (Inhaltstyp '${type}' nicht im Filter-Schema).`;
  if (containsKeyword(text, filters.blockedKeywords)) return `[Filter] Paket ${message.id} blockiert (enthält Blacklist-Signatur).`;
  if (!allowsKeyword(text, filters.allowedKeywords)) return `[Filter] Paket ${message.id} verworfen (keine erlaubte Signatur enthalten).`;
  return null;
}

function filterRejection(message: FilterMessage, filters: FilterSettings, sourceChatId: SourceChatId,
  config: FilterConfiguration | null, logCallback: (msg: string) => void): string | null {
  const { text, type } = getMessageTextAndType(message);
  const rejection = contentRejection(message, filters, text, type);
  if (rejection) return rejection;
  const regexPatterns = resolveRegexPatterns(filters, sourceChatId, config);
  if (!matchesAllRegexPatterns(text, regexPatterns, logCallback)) {
    return `[Filter] Paket ${message.id} verworfen (Regex-Kriterien nicht erfüllt).`;
  }
  return null;
}

function logFilterDecision(rejection: string | null, logCallback: (msg: string) => void): boolean {
  if (!rejection) return true;
  logCallback(rejection);
  return false;
}
