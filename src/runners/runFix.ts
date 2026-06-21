import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, FixerName } from "../config/schema.js";
import { buildCodexFixPrompt } from "../prompts/buildCodexFixPrompt.js";
import { buildCursorFixPrompt } from "../prompts/buildCursorFixPrompt.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import type { CommandExecutor } from "../utils/execWithTimeout.js";
import type { ReviewJson } from "./reviewSchemas.js";
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

interface RunFixResultBase {
  outputPaths: string[];
  attempts: FixRunnerResult[];
  failovers: FixFailover[];
}

export type RunFixResult =
  | (RunFixResultBase & { status: "completed"; activeFixer: FixerName })
  | (RunFixResultBase & { status: "skipped"; reason?: string })
  | (RunFixResultBase & { status: "human_review_required"; reason: string })
  | (RunFixResultBase & { status: "no_changes"; activeFixer: FixerName; reason: string });

const severityRank: Record<ReviewJson["tasks"][number]["severity"], number> = {
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
  const review = prioritizeReview(input.review);

  if (input.dryRun) {
    const codexPromptPath = join(input.fixDir, "codex-prompt.md");
    const cursorPromptPath = join(input.fixDir, "cursor-prompt.md");
    await writeFile(
      codexPromptPath,
      buildCodexFixPrompt({ review, reviewJsonPath: input.reviewJsonPath }),
      "utf8"
    );
    await writeFile(
      cursorPromptPath,
      buildCursorFixPrompt({
        review,
        reviewJsonPath: input.reviewJsonPath,
        currentDiffPath: input.currentDiffPath
      }),
      "utf8"
    );
    return {
      status: "skipped",
      outputPaths: [codexPromptPath, cursorPromptPath],
      attempts: [],
      failovers: [],
      reason: "Dry run: fixer execution skipped; prompts were generated."
    };
  }

  if (input.review.tasks.length === 0) {
    const noTasksPath = join(input.fixDir, "no-tasks.txt");
    const reason = "No review tasks were produced; fixer execution skipped.";
    await writeFile(noTasksPath, `${reason}\n`, "utf8");
    return {
      status: "skipped",
      outputPaths: [noTasksPath],
      attempts: [],
      failovers: [],
      reason
    };
  }

  if (input.config.agents.fixer_mode === "sequential") {
    return runSequentialFixers(input, review, executor);
  }

  return runFailoverFixers(input, review, executor);
}

async function runSequentialFixers(
  input: RunFixInput,
  review: ReviewJson,
  executor: CommandExecutor
): Promise<RunFixResult> {
  const attempts: FixRunnerResult[] = [];
  const failovers: FixFailover[] = [];
  let lastCompletedFixer: FixerName | undefined;

  for (const fixer of input.config.agents.fixers) {
    const attempt = await runFixerAttempt(fixer, input, review, executor);
    attempts.push(attempt);

    if (attempt.status === "completed") {
      lastCompletedFixer = fixer;
      continue;
    }

    if (attempt.status === "no_changes") {
      continue;
    }

    if (attempt.status === "token_limited" && attempt.changed) {
      const reason = `${attempt.failureReason} ${fixer} modified the working tree before reaching its token limit; automatic failover was stopped to avoid layering another fix on partial changes.`;
      failovers.push(await recordFailover(input.commandLogPath, fixer, undefined, reason));
      return {
        status: "human_review_required",
        outputPaths: attempts.map((item) => item.outputPath),
        attempts,
        failovers,
        reason
      };
    }

    const nextFixer = input.config.agents.fixers[input.config.agents.fixers.indexOf(fixer) + 1];
    if (attempt.status === "token_limited" && nextFixer) {
      failovers.push(
        await recordFailover(input.commandLogPath, fixer, nextFixer, attempt.failureReason ?? "token_limit")
      );
      continue;
    }

    if (attempt.status === "token_limited") {
      continue;
    }

    if (attempt.execResult.timedOut || attempt.status === "failed") {
      if (lastCompletedFixer) {
        return {
          status: "completed",
          activeFixer: lastCompletedFixer,
          outputPaths: attempts.map((item) => item.outputPath),
          attempts,
          failovers
        };
      }

      if (attempt.execResult.timedOut) {
        throw new Error(`${fixer} fixer timed out`);
      }

      throw new Error(
        `${fixer} fixer failed: ${attempt.failureReason || attempt.execResult.stderr || attempt.execResult.all || "unknown error"}`
      );
    }
  }

  if (lastCompletedFixer) {
    return {
      status: "completed",
      activeFixer: lastCompletedFixer,
      outputPaths: attempts.map((item) => item.outputPath),
      attempts,
      failovers
    };
  }

  const noChangeAttempt = attempts.find((attempt) => attempt.status === "no_changes");
  if (noChangeAttempt) {
    return {
      status: "no_changes",
      activeFixer: noChangeAttempt.fixer,
      outputPaths: attempts.map((item) => item.outputPath),
      attempts,
      failovers,
      reason: noChangeAttempt.failureReason
    };
  }

  if (attempts.every((attempt) => attempt.status === "token_limited")) {
    return {
      status: "human_review_required",
      outputPaths: attempts.map((item) => item.outputPath),
      attempts,
      failovers,
      reason: `All configured fixers reported token limits.${attempts.at(-1)?.failureReason ? ` ${attempts.at(-1)?.failureReason}` : ""}`
    };
  }

  const lastAttempt = attempts.at(-1);
  throw new Error(
    `No configured fixer completed successfully.${lastAttempt ? ` Last ${lastAttempt.fixer} status: ${lastAttempt.status}.` : ""}`
  );
}

