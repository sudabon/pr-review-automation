import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GIT_TIMEOUT_MS, execWithTimeout } from "../src/utils/execWithTimeout.js";
import { execResult, makeExecutor, withTempDir } from "./helpers.js";

describe("execWithTimeout", () => {
  it("returns an ExecResult for timeouts", async () => {
    const result = await execWithTimeout({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 10
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("throws spawn failures instead of converting them to timeout results", async () => {
    await expect(
      execWithTimeout({
        command: `definitely-missing-ai-dev-loop-command-${Date.now()}`
      })
    ).rejects.toThrow();
  });

  it("reports signal termination as a non-zero failure", async () => {
    const result = await execWithTimeout({
      command: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"]
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      signal: "SIGTERM"
    });
  });

  it("applies a default timeout to git commands", async () => {
    const executor = makeExecutor(() => execResult());

    await execWithTimeout({ command: "git", args: ["status"] }, executor);

    expect(executor.calls[0]?.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS);
  });

  it("persists command output and timing metadata", async () => {
    await withTempDir(async (dir) => {
      const outputPath = join(dir, "output.log");
      const commandLogPath = join(dir, "command-log.jsonl");

      const result = await execWithTimeout({
        command: process.execPath,
        args: ["-e", "process.stdout.write('artifact')"],
        outputPath,
        commandLogPath
      });

      expect(result.exitCode).toBe(0);
      expect(await readFile(outputPath, "utf8")).toBe("artifact");
      expect(JSON.parse(await readFile(commandLogPath, "utf8"))).toMatchObject({
        exit_code: 0,
        timed_out: false,
        is_canceled: false,
        duration_ms: expect.any(Number)
      });
    });
  });

  it("records termination signals in the command log", async () => {
    await withTempDir(async (dir) => {
      const commandLogPath = join(dir, "command-log.jsonl");

      await execWithTimeout({
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
        commandLogPath
      });

      expect(JSON.parse(await readFile(commandLogPath, "utf8"))).toMatchObject({ signal: "SIGTERM" });
    });
  });

  it("rejects the deprecated shell execution path instead of dropping args", async () => {
    await expect(
      execWithTimeout({ command: "printf", args: ["%s", "shell-args"], shell: true })
    ).rejects.toThrow("Shell execution is not supported");
  });
});
