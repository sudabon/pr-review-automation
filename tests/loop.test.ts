import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { detectRepeatedIssues } from "../src/loop/detectRepeatedIssues.js";
import { getRequiredCliCommands, runLoop } from "../src/loop/runLoop.js";
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
  it("does not require fixer CLIs for dry-run or review-only runs", () => {
    const config = createDefaultConfig("demo");
    const options = {
      baseBranch: "main",
      maxLoops: 1,
      commitOnSuccess: false,
      dryRun: false,
      onlyReview: false
    };

    expect(getRequiredCliCommands(config, options)).toEqual(["claude", "codex", "agent"]);
    expect(getRequiredCliCommands(config, { ...options, dryRun: true })).toEqual(["claude"]);
    expect(getRequiredCliCommands(config, { ...options, onlyReview: true })).toEqual(["claude"]);
  });

  it("stops on approval and honors stop_on_validation_failure", () => {
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

    const validationFailureInput = {
      config,
      loopNumber: 1,
      maxLoops: 3,
      finalResult: final("needs_changes", [{ severity: "major" as const, title: "Bug" }], "fix"),
      validationResult: { ...validationPassed, status: "failed" as const },
      maxRepeatCount: 0
    };
    expect(shouldContinue(validationFailureInput)).toMatchObject({
      action: "stop",
      status: "human_review_required"
    });

    config.limits.stop_on_validation_failure = false;
    expect(
      shouldContinue({
        ...validationFailureInput,
        config
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

    const firstWithId = detectRepeatedIssues({}, [
      { id: "R1", severity: "major", title: "Original wording" }
    ]);
    const drifted = detectRepeatedIssues(firstWithId.counts, [
      { id: "R1", severity: "major", description: "Completely different wording" }
    ]);
    expect(drifted.maxRepeatCount).toBe(2);
    expect(drifted.repeatedKeys).toEqual(["r1"]);
  });

  it("checks abnormal diff growth against the pre-fix baseline", () => {
    const config = createDefaultConfig("demo");
    config.limits.abnormal_diff_line_threshold = 10;

    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("needs_changes", ["issue"]),
        validationResult: validationPassed,
        maxRepeatCount: 0,
        baselineDiffLineCount: 5_000,
        diffLineCount: 5_005
      }).status
    ).toBe("needs_changes");
    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("needs_changes", ["issue"]),
        validationResult: validationPassed,
        maxRepeatCount: 0,
        baselineDiffLineCount: 5_000,
        diffLineCount: 5_011
      }).status
    ).toBe("abnormal_diff");
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

  it("keeps an approved worktree so successful fixes remain accessible", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      let status = "";
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (options.command === "git" && args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (options.command === "git" && options.args?.[0] === "worktree") return execResult();
        if (options.command === "git" && args === "status --porcelain") return execResult({ stdout: status });
        if (options.command === "git" && options.args?.[0] === "status") return execResult({ stdout: "## feature\n" });
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n" });
        }
        if (options.command === "codex") {
          status = " M file.ts\n";
          return execResult({ stdout: "fixed" });
        }
        if (options.command === "claude") {
          const output = options.input?.includes("Perform the final review")
            ? { decision: "approved", remaining_issues: [], reason: "clean" }
            : {
                summary: "review",
                overall_risk: "medium",
                tasks: [{
                  id: "R1",
                  severity: "major",
                  category: "bug",
                  title: "Bug",
                  description: "Bug",
                  files: ["file.ts"],
                  suggested_fix: "Fix",
                  acceptance_criteria: ["fixed"]
                }]
              };
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: false, dryRun: false, onlyReview: false },
        executor
      });

      expect(result.status).toBe("completed");
      expect(executor.calls.some((call) => call.args?.slice(0, 3).join(" ") === "worktree remove --force")).toBe(
        false
      );
    });
  });

  it("runs only the initial review in --only-review mode", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      const reviewJson = { summary: "reviewed", overall_risk: "low", tasks: [] };
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (options.command === "git" && args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (options.command === "git" && options.args?.[0] === "status") return execResult({ stdout: "## feature\n" });
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" });
        }
        if (options.command === "claude") return execResult({ stdout: JSON.stringify(reviewJson), all: JSON.stringify(reviewJson) });
        throw new Error(`Unexpected command: ${options.command} ${args}`);
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: true, dryRun: false, onlyReview: true },
        executor
      });

      expect(result).toMatchObject({ status: "completed", reason: "Stopped after Claude review." });
      expect(executor.calls.filter((call) => call.command === "claude" && call.input)).toHaveLength(1);
      expect(executor.calls.some((call) => call.command === "codex" || call.command === "agent")).toBe(false);
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.history.at(-1)?.action).toBe("only_review");
    });
  });

  it("logs cleanup failures without replacing the loop result", async () => {
    await withTempDir(async (dir) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const config = createDefaultConfig("demo");
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (args.startsWith("worktree add")) return execResult();
        if (args.startsWith("worktree remove")) return execResult({ exitCode: 1, stderr: "remove failed" });
        if (options.args?.[0] === "status") return execResult({ stdout: "## feature\n" });
        if (options.args?.[0] === "diff") return execResult({ stdout: "" });
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: false, dryRun: true, onlyReview: false },
        executor
      });

      expect(result.status).toBe("completed");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
      expect(await readFile(join(result.runDirectory, "meta", "command-log.jsonl"), "utf8")).toContain(
        '"event":"cleanup_failed"'
      );
      warning.mockRestore();
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
      let fixerCount = 0;
      let workingTreeStatus = "";

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
        if (options.command === "git" && options.args?.join(" ") === "status --porcelain") {
          return execResult({ stdout: workingTreeStatus });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/file.ts b/file.ts\n+change\n" });
        }
        if (options.command === "codex") {
          fixerCount += 1;
          workingTreeStatus = ` M file-${fixerCount}.ts\n`;
          return execResult({ stdout: "fixed", all: "fixed" });
        }
        if (options.command === "claude") {
          const prompt = options.input ?? options.args?.at(-1) ?? "";
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

  it("stops dry-run after review and planning without validation, final review, or commit", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
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
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") {
          return execResult({ stdout: "true" });
        }
        if (options.command === "git" && args === "rev-parse --show-toplevel") {
          return execResult({ stdout: dir });
        }
        if (options.args?.[0] === "--version") {
          return execResult({ stdout: "1.0.0" });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "+change\n" });
        }
        if (options.command === "claude") {
          return execResult({ stdout: JSON.stringify(reviewJson), all: JSON.stringify(reviewJson) });
        }
        throw new Error(`Unexpected command in dry-run: ${options.command} ${args}`);
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: {
          baseBranch: "main",
          maxLoops: 3,
          commitOnSuccess: true,
          dryRun: true,
          onlyReview: false
        },
        executor
      });

      expect(result.status).toBe("completed");
      expect(executor.calls.filter((call) => call.command === "claude")).toHaveLength(2);
      expect(executor.calls.some((call) => call.command === "codex" || call.command === "agent")).toBe(false);
      expect(executor.calls.some((call) => call.args?.[0] === "commit")).toBe(false);
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.history.at(-1)?.action).toBe("dry_run");
    });
  });

  it("stops an integrated loop when a stable issue id reaches the repeat limit", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      config.limits.max_same_issue_repeats = 2;
      let fixerCount = 0;
      let finalCount = 0;
      let status = "";

      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") {
          return execResult({ stdout: "true" });
        }
        if (options.command === "git" && args === "rev-parse --show-toplevel") {
          return execResult({ stdout: dir });
        }
        if (options.args?.[0] === "--version") {
          return execResult({ stdout: "1.0.0" });
        }
        if (options.command === "git" && args === "status --porcelain") {
          return execResult({ stdout: status });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "+change\n" });
        }
        if (options.command === "codex") {
          fixerCount += 1;
          status = ` M fix-${fixerCount}.ts\n`;
          return execResult({ stdout: "fixed" });
        }
        if (options.command === "claude") {
          const prompt = options.input ?? options.args?.at(-1) ?? "";
          if (prompt.includes("Perform the final review")) {
            finalCount += 1;
            const remaining = {
              id: "R1",
              severity: "major",
              title: finalCount === 1 ? "Original wording" : "Rephrased finding"
            };
            const output = { decision: "needs_changes", remaining_issues: [remaining], reason: "still present" };
            return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
          }
          const output = {
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
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
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

      expect(result).toMatchObject({ status: "failed", decision: { status: "repeated_issue" } });
      expect(finalCount).toBe(2);
    });
  });

  it("stops an integrated loop only when the fixer increment exceeds the abnormal-diff threshold", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      config.limits.abnormal_diff_line_threshold = 3;
      let fixed = false;
      let status = "";

      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") {
          return execResult({ stdout: "true" });
        }
        if (options.command === "git" && args === "rev-parse --show-toplevel") {
          return execResult({ stdout: dir });
        }
        if (options.args?.[0] === "--version") {
          return execResult({ stdout: "1.0.0" });
        }
        if (options.command === "git" && args === "status --porcelain") {
          return execResult({ stdout: status });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({
            stdout: fixed
              ? "diff --git a/a.ts b/a.ts\n@@ -0,0 +1,5 @@\n+1\n+2\n+3\n+4\n+5\n"
              : "diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+1\n"
          });
        }
        if (options.command === "codex") {
          fixed = true;
          status = " M file.ts\n";
          return execResult({ stdout: "fixed" });
        }
        if (options.command === "claude") {
          const prompt = options.input ?? options.args?.at(-1) ?? "";
          const output = prompt.includes("Perform the final review")
            ? {
                decision: "needs_changes",
                remaining_issues: [{ id: "R1", severity: "major", title: "Bug" }],
                reason: "more"
              }
            : {
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
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: {
          baseBranch: "main",
          targetBranch: "feature",
          maxLoops: 3,
          commitOnSuccess: false,
          dryRun: false,
          onlyReview: false
        },
        executor
      });

      expect(result).toMatchObject({ status: "failed", decision: { status: "abnormal_diff" } });
    });
  });

  it("resumes a preserved run and completes the next loop", async () => {
    await withTempDir(async (dir) => {
      const runId = "resume-run";
      const statePath = join(dir, ".ai-dev-loop", "runs", runId, "meta", "loop-state.json");
      await mkdir(join(dir, ".ai-dev-loop", "runs", runId, "meta"), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          run_id: runId,
          status: "failed",
          current_loop: 1,
          max_loops: 3,
          worktree_path: dir,
          worktree_mode: "current",
          remaining_issues: [],
          repeated_issues: {},
          failovers: [],
          history: []
        }),
        "utf8"
      );
      const config = createDefaultConfig("demo");
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      let status = "";
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "status --porcelain") {
          return execResult({ stdout: status });
        }
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: "## feature\n" });
        }
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "+change\n" });
        }
        if (options.command === "codex") {
          status = " M file.ts\n";
          return execResult({ stdout: "fixed" });
        }
        if (options.command === "claude") {
          const prompt = options.input ?? options.args?.at(-1) ?? "";
          const output = prompt.includes("Perform the final review")
            ? { decision: "approved", remaining_issues: [], reason: "clean" }
            : {
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
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
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
          onlyReview: false,
          resumeRunId: runId
        },
        executor
      });

      expect(result.status).toBe("completed");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.current_loop).toBe(2);
      expect(state.status).toBe("approved");
    });
  });

  it("resumes and cleans up a legacy branch-mode run with persisted special actions", async () => {
    await withTempDir(async (dir) => {
      const runId = "branch-resume-run";
      const statePath = join(dir, ".ai-dev-loop", "runs", runId, "meta", "loop-state.json");
      await mkdir(join(dir, ".ai-dev-loop", "runs", runId, "meta"), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          run_id: runId,
          status: "failed",
          current_loop: 1,
          max_loops: 3,
          worktree_path: dir,
          worktree_mode: "branch",
          worktree_branch: "ai-dev-loop/branch-resume-run",
          worktree_original_branch: "feature",
          remaining_issues: [],
          repeated_issues: {},
          failovers: [],
          history: [
            { loop: 0, action: "only_review" },
            { loop: 1, action: "dry_run" }
          ]
        }),
        "utf8"
      );
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args === "branch --show-current") return execResult({ stdout: "feature\n" });
        if (args.startsWith("show-ref --verify --quiet")) return execResult();
        if (args === "switch ai-dev-loop/branch-resume-run") return execResult();
        if (args === "status --short --branch") return execResult({ stdout: "## ai-dev-loop/branch-resume-run\n" });
        if (args === "diff --binary --merge-base main") return execResult({ stdout: "" });
        if (args === "switch feature") return execResult();
        if (args === "branch -D ai-dev-loop/branch-resume-run") return execResult();
        throw new Error(`Unexpected command: ${options.command} ${args}`);
      });

      const result = await runLoop({
        cwd: dir,
        config: createDefaultConfig("demo"),
        options: {
          baseBranch: "main",
          maxLoops: 3,
          commitOnSuccess: false,
          dryRun: false,
          onlyReview: false,
          resumeRunId: runId
        },
        executor
      });

      expect(result.status).toBe("completed");
      expect(executor.calls.some((call) => call.args?.join(" ") === "switch ai-dev-loop/branch-resume-run")).toBe(
        true
      );
      expect(executor.calls.some((call) => call.args?.join(" ") === "branch -D ai-dev-loop/branch-resume-run")).toBe(
        true
      );
    });
  });

  it("rejects unsafe branch-mode resume states before running the loop", async () => {
    const scenarios = [
      {
        expected: "failed to inspect the current branch",
        handler: (args: string) =>
          args === "branch --show-current" ? execResult({ exitCode: 1, stderr: "inspect failed" }) : execResult()
      },
      {
        expected: "temporary branch ai-dev-loop/resume-error no longer exists",
        handler: (args: string) => {
          if (args === "branch --show-current") return execResult({ stdout: "feature\n" });
          if (args.startsWith("show-ref --verify --quiet")) return execResult({ exitCode: 1 });
          return execResult();
        }
      },
      {
        expected: "failed to switch to ai-dev-loop/resume-error",
        handler: (args: string) => {
          if (args === "branch --show-current") return execResult({ stdout: "feature\n" });
          if (args.startsWith("show-ref --verify --quiet")) return execResult();
          if (args === "switch ai-dev-loop/resume-error") return execResult({ exitCode: 1, stderr: "locked" });
          return execResult();
        }
      }
    ];

    for (const [index, scenario] of scenarios.entries()) {
      await withTempDir(async (dir) => {
        const runId = `resume-error-${index}`;
        const statePath = join(dir, ".ai-dev-loop", "runs", runId, "meta", "loop-state.json");
        await mkdir(join(dir, ".ai-dev-loop", "runs", runId, "meta"), { recursive: true });
        await writeFile(
          statePath,
          JSON.stringify({
            run_id: runId,
            status: "failed",
            current_loop: 1,
            max_loops: 3,
            worktree_path: dir,
            worktree_mode: "branch",
            worktree_branch: "ai-dev-loop/resume-error",
            remaining_issues: [],
            repeated_issues: {},
            failovers: [],
            history: []
          }),
          "utf8"
        );
        const executor = makeExecutor((options) => scenario.handler(options.args?.join(" ") ?? ""));

        await expect(
          runLoop({
            cwd: dir,
            config: createDefaultConfig("demo"),
            options: {
              baseBranch: "main",
              maxLoops: 3,
              commitOnSuccess: false,
              dryRun: false,
              onlyReview: false,
              resumeRunId: runId
            },
            executor
          })
        ).rejects.toThrow(scenario.expected);
      });
    }
  });

  it("commits approved fixes only when both commit gates are enabled", async () => {
    const scenarios = [
      { option: true, config: true, expected: true },
      { option: false, config: true, expected: false },
      { option: true, config: false, expected: false }
    ];

    for (const scenario of scenarios) {
      await withTempDir(async (dir) => {
        const config = createDefaultConfig("demo");
        config.git.use_worktree = false;
        config.git.commit_on_success = scenario.config;
        config.commands.lint = "";
        config.commands.typecheck = "";
        config.commands.test = "";
        config.commands.build = "";
        let status = "";
        const executor = makeExecutor((options) => {
          const args = options.args?.join(" ") ?? "";
          if (options.command === "git" && args === "rev-parse --is-inside-work-tree") {
            return execResult({ stdout: "true" });
          }
          if (options.command === "git" && args === "rev-parse --show-toplevel") {
            return execResult({ stdout: dir });
          }
          if (options.command === "git" && args === "rev-parse HEAD") {
            return execResult({ stdout: "abc123\n" });
          }
          if (options.args?.[0] === "--version") {
            return execResult({ stdout: "1.0.0" });
          }
          if (options.command === "git" && args === "status --porcelain") {
            return execResult({ stdout: status });
          }
          if (options.command === "git" && options.args?.[0] === "status") {
            return execResult({ stdout: "## feature\n" });
          }
          if (options.command === "git" && options.args?.[0] === "diff") {
            return execResult({ stdout: "+change\n" });
          }
          if (options.command === "codex") {
            status = " M file.ts\n";
            return execResult({ stdout: "fixed" });
          }
          if (options.command === "claude") {
            const prompt = options.input ?? options.args?.at(-1) ?? "";
            const output = prompt.includes("Perform the final review")
              ? { decision: "approved", remaining_issues: [], reason: "clean" }
              : {
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
            return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
          }
          return execResult();
        });

        const result = await runLoop({
          cwd: dir,
          config,
          options: {
            baseBranch: "main",
            maxLoops: 1,
            commitOnSuccess: scenario.option,
            dryRun: false,
            onlyReview: false
          },
          executor
        });

        expect(result.status).toBe("completed");
        expect(executor.calls.some((call) => call.command === "git" && call.args?.[0] === "commit")).toBe(
          scenario.expected
        );
      });
    }
  });

  it("continues after a no-change fixer and reports when approval creates no commit", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      const patch = ["diff --git a/file.ts b/file.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (args === "status --short --branch") return execResult({ stdout: "## feature\n" });
        if (args === "status --porcelain") return execResult({ stdout: "" });
        if (args === "diff --binary --merge-base main") return execResult({ stdout: patch });
        if (args === "diff --binary HEAD") return execResult({ stdout: "snapshot" });
        if (options.command === "codex") return execResult({ stdout: "nothing to change" });
        if (options.command === "claude") {
          const prompt = options.input ?? "";
          const output = prompt.includes("Perform the final review")
            ? { decision: "approved", remaining_issues: [], reason: "clean" }
            : {
                summary: "review",
                overall_risk: "medium",
                tasks: [
                  {
                    id: "R1",
                    severity: "major",
                    category: "bug",
                    title: "Check bug",
                    description: "Check bug",
                    files: ["file.ts"],
                    suggested_fix: "Fix if needed",
                    acceptance_criteria: ["reviewed"]
                  }
                ]
              };
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
        }
        throw new Error(`Unexpected command: ${options.command} ${args}`);
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: {
          baseBranch: "main",
          maxLoops: 1,
          commitOnSuccess: true,
          dryRun: false,
          onlyReview: false
        },
        executor
      });

      expect(result).toMatchObject({
        status: "completed",
        reason: expect.stringContaining("No commit was created because the working tree was clean")
      });
      expect(executor.calls.some((call) => call.args?.[0] === "commit")).toBe(false);
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.reason).toContain("No commit was created");
    });
  });
});
