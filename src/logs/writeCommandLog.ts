import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface CommandLogEntry {
  command: string;
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  cwd?: string;
  timed_out?: boolean;
  signal?: string;
  is_canceled?: boolean;
  duration_ms?: number;
  event?: string;
  reason?: string;
  step?: string;
}

export async function writeCommandLog(logPath: string, entry: CommandLogEntry): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
