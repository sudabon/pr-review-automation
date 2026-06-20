import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import type { CommandExecutor, ExecResult, ExecWithTimeoutOptions } from "../src/utils/execWithTimeout.js";

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ai-dev-loop-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function execResult(partial: Partial<ExecResult> = {}): ExecResult {
  return {
    command: partial.command ?? "test",
    exitCode: partial.exitCode ?? 0,
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    all: partial.all ?? partial.stdout ?? "",
    timedOut: partial.timedOut ?? false,
    signal: partial.signal,
    isCanceled: partial.isCanceled ?? false,
    startedAt: partial.startedAt ?? "2026-06-19T00:00:00.000Z",
    endedAt: partial.endedAt ?? "2026-06-19T00:00:01.000Z",
    durationMs: partial.durationMs ?? 1000
  };
}

export function makeExecutor(
  handler: (options: ExecWithTimeoutOptions, calls: ExecWithTimeoutOptions[]) => ExecResult | Promise<ExecResult>
): CommandExecutor & { calls: ExecWithTimeoutOptions[] } {
  const calls: ExecWithTimeoutOptions[] = [];
  const executor = (async (options: ExecWithTimeoutOptions) => {
    calls.push(options);
    const result = await handler(options, calls);
    const resolved = {
      ...result,
      command: result.command === "test" ? [options.command, ...(options.args ?? [])].join(" ") : result.command
    };
    if (options.outputPath) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, resolved.all, "utf8");
    }
    return resolved;
  }) as CommandExecutor & { calls: ExecWithTimeoutOptions[] };
  executor.calls = calls;
  return executor;
}
