import { describe, expect, it } from "vitest";
import { mapDecisionToExternalStatus, mapInternalStateToExternalStatus } from "../src/loop/statusMapping.js";
import type { LoopDecision } from "../src/loop/shouldContinue.js";

describe("status mapping", () => {
  it("maps internal human review status to the external CLI status", () => {
    expect(mapInternalStateToExternalStatus("human_review_required")).toBe("needs_human_review");
    expect(mapInternalStateToExternalStatus("completed")).toBe("completed");
    expect(mapInternalStateToExternalStatus("failed")).toBe("failed");
  });

  it("maps loop decisions exhaustively", () => {
    const approved: LoopDecision = { action: "stop", status: "approved", reason: "ok", success: true };
    const humanReview: LoopDecision = {
      action: "stop",
      status: "human_review_required",
      reason: "review",
      success: false
    };
    const repeated: LoopDecision = {
      action: "stop",
      status: "repeated_issue",
      reason: "repeat",
      success: false
    };

    expect(mapDecisionToExternalStatus(approved)).toBe("completed");
    expect(mapDecisionToExternalStatus(humanReview)).toBe("needs_human_review");
    expect(mapDecisionToExternalStatus(repeated)).toBe("failed");
  });
});
