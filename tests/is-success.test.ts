import { describe, expect, it } from "vitest";
import { isNitOnlySuccess, isSuccess } from "../src/loop/isSuccess.js";
import type { ValidationResult } from "../src/runners/runValidation.js";

const validationPassed: ValidationResult = {
  status: "passed",
  allPassed: true,
  stop_on_validation_failure: false,
  all_steps_skipped: false,
  steps: {
    install: { status: "skipped", exit_code: null },
    lint: { status: "passed", exit_code: 0 },
    typecheck: { status: "passed", exit_code: 0 },
    test: { status: "passed", exit_code: 0 },
    build: { status: "skipped", exit_code: null }
  }
};

describe("success criteria", () => {
  it("requires approved, allPassed, and no major-or-higher issues", () => {
    expect(
      isSuccess({
        finalResult: { decision: "approved", remaining_issues: [], reason: "ok" },
        validationResult: validationPassed
      })
    ).toBe(true);

    expect(
      isSuccess({
        finalResult: { decision: "approved", remaining_issues: [], reason: "ok" },
        validationResult: { ...validationPassed, allPassed: false, status: "failed" }
      })
    ).toBe(false);

    expect(
      isSuccess({
        finalResult: {
          decision: "approved",
          remaining_issues: [{ severity: "major", title: "Bug" }],
          reason: "still open"
        },
        validationResult: validationPassed
      })
    ).toBe(false);
  });

  it("treats nit-only remaining issues as success when validation passes", () => {
    expect(
      isNitOnlySuccess({
        finalResult: {
          decision: "needs_changes",
          remaining_issues: [
            { severity: "nit", title: "Nit 1" },
            { severity: "nit", title: "Nit 2" }
          ],
          reason: "nits only"
        },
        validationResult: validationPassed
      })
    ).toBe(true);
  });
});
