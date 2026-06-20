import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { runClaudeFinalReview } from "../src/runners/runClaudeFinalReview.js";
import { runClaudeReview } from "../src/runners/runClaudeReview.js";
import { finalResultSchema } from "../src/runners/reviewSchemas.js";
import { extractJsonObject } from "../src/utils/safeJsonParse.js";
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
          reviewDir: join(dir, "review"),
          commandLogPath: join(dir, "meta", "command-log.jsonl")
        },
        executor
      );

      expect(result.review.tasks[0]?.severity).toBe("major");
      expect(executor.calls[0]?.input).toContain("/review-pr");
      expect(executor.calls[0]?.args).not.toContain(executor.calls[0]?.input);
      expect(await readFile(result.markdownPath, "utf8")).toContain("Review complete");
      expect(await readFile(result.reviewJsonPath, "utf8")).toContain("Found one issue");
      expect(await readFile(join(dir, "meta", "command-log.jsonl"), "utf8")).toContain('"event":"json_fallback"');
    });
  });

  it("rejects malformed Claude JSON files with a contextual error", async () => {
    await withTempDir(async (dir) => {
      const reviewDir = join(dir, "review");
      const executor = makeExecutor(async () => {
        await writeFile(join(reviewDir, "review.json"), "{", "utf8");
        return execResult({ stdout: JSON.stringify(reviewJson), all: JSON.stringify(reviewJson) });
      });

      await expect(
        runClaudeReview(
          {
            config: createDefaultConfig("demo"),
            cwd: dir,
            diffPath: "diff.patch",
            statusPath: "status.txt",
            reviewDir
          },
          executor
        )
      ).rejects.toThrow("Invalid Claude review JSON");
    });
  });

  it("extracts the first valid object from multiple JSON candidates", () => {
    const extracted = extractJsonObject(
      `Explanation with {not json}.\n\`\`\`json\n{broken}\n\`\`\`\n\`\`\`json\n${JSON.stringify(reviewJson)}\n\`\`\``
    );

    expect(extracted).toEqual({ ok: true, value: reviewJson });
  });

  it("rejects empty remaining-issue objects", () => {
    expect(
      finalResultSchema.safeParse({
        decision: "needs_changes",
        remaining_issues: [{}],
        reason: "more"
      }).success
    ).toBe(false);
    expect(
      finalResultSchema.safeParse({
        decision: "needs_changes",
        remaining_issues: [{ title: "Bug" }],
        reason: "more"
      }).success
    ).toBe(true);
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
