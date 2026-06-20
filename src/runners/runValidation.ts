import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export type ValidationStepName = "lint" | "typecheck" | "test" | "build";
export type ValidationStatus = "passed" | "failed" | "skipped";

export interface ValidationStepResult {
  status: ValidationStatus;
  exit_code: number | null;
  log_path?: string;
  timed_out?: boolean;
  stderr?: string;
}

export interface ValidationResult {
  status: "passed" | "failed";
  stop_on_validation_failure: boolean;
  steps: Record<ValidationStepName, ValidationStepResult>;
}

const VALIDATION_ORDER: ValidationStepName[] = ["lint", "typecheck", "test", "build"];
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@./:+,=\-]+$/;

interface ParsedValidationCommand {
  command: string;
  args: string[];
}

export async function runValidation(
  config: Config,
  cwd: string,
  validationDir: string,
  commandLogPath?: string,
  executor: CommandExecutor = execWithTimeout
): Promise<ValidationResult> {
  await mkdir(validationDir, { recursive: true });
  const steps = {} as Record<ValidationStepName, ValidationStepResult>;

  for (const name of VALIDATION_ORDER) {
    const command = config.commands[name].trim();
    const logPath = join(validationDir, `${name}.log`);

    if (!command) {
      steps[name] = { status: "skipped", exit_code: null, timed_out: false, stderr: "" };
      continue;
    }

    const parsedCommand = parseValidationCommand(command, config.project.package_manager);
    if (!parsedCommand) {
      const rejectionReason = validationCommandRejectionReason(command, config.project.package_manager);
      await writeFile(
        logPath,
        `${rejectionReason}\n`,
        "utf8"
      );
      steps[name] = {
        status: "failed",
        exit_code: 1,
        log_path: logPath,
        timed_out: false,
        stderr: rejectionReason
      };
      continue;
    }

    const result = await executor({
      command: parsedCommand.command,
      args: parsedCommand.args,
      cwd,
      outputPath: logPath,
      commandLogPath
    });

    steps[name] = {
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      exit_code: result.exitCode,
      log_path: logPath,
      timed_out: result.timedOut,
      stderr: result.stderr
    };
  }

  const validationResult: ValidationResult = {
    status: Object.values(steps).some((step) => step.status === "failed") ? "failed" : "passed",
    stop_on_validation_failure: config.limits.stop_on_validation_failure,
    steps
  };

  await writeFile(join(validationDir, "validation-result.json"), JSON.stringify(validationResult, null, 2), "utf8");
  return validationResult;
}

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

function validationCommandRejectionReason(
  rawCommand: string,
  packageManager: Config["project"]["package_manager"]
): string {
  const command = rawCommand.trim().split(/\s+/, 1)[0];
  if (command && PACKAGE_MANAGERS.includes(command as (typeof PACKAGE_MANAGERS)[number]) && command !== packageManager) {
    return `Refusing validation command because it uses package manager "${command}" while project.package_manager is "${packageManager}". Use "${packageManager} run <script>" or a bare package script name.`;
  }
  return `Refusing to run unsafe validation command. Use "${packageManager} run <script>" or a bare package script name.`;
}

export function parseValidationCommand(
  rawCommand: string,
  packageManager: Config["project"]["package_manager"]
): ParsedValidationCommand | null {
  const tokens = rawCommand.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !SAFE_TOKEN_PATTERN.test(token))) {
    return null;
  }

  if (tokens.length === 1) {
    return {
      command: packageManager,
      args: ["run", tokens[0]!]
    };
  }

  const [command, run, script, ...rest] = tokens;
  if (command !== packageManager || run !== "run" || !script) {
    return null;
  }

  return {
    command,
    args: ["run", script, ...rest]
  };
}
