import type { Config } from "../config/schema.js";
import { extractChangedFilePaths, filterDiff, matchesAnyPattern, type FilteredDiff } from "./filterDiff.js";

export type SafetyStopReason = "max_changed_files" | "max_diff_lines" | "important_file_changed";

export interface SafetyWarning {
  type: "lockfile_large_change";
  file: string;
  lineCount: number;
  threshold: number;
  message: string;
}

export interface SafetyCheckResult {
  filtered: FilteredDiff;
  stopReason?: SafetyStopReason;
  stopMessage?: string;
  matchedImportantFiles: string[];
  warnings: SafetyWarning[];
}

const LOCKFILE_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

export function checkSafetyLimits(
  diff: string,
  config: Config,
  ignorePatterns: string[]
): SafetyCheckResult {
  const filtered = filterDiff(diff, ignorePatterns);
  const changedFiles = extractChangedFilePaths(diff);
  const warnings = collectLockfileWarnings(diff, config.limits.lockfile_change_warn_lines);

  if (changedFiles.length > config.limits.max_changed_files) {
    return {
      filtered,
      stopReason: "max_changed_files",
      stopMessage: `Changed file count ${changedFiles.length} exceeds the configured limit of ${config.limits.max_changed_files}.`,
      matchedImportantFiles: [],
      warnings
    };
  }

  if (filtered.lineCount > config.limits.max_diff_lines) {
    return {
      filtered,
      stopReason: "max_diff_lines",
      stopMessage: `Filtered diff line count ${filtered.lineCount} exceeds the configured limit of ${config.limits.max_diff_lines}.`,
      matchedImportantFiles: [],
      warnings
    };
  }

  const matchedImportantFiles = changedFiles.filter((filePath) =>
    matchesAnyPattern(filePath, config.safety.important_file_patterns)
  );

  return {
    filtered,
    matchedImportantFiles,
    warnings
  };
}

function collectLockfileWarnings(diff: string, threshold: number): SafetyWarning[] {
  const warnings: SafetyWarning[] = [];
  const sections = diff.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const filePath = extractSectionFilePath(section);
    if (!filePath || !LOCKFILE_NAMES.has(filePath.split("/").pop() ?? filePath)) {
      continue;
    }
    const lineCount = countSectionChangedLines(section);
    if (lineCount > threshold) {
      warnings.push({
        type: "lockfile_large_change",
        file: filePath,
        lineCount,
        threshold,
        message: `${filePath} changed by ${lineCount} diff lines, exceeding the warning threshold of ${threshold}.`
      });
    }
  }

  return warnings;
}

function extractSectionFilePath(section: string): string | undefined {
  const match = /^a\/(.+?) b\/(.+)$/m.exec(section);
  if (!match) {
    return undefined;
  }
  const [, left, right] = match;
  if (left === "/dev/null") {
    return right;
  }
  if (right === "/dev/null") {
    return left;
  }
  return right ?? left;
}

function countSectionChangedLines(section: string): number {
  let inHunk = false;
  let count = 0;
  for (const line of section.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      count += 1;
    }
  }
  return count;
}
