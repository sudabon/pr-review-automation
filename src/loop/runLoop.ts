import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fixerSchema, type Config } from "../config/schema.js";
import { collectDiff } from "../git/collectDiff.js";
import { commitChanges } from "../git/commitChanges.js";
import { ensureGitRepository, ensureRequiredCliCommands } from "../git/checks.js";
import { cleanupWorktree, createWorktree } from "../git/createWorktree.js";
import { createRunDirectory, getRunDirectory, type RunDirectory } from "../logs/createRunDirectory.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import { runClaudeFinalReview } from "../runners/runClaudeFinalReview.js";
import { runClaudeReview } from "../runners/runClaudeReview.js";
import { runFix, type FixFailover } from "../runners/runFix.js";
import { runValidation } from "../runners/runValidation.js";
import { remainingIssueSchema } from "../runners/reviewSchemas.js";
import { safeJsonParse } from "../utils/safeJsonParse.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import { detectRepeatedIssues } from "./detectRepeatedIssues.js";
import { shouldContinue, type LoopDecision } from "./shouldContinue.js";

export interface RunLoopOptions {
  baseBranch: string;
  targetBranch?: string;
  maxLoops: number;
  commitOnSuccess: boolean;
  dryRun: boolean;
  onlyReview: boolean;
  resumeRunId?: string;
}

export interface RunLoopInput {
  cwd: string;
  config: Config;
  options: RunLoopOptions;
  executor?: CommandExecutor;
}

export interface RunLoopResult {
  status: "completed" | "failed" | "needs_human_review";
  reason: string;
  runId: string;
  runDirectory: string;
  decision?: LoopDecision;
}

const loopStateStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "approved",
  "needs_changes",
  "human_review_required",
  "max_loops",
  "repeated_issue",
  "abnormal_diff"
]);

export type LoopStateStatus = z.infer<typeof loopStateStatusSchema>;

const loopStateSchema = z
  .object({
    run_id: z.string().min(1),
    status: loopStateStatusSchema,
    reason: z.string().optional(),
    current_loop: z.number().int().nonnegative(),
    max_loops: z.number().int().positive(),
    worktree_path: z.string().min(1),
    worktree_mode: z.enum(["worktree", "branch", "current"]).optional(),
    worktree_branch: z.string().optional(),
    worktree_original_branch: z.string().optional(),
    worktree_original_ref: z.string().optional(),
    final_decision: z.enum(["approved", "needs_changes", "human_review_required"]).optional(),
    baseline_diff_line_count: z.number().int().nonnegative().optional(),
    remaining_issues: z.array(remainingIssueSchema),
    repeated_issues: z.record(z.string(), z.number().int().nonnegative()),
    failovers: z.array(
      z
        .object({
          from: fixerSchema,
          to: fixerSchema.optional(),
          at: z.string(),
          reason: z.string()
        })
        .passthrough()
    ),
    history: z.array(
      z
        .object({
          loop: z.number().int().nonnegative(),
          decision: z.enum(["approved", "needs_changes", "human_review_required"]).optional(),
          validation: z.enum(["passed", "failed"]).optional(),
          action: z.enum(["continue", "stop", "only_review", "dry_run"]).optional(),
          reason: z.string().optional()
        })
        .passthrough()
    )
  })
  .passthrough();

export type LoopState = z.infer<typeof loopStateSchema>;

