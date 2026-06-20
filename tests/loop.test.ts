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

async function writeRequestedFinalResult(prompt: string, value: unknown): Promise<void> {
  const match = /^Write JSON to (.+) with exactly:$/m.exec(prompt);
  if (!match?.[1]) {
    throw new Error("Final-review prompt did not include an output path");
  }
  await writeFile(match[1], JSON.stringify(value), "utf8");
}

async function writeRequestedReviewResult(prompt: string, value: unknown): Promise<void> {
  const match = /^Write a structured JSON task file to (.+)\. The JSON must be an object with:$/m.exec(prompt);
  if (!match?.[1]) {
    throw new Error("Initial-review prompt did not include an output path");
  }
  await writeFile(match[1], JSON.stringify(value), "utf8");
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

    config.agents.main_reviewer = "reviewer-wrapper";
    expect(getRequiredCliCommands(config, { ...options, onlyReview: true })).toEqual(["reviewer-wrapper"]);
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

    expect(
      shouldContinue({
        ...validationFailureInput,
        validationResult: {
          ...validationFailureInput.validationResult,
          steps: {
            ...validationPassed.steps,
            test: { status: "failed", exit_code: 124, timed_out: true }
          }
        }
      }).reason
    ).toContain("Validation timed out for: test");

    expect(
      shouldContinue({
        ...validationFailureInput,
        validationResult: {
          ...validationFailureInput.validationResult,
          steps: {
            ...validationPassed.steps,
            test: { status: "failed", exit_code: 1, signal: "SIGKILL" }
          }
        }
      }).reason
    ).toContain("test (SIGKILL)");

    config.limits.stop_on_validation_failure = false;
    expect(
      shouldContinue({
        ...validationFailureInput,
        config
      })
    ).toMatchObject({ action: "continue", status: "needs_changes" });

    expect(
      shouldContinue({
        ...validationFailureInput,
        config,
        validationResult: {
          ...validationFailureInput.validationResult,
          steps: {
            ...validationPassed.steps,
            test: { status: "failed", exit_code: 1, signal: "SIGKILL", is_canceled: true }
          }
        }
      })
    ).toMatchObject({ action: "stop", status: "human_review_required", reason: expect.stringContaining("SIGKILL") });
  });

  it("stops after the configured number of consecutive test failures", () => {
    const config = createDefaultConfig("demo");
    config.limits.stop_on_validation_failure = false;
    config.limits.test_failure_degradation_limit = 2;

    const result = shouldContinue({
      config,
      loopNumber: 2,
      maxLoops: 3,
      finalResult: final("needs_changes", [{ severity: "major", title: "Bug" }]),
      validationResult: {
        ...validationPassed,
        status: "failed",
        steps: { ...validationPassed.steps, test: { status: "failed", exit_code: 1 } }
      },
      maxRepeatCount: 0,
      consecutiveTestFailures: 2
    });

    expect(result).toMatchObject({ action: "stop", status: "human_review_required" });
    expect(result.reason).toContain("2 consecutive loops");
  });

  it("stops on repeated issues, max loops, and human review", () => {
    const config = createDefaultConfig("demo");
    expect(
      shouldContinue({
        config,
        loopNumber: 1,
        maxLoops: 3,
        finalResult: final("needs_changes", [{ severity: "major", description: "same" }]),
        validationResult: validationPassed,
        maxRepeatCount: 2
      }).status
    ).toBe("repeated_issue");
    expect(
      shouldContinue({
        config,
        loopNumber: 3,
        maxLoops: 3,
        finalResult: final("needs_changes", [{ severity: "major", description: "same" }]),
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
    const first = detectRepeatedIssues({}, [{ severity: "major", description: "Bug remains" }]);
    const second = detectRepeatedIssues(first.counts, [{ severity: "major", description: "bug remains" }]);
    expect(second.maxRepeatCount).toBe(2);
    expect(second.repeatedKeys).toEqual(["major:bug remains"]);

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
        finalResult: final("needs_changes", [{ severity: "major", description: "issue" }]),
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
        finalResult: final("needs_changes", [{ severity: "major", description: "issue" }]),
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

  it("rejects traversal run IDs and resume worktree paths outside the repository", async () => {
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
            resumeRunId: "../../../outside"
          },
          executor: makeExecutor(() => execResult())
        })
      ).rejects.toThrow("Invalid run_id");

      const runId = "unsafe-path";
      const statePath = join(dir, ".ai-dev-loop", "runs", runId, "meta", "loop-state.json");
      await mkdir(join(dir, ".ai-dev-loop", "runs", runId, "meta"), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          run_id: runId,
          status: "failed",
          current_loop: 1,
          max_loops: 3,
          worktree_path: "/tmp/outside-worktree",
          worktree_mode: "worktree",
          worktree_branch: "ai-dev-loop/unsafe-path",
          remaining_issues: [],
          repeated_issues: {},
          failovers: [],
          history: []
        }),
        "utf8"
      );
      const executor = makeExecutor(() => execResult());

      await expect(
        runLoop({
          cwd: dir,
          config: createDefaultConfig("demo"),
          options: {
            baseBranch: "main",
            maxLoops: 3,
            commitOnSuccess: false,
            dryRun: true,
            onlyReview: false,
            resumeRunId: runId
          },
          executor
        })
      ).rejects.toThrow("worktree path must be inside");
      expect(executor.calls).toHaveLength(0);
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

  it("rejects unknown and inconsistent fields in resumed state", async () => {
    const invalidStates = [
      { extra: true },
      { worktree_mode: "current", worktree_branch: "ai-dev-loop/stale" }
    ];

    for (const [index, extra] of invalidStates.entries()) {
      await withTempDir(async (dir) => {
        const runId = `strict-state-${index}`;
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
            remaining_issues: [],
            repeated_issues: {},
            failovers: [],
            history: [],
            ...extra
          }),
          "utf8"
        );

        await expect(
          runLoop({
            cwd: dir,
            config: createDefaultConfig("demo"),
            options: {
              baseBranch: "main",
              maxLoops: 3,
              commitOnSuccess: false,
              dryRun: true,
              onlyReview: false,
              resumeRunId: runId
            },
            executor: makeExecutor(() => execResult())
          })
        ).rejects.toThrow("Unrecognized key");
      });
    }
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
        if (options.args?.join(" ") === "rev-parse --verify main^{commit}") {
          return execResult({ stdout: "base-commit\n" });
        }
        if (options.args?.join(" ") === "rev-parse --verify HEAD^{commit}") {
          return execResult({ stdout: "target-commit\n" });
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

  it("fails instead of approving an empty diff when base and target are the same commit", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (args === "status --short --branch") return execResult({ stdout: "## main\n" });
        if (args === "diff --binary --merge-base main") return execResult({ stdout: "" });
        if (args.startsWith("rev-parse --verify ")) return execResult({ stdout: "same-commit\n" });
        throw new Error(`Unexpected command: ${options.command} ${args}`);
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: false, dryRun: true, onlyReview: false },
        executor
      });

      expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("same commit") });
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state).toMatchObject({ status: "failed", reason: expect.stringContaining("same commit") });
    });
  });

  it("cleans an approved worktree and its temporary branch", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      config.git.create_pr_on_success = true;
      let status = "";
      const executor = makeExecutor(async (options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (options.command === "git" && args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.command === "git" && args === "rev-parse HEAD") return execResult({ stdout: "commit-sha\n" });
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
          const isFinalReview = options.input?.includes("Perform the final review") ?? false;
          const output = isFinalReview
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
          if (isFinalReview) {
            await writeRequestedFinalResult(options.input ?? "", output);
          }
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: true, dryRun: false, onlyReview: false },
        executor
      });

      expect(result.status).toBe("completed");
      expect(executor.calls.some((call) => call.args?.slice(0, 3).join(" ") === "worktree remove --force")).toBe(
        true
      );
      expect(executor.calls.some((call) => call.args?.slice(0, 2).join(" ") === "branch -D")).toBe(true);
      expect(executor.calls.some((call) => call.args?.[0] === "commit")).toBe(true);
      expect(executor.calls.some((call) => call.command === "gh" && call.args?.slice(0, 2).join(" ") === "pr create")).toBe(
        true
      );
      expect(await readFile(join(result.runDirectory, "meta", "pr-result.json"), "utf8")).toContain('"status": "created"');
    });
  });

  it("returns non-success and preserves the worktree when PR creation fails after commit", async () => {
    await withTempDir(async (dir) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const config = createDefaultConfig("demo");
      config.git.create_pr_on_success = true;
      config.commands.lint = "";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      let status = "";
      const executor = makeExecutor(async (options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (options.command === "git" && args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.command === "git" && args === "rev-parse HEAD") return execResult({ stdout: "commit-sha\n" });
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
          const isFinalReview = options.input?.includes("Perform the final review") ?? false;
          const output = isFinalReview
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
          if (isFinalReview) await writeRequestedFinalResult(options.input ?? "", output);
          return execResult({ stdout: JSON.stringify(output), all: JSON.stringify(output) });
        }
        if (options.command === "gh" && args === "auth status") return execResult();
        if (options.command === "gh" && args.startsWith("pr create")) {
          return execResult({ exitCode: 1, stderr: "network unavailable" });
        }
        return execResult();
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: true, dryRun: false, onlyReview: false },
        executor
      });

      expect(result).toMatchObject({
        status: "needs_human_review",
        reason: expect.stringContaining("network unavailable")
      });
      expect(executor.calls.some((call) => call.args?.[0] === "commit")).toBe(true);
      expect(executor.calls.some((call) => call.args?.slice(0, 3).join(" ") === "worktree remove --force")).toBe(false);
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state).toMatchObject({
        status: "human_review_required",
        reason: expect.stringContaining("network unavailable")
      });
      expect(state.history.at(-1)?.reason).toContain("network unavailable");
      expect(await readFile(join(result.runDirectory, "meta", "pr-result.json"), "utf8")).toContain('"status": "failed"');
      warning.mockRestore();
    });
  });

  it("runs only the initial review in --only-review mode", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      const reviewJson = { summary: "reviewed", overall_risk: "low", tasks: [] };
      const executor = makeExecutor(async (options) => {
        const args = options.args?.join(" ") ?? "";
        if (options.command === "git" && args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (options.command === "git" && args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (options.command === "git" && options.args?.[0] === "status") return execResult({ stdout: "## feature\n" });
        if (options.command === "git" && options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" });
        }
        if (options.command === "claude") {
          await writeRequestedReviewResult(options.input ?? "", reviewJson);
          return execResult({ stdout: "Review complete", all: "Review complete" });
        }
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

  it("requires human review when an empty initial review comes only from stdout fallback", async () => {
    await withTempDir(async (dir) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const config = createDefaultConfig("demo");
      config.git.use_worktree = false;
      const reviewJson = { summary: "reviewed", overall_risk: "low", tasks: [] };
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args === "rev-parse --is-inside-work-tree") return execResult({ stdout: "true" });
        if (args === "rev-parse --show-toplevel") return execResult({ stdout: dir });
        if (options.args?.[0] === "--version") return execResult({ stdout: "1.0.0" });
        if (args === "status --short --branch") return execResult({ stdout: "## feature\n" });
        if (options.args?.[0] === "diff") {
          return execResult({ stdout: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" });
        }
        if (options.command === "claude") {
          return execResult({ stdout: JSON.stringify(reviewJson), all: JSON.stringify(reviewJson) });
        }
        throw new Error(`Unexpected command: ${options.command} ${args}`);
      });

      const result = await runLoop({
        cwd: dir,
        config,
        options: { baseBranch: "main", maxLoops: 1, commitOnSuccess: false, dryRun: false, onlyReview: true },
        executor
      });

      expect(result).toMatchObject({
        status: "needs_human_review",
        reason: expect.stringContaining("stdout JSON fallback")
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("stdout JSON fallback"));
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.status).toBe("human_review_required");
      warning.mockRestore();
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
        if (args === "rev-parse --verify main^{commit}") return execResult({ stdout: "base-commit\n" });
        if (args === "rev-parse --verify HEAD^{commit}") return execResult({ stdout: "target-commit\n" });
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
      expect(executor.calls.some((call) => call.args?.slice(0, 3).join(" ") === "worktree remove --force")).toBe(
        true
      );
      expect(executor.calls.some((call) => call.args?.slice(0, 2).join(" ") === "branch -D")).toBe(true);
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

      const executor = makeExecutor(async (options) => {
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
            if (finalJson.decision === "approved") {
              await writeRequestedFinalResult(prompt, finalJson);
            }
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
      const executor = makeExecutor(async (options) => {
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
          const isFinalReview = prompt.includes("Perform the final review");
          const output = isFinalReview
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
          if (isFinalReview) {
            await writeRequestedFinalResult(prompt, output);
          }
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
        if (args === "rev-parse --verify main^{commit}") return execResult({ stdout: "base-commit\n" });
        if (args === "rev-parse --verify HEAD^{commit}") return execResult({ stdout: "target-commit\n" });
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
        expected: "temporary branch",
        handler: (args: string) => {
          if (args === "branch --show-current") return execResult({ stdout: "feature\n" });
          if (args.startsWith("show-ref --verify --quiet")) return execResult({ exitCode: 1 });
          return execResult();
        }
      },
      {
        expected: "failed to switch to",
        handler: (args: string) => {
          if (args === "branch --show-current") return execResult({ stdout: "feature\n" });
          if (args.startsWith("show-ref --verify --quiet")) return execResult();
          if (args.startsWith("switch ai-dev-loop/resume-error-")) return execResult({ exitCode: 1, stderr: "locked" });
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
            worktree_branch: `ai-dev-loop/${runId}`,
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
      { option: true, config: true, expected: false },
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
        const executor = makeExecutor(async (options) => {
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
            const isFinalReview = prompt.includes("Perform the final review");
            const output = isFinalReview
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
            if (isFinalReview) {
              await writeRequestedFinalResult(prompt, output);
            }
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
        if (scenario.option && scenario.config) {
          expect(result.reason).toContain("Automatic commit was skipped because git.use_worktree is false");
        }
      });
    }
  });

  it("stops for human review after all fixers make no changes", async () => {
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
        if (options.command === "codex" || options.command === "agent") {
          return execResult({ stdout: "nothing to change" });
        }
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
        status: "needs_human_review",
        reason: expect.stringContaining("made no working-tree changes")
      });
      expect(executor.calls.some((call) => call.command === "pnpm")).toBe(false);
      expect(
        executor.calls.filter((call) => call.command === "claude" && call.args?.[0] !== "--version")
      ).toHaveLength(1);
      expect(executor.calls.some((call) => call.args?.[0] === "commit")).toBe(false);
      const state = JSON.parse(await readFile(join(result.runDirectory, "meta", "loop-state.json"), "utf8"));
      expect(state.status).toBe("human_review_required");
      expect(state.reason).toContain("made no working-tree changes");
    });
  });
});
