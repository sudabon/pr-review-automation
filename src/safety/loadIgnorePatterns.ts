import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".cache/",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "*.min.js",
  "*.map"
] as const;

export async function loadIgnorePatterns(repoRoot: string): Promise<string[]> {
  const ignorePath = join(repoRoot, ".ai-dev-loopignore");
  try {
    const raw = await readFile(ignorePath, "utf8");
    const patterns = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    return patterns.length > 0 ? patterns : [...DEFAULT_IGNORE_PATTERNS];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [...DEFAULT_IGNORE_PATTERNS];
    }
    throw error;
  }
}