export async function runLoop(input: RunLoopInput): Promise<RunLoopResult> {
  const executor = input.executor ?? execWithTimeout;
  const runDirectory = input.options.resumeRunId
    ? getRunDirectory(input.cwd, input.options.resumeRunId)
    : await createRunDirectory(input.cwd);
  let state = input.options.resumeRunId
    ? await loadExistingState(runDirectory)
    : await initializeRun(input, runDirectory, executor);
  if (input.options.resumeRunId) {
    state = await prepareResumeWorktree(input.cwd, state, runDirectory.commandLogPath, executor);
  }
  const worktreePath = state.worktree_path;
  const maxLoops = input.options.maxLoops;
  const startLoop = input.options.resumeRunId ? Math.min(state.current_loop + 1, maxLoops) : 1;

  const persistState = async (nextState: LoopState): Promise<void> => {
    await saveLoopState(runDirectory.loopStatePath, nextState);
    state = nextState;
  };

  try {
    for (let loopNumber = startLoop; loopNumber <= maxLoops; loopNumber += 1) {
      await persistState({
        ...state,
        status: "running",
        current_loop: loopNumber,
        max_loops: maxLoops
      });

      const diff = await collectDiff(
        {
          cwd: worktreePath,
          baseBranch: input.options.baseBranch,
          targetBranch: input.options.targetBranch,
          inputDir: runDirectory.inputDir,
          commandLogPath: runDirectory.commandLogPath
        },
        executor
      );
      const baselineDiffLineCount = state.baseline_diff_line_count ?? diff.lineCount;
      if (state.baseline_diff_line_count === undefined) {
        await persistState({ ...state, baseline_diff_line_count: baselineDiffLineCount });
      }

      if (diff.isEmpty) {
        const nextState: LoopState = {
          ...state,
          status: "completed",
          reason: "No diff to review.",
          current_loop: loopNumber
        };
        await persistState(nextState);
        return {
          status: "completed",
          reason: "No diff to review.",
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      const review = await runClaudeReview(
        {
          config: input.config,
          cwd: worktreePath,
          diffPath: diff.diffPath,
          statusPath: diff.statusPath,
          reviewDir: runDirectory.reviewDir,
          commandLogPath: runDirectory.commandLogPath
        },
        executor
      );

      if (input.options.onlyReview) {
        const nextState: LoopState = {
          ...state,
          status: "completed",
          reason: "Stopped after Claude review because --only-review was set.",
          current_loop: loopNumber,
          history: [
            ...state.history,
            { loop: loopNumber, action: "only_review", reason: "Stopped after Claude review." }
          ]
        };
        await persistState(nextState);
        return {
          status: "completed",
          reason: "Stopped after Claude review.",
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      const fix = await runFix(
        {
          config: input.config,
          cwd: worktreePath,
          fixDir: runDirectory.fixDir,
          review: review.review,
          reviewJsonPath: review.reviewJsonPath,
          dryRun: input.options.dryRun,
          currentDiffPath: diff.diffPath,
          commandLogPath: runDirectory.commandLogPath
        },
        executor
      );

      if (input.options.dryRun) {
        const nextState: LoopState = {
          ...state,
          status: "completed",
          reason: "Stopped after review and fix planning because --dry-run was set.",
          current_loop: loopNumber,
          history: [
            ...state.history,
            { loop: loopNumber, action: "dry_run", reason: "Stopped after review and fix planning." }
          ]
        };
        await persistState(nextState);
        return {
          status: "completed",
          reason: "Stopped after review and fix planning.",
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      if (fix.status === "human_review_required") {
        const nextState: LoopState = {
          ...state,
          status: "human_review_required",
          reason: fix.reason,
          current_loop: loopNumber,
          failovers: [...state.failovers, ...toLoopStateFailovers(fix.failovers)],
          history: [...state.history, { loop: loopNumber, action: "stop", reason: fix.reason }]
        };
        await persistState(nextState);
        return {
          status: "needs_human_review",
          reason: fix.reason ?? "Human review required.",
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      const validation = await runValidation(
        input.config,
        worktreePath,
        runDirectory.validationDir,
        runDirectory.commandLogPath,
        executor
      );
      const refreshedDiff = await collectDiff(
        {
          cwd: worktreePath,
          baseBranch: input.options.baseBranch,
          targetBranch: input.options.targetBranch,
          inputDir: runDirectory.inputDir,
          commandLogPath: runDirectory.commandLogPath
        },
        executor
      );
      const final = await runClaudeFinalReview(
        {
          config: input.config,
          cwd: worktreePath,
          initialReviewPath: review.markdownPath,
          validationResultPath: join(runDirectory.validationDir, "validation-result.json"),
          diffPath: refreshedDiff.diffPath,
          finalDir: runDirectory.finalDir,
          fixLogPaths: fix.outputPaths,
          commandLogPath: runDirectory.commandLogPath
        },
        executor
      );

      const repeated = detectRepeatedIssues(state.repeated_issues, final.finalResult.remaining_issues);
      const allFixersTokenLimited =
        fix.attempts.length > 0 && fix.attempts.every((attempt) => attempt.status === "token_limited");
      const decision = shouldContinue({
        config: input.config,
        loopNumber,
        maxLoops,
        finalResult: final.finalResult,
        validationResult: validation,
        maxRepeatCount: repeated.maxRepeatCount,
        diffLineCount: refreshedDiff.lineCount,
        baselineDiffLineCount,
        allFixersTokenLimited
      });

      const nextState: LoopState = {
        ...state,
        status: decision.status,
        reason: decision.reason,
        current_loop: loopNumber,
        max_loops: maxLoops,
        final_decision: final.finalResult.decision,
        remaining_issues: final.finalResult.remaining_issues,
        repeated_issues: repeated.counts,
        failovers: [...state.failovers, ...toLoopStateFailovers(fix.failovers)],
        history: [
          ...state.history,
          {
            loop: loopNumber,
            decision: final.finalResult.decision,
            validation: validation.status,
            action: decision.action,
            reason: decision.reason
          }
        ]
      };
      await persistState(nextState);

      if (decision.action === "stop") {
        let resultReason = decision.reason;
        if (decision.success && input.options.commitOnSuccess && input.config.git.commit_on_success) {
          const commit = await commitChanges(
            {
              cwd: worktreePath,
              commandLogPath: runDirectory.commandLogPath
            },
            executor
          );
          if (!commit.committed) {
            resultReason = `${decision.reason} No commit was created because the working tree was clean.`;
            const history = [...nextState.history];
            const lastHistory = history.at(-1);
            if (lastHistory) {
              history[history.length - 1] = { ...lastHistory, reason: resultReason };
            }
            await persistState({ ...nextState, reason: resultReason, history });
          }
        }

        return {
          status:
            decision.success ? "completed" : decision.status === "human_review_required" ? "needs_human_review" : "failed",
          reason: resultReason,
          runId: runDirectory.runId,
          runDirectory: runDirectory.root,
          decision
        };
      }
    }

    const nextState: LoopState = {
      ...state,
      status: "failed",
      reason: "Maximum loop count reached.",
      current_loop: maxLoops
    };
    await persistState(nextState);
    return {
      status: "failed",
      reason: "Maximum loop count reached.",
      runId: runDirectory.runId,
      runDirectory: runDirectory.root
    };
  } catch (error) {
    const reason = formatErrorMessage(error);
    const failedState: LoopState = {
      ...state,
      status: "failed",
      reason
    };
    await persistState(failedState);
    return {
      status: "failed",
      reason,
      runId: runDirectory.runId,
      runDirectory: runDirectory.root
    };
  } finally {
    await cleanupLoopWorktree(
      input.cwd,
      state,
      runDirectory.commandLogPath,
      state.status !== "completed",
      executor
    );
  }
}

export function getRequiredCliCommands(config: Config, options: RunLoopOptions): string[] {
  const commands = [config.claude.command];
  if (!options.dryRun && !options.onlyReview) {
    for (const fixer of config.agents.fixers) {
      commands.push(fixer === "codex" ? config.codex.command : config.cursor.command);
    }
  }
  return [...new Set(commands)];
}

async function initializeRun(
  input: RunLoopInput,
  runDirectory: RunDirectory,
  executor: CommandExecutor
): Promise<LoopState> {
  await ensureGitRepository(input.cwd, executor);
  await ensureRequiredCliCommands(getRequiredCliCommands(input.config, input.options), input.cwd, executor);
  const worktree = await createWorktree(
    input.cwd,
    input.config,
    runDirectory.runId,
    input.options.targetBranch,
    runDirectory.commandLogPath,
    executor
  );

  const state: LoopState = {
    run_id: runDirectory.runId,
    status: "running",
    current_loop: 0,
    max_loops: input.options.maxLoops,
    worktree_path: worktree.path,
    worktree_mode: worktree.mode,
    worktree_branch: worktree.branchName,
    worktree_original_branch: worktree.originalBranch,
    worktree_original_ref: worktree.originalRef,
    remaining_issues: [],
    repeated_issues: {},
    failovers: [],
    history: []
  };
  await saveLoopState(runDirectory.loopStatePath, state);
  return state;
}

async function loadExistingState(runDirectory: RunDirectory): Promise<LoopState> {
  try {
    await access(runDirectory.loopStatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Cannot resume ${runDirectory.runId}: loop-state.json does not exist.`);
    }
    throw error;
  }

  const parsed = safeJsonParse(await readFile(runDirectory.loopStatePath, "utf8"));
  if (!parsed.ok) {
    throw new Error(`Cannot resume ${runDirectory.runId}: invalid loop-state.json: ${parsed.error.message}`);
  }

  const validated = loopStateSchema.safeParse(parsed.value);
  if (!validated.success) {
    const issues = validated.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${location}: ${issue.message}`;
    });
    throw new Error(`Cannot resume ${runDirectory.runId}: invalid loop-state.json:\n${issues.join("\n")}`);
  }

  return validated.data;
}

async function saveLoopState(path: string, state: LoopState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

async function cleanupLoopWorktree(
  cwd: string,
  state: LoopState,
  commandLogPath: string,
  preserveForResume: boolean,
  executor: CommandExecutor
): Promise<void> {
  try {
    await cleanupWorktree(
      {
        cwd,
        mode: state.worktree_mode,
        path: state.worktree_path,
        branchName: state.worktree_branch,
        originalBranch: state.worktree_original_branch,
        originalRef: state.worktree_original_ref,
        preserveForResume,
        commandLogPath
      },
      executor
    );
  } catch (error) {
    // Cleanup is best-effort so it does not mask the loop result.
    const reason = formatErrorMessage(error);
    console.warn(`[ai-dev-loop] cleanup failed: ${reason}`);
    try {
      const at = new Date().toISOString();
      await writeCommandLog(commandLogPath, {
        command: "cleanup worktree",
        event: "cleanup_failed",
        reason,
        started_at: at,
        ended_at: at,
        exit_code: 1
      });
    } catch (logError) {
      console.warn(`[ai-dev-loop] failed to record cleanup failure: ${formatErrorMessage(logError)}`);
    }
  }
}

async function prepareResumeWorktree(
  cwd: string,
  state: LoopState,
  commandLogPath: string,
  executor: CommandExecutor
): Promise<LoopState> {
  if (["completed", "approved"].includes(state.status)) {
    throw new Error(`Cannot resume ${state.run_id}: the run is already complete.`);
  }

  try {
    await access(state.worktree_path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Cannot resume ${state.run_id}: worktree does not exist at ${state.worktree_path}.`);
    }
    throw error;
  }

  if (state.worktree_mode !== "branch" || !state.worktree_branch) {
    return state;
  }

  const currentBranch = await executor({
    command: "git",
    args: ["branch", "--show-current"],
    cwd,
    commandLogPath
  });
  if (currentBranch.exitCode !== 0) {
    throw new Error(`Cannot resume ${state.run_id}: failed to inspect the current branch.`);
  }

  const currentBranchName = currentBranch.stdout.trim();
  if (currentBranchName === state.worktree_branch) {
    return state;
  }

  const branchExists = await executor({
    command: "git",
    args: ["show-ref", "--verify", "--quiet", `refs/heads/${state.worktree_branch}`],
    cwd,
    commandLogPath
  });
  if (branchExists.exitCode !== 0) {
    throw new Error(`Cannot resume ${state.run_id}: temporary branch ${state.worktree_branch} no longer exists.`);
  }

  const switched = await executor({
    command: "git",
    args: ["switch", state.worktree_branch],
    cwd,
    commandLogPath
  });
  if (switched.exitCode !== 0) {
    throw new Error(`Cannot resume ${state.run_id}: failed to switch to ${state.worktree_branch}.`);
  }

  return {
    ...state,
    worktree_original_branch: state.worktree_original_branch ?? (currentBranchName || undefined)
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toLoopStateFailovers(failovers: FixFailover[]): LoopState["failovers"] {
  return failovers.map((failover) => ({ ...failover }));
}
