import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { detectRepeatedIssues } from "../src/loop/detectRepeatedIssues.js";
import { runLoop } from "../src/loop/runLoop.js";
import { shouldContinue } from "../src/loop/shouldContinue.js";
import type { FinalResult } from "../src/runners/reviewSchemas.js";
import type { ValidationResult } from "../src/runners/runValidation.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

const validationPassed: ValidationResult = {
  status: "passed",
  stop_on_validation_failure: true,
  steps: {
    lint: { status: "skipped", exit_code: null },
    typecheck: { status: "skipped", exit_code: null },
    test: { status: "skipped", exit_code: null },
    build: { status: "skipped", exit_code: null }
  }
};

function final(decision: FinalResult["decision"], remaining_issues = [], reason = "reason"): FinalResult {
  return { decision, remaining_issues, reason };
}

describe("loop control", () => {
  it("stops on approval and continues on validation failure", () => {
    const config = createDefaultConfig("demo");
    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("approved", [], "approved"),
        validationResult: validationPassed,
        maxRepeatCount: 0
      })
    ).toMatchObject({ action: "stop", success: true });

    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("needs_changes", [{ severity: "major", title: "Bug" }], "fix"),
        validationResult: { ...validationPassed, status: "failed" },
        maxRepeatCount: 0
      })
    ).toMatchObject({ action: "continue", status: "needs_changes" });
  });

  it("stops on repeated issues, max loops, and human review", () => {
    const config = createDefaultConfig("demo");
    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("needs_changes", ["same"]),
        validationResult: validationPassed,
        maxRepeatCount: 2
      }).status
    ).toBe("repeated_issue");
    expect(
      shouldContinue({
        config,
        loopNumber: 3,
        maxLoops: 3,
        finalResult: final("needs_changes", ["same"]),
        validationResult: validationPassed,
        maxRepeatCount: 0
      }).status
    ).toBe("max_loops");
    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("human_review_required", [], "security design"),
        validationResult: validationPassed,
        maxRepeatCount: 0
      }).status
    ).toBe("human_review_required");
    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("needs_changes", [{ severity: "major", title: "Bug" }]),
        validationResult: validationPassed,
        maxRepeatCount: 0,
        allFixersTokenLimited: true
      })
    ).toMatchObject({ action: "stop", status: "human_review_required" });
  });

  it("tracks repeated remaining issues", () => {
    const first = detectRepeatedIssues({}, ["Bug remains"]);
    const second = detectRepeatedIssues(first.counts, ["bug remains"]);
    expect(second.maxRepeatCount).toBe(2);
    expect(second.repeatedKeys).toEqual(["bug remains"]);
  });

  it("errors when --resume references a missing run", async () => {
    await withTempDir(async (dir) => {
      await expect(
        runLoop({
          cwd: dir,
          config: createDefaultConfig("demo"),
          options: {
            baseBranch: "main",
            maxLoops: 1,
            commitOnSuccess: false,
            dryRun: true,
            onlyReview: false,
            resumeRunId: "missing"
          },
          executor: makeExecutor(() => execResult())
        })
      ).rejects.toThrow("loop-state.json");
    });
  });

  it("errors when --resume references an invalid state file", async () => {
    await withTempDir(async (dir) => {
      const statePath = join(dir, ".ai-dev-loop", "runs", "bad-run", "meta", "loop-state.json");
      await mkdir(join(dir, ".ai-dev-loop", "runs", "bad-run", "meta"), { recursive: true });
      await writeFile(statePath, "{", "utf8");

      await expect(
        runLoop({
          cwd: dir,
          config: createDefaultConfig("demo"),
          options: {
            baseBranch: "main",
            maxLoops: 1,
            commitOnSuccess: false,
            dryRun: true,
            onlyReview: false,
            resumeRunId: "bad-run"
          },
          executor: makeExecutor(() => execResult())
        })
      ).rejects.toThrow("invalid loop-state.json");
    });
  });

  it("cleans up a temporary worktree when the loop exits", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      const executor = makeExecutor((options) => {
        if (options.command === "git" && options.args?.join(" ") === "rev-parse --is-inside-work-tree") {
          return execResult({ stdout: "true" });
        }
        if (options.command === "git" && options.args?.join(" ") === "rev-parse --show-toplevel") {
          return execResult({ stdout: dir });
        }
        if (options.args?.[0] === "--version") {
          return execResult({ stdout: "1.0.0" });
        }
        if (options.command === "git" && options.args?.[0] === "worktree") {
          return execResult();
        }
        if (options.command === "git" && options.args?.[0] === "branch") {
          return execResult();
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "" });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: {
          baseBranch: "main",
          maxLoops: 1,
          commitOnSuccess: false,
          dryRun: true,
          onlyReview: false
        },
        executor
      });

      expect(result.status).toBe("completed");
      expect(executor.calls.some((call) => call.args?.slice(0, 3).join(" ") === "worktree remove --force")).toBe(
        true
      );
      expect(executor.calls.some((call) => call.args?.slice(0, 2).join(" ") === "branch -D")).toBe(true);
    });
  });

  it("persists a failed state when fixer execution fails", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".git"), { recursive: true });
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      config.agents.fixers = ["codex"];
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";

      const executor = makeExecutor((options) => {
        if (options.command === "git" && options.args?.join(" ") === "rev-parse --is-inside-work-tree") {
          return execResult({ stdout: "true" });
        }
        if (options.command === "git" && options.args?.join(" ") === "rev-parse --show-toplevel") {
          return execResult({ stdout: dir });
        }
        if (options.args?.[0] === "--version") {
          return execResult({ stdout: "1.0.0" });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/file.ts b/file.ts\n+change\n" });
        }
        if (options.command === "codex") {
          return execResult({ exitCode: 1, stderr: "codex failed", all: "codex failed" });
        }
        if (options.command === "claude") {
          const reviewJson = {
            summary: "review",
            overall_risk: "medium",
            tasks: [
              {
                id: "R1",
                severity: "major",
                category: "bug",
                title: "Bug",
                description: "Bug",
                files: ["file.ts"],
                suggested_fix: "Fix",
                acceptance_criteria: ["fixed"]
              }
            ]
          };
          return execResult({ stdout: JSON.stringify(reviewJson), all: JSON.stringify(reviewJson) });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: {
          baseBranch: "main",
          maxLoops: 1,
          commitOnSuccess: false,
          dryRun: false,
          onlyReview: false
        },
        executor
      });

      expect(result.status).toBe("failed");
      expect(result.reason).toContain("codex fixer failed");
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.status).toBe("failed");
      expect(state.reason).toContain("codex fixer failed");
      expect(state.current_loop).toBe(1);
    });
  });

  it("runs a mocked one-to-three loop flow and persists state", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".git"), { recursive: true });
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      config.limits.max_same_issue_repeats = 3;
      let finalReviewCount = 0;

      const executor = makeExecutor((options) => {
        if (options.command === "git" && options.args?.join(" ") === "rev-parse --is-inside-work-tree") {
          return execResult({ stdout: "true" });
        }
        if (options.command === "git" && options.args?.join(" ") === "rev-parse --show-toplevel") {
          return execResult({ stdout: dir });
        }
        if (options.args?.[0] === "--version") {
          return execResult({ stdout: "1.0.0" });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/file.ts b/file.ts\n+change\n" });
        }
        if (options.command === "codex") {
          return execResult({ stdout: "fixed", all: "fixed" });
        }
        if (options.command === "claude") {
          const prompt = options.args?.at(-1) ?? "";
          if (prompt.includes("Perform the final review")) {
            finalReviewCount += 1;
            const finalJson =
              finalReviewCount < 3
                ? { decision: "needs_changes", remaining_issues: [{ severity: "major", title: "Bug" }], reason: "more" }
                : { decision: "approved", remaining_issues: [], reason: "clean" };
            return execResult({ stdout: JSON.stringify(finalJson), all: JSON.stringify(finalJson) });
          }
          const reviewJson = {
            summary: "review",
            overall_risk: "medium",
            tasks: [
              {
                id: "R1",
                severity: "major",
                category: "bug",
                title: "Bug",
                description: "Bug",
                files: ["file.ts"],
                suggested_fix: "Fix",
                acceptance_criteria: ["fixed"]
              }
            ]
          };
          return execResult({ stdout: JSON.stringify(reviewJson), all: JSON.stringify(reviewJson) });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: {
          baseBranch: "main",
          maxLoops: 3,
          commitOnSuccess: false,
          dryRun: false,
          onlyReview: false
        },
        executor
      });

      expect(result.status).toBe("completed");
      expect(finalReviewCount).toBe(3);
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.current_loop).toBe(3);
      expect(state.final_decision).toBe("approved");
    });
  });
});
