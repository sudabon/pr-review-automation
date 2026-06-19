import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/schema.js";
import { cleanupWorktree, createWorktree } from "../src/git/createWorktree.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

describe("worktree lifecycle", () => {
  it("restores the original branch after the temporary-branch fallback", async () => {
    await withTempDir(async (dir) => {
      const config = createDefaultConfig("demo");
      const executor = makeExecutor((options) => {
        const args = options.args?.join(" ") ?? "";
        if (args.startsWith("worktree add")) {
          return execResult({ exitCode: 1, stderr: "worktree unavailable" });
        }
        if (args === "branch --show-current") {
          return execResult({ stdout: "feature\n" });
        }
        if (args === "rev-parse HEAD") {
          return execResult({ stdout: "abc123\n" });
        }
        return execResult();
      });

      const worktree = await createWorktree(dir, config, "run-1", undefined, undefined, executor);
      expect(worktree).toMatchObject({
        mode: "branch",
        originalBranch: "feature",
        originalRef: "abc123"
      });

      await cleanupWorktree(
        {
          cwd: dir,
          mode: worktree.mode,
          path: worktree.path,
          branchName: worktree.branchName,
          originalBranch: worktree.originalBranch,
          originalRef: worktree.originalRef
        },
        executor
      );

      expect(executor.calls.some((call) => call.args?.join(" ") === "switch feature")).toBe(true);
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
});
