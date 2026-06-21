import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { fixerSchema, resolveMainReviewerCommand, type Config } from "../config/schema.js";
import { collectDiff } from "../git/collectDiff.js";
import { commitChanges } from "../git/commitChanges.js";
import { createPullRequest } from "../git/createPullRequest.js";
import { ensureGitRepository, ensureRequiredCliCommands } from "../git/checks.js";
import { cleanupWorktree, createWorktree } from "../git/createWorktree.js";
import { createRunDirectory, getRunDirectory, type RunDirectory } from "../logs/createRunDirectory.js";
import { writeCommandLog } from "../logs/writeCommandLog.js";
import { runClaudeFinalReview } from "../runners/runClaudeFinalReview.js";
import { runClaudeReview } from "../runners/runClaudeReview.js";
import { runFix, type FixFailover } from "../runners/runFix.js";
import { runValidation } from "../runners/runValidation.js";
import { remainingIssueSchema, type ReviewJson } from "../runners/reviewSchemas.js";
import { buildProjectSummary } from "../safety/buildProjectSummary.js";
import { safeJsonParse } from "../utils/safeJsonParse.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import { detectRepeatedIssues } from "./detectRepeatedIssues.js";
import { shouldContinue, type LoopDecision } from "./shouldContinue.js";
import {
  LOOP_HUMAN_REVIEW_STATUS,
  mapDecisionToExternalStatus,
  mapInternalStateToExternalStatus,
  type RunLoopExternalStatus
} from "./statusMapping.js";

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
  status: RunLoopExternalStatus;
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

const loopStateCommonShape = {
  run_id: z.string().min(1),
  status: loopStateStatusSchema,
  reason: z.string().optional(),
  current_loop: z.number().int().nonnegative(),
  max_loops: z.number().int().positive(),
  final_decision: z.enum(["approved", "needs_changes", "human_review_required"]).optional(),
  baseline_diff_line_count: z.number().int().nonnegative().optional(),
  remaining_issues: z.array(remainingIssueSchema),
  repeated_issues: z.record(z.string(), z.number().int().nonnegative()),
  consecutive_test_failures: z.number().int().nonnegative().default(0),
  failovers: z.array(
    z.strictObject({
      from: fixerSchema,
      to: fixerSchema.optional(),
      at: z.string(),
      reason: z.string()
    })
  ),
  history: z.array(
    z.strictObject({
      loop: z.number().int().nonnegative(),
      decision: z.enum(["approved", "needs_changes", "human_review_required"]).optional(),
      validation: z.enum(["passed", "failed"]).optional(),
      action: z.enum(["continue", "stop", "only_review", "dry_run"]).optional(),
      reason: z.string().optional()
    })
  )
};

