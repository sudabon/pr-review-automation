import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { buildCursorFixPrompt } from "../prompts/buildCursorFixPrompt.js";
import { detectTokenLimit } from "../utils/detectTokenLimit.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import type { ReviewJson } from "./reviewSchemas.js";
import type { FixRunnerResult } from "./runCodexFix.js";

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

  const execResult = await executor({
    command: input.config.cursor.command,
    args: [...input.config.cursor.args, prompt],
    cwd: input.cwd,
    timeoutMs: input.config.cursor.timeout_sec * 1000,
    outputPath,
    commandLogPath: input.commandLogPath
  });

  const tokenLimited = detectTokenLimit({ result: execResult, fixer: "cursor", config: input.config });
  return {
    fixer: "cursor",
    status: execResult.exitCode === 0 ? "completed" : tokenLimited ? "token_limited" : "failed",
    promptPath,
    outputPath,
    execResult
  };
}
