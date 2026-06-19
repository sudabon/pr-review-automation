#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { initConfig, loadConfig } from "./config/loadConfig.js";
import type { Config } from "./config/schema.js";
import { runLoop, type RunLoopOptions } from "./loop/runLoop.js";

export interface CliIo {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface CliDependencies {
  runLoopImpl?: typeof runLoop;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommanderError(1, "commander.invalidArgument", "Expected a positive integer");
  }
  return parsed;
}

export function resolveRunOptions(config: Config, cliOptions: Record<string, unknown>): RunLoopOptions {
  return {
    baseBranch: (cliOptions.base as string | undefined) ?? config.git.base_branch ?? config.project.base_branch,
    targetBranch: (cliOptions.target as string | undefined) ?? config.git.target_branch,
    maxLoops: (cliOptions.maxLoops as number | undefined) ?? config.limits.max_loops,
    commitOnSuccess: cliOptions.commit === false ? false : config.git.commit_on_success,
    dryRun: Boolean(cliOptions.dryRun),
    onlyReview: Boolean(cliOptions.onlyReview),
    resumeRunId: cliOptions.resume as string | undefined
  };
}

export function buildProgram(cwd = process.cwd(), io: CliIo = {}, deps: CliDependencies = {}): Command {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const runLoopImpl = deps.runLoopImpl ?? runLoop;

  const program = new Command();
  program
    .name("ai-dev-loop")
    .description("Run a local AI review, fix, validation, and re-review loop.")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (message) => stdout.write(message),
      writeErr: (message) => stderr.write(message)
    });

  program
    .command("init")
    .description("Create .ai-dev-loop/config.yml with default settings.")
    .action(async () => {
      const result = await initConfig(cwd);
      if (result.created) {
        stdout.write(`Created ${result.path}\n`);
      } else {
        stdout.write(`Config already exists at ${result.path}; leaving it unchanged.\n`);
      }
    });

  program
    .command("run")
    .description("Run the AI development loop for the current repository.")
    .option("--base <branch>", "Base branch to compare against")
    .option("--target <branch>", "Target branch to review/fix")
    .option("--max-loops <count>", "Maximum loop count", parsePositiveInt)
    .option("--no-commit", "Do not commit after approved final review")
    .option("--dry-run", "Review and plan without applying fixer changes")
    .option("--only-review", "Stop after Claude review output is generated")
    .option("--resume <run_id>", "Resume an existing run")
    .action(async (options) => {
      const config = await loadConfig(cwd);
      const runOptions = resolveRunOptions(config, options);
      const result = await runLoopImpl({ cwd, config, options: runOptions });
      stdout.write(`${result.status}: ${result.reason}\n`);
    });

  return program;
}

export async function runCli(
  argv = process.argv,
  cwd = process.cwd(),
  io: CliIo = {},
  deps: CliDependencies = {}
): Promise<void> {
  const program = buildProgram(cwd, io, deps);
  await program.parseAsync(argv, { from: "node" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
