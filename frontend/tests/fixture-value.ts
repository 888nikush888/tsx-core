/** Fail with a useful fixture error before using a missing observed test value. */
export function fixtureValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing test fixture: ${label}`);
  return value;
}
