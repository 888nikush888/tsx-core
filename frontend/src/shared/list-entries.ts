/** Content identities survive reordering; occurrences keep duplicate evidence visible. */
export function listEntries<T>(items: readonly T[], identity: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map(item => {
    const id = identity(item);
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    return { key: JSON.stringify([id, occurrence]), item };
  });
}
