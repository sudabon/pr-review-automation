import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { buildCursorFixPrompt } from "../prompts/buildCursorFixPrompt.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import { detectTokenLimitPattern } from "../utils/detectTokenLimit.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import type { ReviewJson } from "./reviewSchemas.js";
import { formatTokenLimitFailure, readWorkingTreeSnapshot, type FixRunnerResult } from "./runCodexFix.js";

export interface CursorFixRunnerInput {
  config: Config;
  cwd: string;
  fixDir: string;
  review: ReviewJson;
  reviewJsonPath: string;
  currentDiffPath?: string;
  commandLogPath?: string;
}

export async function runCursorFix(
  input: CursorFixRunnerInput,
  executor: CommandExecutor = execWithTimeout
): Promise<FixRunnerResult> {
  await mkdir(input.fixDir, { recursive: true });
  const promptPath = join(input.fixDir, "cursor-prompt.md");
  const outputPath = join(input.fixDir, "cursor-output.md");
  const prompt = buildCursorFixPrompt({
    review: input.review,
    reviewJsonPath: input.reviewJsonPath,
    currentDiffPath: input.currentDiffPath
  });
  await writeFile(promptPath, prompt, "utf8");

  const statusBefore = await readWorkingTreeSnapshot(input.cwd, input.commandLogPath, executor);

  const execResult = await executor({
    command: input.config.cursor.command,
    args: input.config.cursor.args,
    input: prompt,
    cwd: input.cwd,
    timeoutMs: input.config.cursor.timeout_sec * 1000,
    outputPath,
    commandLogPath: input.commandLogPath
  });
  const statusAfter = await readWorkingTreeSnapshot(input.cwd, input.commandLogPath, executor);
  const changed = statusBefore !== statusAfter;
  const tokenLimitPattern = execResult.timedOut
    ? undefined
    : detectTokenLimitPattern({ result: execResult, fixer: "cursor", config: input.config });
  const tokenLimitFailure = tokenLimitPattern
    ? formatTokenLimitFailure("cursor", execResult, tokenLimitPattern)
    : undefined;

  if (tokenLimitFailure && input.commandLogPath) {
    const at = new Date().toISOString();
    await writeCommandLog(input.commandLogPath, {
      command: "token-limit-detected cursor",
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
  const failureReason = tokenLimitFailure
    ? tokenLimitFailure
    : !requiresChanges
      ? "cursor was not given any review tasks"
      : execResult.exitCode === 0 && !execResult.timedOut && !changed
        ? "cursor exited successfully but made no working-tree changes"
        : undefined;
  return {
    fixer: "cursor",
    status: tokenLimitPattern ? "token_limited" : completed ? "completed" : noChanges ? "no_changes" : "failed",
    promptPath,
    outputPath,
    execResult,
    changed,
    failureReason,
    tokenLimitPattern
  };
}
