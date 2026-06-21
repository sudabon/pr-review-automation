import { execa } from "execa";
import { writeFile } from "node:fs/promises";
import { writeCommandLog } from "../logs/writeCommandLog.js";

export interface ExecWithTimeoutOptions {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  /** Shell execution is not supported and throws when set. */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  outputPath?: string;
  commandLogPath?: string;
  step?: string;
}

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
  timedOut: boolean;
  spawnFailed?: boolean;
  signal?: string;
  isCanceled?: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export type CommandExecutor = (options: ExecWithTimeoutOptions) => Promise<ExecResult>;

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export function formatCommand(command: string, args: string[] = []): string {
  return [command, ...args].join(" ");
}

export const defaultExecutor: CommandExecutor = async (rawOptions) => {
  const options = withDefaultTimeout(rawOptions);
  if (options.shell) {
    throw new Error("Shell execution is not supported; pass the command and args separately.");
  }
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const commandString = formatCommand(options.command, options.args);

  try {
    const subprocess = await execa(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      reject: false,
      timeout: options.timeoutMs,
      all: true
    });

    const completed = subprocess as typeof subprocess & {
      failed?: boolean;
      timedOut?: boolean;
      signal?: string;
      isCanceled?: boolean;
    };
    const terminatedBySignal = completed.signal !== undefined || completed.isCanceled === true;
    if (completed.failed && completed.exitCode === undefined && !completed.timedOut && !terminatedBySignal) {
      throw subprocess;
    }

    const endedAtDate = new Date();
    const all = subprocess.all ?? `${subprocess.stdout ?? ""}${subprocess.stderr ?? ""}`;
    const spawnFailed =
      completed.failed === true && completed.exitCode === undefined && !completed.timedOut && !terminatedBySignal;
    const result: ExecResult = {
      command: commandString,
      exitCode: completed.exitCode ?? (completed.timedOut ? 124 : spawnFailed ? 127 : 1),
      stdout: subprocess.stdout ?? "",
      stderr: subprocess.stderr ?? "",
      all,
      timedOut: Boolean(completed.timedOut),
      spawnFailed: spawnFailed || undefined,
      signal: completed.signal,
      isCanceled: Boolean(completed.isCanceled),
      startedAt,
      endedAt: endedAtDate.toISOString(),
      durationMs: endedAtDate.getTime() - startedAtDate.getTime()
    };

    await persistExecResult(options, result);
    return result;
  } catch (error) {
    const endedAtDate = new Date();
    const maybeError = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      all?: string;
      timedOut?: boolean;
      signal?: string;
      isCanceled?: boolean;
      message?: string;
      code?: string;
      errno?: number;
    };

    if (maybeError.timedOut) {
      const result: ExecResult = {
        command: commandString,
        exitCode: maybeError.exitCode ?? 124,
        stdout: maybeError.stdout ?? "",
        stderr: maybeError.stderr ?? maybeError.message ?? "",
        all: maybeError.all ?? `${maybeError.stdout ?? ""}${maybeError.stderr ?? maybeError.message ?? ""}`,
        timedOut: true,
        signal: maybeError.signal,
        isCanceled: Boolean(maybeError.isCanceled),
        startedAt,
        endedAt: endedAtDate.toISOString(),
        durationMs: endedAtDate.getTime() - startedAtDate.getTime()
      };

      await persistExecResult(options, result);
      return result;
    }

    if (isSpawnError(maybeError)) {
      const result: ExecResult = {
        command: commandString,
        exitCode: 127,
        stdout: maybeError.stdout ?? "",
        stderr: maybeError.stderr ?? maybeError.message ?? "",
        all: maybeError.all ?? `${maybeError.stdout ?? ""}${maybeError.stderr ?? maybeError.message ?? ""}`,
        timedOut: false,
        spawnFailed: true,
        startedAt,
        endedAt: endedAtDate.toISOString(),
        durationMs: endedAtDate.getTime() - startedAtDate.getTime()
      };

      await persistExecResult(options, result);
      return result;
    }

    throw error;
  }
};

export async function execWithTimeout(
  options: ExecWithTimeoutOptions,
  executor: CommandExecutor = defaultExecutor
): Promise<ExecResult> {
  return executor(withDefaultTimeout(options));
}

function isSpawnError(error: { code?: string; errno?: number }): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.errno === -2;
}

function withDefaultTimeout(options: ExecWithTimeoutOptions): ExecWithTimeoutOptions {
  if (options.timeoutMs !== undefined || options.command !== "git") {
    return options;
  }
  return { ...options, timeoutMs: DEFAULT_GIT_TIMEOUT_MS };
}

async function persistExecResult(options: ExecWithTimeoutOptions, result: ExecResult): Promise<void> {
  if (options.outputPath) {
    await writeFile(options.outputPath, result.all, "utf8");
  }

  if (options.commandLogPath) {
    await writeCommandLog(options.commandLogPath, {
      command: result.command,
      cwd: options.cwd,
      started_at: result.startedAt,
      ended_at: result.endedAt,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      signal: result.signal,
      is_canceled: result.isCanceled,
      duration_ms: result.durationMs,
      step: options.step
    });
  }
}
