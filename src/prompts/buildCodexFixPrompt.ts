import type { ReviewJson } from "../runners/reviewSchemas.js";

export interface FixPromptInput {
  review: ReviewJson;
  reviewJsonPath: string;
  commentsPath?: string;
}

export function buildCodexFixPrompt(input: FixPromptInput): string {
  return [
    "Use the fix-pr-comments skill to address review comments for this repository.",
    "",
    `Review JSON: ${input.reviewJsonPath}`,
    input.commentsPath ? `Review comments: ${input.commentsPath}` : "",
    "",
    "Constraints:",
    "- Preserve existing behavior and public APIs.",
    "- Keep changes minimal and focused.",
    "- Prioritize blocker, critical, and major findings.",
    "- Add or update tests where needed.",
    "- Do not do unrelated refactoring.",
    "- If an item cannot be fixed, explain why in the output.",
    "",
    "Tasks:",
    ...input.review.tasks.map((task) => `- [${task.severity}] ${task.id}: ${task.title}`)
  ]
    .filter(Boolean)
    .join("\n");
}
