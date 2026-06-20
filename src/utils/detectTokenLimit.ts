import type { Config, FixerName } from "../config/schema.js";
import type { ExecResult } from "./execWithTimeout.js";

export const DEFAULT_TOKEN_LIMIT_PATTERNS = [
  "token limit",
  "quota exceeded",
  "rate limit exceeded",
  "rate_limit_exceeded",
  "rate_limit_error",
  "context length",
  "maximum context",
  "usage limit",
  "too many requests",
  "http 429",
  "status code 429"
];

export interface DetectTokenLimitInput {
  result: Pick<ExecResult, "exitCode" | "stdout" | "stderr" | "all">;
  fixer?: FixerName;
  config?: Config;
  patterns?: string[];
}

export function detectTokenLimit(input: DetectTokenLimitInput): boolean {
  return detectTokenLimitPattern(input) !== undefined;
}

export function detectTokenLimitPattern(input: DetectTokenLimitInput): string | undefined {
  if (input.result.exitCode === 0) {
    return undefined;
  }

  const configured =
    input.fixer && input.config
      ? input.config.agents.token_limit_patterns[input.fixer] ?? []
      : [];
  const patterns = [...DEFAULT_TOKEN_LIMIT_PATTERNS, ...configured, ...(input.patterns ?? [])];
  const stderr = input.result.stderr.trim().slice(-4_000).toLowerCase();
  const stderrPattern = patterns.find((pattern) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern) {
      return false;
    }
    if (/^\d+$/.test(normalizedPattern)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedPattern)}([^a-z0-9]|$)`, "i").test(stderr);
    }
    return stderr.includes(normalizedPattern);
  });
  if (stderrPattern) {
    return stderrPattern;
  }

  // Failed CLIs can echo the prompt to stdout/all. Scan stdout only for narrow,
  // machine-oriented diagnostics that are unlikely to occur in review prose.
  const stdout = input.result.stdout.trim().slice(-4_000).toLowerCase();
  if (/(^|[^a-z0-9_])rate_limit_exceeded([^a-z0-9_]|$)/i.test(stdout)) {
    return "rate_limit_exceeded";
  }
  if (/(^|[\s[(])429(?=$|[\s)\],.;:])/i.test(stdout)) {
    return "429";
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
