import type { ReviewJson } from "../runners/reviewSchemas.js";

export interface CursorFixPromptInput {
  review: ReviewJson;
  reviewJsonPath: string;
  currentDiffPath?: string;
}

export function buildCursorFixPrompt(input: CursorFixPromptInput): string {
  return [
    "Use the fix-pr-comments workflow to continue addressing unresolved review comments.",
    "",
    `Review JSON: ${input.reviewJsonPath}`,
    input.currentDiffPath ? `Current diff: ${input.currentDiffPath}` : "",
    "",
    "Apply changes in non-interactive print/apply mode.",
    "Constraints: preserve compatibility, keep changes minimal, prioritize blocker/critical/major, add tests where needed, avoid unrelated refactors, and report anything not fixed.",
    "",
    "Remaining tasks:",
    ...input.review.tasks.map((task) => `- [${task.severity}] ${task.id}: ${task.title}`)
  ]
    .filter(Boolean)
    .join("\n");
}
