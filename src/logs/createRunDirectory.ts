import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface RunDirectory {
  runId: string;
  root: string;
  inputDir: string;
  reviewDir: string;
  fixDir: string;
  validationDir: string;
  finalDir: string;
  metaDir: string;
  commandLogPath: string;
  loopStatePath: string;
}

export function generateRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${suffix}`;
}

export async function createRunDirectory(cwd: string, runId = generateRunId()): Promise<RunDirectory> {
  const root = join(cwd, ".ai-dev-loop", "runs", runId);
  const dirs = {
    inputDir: join(root, "input"),
    reviewDir: join(root, "review"),
    fixDir: join(root, "fix"),
    validationDir: join(root, "validation"),
    finalDir: join(root, "final"),
    metaDir: join(root, "meta")
  };

  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));

  return {
    runId,
    root,
    ...dirs,
    commandLogPath: join(dirs.metaDir, "command-log.jsonl"),
    loopStatePath: join(dirs.metaDir, "loop-state.json")
  };
}

export function getRunDirectory(cwd: string, runId: string): RunDirectory {
  const root = join(cwd, ".ai-dev-loop", "runs", runId);
  const inputDir = join(root, "input");
  const reviewDir = join(root, "review");
  const fixDir = join(root, "fix");
  const validationDir = join(root, "validation");
  const finalDir = join(root, "final");
  const metaDir = join(root, "meta");

  return {
    runId,
    root,
    inputDir,
    reviewDir,
    fixDir,
    validationDir,
    finalDir,
    metaDir,
    commandLogPath: join(metaDir, "command-log.jsonl"),
    loopStatePath: join(metaDir, "loop-state.json")
  };
}
