export function matchesIgnorePattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  if (normalizedPattern.endsWith("/")) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`) || normalizedPath.includes(`/${prefix}/`);
  }

  if (normalizedPattern.startsWith("**/")) {
    const suffix = normalizedPattern.slice(3);
    if (suffix.endsWith("/")) {
      const dir = suffix.slice(0, -1);
      return normalizedPath === dir || normalizedPath.endsWith(`/${dir}`) || normalizedPath.includes(`/${dir}/`);
    }
    if (suffix.includes("*")) {
      return globMatch(normalizedPath, normalizedPattern);
    }
    return normalizedPath === suffix || normalizedPath.endsWith(`/${suffix}`);
  }

  if (normalizedPattern.includes("/")) {
    if (normalizedPattern.includes("*")) {
      return globMatch(normalizedPath, normalizedPattern);
    }
    return normalizedPath === normalizedPattern || normalizedPath.endsWith(`/${normalizedPattern}`);
  }

  if (normalizedPattern.includes("*")) {
    const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
    return globMatch(fileName, normalizedPattern) || globMatch(normalizedPath, `**/${normalizedPattern}`);
  }

  return normalizedPath === normalizedPattern || normalizedPath.endsWith(`/${normalizedPattern}`);
}

export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesIgnorePattern(filePath, pattern));
}

function globMatch(value: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")}$`
  );
  return regex.test(value);
}

export interface FilteredDiff {
  diff: string;
  lineCount: number;
  changedFiles: string[];
  removedFiles: string[];
}

export function filterDiff(diff: string, patterns: string[]): FilteredDiff {
  if (diff.trim().length === 0) {
    return { diff: "", lineCount: 0, changedFiles: [], removedFiles: [] };
  }

  const sections = splitDiffSections(diff);
  const keptSections: string[] = [];
  const changedFiles: string[] = [];
  const removedFiles: string[] = [];

  for (const section of sections) {
    const filePath = extractFilePath(section);
    if (!filePath) {
      keptSections.push(section);
      continue;
    }
    if (matchesAnyPattern(filePath, patterns)) {
      removedFiles.push(filePath);
      continue;
    }
    keptSections.push(section);
    changedFiles.push(filePath);
  }

  const filtered = keptSections.join("");
  return {
    diff: filtered,
    lineCount: countChangedLines(filtered),
    changedFiles,
    removedFiles
  };
}

export function extractChangedFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const section of splitDiffSections(diff)) {
    const filePath = extractFilePath(section);
    if (filePath) {
      paths.add(filePath);
    }
  }
  return [...paths];
}

function splitDiffSections(diff: string): string[] {
  const lines = diff.split(/\r?\n/);
  const sections: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current);
  }

  return sections.map((section) => (section.join("\n").endsWith("\n") ? `${section.join("\n")}` : `${section.join("\n")}\n`));
}

function extractFilePath(section: string): string | undefined {
  const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
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

function countChangedLines(diff: string): number {
  let inHunk = false;
  let count = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch")) {
      inHunk = false;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      count += 1;
    }
  }

  return count;
}
