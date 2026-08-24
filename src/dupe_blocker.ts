import { findDuplicateSignal } from './db.js';

/**
 * Normalizes XML signal content for comparison.
 * Strips whitespace between tags, removes XML declaration,
 * and collapses whitespace to produce a canonical string.
 */
export function normalizeSignalXml(xmlString: string): string {
  if (!xmlString || typeof xmlString !== 'string') return '';
  const normalized = xmlString
    // Remove XML declaration
    .replace(/<\?xml[^?]*\?>\s*/gi, '')
    // Remove leading/trailing whitespace
    .trim()
    // Normalize whitespace before removing the single spaces adjacent to tags.
    .replace(/\s+/g, ' ')
    .replaceAll('> <', '><')
    .replaceAll('> ', '>')
    .replaceAll(' <', '<')
    .trim();
  return normalized;
}

/**
 * Checks whether a signal is a duplicate of any existing signal in the database.
 */
export async function isDuplicateSignal(
  xmlString: string,
  _signalsDir: string, // Kept for signature compatibility
  cooldownHours: number,
  currentSignalId?: string,
  dedupeScope?: string,
): Promise<{ isDupe: boolean; reason: string; matchFile?: string }> {
  if (!xmlString || typeof xmlString !== 'string') {
    return { isDupe: false, reason: 'Leerer Signal-Inhalt' };
  }

  const normalizedNew = normalizeSignalXml(xmlString);
  if (!normalizedNew) {
    return { isDupe: false, reason: 'Signal konnte nicht normalisiert werden' };
  }

  const match = await findDuplicateSignal(normalizedNew, cooldownHours, currentSignalId, dedupeScope);
  if (match?.isDupe) {
    if (cooldownHours === 0) {
      return {
        isDupe: true,
        reason: `Identisches Signal gefunden: ${match.matchFile} (Cooldown: permanent)`,
        matchFile: match.matchFile
      };
    }
    return {
      isDupe: true,
      reason: `Identisches Signal gefunden: ${match.matchFile} (vor ${match.ageHours}h, Cooldown: ${cooldownHours}h)`,
      matchFile: match.matchFile
    };
  }

  return { isDupe: false, reason: 'Kein Duplikat gefunden' };
}
