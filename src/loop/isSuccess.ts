import type { FinalResult } from "../runners/reviewSchemas.js";
import { hasImportantIssues } from "../runners/reviewSchemas.js";
import type { ValidationResult } from "../runners/runValidation.js";
import { validationAllPassed } from "../runners/runValidation.js";

export interface SuccessCheckInput {
  finalResult: FinalResult;
  validationResult: ValidationResult;
}

export function hasOnlyNitIssues(finalResult: FinalResult): boolean {
  if (finalResult.remaining_issues.length === 0) {
    return false;
  }
  return finalResult.remaining_issues.every((issue) => issue.severity === "nit");
}

export function isNitOnlySuccess(input: SuccessCheckInput): boolean {
  if (input.finalResult.decision === "human_review_required") {
    return false;
  }

  return (
    validationAllPassed(input.validationResult) &&
    hasOnlyNitIssues(input.finalResult) &&
    !hasImportantIssues(input.finalResult.remaining_issues)
  );
}

export function isSuccess(input: SuccessCheckInput): boolean {
  if (!validationAllPassed(input.validationResult)) {
    return false;
  }

  if (isNitOnlySuccess(input)) {
    return true;
  }

  return input.finalResult.decision === "approved" && !hasImportantIssues(input.finalResult.remaining_issues);
}
