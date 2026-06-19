import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fixerSchema, type Config } from "../config/schema.js";
import { collectDiff } from "../git/collectDiff.js";
import { commitChanges } from "../git/commitChanges.js";
import { ensureGitRepository, ensureRequiredCliCommands } from "../git/checks.js";
import { cleanupWorktree, createWorktree, type WorktreeResult } from "../git/createWorktree.js";
import { createRunDirectory, getRunDirectory, type RunDirectory } from "../logs/createRunDirectory.js";
import { runClaudeFinalReview } from "../runners/runClaudeFinalReview.js";
import { runClaudeReview } from "../runners/runClaudeReview.js";
import { runFix, type FixFailover } from "../runners/runFix.js";
import { runValidation, type ValidationResult } from "../runners/runValidation.js";
import { remainingIssueSchema, type FinalResult, type RemainingIssue } from "../runners/reviewSchemas.js";
import { safeJsonParse } from "../utils/safeJsonParse.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import { detectRepeatedIssues, type RepeatedIssueCounts } from "./detectRepeatedIssues.js";
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

export type LoopStateStatus =
  | "running"
  | "completed"
  | "failed"
  | "approved"
  | "needs_changes"
  | "human_review_required"
  | "max_loops"
  | "repeated_issue"
  | "abnormal_diff";

export interface LoopState {
  run_id: string;
  status: LoopStateStatus;
  reason?: string;
  current_loop: number;
  max_loops: number;
  worktree_path: string;
  worktree_mode?: WorktreeResult["mode"];
  worktree_branch?: string;
  final_decision?: FinalResult["decision"];
  remaining_issues: RemainingIssue[];
  repeated_issues: RepeatedIssueCounts;
  failovers: FixFailover[];
  history: Array<{
    loop: number;
    decision?: FinalResult["decision"];
    validation?: ValidationResult["status"];
    action?: LoopDecision["action"] | "only_review";
    reason?: string;
  }>;
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
    final_decision: z.enum(["approved", "needs_changes", "human_review_required"]).optional(),
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
          action: z.enum(["continue", "stop", "only_review"]).optional(),
          reason: z.string().optional()
        })
        .passthrough()
    )
  })
  .passthrough();

export async function runLoop(input: RunLoopInput): Promise<RunLoopResult> {
  const executor = input.executor ?? execWithTimeout;
  const runDirectory = input.options.resumeRunId
    ? getRunDirectory(input.cwd, input.options.resumeRunId)
    : await createRunDirectory(input.cwd);
  let state = input.options.resumeRunId
    ? await loadExistingState(runDirectory)
    : await initializeRun(input, runDirectory, executor);
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

      if (fix.status === "human_review_required") {
        const nextState: LoopState = {
          ...state,
          status: "human_review_required",
          reason: fix.reason,
          current_loop: loopNumber,
          failovers: [...state.failovers, ...fix.failovers],
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
        failovers: [...state.failovers, ...fix.failovers],
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
        if (decision.success && input.options.commitOnSuccess && input.config.git.commit_on_success) {
          await commitChanges(
            {
              cwd: worktreePath,
              commandLogPath: runDirectory.commandLogPath
            },
            executor
          );
        }

        return {
          status:
            decision.success ? "completed" : decision.status === "human_review_required" ? "needs_human_review" : "failed",
          reason: decision.reason,
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
    await cleanupLoopWorktree(input.cwd, state, runDirectory.commandLogPath, executor);
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

  return validated.data as LoopState;
}

async function saveLoopState(path: string, state: LoopState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

async function cleanupLoopWorktree(
  cwd: string,
  state: LoopState,
  commandLogPath: string,
  executor: CommandExecutor
): Promise<void> {
  try {
    await cleanupWorktree(
      {
        cwd,
        mode: state.worktree_mode,
        path: state.worktree_path,
        branchName: state.worktree_branch,
        commandLogPath
      },
      executor
    );
  } catch {
    // Cleanup is best-effort so it does not mask the loop result.
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
