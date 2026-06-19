import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, FixerName } from "../config/schema.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import type { CommandExecutor } from "../utils/execWithTimeout.js";
import type { ReviewJson, ReviewTask } from "./reviewSchemas.js";
import { runCodexFix, type FixRunnerResult } from "./runCodexFix.js";
import { runCursorFix } from "./runCursorFix.js";

export interface FixFailover {
  from: FixerName;
  to?: FixerName;
  at: string;
  reason: string;
}

export interface RunFixInput {
  config: Config;
  cwd: string;
  fixDir: string;
  review: ReviewJson;
  reviewJsonPath: string;
  dryRun: boolean;
  currentDiffPath?: string;
  commandLogPath?: string;
}

export interface RunFixResult {
  status: "completed" | "skipped" | "human_review_required";
  activeFixer?: FixerName;
  outputPaths: string[];
  attempts: FixRunnerResult[];
  failovers: FixFailover[];
  reason?: string;
}

const severityRank: Record<ReviewTask["severity"], number> = {
  blocker: 0,
  critical: 1,
  major: 2,
  minor: 3,
  nit: 4
};

export async function runFix(
  input: RunFixInput,
  executor: CommandExecutor
): Promise<RunFixResult> {
  await mkdir(input.fixDir, { recursive: true });

  if (input.dryRun) {
    const dryRunPath = join(input.fixDir, "dry-run.txt");
    await writeFile(dryRunPath, "Dry run: fixer execution skipped.\n", "utf8");
    return {
      status: "skipped",
      outputPaths: [dryRunPath],
      attempts: [],
      failovers: []
    };
  }

  const review = prioritizeReview(input.review);
  const attempts: FixRunnerResult[] = [];
  const failovers: FixFailover[] = [];

  for (let index = 0; index < input.config.agents.fixers.length; index += 1) {
    const fixer = input.config.agents.fixers[index];
    const attempt =
      fixer === "codex"
        ? await runCodexFix({ ...input, review }, executor)
        : await runCursorFix({ ...input, review, currentDiffPath: input.currentDiffPath }, executor);
    attempts.push(attempt);

    if (attempt.execResult.timedOut) {
      throw new Error(`${fixer} fixer timed out`);
    }

    if (attempt.status === "completed") {
      return {
        status: "completed",
        activeFixer: fixer,
        outputPaths: attempts.map((item) => item.outputPath),
        attempts,
        failovers
      };
    }

    if (attempt.status === "failed") {
      throw new Error(`${fixer} fixer failed: ${attempt.execResult.stderr || attempt.execResult.all}`);
    }

    const nextFixer = input.config.agents.fixers[index + 1];
    const failover = {
      from: fixer,
      to: nextFixer,
      at: new Date().toISOString(),
      reason: "token_limit"
    };
    failovers.push(failover);
    if (input.commandLogPath) {
      await writeCommandLog(input.commandLogPath, {
        command: `fixer-failover ${fixer}${nextFixer ? `->${nextFixer}` : ""}`,
        event: "fixer_failover",
        reason: "token_limit",
        started_at: failover.at,
        ended_at: failover.at,
        exit_code: 0
      });
    }
  }

  return {
    status: "human_review_required",
    outputPaths: attempts.map((item) => item.outputPath),
    attempts,
    failovers,
    reason: "All configured fixers reported token limits."
  };
}

function prioritizeReview(review: ReviewJson): ReviewJson {
  return {
    ...review,
    tasks: [...review.tasks].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])
  };
}