async function runFailoverFixers(
  input: RunFixInput,
  review: ReviewJson,
  executor: CommandExecutor
): Promise<RunFixResult> {
  const attempts: FixRunnerResult[] = [];
  const failovers: FixFailover[] = [];

  for (let index = 0; index < input.config.agents.fixers.length; index += 1) {
    const fixer = input.config.agents.fixers[index]!;
    const attempt = await runFixerAttempt(fixer, input, review, executor);
    attempts.push(attempt);

    if (attempt.status === "completed") {
      return {
        status: "completed",
        activeFixer: fixer,
        outputPaths: attempts.map((item) => item.outputPath),
        attempts,
        failovers
      };
    }

    if (attempt.status === "no_changes") {
      const nextFixer = input.config.agents.fixers[index + 1];
      if (nextFixer) {
        failovers.push(await recordFailover(input.commandLogPath, fixer, nextFixer, attempt.failureReason));
        continue;
      }
      return {
        status: "no_changes",
        activeFixer: fixer,
        outputPaths: attempts.map((item) => item.outputPath),
        attempts,
        failovers,
        reason: attempt.failureReason
      };
    }

    const nextFixer = input.config.agents.fixers[index + 1];

    if (attempt.status === "token_limited" && attempt.changed) {
      const reason = `${attempt.failureReason} ${fixer} modified the working tree before reaching its token limit; automatic failover was stopped to avoid layering another fix on partial changes.`;
      failovers.push(await recordFailover(input.commandLogPath, fixer, undefined, reason));
      return {
        status: "human_review_required",
        outputPaths: attempts.map((item) => item.outputPath),
        attempts,
        failovers,
        reason
      };
    }

    if (attempt.status === "token_limited" && nextFixer) {
      const reason = attempt.failureReason ?? "token_limit";
      failovers.push(await recordFailover(input.commandLogPath, fixer, nextFixer, reason));
      continue;
    }

    if (attempt.status === "token_limited") {
      failovers.push(
        await recordFailover(input.commandLogPath, fixer, undefined, attempt.failureReason ?? "token_limit")
      );
      continue;
    }

    if (attempt.execResult.timedOut) {
      throw new Error(`${fixer} fixer timed out`);
    }

    if (attempt.status === "failed") {
      throw new Error(
        `${fixer} fixer failed: ${attempt.failureReason || attempt.execResult.stderr || attempt.execResult.all || "unknown error"}`
      );
    }
  }

  const noChangeAttempt = attempts.find((attempt) => attempt.status === "no_changes");
  if (noChangeAttempt?.status === "no_changes") {
    return {
      status: "no_changes",
      activeFixer: noChangeAttempt.fixer,
      outputPaths: attempts.map((item) => item.outputPath),
      attempts,
      failovers,
      reason: noChangeAttempt.failureReason
    };
  }

  if (!attempts.every((attempt) => attempt.status === "token_limited")) {
    const lastAttempt = attempts.at(-1);
    throw new Error(
      `No configured fixer completed successfully.${lastAttempt ? ` Last ${lastAttempt.fixer} status: ${lastAttempt.status}.` : ""}`
    );
  }

  return {
    status: "human_review_required",
    outputPaths: attempts.map((item) => item.outputPath),
    attempts,
    failovers,
    reason: `All configured fixers reported token limits.${attempts.at(-1)?.failureReason ? ` ${attempts.at(-1)?.failureReason}` : ""}`
  };
}

async function runFixerAttempt(
  fixer: FixerName,
  input: RunFixInput,
  review: ReviewJson,
  executor: CommandExecutor
): Promise<FixRunnerResult> {
  return fixer === "codex"
    ? runCodexFix({ ...input, review }, executor)
    : runCursorFix({ ...input, review, currentDiffPath: input.currentDiffPath }, executor);
}

function prioritizeReview(review: ReviewJson): ReviewJson {
  return {
    ...review,
    tasks: [...review.tasks].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])
  };
}

async function recordFailover(
  commandLogPath: string | undefined,
  from: FixerName,
  to: FixerName | undefined,
  reason: string
): Promise<FixFailover> {
  const failover = {
    from,
    to,
    at: new Date().toISOString(),
    reason
  };

  if (commandLogPath) {
    await writeCommandLog(commandLogPath, {
      command: `fixer-failover ${from}${to ? `->${to}` : ""}`,
      event: "fixer_failover",
      reason,
      started_at: failover.at,
      ended_at: failover.at,
      exit_code: 0,
      step: "fixer_failover"
    });
  }

  return failover;
}
