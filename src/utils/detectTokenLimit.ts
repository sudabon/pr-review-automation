import type { Config } from "../config/schema.js";
import type { ExecResult } from "./execWithTimeout.js";

export const DEFAULT_TOKEN_LIMIT_PATTERNS = [
  "token limit",
  "quota exceeded",
  "rate limit",
  "rate_limit",
  "context length",
  "maximum context",
  "usage limit",
  "too many requests",
  "429"
];

export interface DetectTokenLimitInput {
  result: Pick<ExecResult, "exitCode" | "stdout" | "stderr" | "all">;
  fixer?: string;
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
  const haystack = input.result.stderr.trim().slice(-4_000).toLowerCase();

  return patterns.find((pattern) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern) {
      return false;
    }
    if (/^\d+$/.test(normalizedPattern)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedPattern)}([^a-z0-9]|$)`, "i").test(haystack);
    }
    return haystack.includes(normalizedPattern);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
