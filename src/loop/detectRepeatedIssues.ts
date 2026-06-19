import type { RemainingIssue } from "../runners/reviewSchemas.js";

export type RepeatedIssueCounts = Record<string, number>;

export interface RepeatedIssueResult {
  counts: RepeatedIssueCounts;
  maxRepeatCount: number;
  repeatedKeys: string[];
}

export function detectRepeatedIssues(
  previousCounts: RepeatedIssueCounts,
  currentIssues: RemainingIssue[]
): RepeatedIssueResult {
  const currentKeys = [...new Set(currentIssues.map(issueKey).filter(Boolean))];
  const counts: RepeatedIssueCounts = {};

  for (const key of currentKeys) {
    counts[key] = (previousCounts[key] ?? 0) + 1;
  }

  const values = Object.values(counts);
  const maxRepeatCount = values.length > 0 ? Math.max(...values) : 0;
  return {
    counts,
    maxRepeatCount,
    repeatedKeys: Object.entries(counts)
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
  };
}

export function issueKey(issue: RemainingIssue): string {
  if (typeof issue === "string") {
    return normalize(issue);
  }

  if (issue.id) {
    return normalize(issue.id);
  }

  return normalize([issue.severity, issue.category, issue.title ?? issue.description].filter(Boolean).join(":"));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
