import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
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

export interface FixRunnerResult {
  fixer: "codex" | "cursor";
  status: "completed" | "failed" | "token_limited";
  promptPath: string;
  outputPath: string;
  execResult: ExecResult;
  changed?: boolean;
  failureReason?: string;
  tokenLimitPattern?: string;
}

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
    args: [...input.config.codex.args, prompt],
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

  if (tokenLimitPattern && input.commandLogPath) {
    const at = new Date().toISOString();
    await writeCommandLog(input.commandLogPath, {
      command: "token-limit-detected codex",
      event: "token_limit_detected",
      reason: tokenLimitPattern,
      started_at: at,
      ended_at: at,
      exit_code: execResult.exitCode
    });
  }

  const requiresChanges = input.review.tasks.length > 0;
  const completed = execResult.exitCode === 0 && !execResult.timedOut && (changed || !requiresChanges);
  return {
    fixer: "codex",
    status: completed ? "completed" : tokenLimitPattern ? "token_limited" : "failed",
    promptPath,
    outputPath,
    execResult,
    changed,
    failureReason:
      execResult.exitCode === 0 && !execResult.timedOut && requiresChanges && !changed
        ? "codex exited successfully but made no working-tree changes"
        : undefined,
    tokenLimitPattern
  };
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
