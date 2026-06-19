import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { buildCodexFixPrompt } from "../prompts/buildCodexFixPrompt.js";
import type { ReviewJson } from "./reviewSchemas.js";
import { detectTokenLimit } from "../utils/detectTokenLimit.js";
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

  const execResult = await executor({
    command: input.config.codex.command,
    args: [...input.config.codex.args, prompt],
    cwd: input.cwd,
    timeoutMs: input.config.codex.timeout_sec * 1000,
    outputPath,
    commandLogPath: input.commandLogPath
  });

  const tokenLimited = detectTokenLimit({ result: execResult, fixer: "codex", config: input.config });
  return {
    fixer: "codex",
    status: execResult.exitCode === 0 ? "completed" : tokenLimited ? "token_limited" : "failed",
    promptPath,
    outputPath,
    execResult
  };
}
