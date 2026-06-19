import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitRepository, PreflightError } from "../src/git/checks.js";
import { collectDiff } from "../src/git/collectDiff.js";
import { createRunDirectory } from "../src/logs/createRunDirectory.js";
import { writeCommandLog } from "../src/logs/writeCommandLog.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

describe("git and logs", () => {
  it("rejects non-Git directories", async () => {
    const executor = makeExecutor(() => execResult({ stdout: "false", exitCode: 1 }));
    await expect(ensureGitRepository("/tmp/not-git", executor)).rejects.toThrow(PreflightError);
  });

  it("creates the run directory tree and appends command logs", async () => {
    await withTempDir(async (dir) => {
      const run = await createRunDirectory(dir, "run-1");
      await mkdir(run.inputDir, { recursive: true });
      await writeCommandLog(run.commandLogPath, {
        command: "git status",
        started_at: "2026-06-19T00:00:00.000Z",
        ended_at: "2026-06-19T00:00:01.000Z",
        exit_code: 0
      });

      const line = (await readFile(run.commandLogPath, "utf8")).trim();
      expect(JSON.parse(line)).toMatchObject({ command: "git status", exit_code: 0 });
    });
  });

  it("collects an empty diff and writes status/diff artifacts", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor((options) => {
        if (options.args?.[0] === "status") {
          return execResult({ stdout: "## main\n" });
        }
        return execResult({ stdout: "" });
      });

      const result = await collectDiff(
        {
          cwd: dir,
          baseBranch: "main",
          inputDir: join(dir, "input")
        },
        executor
      );

      expect(result.isEmpty).toBe(true);
      expect(await readFile(result.statusPath, "utf8")).toContain("main");
      expect(await readFile(result.diffPath, "utf8")).toBe("");
    });
  });
});
