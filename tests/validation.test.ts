import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { runValidation } from "../src/runners/runValidation.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

describe("validation runner", () => {
  it("runs validation commands in order, records failures, and skips empty commands", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.lint = "pnpm run lint";
      config.commands.typecheck = "typecheck";
      config.commands.test = "";
      config.commands.build = "build";
      config.limits.stop_on_validation_failure = false;
      const executor = makeExecutor((options) => {
        if (options.args?.[1] === "typecheck") {
          return execResult({ exitCode: 1, stdout: "type error", all: "type error" });
        }
        return execResult({ stdout: `${options.args?.[1]} ok`, all: `${options.args?.[1]} ok` });
      });

      const result = await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(result.status).toBe("failed");
      expect(result.stop_on_validation_failure).toBe(false);
      expect(result.steps.lint.status).toBe("passed");
      expect(result.steps.typecheck.status).toBe("failed");
      expect(result.steps.test.status).toBe("skipped");
      expect(result.steps.build.status).toBe("passed");
      expect(await readFile(join(dir, "validation", "typecheck.log"), "utf8")).toContain("type error");
      expect(await readFile(join(dir, "validation", "validation-result.json"), "utf8")).toContain("failed");
      expect(executor.calls.map((call) => [call.command, ...(call.args ?? [])].join(" "))).toEqual([
        "pnpm run lint",
        "pnpm run typecheck",
        "pnpm run build"
      ]);
      expect(executor.calls.every((call) => call.shell !== true)).toBe(true);
    });
  });

  it("rejects unsafe validation commands without invoking a shell", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.lint = "pnpm run lint && rm -rf .";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      const executor = makeExecutor(() => {
        throw new Error("should not run");
      });

      const result = await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(result.status).toBe("failed");
      expect(result.steps.lint.status).toBe("failed");
      expect(result.steps.lint.exit_code).toBe(1);
      expect(await readFile(join(dir, "validation", "lint.log"), "utf8")).toContain("Refusing to run unsafe");
      expect(executor.calls).toHaveLength(0);
    });
  });

  it("uses the configured package manager for default bare scripts", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.project.package_manager = "npm";
      const executor = makeExecutor(() => execResult());

      await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(executor.calls.map((call) => [call.command, ...(call.args ?? [])].join(" "))).toEqual([
        "npm run lint",
        "npm run typecheck",
        "npm run test",
        "npm run build"
      ]);
    });
  });

  it("explains package-manager mismatches without executing them", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.project.package_manager = "npm";
      config.commands.lint = "pnpm run lint";
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      const executor = makeExecutor(() => {
        throw new Error("should not run");
      });

      const result = await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(result.steps.lint.stderr).toContain('uses package manager "pnpm"');
      expect(result.steps.lint.stderr).toContain('project.package_manager is "npm"');
      expect(executor.calls).toHaveLength(0);
    });
  });

  it("records timeout and stderr details for failed validation steps", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      const executor = makeExecutor(() =>
        execResult({ exitCode: 124, timedOut: true, stderr: "lint timed out", all: "lint timed out" })
      );

      const result = await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(result.steps.lint).toMatchObject({
        status: "failed",
        exit_code: 124,
        timed_out: true,
        stderr: "lint timed out"
      });
    });
  });

  it("does not pass a timed-out validation step with a zero exit code", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      const executor = makeExecutor(() => execResult({ exitCode: 0, timedOut: true }));

      const result = await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(result.status).toBe("failed");
      expect(result.steps.lint.status).toBe("failed");
    });
  });

  it("records signal and cancellation details for terminated validation", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      config.commands.typecheck = "";
      config.commands.test = "";
      config.commands.build = "";
      const executor = makeExecutor(() =>
        execResult({ exitCode: 0, signal: "SIGKILL", isCanceled: true, stderr: "killed" })
      );

      const result = await runValidation(config, dir, join(dir, "validation"), undefined, executor);

      expect(result.steps.lint).toMatchObject({
        status: "failed",
        signal: "SIGKILL",
        is_canceled: true
      });
      expect(await readFile(join(dir, "validation", "validation-result.json"), "utf8")).toContain('"SIGKILL"');
    });
  });
});
