import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export interface CollectDiffInput {
  cwd: string;
  baseBranch: string;
  targetBranch?: string;
  inputDir: string;
  commandLogPath?: string;
}

export interface DiffResult {
  diffPath: string;
  statusPath: string;
  diff: string;
  status: string;
  isEmpty: boolean;
  lineCount: number;
}

export async function collectDiff(
  input: CollectDiffInput,
  executor: CommandExecutor = execWithTimeout
): Promise<DiffResult> {
  await mkdir(input.inputDir, { recursive: true });
  const diffPath = join(input.inputDir, "diff.patch");
  const statusPath = join(input.inputDir, "status.txt");

  const statusResult = await executor({
    command: "git",
    args: ["status", "--short", "--branch"],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });
  if (statusResult.exitCode !== 0) {
    throw new Error(`Failed to collect git status: ${statusResult.stderr}`);
  }

  const range = input.targetBranch
    ? `${input.baseBranch}...${input.targetBranch}`
    : `${input.baseBranch}...HEAD`;
  const diffResult = await executor({
    command: "git",
    args: ["diff", "--binary", range],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath
  });
  if (diffResult.exitCode !== 0) {
    throw new Error(`Failed to collect git diff: ${diffResult.stderr}`);
  }

  const staged = input.targetBranch
    ? ""
    : await collectOptionalDiff(["diff", "--binary", "--cached"], input.cwd, input.commandLogPath, executor);
  const unstaged = input.targetBranch
    ? ""
    : await collectOptionalDiff(["diff", "--binary"], input.cwd, input.commandLogPath, executor);

  const sections = [
    diffResult.stdout.trim(),
    staged.trim() ? `\n# Staged changes\n${staged.trim()}` : "",
    unstaged.trim() ? `\n# Unstaged changes\n${unstaged.trim()}` : ""
  ].filter(Boolean);
  const diff = sections.join("\n");

  await writeFile(diffPath, diff, "utf8");
  await writeFile(statusPath, statusResult.stdout, "utf8");

  return {
    diffPath,
    statusPath,
    diff,
    status: statusResult.stdout,
    isEmpty: diff.trim().length === 0,
    lineCount: countChangedLines(diff)
  };
}

function countChangedLines(diff: string): number {
  let inHunk = false;
  let count = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch")) {
      inHunk = false;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      count += 1;
    }
  }

  return count;
}

async function collectOptionalDiff(
  args: string[],
  cwd: string,
  commandLogPath: string | undefined,
  executor: CommandExecutor
): Promise<string> {
  const result = await executor({
    command: "git",
    args,
    cwd,
    commandLogPath
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to collect git diff: ${result.stderr}`);
  }
  return result.stdout;
}
