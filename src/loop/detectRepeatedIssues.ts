import type { NormalizedRemainingIssue } from "../runners/reviewSchemas.js";

export type RepeatedIssueCounts = Record<string, number>;

export interface RepeatedIssueResult {
  counts: RepeatedIssueCounts;
  maxRepeatCount: number;
  repeatedKeys: string[];
}

export function detectRepeatedIssues(
  previousCounts: RepeatedIssueCounts,
  currentIssues: NormalizedRemainingIssue[]
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

export function issueKey(issue: NormalizedRemainingIssue): string {
  if ("id" in issue && issue.id) {
    return normalize(issue.id);
  }

  const category = "category" in issue ? issue.category : undefined;
  const title = "title" in issue ? issue.title : undefined;
  return normalize([issue.severity, category, title ?? issue.description].filter(Boolean).join(":"));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
