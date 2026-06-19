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
});
