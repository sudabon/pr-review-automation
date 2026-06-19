import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export async function ensureGitRepository(
  cwd: string,
  executor: CommandExecutor = execWithTimeout
): Promise<string> {
  const inside = await executor({
    command: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd
  });

  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    throw new PreflightError("Current directory is not a Git repository.");
  }

  const root = await executor({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd
  });

  if (root.exitCode !== 0 || !root.stdout.trim()) {
    throw new PreflightError("Unable to determine Git repository root.");
  }

  return root.stdout.trim();
}

export async function ensureCommandAvailable(
  command: string,
  cwd: string,
  executor: CommandExecutor = execWithTimeout
): Promise<void> {
  const result = await executor({
    command,
    args: ["--version"],
    cwd,
    timeoutMs: 10_000
  });

  if (result.exitCode !== 0) {
    throw new PreflightError(`Required CLI is not available: ${command}`);
  }
}

export async function ensureRequiredCliCommands(
  commands: string[],
  cwd: string,
  executor: CommandExecutor = execWithTimeout
): Promise<void> {
  for (const command of [...new Set(commands)]) {
    await ensureCommandAvailable(command, cwd, executor);
  }
}
