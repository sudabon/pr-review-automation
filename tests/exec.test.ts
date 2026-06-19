import { describe, expect, it } from "vitest";
import { execWithTimeout } from "../src/utils/execWithTimeout.js";

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
});
