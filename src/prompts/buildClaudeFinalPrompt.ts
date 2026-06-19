import type { Config } from "../config/schema.js";

export interface ClaudeFinalPromptInput {
  config: Config;
  initialReviewPath: string;
  validationResultPath: string;
  diffPath: string;
  finalResultPath: string;
  fixLogPaths: string[];
}

export function buildClaudeFinalPrompt(input: ClaudeFinalPromptInput): string {
  return [
    "Perform the final review for this AI development loop.",
    "",
    "Inputs:",
    `- Initial review: ${input.initialReviewPath}`,
    `- Current diff: ${input.diffPath}`,
    `- Validation result: ${input.validationResultPath}`,
    ...input.fixLogPaths.map((path) => `- Fixer output: ${path}`),
    "",
    "Decide whether the current state is approved, needs more changes, or requires human review.",
    "Use human_review_required for authentication/billing/external-service integration, DB migrations, security design changes, large architecture changes, UI/UX product judgment, or production-data impact.",
    "",
    `Write JSON to ${input.finalResultPath} with exactly:`,
    "- decision: approved | needs_changes | human_review_required",
    "- remaining_issues: array",
    "- reason: string",
    "",
    `Project: ${input.config.project.name}`
  ].join("\n");
}
