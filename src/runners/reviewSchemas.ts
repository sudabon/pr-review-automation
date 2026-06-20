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

const remainingIssueObjectSchema = z
  .strictObject({
    id: z.string().min(1).optional(),
    severity: severitySchema.default("major"),
    category: categorySchema.optional(),
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    reason: z.string().optional()
  })
  .refine((issue) => issue.title !== undefined || issue.description !== undefined, {
    message: "A remaining issue must include a non-empty title or description."
  });

const remainingIssueStringSchema = z
  .string()
  .trim()
  .min(1)
  .transform((description) => ({ severity: "major" as const, description }));

export const remainingIssueSchema = z.union([remainingIssueStringSchema, remainingIssueObjectSchema]);

export const finalResultSchema = z.strictObject({
  decision: z.enum(["approved", "needs_changes", "human_review_required"]),
  remaining_issues: z.array(remainingIssueSchema),
  reason: z.string()
});

export type ReviewJson = z.infer<typeof reviewSchema>;
export type ReviewTask = z.infer<typeof reviewTaskSchema>;
export type FinalResult = z.infer<typeof finalResultSchema>;
export type RemainingIssue = z.input<typeof remainingIssueSchema>;
export type NormalizedRemainingIssue = z.output<typeof remainingIssueSchema>;

export function hasImportantIssues(issues: NormalizedRemainingIssue[]): boolean {
  return issues.some((issue) => ["blocker", "critical", "major"].includes(issue.severity));
}
