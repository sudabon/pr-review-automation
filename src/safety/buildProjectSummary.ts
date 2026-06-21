import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_CANDIDATES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  "vitest.config.ts",
  "vite.config.ts"
] as const;

export interface ProjectSummaryInput {
  repoRoot: string;
  outputPath: string;
}

export async function buildProjectSummary(input: ProjectSummaryInput): Promise<string> {
  const lines: string[] = ["# Project Summary", ""];
  const packageJsonPath = join(input.repoRoot, "package.json");

  try {
    await access(packageJsonPath);
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    lines.push("## package.json", "");
    if (parsed.name) {
      lines.push(`- name: ${parsed.name}`);
    }
    if (parsed.scripts) {
      lines.push("- scripts:", ...Object.keys(parsed.scripts).map((name) => `  - ${name}`));
    }
    if (parsed.dependencies) {
      lines.push(`- dependencies: ${Object.keys(parsed.dependencies).length} packages`);
    }
    if (parsed.devDependencies) {
      lines.push(`- devDependencies: ${Object.keys(parsed.devDependencies).length} packages`);
    }
    lines.push("");
  } catch {
    lines.push("## package.json", "", "package.json was not found.", "");
  }

  const existingConfigFiles: string[] = [];
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      await access(join(input.repoRoot, candidate));
      existingConfigFiles.push(candidate);
    } catch {
      // ignore missing files
    }
  }

  lines.push("## Configuration files", "");
  if (existingConfigFiles.length === 0) {
    lines.push("No known configuration files were found.");
  } else {
    lines.push(...existingConfigFiles.map((file) => `- ${file}`));
  }
  lines.push("");

  const content = `${lines.join("\n")}\n`;
  await writeFile(input.outputPath, content, "utf8");
  return content;
}
