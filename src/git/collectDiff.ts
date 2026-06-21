import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import { loadIgnorePatterns } from "../safety/loadIgnorePatterns.js";
import { checkSafetyLimits, type SafetyCheckResult } from "../safety/checkSafetyLimits.js";

export interface CollectDiffInput {
  cwd: string;
  repoRoot: string;
  baseBranch: string;
  targetBranch?: string;
  inputDir: string;
  commandLogPath?: string;
  config?: Parameters<typeof checkSafetyLimits>[1];
}

export interface DiffResult {
  diffPath: string;
  statusPath: string;
  diff: string;
  rawDiff: string;
  status: string;
  isEmpty: boolean;
  isSameCommit?: boolean;
  lineCount: number;
  changedFiles: string[];
  filteredRemovedFiles: string[];
  safety?: SafetyCheckResult;
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
    commandLogPath: input.commandLogPath,
    step: "git_status"
  });
  if (statusResult.exitCode !== 0) {
    throw new Error(`Failed to collect git status: ${formatFailure(statusResult)}`);
  }

  const range = input.targetBranch
    ? `${input.baseBranch}...${input.targetBranch}`
    : `${input.baseBranch}...HEAD`;
  const diffResult = await executor({
    command: "git",
    args: input.targetBranch
      ? ["diff", "--binary", range]
      : ["diff", "--binary", "--merge-base", input.baseBranch],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath,
    step: "git_diff"
  });
  if (diffResult.exitCode !== 0) {
    throw new Error(`Failed to collect git diff: ${formatFailure(diffResult)}`);
  }

  const rawDiff = diffResult.stdout.trim();
  let isSameCommit = false;
  if (rawDiff.length === 0) {
    const baseCommit = await resolveCommit(input.baseBranch, input, executor);
    const targetCommit = await resolveCommit(input.targetBranch ?? "HEAD", input, executor);
    isSameCommit = baseCommit === targetCommit;
  }

  const ignorePatterns = await loadIgnorePatterns(input.repoRoot ?? input.cwd);
  const safety = input.config ? checkSafetyLimits(rawDiff, input.config, ignorePatterns) : undefined;
  const diff = safety?.filtered.diff ?? rawDiff;
  const lineCount = safety?.filtered.lineCount ?? countChangedLines(rawDiff);

  await writeFile(diffPath, diff, "utf8");
  await writeFile(statusPath, statusResult.stdout, "utf8");

  return {
    diffPath,
    statusPath,
    diff,
    rawDiff,
    status: statusResult.stdout,
    isEmpty: diff.trim().length === 0,
    isSameCommit,
    lineCount,
    changedFiles: safety?.filtered.changedFiles ?? [],
    filteredRemovedFiles: safety?.filtered.removedFiles ?? [],
    safety
  };
}

async function resolveCommit(
  ref: string,
  input: CollectDiffInput,
  executor: CommandExecutor
): Promise<string> {
  const result = await executor({
    command: "git",
    args: ["rev-parse", "--verify", `${ref}^{commit}`],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath,
    step: "git_rev_parse"
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`Failed to resolve git ref ${ref}: ${formatFailure(result)}`);
  }
  return result.stdout.trim();
}

function formatFailure(result: { stderr: string; all: string; exitCode: number }): string {
  return result.stderr || result.all || `git exited with code ${result.exitCode}`;
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
