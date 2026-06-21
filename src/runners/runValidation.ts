import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { execWithTimeout, type CommandExecutor } from "../utils/execWithTimeout.js";

export type ValidationStepName = "install" | "lint" | "typecheck" | "test" | "build";
export type ValidationStatus = "passed" | "failed" | "skipped";

export interface ValidationStepResult {
  status: ValidationStatus;
  exit_code: number | null;
  log_path?: string;
  timed_out?: boolean;
  signal?: string;
  is_canceled?: boolean;
  stderr?: string;
}

export interface ValidationResult {
  status: "passed" | "failed";
  allPassed: boolean;
  stop_on_validation_failure: boolean;
  all_steps_skipped: boolean;
  steps: Record<ValidationStepName, ValidationStepResult>;
}

export function allValidationStepsSkipped(steps: Record<ValidationStepName, ValidationStepResult>): boolean {
  return VALIDATION_ORDER.every((name) => steps[name].status === "skipped");
}

export function validationAllPassed(result: ValidationResult): boolean {
  return result.allPassed;
}

export function hasUnsetRequiredValidationSteps(
  steps: Record<ValidationStepName, ValidationStepResult>
): boolean {
  const required: ValidationStepName[] = ["lint", "typecheck", "test"];
  return required.some((name) => steps[name].status === "skipped");
}

const VALIDATION_ORDER: ValidationStepName[] = ["install", "lint", "typecheck", "test", "build"];
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
  executor: CommandExecutor = execWithTimeout,
  loopNumber = 1
): Promise<ValidationResult> {
  await mkdir(validationDir, { recursive: true });
  const steps = {} as Record<ValidationStepName, ValidationStepResult>;

  for (const name of VALIDATION_ORDER) {
    const command = config.commands[name].trim();
    const logPath = join(validationDir, `${name}.log`);

    if (name === "install" && loopNumber > 1) {
      steps[name] = { status: "skipped", exit_code: null, timed_out: false, stderr: "" };
      continue;
    }

    if (!command) {
      steps[name] = { status: "skipped", exit_code: null, timed_out: false, stderr: "" };
      continue;
    }

    const parsedCommand = parseValidationCommand(command, config.project.package_manager);
    if (!parsedCommand) {
      const rejectionReason = validationCommandRejectionReason(command, config.project.package_manager);
      await writeFile(logPath, `${rejectionReason}\n`, "utf8");
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
      commandLogPath,
      step: `validation_${name}`
    });

    steps[name] = {
      status:
        result.exitCode === 0 && !result.timedOut && !result.signal && !result.isCanceled ? "passed" : "failed",
      exit_code: result.exitCode,
      log_path: logPath,
      timed_out: result.timedOut,
      signal: result.signal,
      is_canceled: result.isCanceled,
      stderr: result.stderr
    };
  }

  const allStepsSkipped = allValidationStepsSkipped(steps);
  const allPassed = computeAllPassed(steps);
  const validationResult: ValidationResult = {
    status: Object.values(steps).some((step) => step.status === "failed") || allStepsSkipped ? "failed" : "passed",
    allPassed,
    stop_on_validation_failure: config.limits.stop_on_validation_failure,
    all_steps_skipped: allStepsSkipped,
    steps
  };

  await writeFile(join(validationDir, "validation-result.json"), JSON.stringify(validationResult, null, 2), "utf8");
  return validationResult;
}

function computeAllPassed(steps: Record<ValidationStepName, ValidationStepResult>): boolean {
  const required: ValidationStepName[] = ["lint", "typecheck", "test"];
  const requiredPassed = required.every((name) => steps[name].status === "passed");
  const buildOk = steps.build.status === "passed" || steps.build.status === "skipped";
  return requiredPassed && buildOk;
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

  const [command, second, third, ...rest] = tokens;
  if (!PACKAGE_MANAGERS.includes(command as (typeof PACKAGE_MANAGERS)[number])) {
    return null;
  }

  if (command !== packageManager) {
    return null;
  }

  if (second === "run") {
    if (!third) {
      return null;
    }
    return {
      command,
      args: ["run", third, ...rest]
    };
  }

  return {
    command,
    args: [second, third, ...rest].filter(Boolean) as string[]
  };
}
