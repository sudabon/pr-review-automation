import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigNotFoundError, ConfigValidationError, CONFIG_PATH, initConfig, loadConfig } from "../src/config/loadConfig.js";
import { createDefaultConfig } from "../src/config/schema.js";
import { withTempDir } from "./helpers.js";

describe("configuration", () => {
  it("loads a valid partial config and applies defaults", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, CONFIG_PATH);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        [
          "project:",
          "  name: demo",
          "agents:",
          "  fixers:",
          "    - cursor",
          "commands:",
          "  build: ''"
        ].join("\n"),
        "utf8"
      );

      const config = await loadConfig(dir);

      expect(config.project.name).toBe("demo");
      expect(config.limits.max_loops).toBe(3);
      expect(config.limits.max_same_issue_repeats).toBe(2);
      expect(config.git.use_worktree).toBe(true);
      expect(config.git.commit_on_success).toBe(true);
      expect(config.git.create_pr_on_success).toBe(false);
      expect(config.agents.fixers).toEqual(["cursor"]);
      expect(config.commands.build).toBe("");
    });
  });

  it("reports missing config with an init hint", async () => {
    await withTempDir(async (dir) => {
      await expect(loadConfig(dir)).rejects.toThrow(ConfigNotFoundError);
      await expect(loadConfig(dir)).rejects.toThrow("ai-dev-loop init");
    });
  });

  it("reports invalid field types", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, CONFIG_PATH);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, "limits:\n  max_loops: nope\n", "utf8");

      await expect(loadConfig(dir)).rejects.toThrow(ConfigValidationError);
      await expect(loadConfig(dir)).rejects.toThrow("limits.max_loops");
    });
  });

  it("rejects unknown fields explicitly", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, CONFIG_PATH);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, "project:\n  name: demo\n  unexpected: true\n", "utf8");

      await expect(loadConfig(dir)).rejects.toThrow("Unrecognized key");
    });
  });

  it("creates default config without overwriting an existing file", async () => {
    await withTempDir(async (dir) => {
      const created = await initConfig(dir);
      expect(created.created).toBe(true);
      expect(await loadConfig(dir)).toMatchObject({ project: { name: expect.any(String) } });

      await writeFile(created.path, "project:\n  name: preserved\n", "utf8");
      const second = await initConfig(dir);
      expect(second.created).toBe(false);
      expect(await readFile(created.path, "utf8")).toContain("preserved");
    });
  });

  it("defines the expected default fixer failover order", () => {
    const config = createDefaultConfig("demo");
    expect(config.agents.fixers).toEqual(["codex", "cursor"]);
    expect(config.agents.token_limit_patterns.codex.length).toBeGreaterThan(0);
  });
});
