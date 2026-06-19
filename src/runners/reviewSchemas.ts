import { z } from "zod";

export const severitySchema = z.enum(["blocker", "critical", "major", "minor", "nit"]);
export const categorySchema = z.enum(["bug", "security", "type", "test", "refactor", "design", "docs"]);
export const riskSchema = z.enum(["low", "medium", "high"]);

export const reviewTaskSchema = z.strictObject({
  id: z.string().min(1),
  severity: severitySchema,
  category: categorySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  files: z.array(z.string()),
  suggested_fix: z.string().min(1),
  acceptance_criteria: z.array(z.string()).min(1)
});

export const reviewSchema = z.strictObject({
  summary: z.string(),
  overall_risk: riskSchema,
  tasks: z.array(reviewTaskSchema)
});

export const remainingIssueSchema = z.union([
  z.string(),
  z.strictObject({
    id: z.string().optional(),
    severity: severitySchema.default("major"),
    category: categorySchema.optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    reason: z.string().optional()
  })
]);

export const finalResultSchema = z.strictObject({
  decision: z.enum(["approved", "needs_changes", "human_review_required"]),
  remaining_issues: z.array(remainingIssueSchema),
  reason: z.string()
});

export type ReviewJson = z.infer<typeof reviewSchema>;
export type ReviewTask = z.infer<typeof reviewTaskSchema>;
export type FinalResult = z.infer<typeof finalResultSchema>;
export type RemainingIssue = z.infer<typeof remainingIssueSchema>;

export function hasImportantIssues(issues: RemainingIssue[]): boolean {
  return issues.some((issue) => {
    if (typeof issue === "string") {
      return issue.trim().length > 0;
    }
    return ["blocker", "critical", "major"].includes(issue.severity);
  });
}
