import { z } from "zod";
import { DEFAULT_TOKEN_LIMIT_PATTERNS } from "../utils/detectTokenLimit.js";

export const fixerSchema = z.enum(["codex", "cursor"]);

export const commandsSchema = z
  .strictObject({
    install: z.string().default("pnpm install"),
    lint: z.string().default("lint"),
    typecheck: z.string().default("typecheck"),
    test: z.string().default("test"),
    build: z.string().default("build")
  })
  .prefault({});

const configObjectSchema = z.strictObject({
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
        .strictObject({
          codex: z.array(z.string().trim().min(1)).default(DEFAULT_TOKEN_LIMIT_PATTERNS),
          cursor: z.array(z.string().trim().min(1)).default(DEFAULT_TOKEN_LIMIT_PATTERNS)
        })
        .prefault({})
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
      worktree_mode: z.enum(["worktree", "branch"]).default("worktree"),
      commit_on_success: z.boolean().default(true),
      create_pr_on_success: z.boolean().default(false),
      pr_command: z.string().default("gh pr create --fill"),
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

export const configSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const input = value as Record<string, unknown>;
  const project = input.project;
  if (typeof project !== "object" || project === null || !("base_branch" in project)) {
    return value;
  }

  const git = typeof input.git === "object" && input.git !== null ? (input.git as Record<string, unknown>) : {};
  if ("base_branch" in git) {
    return value;
  }

  // Retain project.base_branch as a backward-compatible alias. An explicit
  // git.base_branch remains authoritative when both are present.
  return { ...input, git: { ...git, base_branch: (project as Record<string, unknown>).base_branch } };
}, configObjectSchema);

type ParsedConfig = z.infer<typeof configSchema>;
export type Config = Omit<ParsedConfig, "git"> & {
  git: Omit<ParsedConfig["git"], "worktree_mode"> & {
    worktree_mode?: ParsedConfig["git"]["worktree_mode"];
  };
};
export type FixerName = z.infer<typeof fixerSchema>;

export function resolveMainReviewerCommand(config: Config): string {
  return config.agents.main_reviewer === "claude" ? config.claude.command : config.agents.main_reviewer;
}

export function createDefaultConfig(projectName = "ai-dev-loop-target"): Config {
  return configSchema.parse({
    project: {
      name: projectName
    }
  });
}
