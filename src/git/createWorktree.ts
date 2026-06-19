import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export interface WorktreeResult {
  mode: "worktree" | "branch" | "current";
  path: string;
  branchName?: string;
}

export async function createWorktree(
  cwd: string,
  config: Config,
  runId: string,
  targetBranch: string | undefined,
  commandLogPath?: string,
  executor: CommandExecutor = execWithTimeout
): Promise<WorktreeResult> {
  if (!config.git.use_worktree) {
    return { mode: "current", path: cwd };
  }

  const branchName = `ai-dev-loop/${runId}`;
  const worktreePath = join(cwd, config.git.worktree_dir, runId);
  await mkdir(join(cwd, config.git.worktree_dir), { recursive: true });

  const addResult = await executor({
    command: "git",
    args: ["worktree", "add", "-b", branchName, worktreePath, targetBranch ?? "HEAD"],
    cwd,
    commandLogPath
  });

  if (addResult.exitCode === 0) {
    return { mode: "worktree", path: worktreePath, branchName };
  }

  const branchResult = await executor({
    command: "git",
    args: ["switch", "-c", branchName],
    cwd,
    commandLogPath
  });

  if (branchResult.exitCode !== 0) {
    throw new Error(`Failed to create worktree or temporary branch: ${branchResult.stderr || addResult.stderr}`);
  }

  return { mode: "branch", path: cwd, branchName };
}
