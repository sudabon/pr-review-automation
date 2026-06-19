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
  const configured =
    input.fixer && input.config
      ? input.config.agents.token_limit_patterns[input.fixer] ?? []
      : [];
  const patterns = [...DEFAULT_TOKEN_LIMIT_PATTERNS, ...configured, ...(input.patterns ?? [])];
  const haystack = `${input.result.stderr}\n${input.result.stdout}\n${input.result.all}`.toLowerCase();

  return patterns.some((pattern) => {
    if (!pattern.trim()) {
      return false;
    }
    return haystack.includes(pattern.toLowerCase());
  });
}
