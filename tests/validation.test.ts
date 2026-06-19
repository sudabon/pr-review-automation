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
      config.commands.lint = "lint";
      config.commands.typecheck = "typecheck";
      config.commands.test = "";
      config.commands.build = "build";
      config.limits.stop_on_validation_failure = false;
      const executor = makeExecutor((options) => {
        if (options.command === "typecheck") {
          return execResult({ exitCode: 1, stdout: "type error", all: "type error" });
        }
        return execResult({ stdout: `${options.command} ok`, all: `${options.command} ok` });
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
      expect(executor.calls.map((call) => call.command)).toEqual(["lint", "typecheck", "build"]);
    });
  });
});
