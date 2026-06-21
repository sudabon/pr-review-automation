import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { buildProjectSummary } from "../src/safety/buildProjectSummary.js";
import { checkSafetyLimits } from "../src/safety/checkSafetyLimits.js";
import { filterDiff, matchesIgnorePattern } from "../src/safety/filterDiff.js";
import { DEFAULT_IGNORE_PATTERNS, loadIgnorePatterns } from "../src/safety/loadIgnorePatterns.js";
import { withTempDir } from "./helpers.js";

const sampleDiff = [
  "diff --git a/node_modules/pkg/index.js b/node_modules/pkg/index.js",
  "index 111..222 100644",
  "--- a/node_modules/pkg/index.js",
  "+++ b/node_modules/pkg/index.js",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new"
].join("\n");

describe("safety guards", () => {
  it("uses default ignore patterns when .ai-dev-loopignore is missing", async () => {
    await withTempDir(async (dir) => {
      const patterns = await loadIgnorePatterns(dir);
      expect(patterns).toEqual([...DEFAULT_IGNORE_PATTERNS]);
    });
  });

  it("filters ignored paths out of the diff", () => {
    const filtered = filterDiff(sampleDiff, ["node_modules/"]);
    expect(filtered.diff).toContain("src/app.ts");
    expect(filtered.diff).not.toContain("node_modules/pkg/index.js");
    expect(filtered.removedFiles).toEqual(["node_modules/pkg/index.js"]);
  });

  it("detects important file changes and limit breaches using filtered file counts", () => {
    const config = createDefaultConfig("demo");
    config.limits.max_changed_files = 0;
    const result = checkSafetyLimits(sampleDiff, config, ["node_modules/"]);
    expect(result.stopReason).toBe("max_changed_files");
    expect(matchesIgnorePattern(".env.production", ".env.*")).toBe(true);
  });

  it("records lockfile warnings without stopping the loop", () => {
    const lockfileDiff = [
      "diff --git a/package-lock.json b/package-lock.json",
      "index 111..222 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,1 +1,250 @@",
      ...Array.from({ length: 250 }, (_, index) => `+line-${index}`)
    ].join("\n");
    const config = createDefaultConfig("demo");
    const result = checkSafetyLimits(lockfileDiff, config, []);
    expect(result.stopReason).toBeUndefined();
    expect(result.warnings[0]?.type).toBe("lockfile_large_change");
  });

  it("builds project-summary.md from package.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { zod: "1.0.0" } }),
        "utf8"
      );
      const outputPath = join(dir, "project-summary.md");
      const summary = await buildProjectSummary({ repoRoot: dir, outputPath });
      expect(summary).toContain("demo");
      expect(summary).toContain("package.json");
    });
  });
});
