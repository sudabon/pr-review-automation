import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitRepository, ensureRequiredCliCommands, PreflightError } from "../src/git/checks.js";
import { collectDiff } from "../src/git/collectDiff.js";
import { commitChanges } from "../src/git/commitChanges.js";
import { createPullRequest } from "../src/git/createPullRequest.js";
import { createRunDirectory } from "../src/logs/createRunDirectory.js";
import { writeCommandLog } from "../src/logs/writeCommandLog.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

describe("git and logs", () => {
  it("rejects non-Git directories", async () => {
    const executor = makeExecutor(() => execResult({ stdout: "false", exitCode: 1 }));
    await expect(ensureGitRepository("/tmp/not-git", executor)).rejects.toThrow(PreflightError);
  });

  it("checks each required CLI once and reports missing commands", async () => {
    const executor = makeExecutor((options) =>
      options.command === "missing" ? execResult({ exitCode: 1 }) : execResult({ stdout: "1.0.0" })
    );

    await expect(ensureRequiredCliCommands(["claude", "claude", "missing"], "/repo", executor)).rejects.toThrow(
      "Required CLI is not available: missing"
    );
    expect(executor.calls.map((call) => call.command)).toEqual(["claude", "missing"]);
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

  it("rejects run IDs that can escape the run directory", async () => {
    await withTempDir(async (dir) => {
      await expect(createRunDirectory(dir, "../outside")).rejects.toThrow("Invalid run_id");
      await expect(createRunDirectory(dir, "..")).rejects.toThrow("Invalid run_id");
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

  it("counts only changed hunk lines and ignores binary patch payloads", async () => {
    await withTempDir(async (dir) => {
      const patch = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        "++++added content beginning with plus signs",
        " unchanged",
        "diff --git a/image.png b/image.png",
        "GIT binary patch",
        "literal 12345",
        "zcmV;429payload"
      ].join("\n");
      const executor = makeExecutor((options) =>
        options.args?.[0] === "status" ? execResult({ stdout: "## main\n" }) : execResult({ stdout: patch })
      );

      const result = await collectDiff(
        { cwd: dir, baseBranch: "main", targetBranch: "feature", inputDir: join(dir, "input") },
        executor
      );

      expect(result.lineCount).toBe(3);
      expect(executor.calls.at(-1)?.args).toEqual(["diff", "--binary", "main...feature"]);
    });
  });

  it("throws when git status collection fails", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => execResult({ exitCode: 1, stderr: "not a repository" }));

      await expect(
        collectDiff({ cwd: dir, baseBranch: "main", inputDir: join(dir, "input") }, executor)
      ).rejects.toThrow("Failed to collect git status: not a repository");
      expect(executor.calls).toHaveLength(1);
    });
  });

  it("throws when git diff collection fails", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor((options) =>
        options.args?.[0] === "status"
          ? execResult({ stdout: "## main\n" })
          : execResult({ exitCode: 1, stderr: "bad revision" })
      );

      await expect(
        collectDiff({ cwd: dir, baseBranch: "main", inputDir: join(dir, "input") }, executor)
      ).rejects.toThrow("Failed to collect git diff: bad revision");
      expect(executor.calls).toHaveLength(2);
    });
  });

  it("falls back to combined output and exit code for git failures", async () => {
    await withTempDir(async (dir) => {
      const combinedExecutor = makeExecutor(() => execResult({ exitCode: 1, all: "combined failure" }));
      await expect(
        collectDiff({ cwd: dir, baseBranch: "main", inputDir: join(dir, "input") }, combinedExecutor)
      ).rejects.toThrow("combined failure");

      const exitCodeExecutor = makeExecutor(() => execResult({ exitCode: 7, all: "" }));
      await expect(commitChanges({ cwd: dir }, exitCodeExecutor)).rejects.toThrow("git exited with code 7");
    });
  });

  it("collects one merge-base diff so staged changes are not double-counted", async () => {
    await withTempDir(async (dir) => {
      const patch = [
        "diff --git a/a.ts b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new"
      ].join("\n");
      const executor = makeExecutor((options) =>
        options.args?.[0] === "status" ? execResult({ stdout: "## feature\n M a.ts\n" }) : execResult({ stdout: patch })
      );

      const result = await collectDiff(
        { cwd: dir, baseBranch: "main", inputDir: join(dir, "input") },
        executor
      );

      expect(result.lineCount).toBe(2);
      expect(executor.calls.filter((call) => call.args?.[0] === "diff")).toHaveLength(1);
      expect(executor.calls.at(-1)?.args).toEqual(["diff", "--binary", "--merge-base", "main"]);
    });
  });

  it("fails commit tracking when HEAD cannot be resolved", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor((options) => {
        if (options.args?.[0] === "status") {
          return execResult({ stdout: " M file.ts\n" });
        }
        if (options.args?.[0] === "add") {
          return execResult();
        }
        if (options.args?.[0] === "commit") {
          return execResult();
        }
        if (options.args?.join(" ") === "rev-parse HEAD") {
          return execResult({ exitCode: 1, stderr: "bad revision" });
        }
        return execResult();
      });

      await expect(commitChanges({ cwd: dir }, executor)).rejects.toThrow("Failed to read committed HEAD");
    });
  });

  it("returns early for a clean tree and reports a successful commit SHA", async () => {
    const cleanExecutor = makeExecutor(() => execResult({ stdout: "" }));
    await expect(commitChanges({ cwd: "/repo" }, cleanExecutor)).resolves.toEqual({ committed: false });
    expect(cleanExecutor.calls).toHaveLength(1);

    const commitExecutor = makeExecutor((options) =>
      options.args?.join(" ") === "status --porcelain"
        ? execResult({ stdout: " M file.ts\n" })
        : options.args?.join(" ") === "rev-parse HEAD"
          ? execResult({ stdout: "abc123\n" })
          : execResult()
    );
    await expect(commitChanges({ cwd: "/repo" }, commitExecutor)).resolves.toEqual({
      committed: true,
      sha: "abc123"
    });
    expect(commitExecutor.calls.map((call) => call.args?.[0])).toEqual(["status", "add", "commit", "rev-parse"]);
  });

  it("creates a pull request with configured args and records the URL", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor((options) =>
        options.args?.join(" ") === "auth status"
          ? execResult()
          : execResult({ stdout: "https://github.com/example/repo/pull/42\n" })
      );

      const result = await createPullRequest(
        {
          cwd: dir,
          command: 'gh pr create --title "AI fixes" --fill',
          metaDir: join(dir, "meta")
        },
        executor
      );

      expect(result).toEqual({ status: "created", url: "https://github.com/example/repo/pull/42" });
      expect(executor.calls[1]?.args).toEqual(["pr", "create", "--title", "AI fixes", "--fill"]);
      expect(await readFile(join(dir, "meta", "pr-result.json"), "utf8")).toContain("pull/42");
    });
  });

  it("records a skipped pull request when gh is unavailable", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => {
        throw new Error("spawn gh ENOENT");
      });

      const result = await createPullRequest(
        { cwd: dir, command: "gh pr create --fill", metaDir: join(dir, "meta") },
        executor
      );

      expect(result).toEqual({ status: "skipped", reason: "spawn gh ENOENT" });
      expect(await readFile(join(dir, "meta", "pr-result.json"), "utf8")).toContain("spawn gh ENOENT");
    });
  });
});
