import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { buildProgram, resolveRunOptions, runCli } from "../src/cli.js";
import { CONFIG_PATH } from "../src/config/loadConfig.js";
import { createDefaultConfig } from "../src/config/schema.js";
import { withTempDir } from "./helpers.js";

describe("CLI", () => {
  it("init creates config and protects existing config", async () => {
    await withTempDir(async (dir) => {
      const output: string[] = [];
      await runCli(["node", "ai-dev-loop", "init"], dir, { stdout: { write: (message: string) => output.push(message) } });
      const configPath = join(dir, CONFIG_PATH);
      expect(await readFile(configPath, "utf8")).toContain("project");

      await writeFile(configPath, "project:\n  name: existing\n", "utf8");
      await runCli(["node", "ai-dev-loop", "init"], dir, { stdout: { write: (message: string) => output.push(message) } });
      expect(await readFile(configPath, "utf8")).toContain("existing");
      expect(output.join("")).toContain("already exists");
    });
  });

  it("resolves run option priority from CLI over config defaults", () => {
    const config = createDefaultConfig("demo");
    config.git.base_branch = "develop";
    config.limits.max_loops = 5;
    config.git.commit_on_success = true;

    const options = resolveRunOptions(config, {
      base: "main",
      maxLoops: 1,
      commit: false,
      dryRun: true,
      onlyReview: false
    });

    expect(options.baseBranch).toBe("main");
    expect(options.maxLoops).toBe(1);
    expect(options.commitOnSuccess).toBe(false);
    expect(options.dryRun).toBe(true);
  });

  it("run loads config and delegates to runLoop", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, CONFIG_PATH);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, "project:\n  name: demo\nlimits:\n  max_loops: 5\n", "utf8");
      const runLoopImpl = vi.fn().mockResolvedValue({
        status: "completed",
        reason: "done",
        runId: "run-1",
        runDirectory: join(dir, ".ai-dev-loop", "runs", "run-1")
      });
      const output: string[] = [];

      await runCli(
        ["node", "ai-dev-loop", "run", "--max-loops", "1", "--dry-run"],
        dir,
        { stdout: { write: (message: string) => output.push(message) } },
        { runLoopImpl }
      );

      expect(runLoopImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: dir,
          options: expect.objectContaining({ maxLoops: 1, dryRun: true })
        })
      );
    });
  });

  it("unknown commands fail with a commander error", async () => {
    const output: string[] = [];
    const program = buildProgram("/tmp", {
      stdout: { write: (message: string) => output.push(message) },
      stderr: { write: (message: string) => output.push(message) }
    });
    await expect(program.parseAsync(["node", "ai-dev-loop", "unknown"], { from: "node" })).rejects.toBeInstanceOf(
      CommanderError
    );
    expect(output.join("")).toContain("unknown command");
  });
});
