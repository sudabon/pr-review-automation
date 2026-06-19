import { z } from "zod";
import { DEFAULT_TOKEN_LIMIT_PATTERNS } from "../utils/detectTokenLimit.js";

export const fixerSchema = z.enum(["codex", "cursor"]);

export const commandsSchema = z
  .strictObject({
    install: z.string().default("pnpm install"),
    lint: z.string().default("pnpm run lint"),
    typecheck: z.string().default("pnpm run typecheck"),
    test: z.string().default("pnpm run test"),
    build: z.string().default("pnpm run build")
  })
  .prefault({});

export const configSchema = z.strictObject({
  project: z
    .strictObject({
      name: z.string().min(1).default("ai-dev-loop-target"),
      package_manager: z.enum(["npm", "pnpm", "yarn", "bun"]).default("pnpm"),
      base_branch: z.string().min(1).default("main")
    })
    .prefault({}),
  agents: z
    .strictObject({
      main_reviewer: z.string().min(1).default("claude"),
      fixers: z.array(fixerSchema).min(1).default(["codex", "cursor"]),
      token_limit_patterns: z
        .record(z.string(), z.array(z.string()))
        .default({
          codex: DEFAULT_TOKEN_LIMIT_PATTERNS,
          cursor: DEFAULT_TOKEN_LIMIT_PATTERNS
        })
    })
    .prefault({}),
  limits: z
    .strictObject({
      max_loops: z.number().int().positive().default(3),
      max_same_issue_repeats: z.number().int().positive().default(2),
      stop_on_validation_failure: z.boolean().default(true),
      abnormal_diff_line_threshold: z.number().int().positive().default(2500),
      test_failure_degradation_limit: z.number().int().nonnegative().default(2)
    })
    .prefault({}),
  commands: commandsSchema,
  git: z
    .strictObject({
      base_branch: z.string().min(1).default("main"),
      target_branch: z.string().min(1).optional(),
      use_worktree: z.boolean().default(true),
      commit_on_success: z.boolean().default(true),
      create_pr_on_success: z.boolean().default(false),
      pr_command: z.string().default("gh pr view --json number,title,url,headRefName,baseRefName"),
      worktree_dir: z.string().default(".ai-dev-loop/worktrees")
    })
    .prefault({}),
  claude: z
    .strictObject({
      command: z.string().min(1).default("claude"),
      args: z.array(z.string()).default(["-p"]),
      timeout_sec: z.number().int().positive().default(1800)
    })
    .prefault({}),
  codex: z
    .strictObject({
      command: z.string().min(1).default("codex"),
      args: z.array(z.string()).default(["exec", "--full-auto"]),
      timeout_sec: z.number().int().positive().default(1800)
    })
    .prefault({}),
  cursor: z
    .strictObject({
      command: z.string().min(1).default("agent"),
      args: z.array(z.string()).default(["-p", "--force", "--output-format", "text"]),
      timeout_sec: z.number().int().positive().default(1800)
    })
    .prefault({})
});

export type Config = z.infer<typeof configSchema>;
export type FixerName = z.infer<typeof fixerSchema>;

export function createDefaultConfig(projectName = "ai-dev-loop-target"): Config {
  return configSchema.parse({
    project: {
      name: projectName
    }
  });
}
