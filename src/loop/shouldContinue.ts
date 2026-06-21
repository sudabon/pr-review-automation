import type { Config } from "../config/schema.js";
import { hasImportantIssues, type FinalResult } from "../runners/reviewSchemas.js";
import type { ValidationResult } from "../runners/runValidation.js";

export type LoopDecisionAction = "continue" | "stop";

export interface LoopDecisionInput {
  config: Config;
  loopNumber: number;
  maxLoops: number;
  finalResult: FinalResult;
  validationResult: ValidationResult;
  maxRepeatCount: number;
  diffLineCount?: number;
  baselineDiffLineCount?: number;
  allFixersTokenLimited?: boolean;
  consecutiveTestFailures?: number;
}

export type LoopDecision =
  | {
      action: "continue";
      status: "needs_changes";
      reason: string;
      success: false;
    }
  | {
      action: "stop";
      status: "approved";
      reason: string;
      success: true;
    }
  | {
      action: "stop";
      status: "human_review_required" | "max_loops" | "repeated_issue" | "abnormal_diff";
      reason: string;
      success: false;
    };

export function shouldContinue(input: LoopDecisionInput): LoopDecision {
  if (input.validationResult.all_steps_skipped) {
    return {
      action: "stop",
      status: "human_review_required",
      reason:
        "All validation commands are empty or unset; configure commands.lint, commands.typecheck, commands.test, or commands.build before continuing.",
      success: false
    };
  }

  const signaledSteps = Object.entries(input.validationResult.steps)
    .filter(([, step]) => step.signal || step.is_canceled)
    .map(([name, step]) => `${name}${step.signal ? ` (${step.signal})` : " (canceled)"}`);
  if (signaledSteps.length > 0) {
    return {
      action: "stop",
      status: "human_review_required",
      reason: `Validation was terminated for: ${signaledSteps.join(", ")}.`,
      success: false
    };
  }

  if (input.validationResult.status === "failed" && input.config.limits.stop_on_validation_failure) {
    const timedOutSteps = Object.entries(input.validationResult.steps)
      .filter(([, step]) => step.timed_out)
      .map(([name]) => name);
    return {
      action: "stop",
      status: "human_review_required",
      reason: timedOutSteps.length > 0
        ? `Validation timed out for: ${timedOutSteps.join(", ")}. stop_on_validation_failure is enabled.`
        : "Validation failed and stop_on_validation_failure is enabled.",
      success: false
    };
  }

  const degradationLimit = input.config.limits.test_failure_degradation_limit;
  if (degradationLimit > 0 && (input.consecutiveTestFailures ?? 0) >= degradationLimit) {
    return {
      action: "stop",
      status: "human_review_required",
      reason: `Tests failed for ${input.consecutiveTestFailures} consecutive loops, reaching the configured degradation limit of ${degradationLimit}.`,
      success: false
    };
  }

  if (input.finalResult.decision === "approved") {
    return { action: "stop", status: "approved", reason: input.finalResult.reason, success: true };
  }

  if (input.allFixersTokenLimited) {
    return {
      action: "stop",
      status: "human_review_required",
      reason: "All configured fixers reached token limits.",
      success: false
    };
  }

  if (input.finalResult.decision === "human_review_required") {
    return { action: "stop", status: "human_review_required", reason: input.finalResult.reason, success: false };
  }

  const diffGrowth = Math.max(0, (input.diffLineCount ?? 0) - (input.baselineDiffLineCount ?? 0));
  if (diffGrowth > input.config.limits.abnormal_diff_line_threshold) {
    return {
      action: "stop",
      status: "abnormal_diff",
      reason: `Fixer increased the diff by ${diffGrowth} lines, beyond the ${input.config.limits.abnormal_diff_line_threshold}-line threshold.`,
      success: false
    };
  }

  if (input.maxRepeatCount >= input.config.limits.max_same_issue_repeats) {
    return {
      action: "stop",
      status: "repeated_issue",
      reason: "The same issue remained across the configured repeat limit.",
      success: false
    };
  }

  if (input.loopNumber >= input.maxLoops) {
    return { action: "stop", status: "max_loops", reason: "Maximum loop count reached.", success: false };
  }

  if (
    input.finalResult.decision === "needs_changes" ||
    input.validationResult.status === "failed" ||
    hasImportantIssues(input.finalResult.remaining_issues)
  ) {
    return { action: "continue", status: "needs_changes", reason: input.finalResult.reason, success: false };
  }

  return {
    action: "stop",
    status: "human_review_required",
    reason: "Final review did not approve, but no automatic continuation condition matched.",
    success: false
  };
}
