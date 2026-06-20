import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { PreflightError } from "../src/git/checks.js";
import { cleanupWorktree, createWorktree } from "../src/git/createWorktree.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

describe("worktree lifecycle", () => {
  it("stops without changing the current checkout when worktree creation fails", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      const commandLogPath = join(dir, "meta", "command-log.jsonl");
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args.startsWith("worktree add")) {
          return execResult({ exitCode: 1, stderr: "worktree unavailable" });
        }
        throw new Error(`Unexpected command: ${args}`);
      });

      await expect(createWorktree(dir, config, "run-1", undefined, commandLogPath, executor)).rejects.toThrow(
        PreflightError
      );
      expect(executor.calls).toHaveLength(1);
      expect(await readFile(commandLogPath, "utf8")).toContain('"event":"worktree_creation_failed"');
    });
  });

  it("creates and cleans up a temporary worktree", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => execResult());
      const worktree = await createWorktree(dir, createDefaultConfig("demo"), "run-1", "feature", undefined, executor);

      expect(worktree).toMatchObject({
        mode: "worktree",
        path: join(dir, ".ai-dev-loop", "worktrees", "run-1"),
        branchName: "ai-dev-loop/run-1"
      });
      expect(executor.calls[0]?.args).toEqual([
        "worktree",
        "add",
        "-b",
        "ai-dev-loop/run-1",
        worktree.path,
        "feature"
      ]);

      await cleanupWorktree({ cwd: dir, ...worktree }, executor);

      expect(executor.calls.some((call) => call.args?.join(" ") === `worktree remove --force ${worktree.path}`)).toBe(
        true
      );
      expect(executor.calls.some((call) => call.args?.join(" ") === "branch -D ai-dev-loop/run-1")).toBe(true);
    });
  });

  it("keeps a worktree that is needed for resume", async () => {
    await withTempDir(async (dir) => {
      const executor = makeExecutor(() => execResult());
      await cleanupWorktree(
        {
          cwd: dir,
          mode: "worktree",
          path: `${dir}/preserved`,
          branchName: "ai-dev-loop/run-1",
          preserveForResume: true
        },
        executor
      );

      expect(executor.calls).toHaveLength(0);
    });
  });

  it("keeps a fallback branch when preservation is requested", async () => {
    const executor = makeExecutor(() => execResult());
    await cleanupWorktree(
      {
        cwd: "/repo",
        mode: "branch",
        path: "/repo",
        branchName: "ai-dev-loop/run-1",
        originalBranch: "feature",
        preserveForResume: true
      },
      executor
    );

    expect(executor.calls).toHaveLength(0);
  });

  it("restores and deletes a legacy fallback branch", async () => {
    const executor = makeExecutor(() => execResult());
    await cleanupWorktree(
      {
        cwd: "/repo",
        mode: "branch",
        path: "/repo",
        branchName: "ai-dev-loop/run-1",
        originalBranch: "feature"
      },
      executor
    );

    expect(executor.calls.map((call) => call.args?.join(" "))).toEqual([
      "switch feature",
      "branch -D ai-dev-loop/run-1"
    ]);
  });

  it("throws when restoring the original checkout fails", async () => {
    const executor = makeExecutor(() => execResult({ exitCode: 1, stderr: "restore failed" }));
    await expect(
      cleanupWorktree({ cwd: "/repo", mode: "branch", path: "/repo", originalBranch: "feature" }, executor)
    ).rejects.toThrow("Failed to restore the original checkout");
  });

  it("throws when removing the worktree fails", async () => {
    const executor = makeExecutor(() => execResult({ exitCode: 1, stderr: "remove failed" }));
    await expect(
      cleanupWorktree({ cwd: "/repo", mode: "worktree", path: "/repo/worktree", branchName: "temp" }, executor)
    ).rejects.toThrow("Failed to remove worktree");
  });

  it("throws when deleting the temporary branch fails", async () => {
    const executor = makeExecutor((options) =>
      options.args?.[0] === "branch" ? execResult({ exitCode: 1, stderr: "delete failed" }) : execResult()
    );
    await expect(
      cleanupWorktree({ cwd: "/repo", mode: "worktree", path: "/repo/worktree", branchName: "temp" }, executor)
    ).rejects.toThrow("Failed to delete temporary branch");
  });
});
