import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export interface CommitChangesInput {
  cwd: string;
  message?: string;
  commandLogPath?: string;
}

export async function commitChanges(
  input: CommitChangesInput,
  executor: CommandExecutor = execWithTimeout
): Promise<{ committed: boolean; sha?: string }> {
  const status = await executor({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });
  if (status.exitCode !== 0) {
    throw new Error(`Failed to inspect git status before commit: ${status.stderr}`);
  }
  if (!status.stdout.trim()) {
    return { committed: false };
  }

  const add = await executor({
    command: "git",
    args: ["add", "-A"],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });
  if (add.exitCode !== 0) {
    throw new Error(`Failed to stage changes: ${add.stderr}`);
  }

  const commit = await executor({
    command: "git",
    args: ["commit", "-m", input.message ?? "Apply AI dev loop fixes"],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit changes: ${commit.stderr}`);
  }

  const sha = await executor({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });

  return { committed: true, sha: sha.stdout.trim() || undefined };
}
