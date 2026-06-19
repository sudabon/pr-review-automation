import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import { buildClaudeReviewPrompt } from "../prompts/buildClaudeReviewPrompt.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import { extractJsonObject, safeJsonParse } from "../utils/safeJsonParse.js";
import { reviewSchema, type ReviewJson } from "./reviewSchemas.js";

export interface RunClaudeReviewInput {
  config: Config;
  cwd: string;
  diffPath: string;
  statusPath: string;
  reviewDir: string;
  commandLogPath?: string;
}

export interface ClaudeReviewResult {
  markdownPath: string;
  reviewJsonPath: string;
  promptPath: string;
  review: ReviewJson;
}

export async function runClaudeReview(
  input: RunClaudeReviewInput,
  executor: CommandExecutor = execWithTimeout
): Promise<ClaudeReviewResult> {
  await mkdir(input.reviewDir, { recursive: true });
  const markdownPath = join(input.reviewDir, "claude-review.md");
  const reviewJsonPath = join(input.reviewDir, "review.json");
  const promptPath = join(input.reviewDir, "claude-review-prompt.md");
  const prompt = buildClaudeReviewPrompt({
    config: input.config,
    diffPath: input.diffPath,
    statusPath: input.statusPath,
    reviewJsonPath
  });
  await writeFile(promptPath, prompt, "utf8");
  await rm(reviewJsonPath, { force: true });

  const result = await executor({
    command: input.config.claude.command,
    args: [...input.config.claude.args, prompt],
    cwd: input.cwd,
    timeoutMs: input.config.claude.timeout_sec * 1000,
    outputPath: markdownPath,
    commandLogPath: input.commandLogPath
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Claude review failed${result.timedOut ? " by timeout" : ""}: ${result.stderr || result.all}`);
  }

  const review = await readOrExtractReviewJson(reviewJsonPath, result.all, input.commandLogPath);
  await writeFile(reviewJsonPath, JSON.stringify(review, null, 2), "utf8");

  return { markdownPath, reviewJsonPath, promptPath, review };
}

async function readOrExtractReviewJson(
  path: string,
  output: string,
  commandLogPath?: string
): Promise<ReviewJson> {
  let parsed: unknown;

  try {
    await access(path);
    const result = safeJsonParse(await readFile(path, "utf8"));
    if (!result.ok) {
      throw new Error(`Invalid Claude review JSON at ${path}: ${result.error.message}`);
    }
    parsed = result.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (commandLogPath) {
      const at = new Date().toISOString();
      await writeCommandLog(commandLogPath, {
        command: "claude-review-json-fallback",
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

  return reviewSchema.parse(parsed);
}
