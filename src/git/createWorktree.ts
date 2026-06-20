import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Config } from "../config/schema.js";
import { PreflightError } from "./checks.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export type WorktreeResult =
  | { mode: "current"; path: string }
  | { mode: "worktree"; path: string; branchName: string }
  | {
      mode: "branch";
      path: string;
      branchName: string;
      originalBranch?: string;
      originalRef?: string;
    };

export interface CleanupWorktreeInput {
  cwd: string;
  mode?: WorktreeResult["mode"];
  path: string;
  branchName?: string;
  originalBranch?: string;
  originalRef?: string;
  preserveForResume?: boolean;
  commandLogPath?: string;
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
  const repositoryRoot = resolve(cwd);
  const resolvedWorktreePath = resolve(worktreePath);
  const pathFromRepository = relative(repositoryRoot, resolvedWorktreePath);
  if (pathFromRepository === "" || pathFromRepository === ".." || pathFromRepository.startsWith(`..${sep}`)) {
    throw new PreflightError("git.worktree_dir must resolve inside the repository.");
  }
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

  const failureReason = addResult.stderr || addResult.all || `git exited with code ${addResult.exitCode}`;
  const reason = `git worktree add failed; refusing to modify the current working tree: ${failureReason}`;
  if (commandLogPath) {
    try {
      const at = new Date().toISOString();
      await writeCommandLog(commandLogPath, {
        command: "git worktree add",
        event: "worktree_creation_failed",
        reason,
        started_at: at,
        ended_at: at,
        exit_code: addResult.exitCode
      });
    } catch (error) {
      console.warn(
        `[ai-dev-loop] failed to record worktree creation failure: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw new PreflightError(reason);
}

export async function cleanupWorktree(
  input: CleanupWorktreeInput,
  executor: CommandExecutor = execWithTimeout
): Promise<void> {
  if (input.preserveForResume) {
    return;
  }

  if (input.mode === "branch") {
    const restoreArgs = input.originalBranch
      ? ["switch", input.originalBranch]
      : input.originalRef
        ? ["switch", "--detach", input.originalRef]
        : undefined;
    if (!restoreArgs) {
      return;
    }
    const restore = await executor({
      command: "git",
      args: restoreArgs,
      cwd: input.cwd,
      commandLogPath: input.commandLogPath
    });
    if (restore.exitCode !== 0) {
      throw new Error(`Failed to restore the original checkout: ${restore.stderr || restore.all}`);
    }

    if (input.branchName) {
      await deleteTemporaryBranch(input.cwd, input.branchName, input.commandLogPath, executor);
    }
    return;
  }

  if (input.mode !== "worktree") {
    return;
  }

  const remove = await executor({
    command: "git",
    args: ["worktree", "remove", "--force", input.path],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });
  if (remove.exitCode !== 0) {
    throw new Error(`Failed to remove worktree ${input.path}: ${remove.stderr || remove.all}`);
  }

  if (!input.branchName) {
    return;
  }

  await deleteTemporaryBranch(input.cwd, input.branchName, input.commandLogPath, executor);
}

async function deleteTemporaryBranch(
  cwd: string,
  branchName: string,
  commandLogPath: string | undefined,
  executor: CommandExecutor
): Promise<void> {
  const deleteBranch = await executor({
    command: "git",
    args: ["branch", "-D", branchName],
    cwd,
    commandLogPath
  });
  if (deleteBranch.exitCode !== 0) {
    throw new Error(`Failed to delete temporary branch ${branchName}: ${deleteBranch.stderr || deleteBranch.all}`);
  }
}
