import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("confirmation interaction policy", () => {
  it("uses the shared application dialog instead of browser-native prompts", () => {
    const sourceRoot = join(process.cwd(), "src");
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return /window\.(?:confirm|prompt|alert)\s*\(/.test(source) ? [path] : [];
    });
    expect(violations).toEqual([]);
  });
});
