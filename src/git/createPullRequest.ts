import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";
import type { FinalResult } from "../runners/reviewSchemas.js";

export interface CreatePullRequestInput {
  cwd: string;
  command: string;
  metaDir: string;
  commandLogPath?: string;
  finalReviewMarkdownPath?: string;
  finalResult?: FinalResult;
}

export type PullRequestResult =
  | { status: "created"; url?: string }
  | { status: "auth_required"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const UNSAFE_PR_TOKEN_PATTERN = /[;&|`$()<>\\]/;

function isSafePullRequestToken(token: string): boolean {
  return token.length > 0 && !UNSAFE_PR_TOKEN_PATTERN.test(token);
}

export async function createPullRequest(
  input: CreatePullRequestInput,
  executor: CommandExecutor = execWithTimeout
): Promise<PullRequestResult> {
  await mkdir(input.metaDir, { recursive: true });
  const resultPath = join(input.metaDir, "pr-result.json");
  let result: PullRequestResult;

  const parsed = parsePullRequestCommand(input.command);
  if (!parsed) {
    result = {
      status: "failed",
      reason: 'git.pr_command must be a safe "gh pr create" command with allowed arguments only.'
    };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  const auth = await executor({
    command: "gh",
    args: ["auth", "status"],
    cwd: input.cwd,
    commandLogPath: input.commandLogPath,
    step: "pr_auth"
  });
  if (auth.spawnFailed) {
    result = { status: "skipped", reason: auth.stderr || auth.all || "gh is not available." };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }
  if (auth.exitCode !== 0) {
    result = {
      status: "auth_required",
      reason: auth.stderr || auth.all || "gh is not authenticated. Run `gh auth login`."
    };
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  const bodyAppendix = await buildPullRequestBodyAppendix(input);
  const args = appendBodyToPullRequestArgs(parsed.args, bodyAppendix);

  const created = await executor({
    command: parsed.command,
    args,
    cwd: input.cwd,
    commandLogPath: input.commandLogPath,
    step: "pr_create"
  });
  if (created.spawnFailed) {
    result = { status: "skipped", reason: created.stderr || created.all || "gh is not available." };
  } else if (created.exitCode !== 0) {
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

async function buildPullRequestBodyAppendix(input: CreatePullRequestInput): Promise<string | undefined> {
  const sections: string[] = [];

  if (input.finalReviewMarkdownPath) {
    try {
      const markdown = await readFile(input.finalReviewMarkdownPath, "utf8");
      const summary = markdown.trim();
      if (summary) {
        sections.push("## AI Review Summary", "", summary);
      }
    } catch {
      // optional input
    }
  }

  if (input.finalResult && input.finalResult.remaining_issues.length > 0) {
    sections.push(
      "## Remaining Issues",
      "",
      ...input.finalResult.remaining_issues.map((issue) => {
        const label = "title" in issue && issue.title ? issue.title : issue.description ?? "issue";
        return `- [${issue.severity}] ${label}`;
      })
    );
  }

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n");
}

export function appendBodyToPullRequestArgs(args: string[], bodyAppendix?: string): string[] {
  if (!bodyAppendix) {
    return args;
  }

  const nextArgs = args.filter((token) => token !== "--fill");
  const bodyIndex = nextArgs.indexOf("--body");
  if (bodyIndex >= 0) {
    const existingBody = nextArgs[bodyIndex + 1] ?? "";
    nextArgs[bodyIndex + 1] = `${existingBody}\n\n${bodyAppendix}`.trim();
    return nextArgs;
  }

  nextArgs.push("--body", bodyAppendix);
  return nextArgs;
}

export function parsePullRequestCommand(input: string): { command: string; args: string[] } | null {
  const parsed = parseCommandLine(input);
  if (!parsed || parsed.command !== "gh" || parsed.args[0] !== "pr" || parsed.args[1] !== "create") {
    return null;
  }

  const tokens = [parsed.command, ...parsed.args];
  if (tokens.some((token) => !isSafePullRequestToken(token))) {
    return null;
  }

  return parsed;
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
