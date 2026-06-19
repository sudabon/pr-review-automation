import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import { buildClaudeFinalPrompt } from "../prompts/buildClaudeFinalPrompt.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import { extractJsonObject, safeJsonParse } from "../utils/safeJsonParse.js";
import { finalResultSchema, type FinalResult } from "./reviewSchemas.js";

export interface RunClaudeFinalReviewInput {
  config: Config;
  cwd: string;
  initialReviewPath: string;
  validationResultPath: string;
  diffPath: string;
  finalDir: string;
  fixLogPaths: string[];
  commandLogPath?: string;
}

export interface ClaudeFinalReviewResult {
  markdownPath: string;
  finalResultPath: string;
  promptPath: string;
  finalResult: FinalResult;
}

export async function runClaudeFinalReview(
  input: RunClaudeFinalReviewInput,
  executor: CommandExecutor = execWithTimeout
): Promise<ClaudeFinalReviewResult> {
  await mkdir(input.finalDir, { recursive: true });
  const markdownPath = join(input.finalDir, "claude-final-review.md");
  const finalResultPath = join(input.finalDir, "final-result.json");
  const promptPath = join(input.finalDir, "claude-final-prompt.md");
  const prompt = buildClaudeFinalPrompt({
    config: input.config,
    initialReviewPath: input.initialReviewPath,
    validationResultPath: input.validationResultPath,
    diffPath: input.diffPath,
    finalResultPath,
    fixLogPaths: input.fixLogPaths
  });
  await writeFile(promptPath, prompt, "utf8");
  await rm(finalResultPath, { force: true });

  const result = await executor({
    command: input.config.claude.command,
    args: [...input.config.claude.args, prompt],
    cwd: input.cwd,
    timeoutMs: input.config.claude.timeout_sec * 1000,
    outputPath: markdownPath,
    commandLogPath: input.commandLogPath
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Claude final review failed${result.timedOut ? " by timeout" : ""}: ${result.stderr || result.all}`);
  }

  const finalResult = await readOrExtractFinalJson(finalResultPath, result.all, input.commandLogPath);
  await writeFile(finalResultPath, JSON.stringify(finalResult, null, 2), "utf8");

  return { markdownPath, finalResultPath, promptPath, finalResult };
}

async function readOrExtractFinalJson(
  path: string,
  output: string,
  commandLogPath?: string
): Promise<FinalResult> {
  let parsed: unknown;

  try {
    await access(path);
    const result = safeJsonParse(await readFile(path, "utf8"));
    if (!result.ok) {
      throw new Error(`Invalid Claude final-review JSON at ${path}: ${result.error.message}`);
    }
    parsed = result.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (commandLogPath) {
      const at = new Date().toISOString();
      await writeCommandLog(commandLogPath, {
        command: "claude-final-review-json-fallback",
        event: "json_fallback",
        reason: `Expected JSON file was not written: ${path}`,
        started_at: at,
        ended_at: at,
        exit_code: 0
      });
    }
    const extracted = extractJsonObject(output);
    if (!extracted.ok) {
      throw extracted.error;
    }
    parsed = extracted.value;
  }

  return finalResultSchema.parse(parsed);
}
