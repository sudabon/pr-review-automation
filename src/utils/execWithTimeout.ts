import { execa } from "execa";
import { writeFile } from "node:fs/promises";
import { writeCommandLog } from "../logs/writeCommandLog.js";

export interface ExecWithTimeoutOptions {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  outputPath?: string;
  commandLogPath?: string;
}

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
  timedOut: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export type CommandExecutor = (options: ExecWithTimeoutOptions) => Promise<ExecResult>;

export function formatCommand(command: string, args: string[] = []): string {
  return [command, ...args].join(" ");
}

export const defaultExecutor: CommandExecutor = async (options) => {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const commandString = formatCommand(options.command, options.args);

  try {
    const subprocess = options.shell
      ? await execa(options.command, {
          cwd: options.cwd,
          env: options.env,
          input: options.input,
          reject: false,
          shell: true,
          timeout: options.timeoutMs,
          all: true
        })
      : await execa(options.command, options.args ?? [], {
          cwd: options.cwd,
          env: options.env,
          input: options.input,
          reject: false,
          timeout: options.timeoutMs,
          all: true
        });

    const endedAtDate = new Date();
    const all = subprocess.all ?? `${subprocess.stdout ?? ""}${subprocess.stderr ?? ""}`;
    const result: ExecResult = {
      command: commandString,
      exitCode: subprocess.exitCode ?? 0,
      stdout: subprocess.stdout ?? "",
      stderr: subprocess.stderr ?? "",
      all,
      timedOut: false,
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
      message?: string;
    };
    const result: ExecResult = {
      command: commandString,
      exitCode: maybeError.exitCode ?? 124,
      stdout: maybeError.stdout ?? "",
      stderr: maybeError.stderr ?? maybeError.message ?? "",
      all: maybeError.all ?? `${maybeError.stdout ?? ""}${maybeError.stderr ?? maybeError.message ?? ""}`,
      timedOut: Boolean(maybeError.timedOut),
      startedAt,
      endedAt: endedAtDate.toISOString(),
      durationMs: endedAtDate.getTime() - startedAtDate.getTime()
    };

    await persistExecResult(options, result);
    return result;
  }
};

export async function execWithTimeout(
  options: ExecWithTimeoutOptions,
  executor: CommandExecutor = defaultExecutor
): Promise<ExecResult> {
  return executor(options);
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
      duration_ms: result.durationMs
    });
  }
}
