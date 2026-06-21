import type { LoopStateStatus } from "./runLoop.js";
import type { LoopDecision } from "./shouldContinue.js";

/** CLI-facing loop result status. */
export type RunLoopExternalStatus = "completed" | "failed" | "needs_human_review";

/** Persisted loop-state status for human escalation. */
export const LOOP_HUMAN_REVIEW_STATUS = "human_review_required" as const satisfies LoopStateStatus;

export function mapDecisionToExternalStatus(decision: LoopDecision): RunLoopExternalStatus {
  if (decision.success) {
    return "completed";
  }
  switch (decision.status) {
    case "human_review_required":
      return "needs_human_review";
    case "needs_changes":
    case "max_loops":
    case "repeated_issue":
    case "abnormal_diff":
      return "failed";
  }
}

export function mapInternalStateToExternalStatus(status: LoopStateStatus): RunLoopExternalStatus {
  switch (status) {
    case "completed":
    case "approved":
      return "completed";
    case "human_review_required":
      return "needs_human_review";
    case "running":
    case "failed":
    case "needs_changes":
    case "max_loops":
    case "repeated_issue":
    case "abnormal_diff":
      return "failed";
    default: {
      const exhaustiveCheck: never = status;
      return exhaustiveCheck;
    }
  }
}
