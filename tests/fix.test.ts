import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { runFix } from "../src/runners/runFix.js";
import type { ReviewJson } from "../src/runners/reviewSchemas.js";
import { detectTokenLimit } from "../src/utils/detectTokenLimit.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

const review: ReviewJson = {
  summary: "two tasks",
  overall_risk: "high",
  tasks: [
    {
      id: "minor-1",
      severity: "minor",
      category: "docs",
      title: "Docs",
      description: "Docs",
      files: [],
      suggested_fix: "Update docs",
      acceptance_criteria: ["docs updated"]
    },
    {
      id: "major-1",
      severity: "major",
      category: "bug",
      title: "Bug",
      description: "Bug",
      files: ["src/a.ts"],
      suggested_fix: "Fix bug",
      acceptance_criteria: ["bug fixed"]
    }
  ]
};

describe("fix runners", () => {
  it("skips fixer execution in dry-run mode", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => {
        throw new Error("should not run");
      });
      const result = await runFix(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: true
        },
        executor
      );

      expect(result.status).toBe("skipped");
      expect(await readFile(result.outputPaths[0]!, "utf8")).toContain("Dry run");
      expect(executor.calls).toHaveLength(0);
    });
  });

  it("runs the first configured fixer and prioritizes major comments", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => execResult({ stdout: "fixed", all: "fixed" }));
      const result = await runFix(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result.status).toBe("completed");
      expect(result.activeFixer).toBe("codex");
      const prompt = await readFile(join(dir, "fix", "codex-prompt.md"), "utf8");
      expect(prompt.indexOf("major-1")).toBeLessThan(prompt.indexOf("minor-1"));
    });
  });

  it("fails over to Cursor when Codex reports token limits", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor((options) => {
        if (options.command === "codex") {
          return execResult({ exitCode: 1, stderr: "quota exceeded", all: "quota exceeded" });
        }
        return execResult({ stdout: "cursor fixed", all: "cursor fixed" });
      });

      const result = await runFix(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false,
          commandLogPath: join(dir, "meta", "command-log.jsonl")
        },
        executor
      );

      expect(result.status).toBe("completed");
      expect(result.activeFixer).toBe("cursor");
      expect(result.failovers).toHaveLength(1);
    });
  });

  it("fails over to Cursor when Codex fails normally", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor((options) => {
        if (options.command === "codex") {
          return execResult({ exitCode: 1, stderr: "codex unavailable", all: "codex unavailable" });
        }
        return execResult({ stdout: "cursor fixed", all: "cursor fixed" });
      });

      const result = await runFix(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result.status).toBe("completed");
      expect(result.activeFixer).toBe("cursor");
      expect(result.failovers).toMatchObject([{ from: "codex", to: "cursor", reason: "failed" }]);
    });
  });

  it("returns human review when all fixers hit token limits", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => execResult({ exitCode: 1, stderr: "rate limit", all: "rate limit" }));
      const result = await runFix(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result.status).toBe("human_review_required");
      expect(result.failovers).toHaveLength(2);
    });
  });

  it("detects configured token-limit patterns", () => {
    const config = createDefaultConfig("demo");
    config.agents.token_limit_patterns.codex = ["custom token stop"];
    expect(
      detectTokenLimit({
        result: execResult({ exitCode: 1, stderr: "Custom token stop happened" }),
        fixer: "codex",
        config
      })
    ).toBe(true);
  });

  it("does not treat stdout-only 429 text as a token limit when stderr has the real failure", () => {
    expect(
      detectTokenLimit({
        result: execResult({
          exitCode: 1,
          stdout: "src/file.ts:429: broken assertion",
          stderr: "authentication failed"
        })
      })
    ).toBe(false);
  });
});
