import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { runClaudeFinalReview } from "../src/runners/runClaudeFinalReview.js";
import { runClaudeReview } from "../src/runners/runClaudeReview.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

const reviewJson = {
  summary: "Found one issue",
  overall_risk: "medium",
  tasks: [
    {
      id: "R1",
      severity: "major",
      category: "bug",
      title: "Fix bug",
      description: "Bug description",
      files: ["src/a.ts"],
      suggested_fix: "Fix it",
      acceptance_criteria: ["passes tests"]
    }
  ]
};

describe("review runners", () => {
  it("runs Claude review and writes validated artifacts", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() =>
        execResult({
          stdout: `Review complete\n\n\`\`\`json\n${JSON.stringify(reviewJson)}\n\`\`\``,
          all: `Review complete\n\n\`\`\`json\n${JSON.stringify(reviewJson)}\n\`\`\``
        })
      );

      const result = await runClaudeReview(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          diffPath: join(dir, "diff.patch"),
          statusPath: join(dir, "status.txt"),
          reviewDir: join(dir, "review")
        },
        executor
      );

      expect(result.review.tasks[0]?.severity).toBe("major");
      expect(await readFile(result.markdownPath, "utf8")).toContain("Review complete");
      expect(await readFile(result.reviewJsonPath, "utf8")).toContain("Found one issue");
    });
  });

  it("rejects invalid review severity", async () => {
    await withTempDir(async (dir) => {
      const invalid = { ...reviewJson, tasks: [{ ...reviewJson.tasks[0], severity: "urgent" }] };
      const executor = makeExecutor(() => execResult({ stdout: JSON.stringify(invalid), all: JSON.stringify(invalid) }));

      await expect(
        runClaudeReview(
          {
            config: createDefaultConfig("demo"),
            cwd: dir,
            diffPath: "diff.patch",
            statusPath: "status.txt",
            reviewDir: join(dir, "review")
          },
          executor
        )
      ).rejects.toThrow();
    });
  });

  it("treats Claude CLI failure as a loop failure", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => execResult({ exitCode: 1, stderr: "boom", all: "boom" }));

      await expect(
        runClaudeReview(
          {
            config: createDefaultConfig("demo"),
            cwd: dir,
            diffPath: "diff.patch",
            statusPath: "status.txt",
            reviewDir: join(dir, "review")
          },
          executor
        )
      ).rejects.toThrow("Claude review failed");
    });
  });

  it("runs Claude final review and validates the decision JSON", async () => {
    await withTempDir(async (dir) => {
      const finalJson = { decision: "approved", remaining_issues: [], reason: "clean" };
      const executor = makeExecutor(() => execResult({ stdout: JSON.stringify(finalJson), all: JSON.stringify(finalJson) }));

      const result = await runClaudeFinalReview(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          initialReviewPath: "review.md",
          validationResultPath: "validation.json",
          diffPath: "diff.patch",
          finalDir: join(dir, "final"),
          fixLogPaths: []
        },
        executor
      );

      expect(result.finalResult.decision).toBe("approved");
      expect(await readFile(result.finalResultPath, "utf8")).toContain("approved");
    });
  });
});
