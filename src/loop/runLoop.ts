import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config/schema.js";
import { collectDiff } from "../git/collectDiff.js";
import { commitChanges } from "../git/commitChanges.js";
import { ensureGitRepository, ensureRequiredCliCommands } from "../git/checks.js";
import { createWorktree } from "../git/createWorktree.js";
import { createRunDirectory, getRunDirectory, type RunDirectory } from "../logs/createRunDirectory.js";
import { runClaudeFinalReview } from "../runners/runClaudeFinalReview.js";
import { runClaudeReview } from "../runners/runClaudeReview.js";
import { runFix, type FixFailover } from "../runners/runFix.js";
import { runValidation } from "../runners/runValidation.js";
import type { FinalResult, RemainingIssue } from "../runners/reviewSchemas.js";
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

export interface LoopState {
  run_id: string;
  status: string;
  reason?: string;
  current_loop: number;
  max_loops: number;
  worktree_path: string;
  worktree_mode?: string;
  final_decision?: FinalResult["decision"];
  remaining_issues: RemainingIssue[];
  repeated_issues: RepeatedIssueCounts;
  failovers: FixFailover[];
  history: Array<{
    loop: number;
    decision?: FinalResult["decision"];
    validation?: string;
    action?: string;
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

export async function runLoop(input: RunLoopInput): Promise<RunLoopResult> {
  const executor = input.executor ?? execWithTimeout;
  const runDirectory = input.options.resumeRunId
    ? getRunDirectory(input.cwd, input.options.resumeRunId)
    : await createRunDirectory(input.cwd);
  const state = input.options.resumeRunId
    ? await loadExistingState(runDirectory)
    : await initializeRun(input, runDirectory, executor);

  const worktreePath = state.worktree_path;
  const maxLoops = input.options.maxLoops;
  const startLoop = input.options.resumeRunId ? Math.min(state.current_loop + 1, maxLoops) : 1;

  for (let loopNumber = startLoop; loopNumber <= maxLoops; loopNumber += 1) {
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
      const nextState = {
        ...state,
        status: "completed",
        reason: "No diff to review.",
        current_loop: loopNumber
      };
      await saveLoopState(runDirectory.loopStatePath, nextState);
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
      const nextState = {
        ...state,
        status: "completed",
        reason: "Stopped after Claude review because --only-review was set.",
        current_loop: loopNumber,
        history: [
          ...state.history,
          { loop: loopNumber, action: "only_review", reason: "Stopped after Claude review." }
        ]
      };
      await saveLoopState(runDirectory.loopStatePath, nextState);
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
      const nextState = {
        ...state,
        status: "human_review_required",
        reason: fix.reason,
        current_loop: loopNumber,
        failovers: [...state.failovers, ...fix.failovers],
        history: [...state.history, { loop: loopNumber, action: "stop", reason: fix.reason }]
      };
      await saveLoopState(runDirectory.loopStatePath, nextState);
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
    const decision = shouldContinue({
      config: input.config,
      loopNumber,
      maxLoops,
      finalResult: final.finalResult,
      validationResult: validation,
      maxRepeatCount: repeated.maxRepeatCount,
      diffLineCount: refreshedDiff.lineCount,
      allFixersTokenLimited: false
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
    await saveLoopState(runDirectory.loopStatePath, nextState);

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
        status: decision.success ? "completed" : decision.status === "human_review_required" ? "needs_human_review" : "failed",
        reason: decision.reason,
        runId: runDirectory.runId,
        runDirectory: runDirectory.root,
        decision
      };
    }

    state.repeated_issues = nextState.repeated_issues;
    state.remaining_issues = nextState.remaining_issues;
    state.failovers = nextState.failovers;
    state.history = nextState.history;
    state.current_loop = nextState.current_loop;
  }

  return {
    status: "failed",
    reason: "Maximum loop count reached.",
    runId: runDirectory.runId,
    runDirectory: runDirectory.root
  };
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

  return JSON.parse(await readFile(runDirectory.loopStatePath, "utf8")) as LoopState;
}

async function saveLoopState(path: string, state: LoopState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}