const loopStateSchema = z.preprocess(
  (value) => {
    if (typeof value === "object" && value !== null && !("worktree_mode" in value)) {
      return { ...value, worktree_mode: "current" };
    }
    return value;
  },
  z.discriminatedUnion("worktree_mode", [
    z.strictObject({
      ...loopStateCommonShape,
      worktree_path: z.string().min(1),
      worktree_mode: z.literal("current")
    }),
    z.strictObject({
      ...loopStateCommonShape,
      worktree_path: z.string().min(1),
      worktree_mode: z.literal("worktree"),
      worktree_branch: z.string().min(1)
    }),
    z.strictObject({
      ...loopStateCommonShape,
      worktree_path: z.string().min(1),
      worktree_mode: z.literal("branch"),
      worktree_branch: z.string().min(1),
      worktree_original_branch: z.string().min(1).optional(),
      worktree_original_ref: z.string().min(1).optional()
    })
  ])
);

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
    state = await prepareResumeWorktree(input.cwd, input.config, state, runDirectory.commandLogPath, executor);
  }
  const worktreePath = state.worktree_path;
  const maxLoops = input.options.maxLoops;
  const startLoop = input.options.resumeRunId ? Math.min(state.current_loop + 1, maxLoops) : 1;

  const persistState = async (nextState: LoopState): Promise<void> => {
    await saveLoopState(runDirectory.loopStatePath, nextState);
    state = nextState;
  };
  let preserveCommittedArtifacts = false;
  let projectSummaryPath: string | undefined;
  let configFilePaths: string[] = [];

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
          repoRoot: input.cwd,
          baseBranch: input.options.baseBranch,
          targetBranch: input.options.targetBranch,
          inputDir: runDirectory.inputDir,
          commandLogPath: runDirectory.commandLogPath,
          config: input.config
        },
        executor
      );
      const safetyStop = diff.safety?.stopReason
        ? {
            reason: diff.safety.stopMessage ?? "Safety limits were exceeded.",
            status: diff.safety.stopReason === "max_diff_lines" ? ("abnormal_diff" as const) : ("human_review_required" as const)
          }
        : undefined;
      if (safetyStop) {
        const nextState: LoopState = {
          ...state,
          status: safetyStop.status,
          reason: safetyStop.reason,
          current_loop: loopNumber
        };
        await persistState(nextState);
        return {
          status: mapInternalStateToExternalStatus(safetyStop.status),
          reason: safetyStop.reason,
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      if (diff.safety?.warnings.length) {
        await writeFile(
          join(runDirectory.metaDir, "safety-warnings.json"),
          JSON.stringify({ warnings: diff.safety.warnings }, null, 2),
          "utf8"
        );
      }
      const baselineDiffLineCount = state.baseline_diff_line_count ?? diff.lineCount;
      if (state.baseline_diff_line_count === undefined) {
        await persistState({ ...state, baseline_diff_line_count: baselineDiffLineCount });
      }

      if (diff.isEmpty) {
        if (diff.isSameCommit) {
          const reason = `No diff to review because base ${input.options.baseBranch} and target ${input.options.targetBranch ?? "HEAD"} resolve to the same commit.`;
          const nextState: LoopState = {
            ...state,
            status: "failed",
            reason,
            current_loop: loopNumber
          };
          await persistState(nextState);
          return {
            status: "failed",
            reason,
            runId: runDirectory.runId,
            runDirectory: runDirectory.root
          };
        }
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

      if (!projectSummaryPath) {
        projectSummaryPath = join(runDirectory.inputDir, "project-summary.md");
        await buildProjectSummary({ repoRoot: input.cwd, outputPath: projectSummaryPath });
        configFilePaths = await listExistingConfigFiles(input.cwd);
      }

      const previousFinalResultPath =
        loopNumber > 1 ? join(runDirectory.finalDir, "final-result.json") : undefined;

      const review = await runClaudeReview(
        {
          config: input.config,
          cwd: worktreePath,
          diffPath: diff.diffPath,
          statusPath: diff.statusPath,
          reviewDir: runDirectory.reviewDir,
          commandLogPath: runDirectory.commandLogPath,
          projectSummaryPath,
          configFilePaths,
          previousFinalResultPath:
            previousFinalResultPath && (await fileExists(previousFinalResultPath))
              ? previousFinalResultPath
              : undefined
        },
        executor
      );

      if (review.source === "stdout_fallback" && review.review.tasks.length === 0) {
        const reason =
          "Claude produced an empty initial review only through the stdout JSON fallback; human verification is required.";
        const nextState: LoopState = {
          ...state,
          status: "human_review_required",
          reason,
          current_loop: loopNumber,
          history: [...state.history, { loop: loopNumber, action: "stop", reason }]
        };
        await persistState(nextState);
        return {
          status: mapInternalStateToExternalStatus(LOOP_HUMAN_REVIEW_STATUS),
          reason,
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

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

      const preFixSafetyReason = resolvePreFixSafetyReason(diff, review.review);
      if (preFixSafetyReason) {
        const nextState: LoopState = {
          ...state,
          status: "human_review_required",
          reason: preFixSafetyReason,
          current_loop: loopNumber,
          history: [...state.history, { loop: loopNumber, action: "stop", reason: preFixSafetyReason }]
        };
        await persistState(nextState);
        return {
          status: mapInternalStateToExternalStatus(LOOP_HUMAN_REVIEW_STATUS),
          reason: preFixSafetyReason,
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
          status: mapInternalStateToExternalStatus(LOOP_HUMAN_REVIEW_STATUS),
          reason: fix.reason ?? "Human review required.",
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      if (fix.status === "no_changes") {
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
          status: mapInternalStateToExternalStatus(LOOP_HUMAN_REVIEW_STATUS),
          reason: fix.reason,
          runId: runDirectory.runId,
          runDirectory: runDirectory.root
        };
      }

      const validation = await runValidation(
        input.config,
        worktreePath,
        runDirectory.validationDir,
        runDirectory.commandLogPath,
        executor,
        loopNumber
      );
      const refreshedDiff = await collectDiff(
        {
          cwd: worktreePath,
          repoRoot: input.cwd,
          baseBranch: input.options.baseBranch,
          targetBranch: input.options.targetBranch,
          inputDir: runDirectory.inputDir,
          commandLogPath: runDirectory.commandLogPath,
          config: input.config
        },
        executor
      );
      if (refreshedDiff.safety?.warnings.length) {
        await writeFile(
          join(runDirectory.metaDir, "safety-warnings.json"),
          JSON.stringify({ warnings: refreshedDiff.safety.warnings }, null, 2),
          "utf8"
        );
      }
      const postFixSafetyStop = refreshedDiff.safety?.stopReason
        ? refreshedDiff.safety.stopMessage ?? "Safety limits were exceeded after fixes."
        : undefined;
      const safetyWarningsPath = (await fileExists(join(runDirectory.metaDir, "safety-warnings.json")))
        ? join(runDirectory.metaDir, "safety-warnings.json")
        : undefined;
      const final = await runClaudeFinalReview(
        {
          config: input.config,
          cwd: worktreePath,
          initialReviewPath: review.markdownPath,
          validationResultPath: join(runDirectory.validationDir, "validation-result.json"),
          diffPath: refreshedDiff.diffPath,
          finalDir: runDirectory.finalDir,
          fixLogPaths: fix.outputPaths,
          commandLogPath: runDirectory.commandLogPath,
          safetyWarningsPath
        },
        executor
      );

      const repeated = detectRepeatedIssues(state.repeated_issues, final.finalResult.remaining_issues);
      const consecutiveTestFailures =
        validation.steps.test.status === "failed" ? state.consecutive_test_failures + 1 : 0;
      const allFixersTokenLimited =
        fix.attempts.length > 0 && fix.attempts.every((attempt) => attempt.status === "token_limited");
      let decision = shouldContinue({
        config: input.config,
        loopNumber,
        maxLoops,
        finalResult: final.finalResult,
        validationResult: validation,
        maxRepeatCount: repeated.maxRepeatCount,
        diffLineCount: refreshedDiff.lineCount,
        baselineDiffLineCount,
        allFixersTokenLimited,
        consecutiveTestFailures
      });

      if (postFixSafetyStop && decision.success) {
        decision = {
          action: "stop",
          status: refreshedDiff.safety?.stopReason === "max_diff_lines" ? "abnormal_diff" : "human_review_required",
          reason: postFixSafetyStop,
          success: false
        };
      }

      const nextState: LoopState = {
        ...state,
        status: decision.status,
        reason: decision.reason,
        current_loop: loopNumber,
        max_loops: maxLoops,
        final_decision: final.finalResult.decision,
        remaining_issues: final.finalResult.remaining_issues,
        repeated_issues: repeated.counts,
        consecutive_test_failures: consecutiveTestFailures,
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
          if (nextState.worktree_mode === "current") {
            resultReason = `${decision.reason} Automatic commit was skipped because git.use_worktree is false; commit the reviewed changes manually.`;
            const history = [...nextState.history];
            const lastHistory = history.at(-1);
            if (lastHistory) {
              history[history.length - 1] = { ...lastHistory, reason: resultReason };
            }
            await persistState({ ...nextState, reason: resultReason, history });
          } else {
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
            } else {
              preserveCommittedArtifacts = true;
              const artifactHint = formatCommittedArtifactHint(nextState);
              resultReason = artifactHint ? `${decision.reason} ${artifactHint}` : decision.reason;

              if (input.config.git.create_pr_on_success) {
                try {
                  const pullRequest = await createPullRequest(
                    {
                      cwd: worktreePath,
                      command: input.config.git.pr_command,
                      metaDir: runDirectory.metaDir,
                      commandLogPath: runDirectory.commandLogPath,
                      finalReviewMarkdownPath: final.markdownPath,
                      finalResult: final.finalResult
                    },
                    executor
                  );
                  if (pullRequest.status === "created") {
                    preserveCommittedArtifacts = false;
                  } else {
                    const pullRequestNote =
                      pullRequest.status === "auth_required"
                        ? `Pull request was not created because GitHub CLI is not authenticated. Run "gh auth login". ${pullRequest.reason}`
                        : pullRequest.status === "skipped"
                          ? `Pull request creation was skipped: ${pullRequest.reason}`
                          : `Pull request creation failed: ${pullRequest.reason}`;
                    resultReason = `${resultReason} ${pullRequestNote}`;
                    console.warn(`[ai-dev-loop] ${pullRequestNote}`);
                  }
                } catch (error) {
                  const pullRequestNote = `Pull request creation failed: ${formatErrorMessage(error)}`;
                  resultReason = `${resultReason} ${pullRequestNote}`;
                  console.warn(`[ai-dev-loop] ${pullRequestNote}`);
                }
              }

              const history = [...nextState.history];
              const lastHistory = history.at(-1);
              if (lastHistory) {
                history[history.length - 1] = { ...lastHistory, reason: resultReason };
              }
              await persistState({ ...nextState, reason: resultReason, history });
            }
          }
        }

        return {
          status: mapDecisionToExternalStatus(decision),
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
      isResumableStatus(state.status),
      preserveCommittedArtifacts,
      executor
    );
  }
}

export function getRequiredCliCommands(config: Config, options: RunLoopOptions): string[] {
  const commands = [resolveMainReviewerCommand(config)];
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

  const commonState = {
    run_id: runDirectory.runId,
    status: "running" as const,
    current_loop: 0,
    max_loops: input.options.maxLoops,
    remaining_issues: [],
    repeated_issues: {},
    consecutive_test_failures: 0,
    failovers: [],
    history: []
  };
  const state: LoopState =
    worktree.mode === "current"
      ? { ...commonState, worktree_path: worktree.path, worktree_mode: "current" }
      : worktree.mode === "worktree"
        ? {
            ...commonState,
            worktree_path: worktree.path,
            worktree_mode: "worktree",
            worktree_branch: worktree.branchName
          }
        : {
            ...commonState,
            worktree_path: worktree.path,
            worktree_mode: "branch",
            worktree_branch: worktree.branchName,
            worktree_original_branch: worktree.originalBranch,
            worktree_original_ref: worktree.originalRef
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

  if (validated.data.run_id !== runDirectory.runId) {
    throw new Error(`Cannot resume ${runDirectory.runId}: loop-state.json run_id does not match the requested run.`);
  }

  return validated.data;
}

async function saveLoopState(path: string, state: LoopState): Promise<void> {
  const validated = loopStateSchema.parse(state);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(validated, null, 2), "utf8");
}

async function cleanupLoopWorktree(
  cwd: string,
  state: LoopState,
  commandLogPath: string,
  preserveForResume: boolean,
  preserveCommittedArtifacts: boolean,
  executor: CommandExecutor
): Promise<void> {
  const preserveWorktree = preserveForResume || preserveCommittedArtifacts;
  try {
    if (preserveForResume) {
      console.warn(`[ai-dev-loop] run can be resumed; preserving worktree at ${state.worktree_path}`);
    } else if (preserveCommittedArtifacts) {
      const branchHint =
        state.worktree_mode !== "current" && state.worktree_branch ? ` on branch ${state.worktree_branch}` : "";
      console.warn(`[ai-dev-loop] committed changes preserved${branchHint} at ${state.worktree_path}`);
    }
    await cleanupWorktree(
      {
        cwd,
        mode: state.worktree_mode,
        path: state.worktree_path,
        branchName: state.worktree_mode === "current" ? undefined : state.worktree_branch,
        originalBranch: state.worktree_mode === "branch" ? state.worktree_original_branch : undefined,
        originalRef: state.worktree_mode === "branch" ? state.worktree_original_ref : undefined,
        preserveForResume: preserveWorktree,
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

function isResumableStatus(status: LoopStateStatus): boolean {
  return status === "human_review_required";
}

function formatCommittedArtifactHint(state: LoopState): string {
  const parts: string[] = [];
  if (state.worktree_mode !== "current" && state.worktree_branch) {
    parts.push(`Committed changes are on branch ${state.worktree_branch}.`);
  }
  if (state.worktree_mode === "worktree") {
    parts.push(`Worktree preserved at ${state.worktree_path}.`);
  }
  return parts.join(" ");
}

async function prepareResumeWorktree(
  cwd: string,
  config: Config,
  state: LoopState,
  commandLogPath: string,
  executor: CommandExecutor
): Promise<LoopState> {
  if (["completed", "approved"].includes(state.status)) {
    throw new Error(`Cannot resume ${state.run_id}: the run is already complete.`);
  }

  assertSafeWorktreePath(cwd, config.git.worktree_dir, state);

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

function assertSafeWorktreePath(cwd: string, configuredWorktreeDir: string, state: LoopState): void {
  const repositoryRoot = resolve(cwd);
  const statePath = resolve(state.worktree_path);
  if (state.worktree_mode !== "current" && state.worktree_branch !== `ai-dev-loop/${state.run_id}`) {
    throw new Error(`Cannot resume ${state.run_id}: temporary worktree branch does not match the run ID.`);
  }

  if (state.worktree_mode !== "worktree") {
    if (statePath !== repositoryRoot) {
      throw new Error(`Cannot resume ${state.run_id}: current/branch worktree path must match the repository root.`);
    }
    return;
  }

  const worktreesRoot = resolve(cwd, configuredWorktreeDir);
  const configuredPath = relative(repositoryRoot, worktreesRoot);
  if (configuredPath === "" || configuredPath === ".." || configuredPath.startsWith(`..${sep}`)) {
    throw new Error(`Cannot resume ${state.run_id}: configured worktree directory must be inside the repository.`);
  }

  const stateRelativePath = relative(worktreesRoot, statePath);
  if (stateRelativePath === "" || stateRelativePath === ".." || stateRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`Cannot resume ${state.run_id}: worktree path must be inside ${worktreesRoot}.`);
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toLoopStateFailovers(failovers: FixFailover[]): LoopState["failovers"] {
  return failovers.map((failover) => ({ ...failover }));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listExistingConfigFiles(repoRoot: string): Promise<string[]> {
  const candidates = [
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "eslint.config.mjs",
    ".eslintrc",
    ".eslintrc.json",
    "vitest.config.ts",
    "vite.config.ts"
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(join(repoRoot, candidate))) {
      existing.push(join(repoRoot, candidate));
    }
  }
  return existing;
}

function resolvePreFixSafetyReason(diff: Awaited<ReturnType<typeof collectDiff>>, review: ReviewJson): string | undefined {
  if (diff.safety?.matchedImportantFiles.length) {
    return `Important files changed (${diff.safety.matchedImportantFiles.join(", ")}); human review is required before applying fixes.`;
  }

  const blockerSecurity = review.tasks.find(
    (task) => task.severity === "blocker" && task.category === "security"
  );
  if (blockerSecurity) {
    return `Blocker security review task ${blockerSecurity.id} requires human review before applying fixes.`;
  }

  return undefined;
}
