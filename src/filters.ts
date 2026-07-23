import vm from 'node:vm';

const regexCache = new Map<string, RegExp>();
const MAX_REGEX_CACHE_SIZE = 100;
type SourceChatId = string | number | null;

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
  } catch (err: any) {
    throw new Error(`Regex timeout oder Script-Fehler bei der Prüfung auf Duplikate: ${err.message}`, { cause: err });
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
  return nextChar === '+' || nextChar === '*' || nextChar === '?' || nextChar === '{';
}

class NestedQuantifierScanner {
  private readonly openGroups: RegexGroupState[] = [];
  private inCharacterClass = false;

  consume(pattern: string, index: number): boolean {
    const char = pattern[index];
    if (char === '[' && !this.inCharacterClass) {
      this.inCharacterClass = true;
      return false;
    }
    if (char === ']' && this.inCharacterClass) {
      this.inCharacterClass = false;
      return false;
    }
    if (this.inCharacterClass) return false;
    if (char === '(') {
      this.openGroups.push({ index, hasQuantifier: false, isSpecial: pattern[index + 1] === '?' });
      return false;
    }
    if (char === ')') return closesNestedQuantifier(pattern, index, this.openGroups);
    if ((char === '+' || char === '*' || char === '{') && this.openGroups.length > 0) {
      this.openGroups.at(-1)!.hasQuantifier = true;
    }
    return false;
  }
}

/**
 * Checks if a pattern contains nested quantifiers or dangerous alternation structures
 * that might result in exponential backtracking (ReDoS).
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
    pattern = match[1]!;
    flags = match[2]!;
  }

  // Reject dangerous patterns
  if (hasNestedQuantifiers(pattern)) {
    throw new Error(`ReDoS warning: Nested quantifiers or dangerous structures detected: "${patternStr}"`);
  }

  // Limit pattern length to prevent extremely complex/vulnerable patterns
  if (pattern.length > 150) {
    throw new Error(`Regex pattern exceeds maximum length of 150 characters: "${patternStr}"`);
  }

  try {
    const regex = new RegExp(pattern, flags);
    // Eviction: Cache leeren wenn Limit überschritten, um Memory Leaks zu verhindern
    if (regexCache.size >= MAX_REGEX_CACHE_SIZE) {
      regexCache.clear();
    }
    regexCache.set(trimmed, regex);
    return regex;
  } catch (err: any) {
    throw new Error(`Invalid regex pattern: ${err.message}`, { cause: err });
  }
}

interface MessageTextAndType {
  text: string;
  type: string;
}

/**
 * Extracts message text and type from a TDLib message object.
 */
export function getMessageTextAndType(message: any): MessageTextAndType {
  const content = message.content;
  if (!content) return { text: '', type: 'unknown' };

  const contentType = content._;

  const typeMap: Record<string, { type: string; textField: string | null }> = {
    messageText:      { type: 'text',      textField: 'text' },
    messagePhoto:     { type: 'photo',     textField: 'caption' },
    messageVideo:     { type: 'video',     textField: 'caption' },
    messageDocument:  { type: 'document',  textField: 'caption' },
    messageAudio:     { type: 'audio',     textField: 'caption' },
    messageVoiceNote: { type: 'voice',     textField: 'caption' },
    messageVideoNote: { type: 'video_note', textField: null },
    messageAnimation: { type: 'animation', textField: 'caption' },
    messageSticker:   { type: 'sticker',   textField: null }
  };

  const mapping = typeMap[contentType];
  if (!mapping) return { text: '', type: contentType || 'unknown' };

  const text = mapping.textField ? (content[mapping.textField]?.text || '') : '';
  return { text, type: mapping.type };
}

/**
 * Returns the regex patterns applicable for a given source channel.
 * Uses per-source patterns from config.sourceFilters if available,
 * otherwise falls back to global filters.regexPatterns.
 */
export function getRegexPatternsForSource(config: any, sourceChatId: SourceChatId): string[] {
  if (sourceChatId && config?.sourceFilters) {
    const sourceId = String(sourceChatId);
    const sourceFilter = config.sourceFilters[sourceId];
    if (sourceFilter && Array.isArray(sourceFilter.regexPatterns)) {
      return sourceFilter.regexPatterns;
    }
  }
  // Fallback to global regex patterns
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
  filters: any,
  sourceChatId: string | number | null,
  config: any
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
    } catch (err: any) {
      logCallback(`[Filter-FEHLER] Ungültiges Regex-Muster /${pattern}/: ${err.message}`);
      return false;
    }
  });
}

/**
 * Filters the message based on configured allowed/blocked keywords, media types, and custom regex.
 * Includes text length limiting to prevent long match ReDoS execution times.
 */
export function shouldForward(
  message: any,
  filters: any,
  logCallback: (msg: string) => void = () => {},
  sourceChatId: string | number | null = null,
  config: any = null
): boolean {
  if (!filters) return true;

  const { text, type } = getMessageTextAndType(message);

  if (filters.allowedTypes?.length && !filters.allowedTypes.includes(type)) {
    logCallback(`[Filter] Paket ${message.id} ignoriert (Inhaltstyp '${type}' nicht im Filter-Schema).`);
    return false;
  }

  if (containsKeyword(text, filters.blockedKeywords)) {
    logCallback(`[Filter] Paket ${message.id} blockiert (enthält Blacklist-Signatur).`);
    return false;
  }

  if (!allowsKeyword(text, filters.allowedKeywords)) {
    logCallback(`[Filter] Paket ${message.id} verworfen (keine erlaubte Signatur enthalten).`);
    return false;
  }

  const regexPatterns = resolveRegexPatterns(filters, sourceChatId, config);
  if (!matchesAllRegexPatterns(text, regexPatterns, logCallback)) {
    logCallback(`[Filter] Paket ${message.id} verworfen (Regex-Kriterien nicht erfüllt).`);
    return false;
  }

  return true;
}
