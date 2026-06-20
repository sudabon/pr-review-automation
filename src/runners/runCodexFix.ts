import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, FixerName } from "../config/schema.js";
import { buildCodexFixPrompt } from "../prompts/buildCodexFixPrompt.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import type { ReviewJson } from "./reviewSchemas.js";
import { detectTokenLimitPattern } from "../utils/detectTokenLimit.js";
import { execWithTimeout, type CommandExecutor, type ExecResult } from "../utils/execWithTimeout.js";

export interface FixRunnerInput {
  config: Config;
  cwd: string;
  fixDir: string;
  review: ReviewJson;
  reviewJsonPath: string;
  commandLogPath?: string;
}

interface FixRunnerResultBase {
  fixer: FixerName;
  promptPath: string;
  outputPath: string;
  execResult: ExecResult;
}

export type FixRunnerResult =
  | (FixRunnerResultBase & { status: "completed"; changed: true })
  | (FixRunnerResultBase & { status: "no_changes"; changed: false; failureReason: string })
  | (FixRunnerResultBase & {
      status: "token_limited";
      changed: boolean;
      failureReason: string;
      tokenLimitPattern: string;
    })
  | (FixRunnerResultBase & { status: "failed"; changed: boolean; failureReason: string });

export async function runCodexFix(
  input: FixRunnerInput,
  executor: CommandExecutor = execWithTimeout
): Promise<FixRunnerResult> {
  await mkdir(input.fixDir, { recursive: true });
  const promptPath = join(input.fixDir, "codex-prompt.md");
  const outputPath = join(input.fixDir, "codex-output.md");
  const prompt = buildCodexFixPrompt({
    review: input.review,
    reviewJsonPath: input.reviewJsonPath
  });
  await writeFile(promptPath, prompt, "utf8");

  const statusBefore = await readWorkingTreeSnapshot(input.cwd, input.commandLogPath, executor);

  const execResult = await executor({
    command: input.config.codex.command,
    args: input.config.codex.args,
    input: prompt,
    cwd: input.cwd,
    timeoutMs: input.config.codex.timeout_sec * 1000,
    outputPath,
    commandLogPath: input.commandLogPath
  });
  const statusAfter = await readWorkingTreeSnapshot(input.cwd, input.commandLogPath, executor);
  const changed = statusBefore !== statusAfter;
  const tokenLimitPattern = execResult.timedOut
    ? undefined
    : detectTokenLimitPattern({ result: execResult, fixer: "codex", config: input.config });
  const tokenLimitFailure = tokenLimitPattern
    ? formatTokenLimitFailure("codex", execResult, tokenLimitPattern)
    : undefined;

  if (tokenLimitFailure && input.commandLogPath) {
    const at = new Date().toISOString();
    await writeCommandLog(input.commandLogPath, {
      command: "token-limit-detected codex",
      event: "token_limit_detected",
      reason: tokenLimitFailure,
      started_at: at,
      ended_at: at,
      exit_code: execResult.exitCode
    });
  }

  const requiresChanges = input.review.tasks.length > 0;
  const completed =
    execResult.exitCode === 0 && !execResult.timedOut && requiresChanges && changed && !tokenLimitPattern;
  const noChanges =
    execResult.exitCode === 0 && !execResult.timedOut && requiresChanges && !changed && !tokenLimitPattern;
  const base = {
    fixer: "codex" as const,
    promptPath,
    outputPath,
    execResult
  };
  if (tokenLimitPattern && tokenLimitFailure) {
    return { ...base, status: "token_limited", changed, failureReason: tokenLimitFailure, tokenLimitPattern };
  }
  if (completed) {
    return { ...base, status: "completed", changed: true };
  }
  if (noChanges) {
    return {
      ...base,
      status: "no_changes",
      changed: false,
      failureReason: "codex exited successfully but made no working-tree changes"
    };
  }
  return {
    ...base,
    status: "failed",
    changed,
    failureReason: !requiresChanges
      ? "codex was not given any review tasks"
      : formatExecutionFailure("codex", execResult)
  };
}

function formatExecutionFailure(fixer: string, result: ExecResult): string {
  const termination = result.signal
    ? ` was terminated by ${result.signal}`
    : result.isCanceled
      ? " was canceled"
      : ` exited with code ${result.exitCode}`;
  return `${fixer}${termination}: ${result.stderr || result.all || "unknown error"}`;
}

export function formatTokenLimitFailure(fixer: string, result: ExecResult, pattern: string): string {
  const stderrTail = result.stderr.trim().slice(-1_000);
  return `${fixer} exited with code ${result.exitCode}; token limit matched "${pattern}"${stderrTail ? `; stderr: ${stderrTail}` : ""}`;
}

export async function readWorkingTreeSnapshot(
  cwd: string,
  commandLogPath: string | undefined,
  executor: CommandExecutor
): Promise<string> {
  const result = await executor({
    command: "git",
    args: ["status", "--porcelain"],
    cwd,
    commandLogPath
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to inspect working tree around fixer execution: ${result.stderr || result.all}`);
  }
  const diff = await executor({
    command: "git",
    args: ["diff", "--binary", "HEAD"],
    cwd,
    commandLogPath
  });
  if (diff.exitCode !== 0) {
    throw new Error(`Failed to inspect working-tree diff around fixer execution: ${diff.stderr || diff.all}`);
  }
  return `${result.stdout}\0${diff.stdout}`;
}
