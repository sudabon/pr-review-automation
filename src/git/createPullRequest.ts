import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export interface CreatePullRequestInput {
  cwd: string;
  command: string;
  metaDir: string;
  commandLogPath?: string;
}

export type PullRequestResult =
  | { status: "created"; url?: string }
  | { status: "skipped" | "failed"; reason: string };

export async function createPullRequest(
  input: CreatePullRequestInput,
  executor: CommandExecutor = execWithTimeout
): Promise<PullRequestResult> {
  await mkdir(input.metaDir, { recursive: true });
  const resultPath = join(input.metaDir, "pr-result.json");
  let result: PullRequestResult;

  const parsed = parseCommandLine(input.command);
  if (!parsed || parsed.command !== "gh" || parsed.args[0] !== "pr" || parsed.args[1] !== "create") {
    result = { status: "failed", reason: 'git.pr_command must start with "gh pr create".' };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  let auth;
  try {
    auth = await executor({
      command: "gh",
      args: ["auth", "status"],
      cwd: input.cwd,
      commandLogPath: input.commandLogPath
    });
  } catch (error) {
    result = { status: "skipped", reason: formatError(error) };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }
  if (auth.exitCode !== 0) {
    result = { status: "skipped", reason: auth.stderr || auth.all || "gh is not authenticated." };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  let created;
  try {
    created = await executor({
      command: parsed.command,
      args: parsed.args,
      cwd: input.cwd,
      commandLogPath: input.commandLogPath
    });
  } catch (error) {
    result = { status: "failed", reason: formatError(error) };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }
  if (created.exitCode !== 0) {
    result = {
      status: "failed",
      reason: created.stderr || created.all || `gh exited with code ${created.exitCode}`
    };
  } else {
    result = { status: "created", url: created.stdout.match(/https:\/\/\S+/)?.[0] };
  }

  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCommandLine(input: string): { command: string; args: string[] } | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }

  if (escaped || quote) return null;
  if (token) tokens.push(token);
  const [command, ...args] = tokens;
  return command ? { command, args } : null;
}
