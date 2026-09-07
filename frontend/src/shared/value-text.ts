/** Plain text for JSON evidence and form values; preserve explicit primitive values. */
export function valueText(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
