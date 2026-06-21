import type { Config } from "../config/schema.js";

export interface ClaudeReviewPromptInput {
  config: Config;
  diffPath: string;
  statusPath: string;
  reviewJsonPath: string;
  projectSummaryPath?: string;
  configFilePaths?: string[];
  previousFinalResultPath?: string;
}

export function buildClaudeReviewPrompt(input: ClaudeReviewPromptInput): string {
  return [
    "/review-pr",
    "",
    "Review the Git changes for this repository using the pr-review-toolkit:review-pr workflow.",
    "",
    "Inputs:",
    `- Git diff: ${input.diffPath}`,
    `- Git status: ${input.statusPath}`,
    input.projectSummaryPath ? `- Project summary: ${input.projectSummaryPath}` : "",
    ...(input.configFilePaths ?? []).map((path) => `- Config file: ${path}`),
    input.previousFinalResultPath ? `- Previous loop final result: ${input.previousFinalResultPath}` : "",
    `- Project: ${input.config.project.name}`,
    "",
    "Review focus:",
    "- Bugs, security issues, type safety, missing tests, readability, design problems, breaking changes, and over-engineering.",
    "- Prioritize actionable findings. Do not invent issues not grounded in the diff.",
    "",
    `Write a structured JSON task file to ${input.reviewJsonPath}. The JSON must be an object with:`,
    "- summary: string",
    "- overall_risk: low | medium | high",
    "- tasks: array of objects with id, severity, category, title, description, files, suggested_fix, acceptance_criteria",
    "",
    "Allowed severities: blocker, critical, major, minor, nit.",
    "Allowed categories: bug, security, type, refactor, design, docs.",
    "Use a deterministic task id based on the finding identity and source location. Keep the same id when the same finding is reworded in a later loop.",
    "",
    "Also return a Markdown review summary in the CLI output."
  ]
    .filter(Boolean)
    .join("\n");
}
