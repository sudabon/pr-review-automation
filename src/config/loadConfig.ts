import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import YAML from "yaml";
import { ZodError } from "zod";
import { configSchema, createDefaultConfig, type Config } from "./schema.js";

export const CONFIG_PATH = join(".ai-dev-loop", "config.yml");

export class ConfigNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Configuration not found at ${path}. Run "ai-dev-loop init" first.`);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[]
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export async function loadConfig(cwd: string): Promise<Config> {
  const path = join(cwd, CONFIG_PATH);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigNotFoundError(path);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new ConfigValidationError(`Invalid YAML in ${path}: ${(error as Error).message}`, [
      (error as Error).message
    ]);
  }

  try {
    return configSchema.parse(parsed ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${location}: ${issue.message}`;
      });
      throw new ConfigValidationError(`Invalid configuration in ${path}:\n${issues.join("\n")}`, issues);
    }
    throw error;
  }
}

export async function initConfig(cwd: string): Promise<{ path: string; created: boolean }> {
  const path = join(cwd, CONFIG_PATH);

  try {
    await access(path);
    return { path, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(join(cwd, ".ai-dev-loop"), { recursive: true });
  const defaultConfig = createDefaultConfig(basename(cwd));
  await writeFile(path, YAML.stringify(defaultConfig), "utf8");
  return { path, created: true };
}
