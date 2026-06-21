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
      expect(result.outputPaths).toHaveLength(2);
      expect(await readFile(result.outputPaths[0]!, "utf8")).toContain("fix-pr-comments");
      expect(await readFile(result.outputPaths[1]!, "utf8")).toContain("fix-pr-comments");
      expect(executor.calls).toHaveLength(0);
    });
  });

  it("runs the first configured fixer and prioritizes major comments", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixer_mode = "failover";
      let status = "";
      const executor = makeExecutor((options) => {
        if (options.command === "git") {
          return execResult({ stdout: status });
        }
        status = " M src/a.ts\n";
        return execResult({ stdout: "fixed", all: "fixed" });
      });
      const result = await runFix(
        {
          config,
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
      const cursorCall = executor.calls.find((call) => call.command === "agent");
      expect(cursorCall?.input).toContain("major-1");
      expect(cursorCall?.args).not.toContain(cursorCall?.input);
      const prompt = await readFile(join(dir, "fix", "cursor-prompt.md"), "utf8");
      expect(prompt.indexOf("major-1")).toBeLessThan(prompt.indexOf("minor-1"));
    });
  });

  it("fails over to Cursor when Codex reports token limits", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixers = ["codex", "cursor"];
      config.agents.fixer_mode = "failover";
      let status = "";
      const executor = makeExecutor((options) => {
        if (options.command === "git") {
          return execResult({ stdout: status });
        }
        if (options.command === "codex") {
          return execResult({ exitCode: 1, stderr: "quota exceeded", all: "quota exceeded" });
        }
        status = " M src/a.ts\n";
        return execResult({ stdout: "cursor fixed", all: "cursor fixed" });
      });

      const result = await runFix(
        {
          config,
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
      const commandLog = await readFile(join(dir, "meta", "command-log.jsonl"), "utf8");
      expect(commandLog).toContain('"event":"token_limit_detected"');
      expect(commandLog).toContain("codex exited with code 1");
      expect(commandLog).toContain("stderr: quota exceeded");
    });
  });

  it("does not fail over when Codex fails normally", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixers = ["codex", "cursor"];
      config.agents.fixer_mode = "failover";
      const executor = makeExecutor((options) => {
        if (options.command === "git") {
          return execResult();
        }
        if (options.command === "codex") {
          return execResult({ exitCode: 1, stderr: "codex unavailable", all: "codex unavailable" });
        }
        throw new Error("Cursor must not run after a hard failure");
      });

      await expect(
        runFix(
          {
            config,
            cwd: dir,
            fixDir: join(dir, "fix"),
            review,
            reviewJsonPath: "review.json",
            dryRun: false
          },
          executor
        )
      ).rejects.toThrow("codex unavailable");
      expect(executor.calls.some((call) => call.command === "agent")).toBe(false);
    });
  });

  it("preserves the termination signal in Codex failure details", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixers = ["codex"];
      const executor = makeExecutor((options) =>
        options.command === "git"
          ? execResult()
          : execResult({ exitCode: 1, signal: "SIGKILL", isCanceled: true, stderr: "killed" })
      );

      await expect(
        runFix(
          {
            config,
            cwd: dir,
            fixDir: join(dir, "fix"),
            review,
            reviewJsonPath: "review.json",
            dryRun: false
          },
          executor
        )
      ).rejects.toThrow("terminated by SIGKILL");
    });
  });

  it("fails over on no_changes and returns it only after the final fixer", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixer_mode = "failover";
      const executor = makeExecutor((options) =>
        options.command === "git" ? execResult() : execResult({ stdout: "nothing to apply" })
      );

      const result = await runFix(
        {
          config,
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result).toMatchObject({
        status: "no_changes",
        activeFixer: "codex",
        reason: expect.stringContaining("made no working-tree changes")
      });
      expect(result.attempts).toHaveLength(2);
      expect(result.failovers).toHaveLength(1);
      expect(executor.calls.some((call) => call.command === "agent")).toBe(true);
      expect(executor.calls.some((call) => call.command === "codex")).toBe(true);
    });
  });

  it("skips fixer execution when the review contains no tasks", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => {
        throw new Error("fixer must not run without review tasks");
      });
      const result = await runFix(
        {
          config: createDefaultConfig("demo"),
          cwd: dir,
          fixDir: join(dir, "fix"),
          review: { summary: "nothing actionable", overall_risk: "low", tasks: [] },
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result).toMatchObject({ status: "skipped", reason: expect.stringContaining("No review tasks") });
      expect(executor.calls).toHaveLength(0);
      expect(await readFile(result.outputPaths[0]!, "utf8")).toContain("fixer execution skipped");
    });
  });

  it("preserves codex changes when cursor times out in sequential mode", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixers = ["codex", "cursor"];
      config.agents.fixer_mode = "sequential";
      let status = "";
      const executor = makeExecutor((options) => {
        if (options.command === "git") {
          return execResult({ stdout: status });
        }
        if (options.command === "codex") {
          status = " M src/a.ts\n";
          return execResult({ stdout: "codex fixed", all: "codex fixed" });
        }
        return execResult({ exitCode: 124, timedOut: true, stderr: "timed out", all: "timed out" });
      });

      const result = await runFix(
        {
          config,
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
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]).toMatchObject({ fixer: "codex", status: "completed" });
      expect(result.attempts[1]).toMatchObject({ fixer: "cursor", status: "failed" });
    });
  });

  it("classifies token limits even when a fixer times out", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixer_mode = "failover";
      const executor = makeExecutor((options) => {
        if (options.command === "git") {
          return execResult({ stdout: " M src/a.ts\n" });
        }
        return execResult({
          exitCode: 124,
          timedOut: true,
          stderr: "rate limit exceeded after retries",
          all: "rate limit exceeded after retries"
        });
      });

      const result = await runFix(
        {
          config,
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result.status).toBe("human_review_required");
      expect(result.reason).toContain("token limit");
      expect(result.attempts[0]?.status).toBe("token_limited");
    });
  });

  it("throws a specific error when a fixer times out", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixer_mode = "failover";
      const executor = makeExecutor((options) =>
        options.command === "git"
          ? execResult()
          : execResult({ exitCode: 124, timedOut: true, stderr: "timed out", all: "timed out" })
      );

      await expect(
        runFix(
          {
            config,
            cwd: dir,
            fixDir: join(dir, "fix"),
            review,
            reviewJsonPath: "review.json",
            dryRun: false
          },
          executor
        )
      ).rejects.toThrow("cursor fixer timed out");
    });
  });

  it("detects content changes when an already-modified file keeps the same porcelain status", async () => {
    await withTempDir(async (dir) => {
      let diff = "before";
      const executor = makeExecutor((options) => {
        if (options.command === "git" && options.args?.[0] === "status") {
          return execResult({ stdout: " M src/a.ts\n" });
        }
        if (options.command === "git") {
          return execResult({ stdout: diff });
        }
        diff = "after";
        return execResult({ stdout: "fixed" });
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
      expect(result.attempts[0]?.changed).toBe(true);
    });
  });

  it("returns human review when all fixers hit token limits", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixer_mode = "failover";
      const executor = makeExecutor((options) =>
        options.command === "git"
          ? execResult()
          : execResult({ exitCode: 1, stderr: "rate limit exceeded", all: "rate limit exceeded" })
      );
      const result = await runFix(
        {
          config,
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
      expect(result.reason).toContain("exited with code 1");
    });
  });

  it("does not misclassify a successful fixer that echoes token-limit text", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.agents.fixers = ["codex"];
      let status = "";
      const executor = makeExecutor((options) => {
        if (options.command === "git") return execResult({ stdout: status });
        status = " M src/a.ts\n";
        return execResult({ exitCode: 0, stdout: "rate limit exceeded", all: "rate limit exceeded" });
      });

      const result = await runFix(
        {
          config,
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result.status).toBe("completed");
      expect(result.attempts[0]).toMatchObject({ status: "completed", changed: true });
    });
  });

  it("does not run another fixer over partial token-limited changes", async () => {
    await withTempDir(async (dir) => {
      let status = "";
      const executor = makeExecutor((options) => {
        if (options.command === "git") return execResult({ stdout: status });
        if (options.command === "codex") {
          status = " M src/a.ts\n";
          return execResult({ exitCode: 1, stderr: "quota exceeded", all: "quota exceeded" });
        }
        throw new Error("Cursor must not run over partial Codex changes");
      });

      const config = createDefaultConfig("demo");
      config.agents.fixers = ["codex", "cursor"];

      const result = await runFix(
        {
          config,
          cwd: dir,
          fixDir: join(dir, "fix"),
          review,
          reviewJsonPath: "review.json",
          dryRun: false
        },
        executor
      );

      expect(result).toMatchObject({
        status: "human_review_required",
        reason: expect.stringContaining("partial changes")
      });
      expect(executor.calls.some((call) => call.command === "agent")).toBe(false);
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

  it("ignores broad token-limit prose from stdout after a failed exit", () => {
    expect(
      detectTokenLimit({
        result: execResult({ exitCode: 1, stdout: "quota exceeded", stderr: "" })
      })
    ).toBe(false);
  });

  it("detects narrow rate-limit diagnostics from stdout after a failed exit", () => {
    expect(
      detectTokenLimit({
        result: execResult({ exitCode: 1, stdout: "API error: rate_limit_exceeded", stderr: "" })
      })
    ).toBe(true);
    expect(
      detectTokenLimit({
        result: execResult({ exitCode: 1, stdout: "Request failed with HTTP 429", stderr: "" })
      })
    ).toBe(true);
  });

  it("ignores token-limit diagnostics emitted with a successful exit", () => {
    expect(
      detectTokenLimit({
        result: execResult({ exitCode: 0, stdout: "rate limit exceeded", stderr: "" })
      })
    ).toBe(false);
  });

  it("does not treat an unrelated 429 location as a token limit", () => {
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

  it("does not treat an unrelated line number as a token limit", () => {
    expect(
      detectTokenLimit({
        result: execResult({
          exitCode: 1,
          stdout: "Error on line 429.",
          stderr: ""
        })
      })
    ).toBe(false);
  });

  it("ignores token-limit text outside the inspected output tail", () => {
    expect(
      detectTokenLimit({
        result: execResult({ exitCode: 1, stderr: `quota exceeded${"x".repeat(4_100)}` })
      })
    ).toBe(false);
  });
});
