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
  allFixersTokenLimited?: boolean;
}

export interface LoopDecision {
  action: LoopDecisionAction;
  status: "approved" | "needs_changes" | "human_review_required" | "max_loops" | "repeated_issue" | "abnormal_diff";
  reason: string;
  success: boolean;
}

export function shouldContinue(input: LoopDecisionInput): LoopDecision {
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

  if (input.diffLineCount && input.diffLineCount > input.config.limits.abnormal_diff_line_threshold) {
    return {
      action: "stop",
      status: "abnormal_diff",
      reason: `Diff grew beyond ${input.config.limits.abnormal_diff_line_threshold} lines.`,
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
