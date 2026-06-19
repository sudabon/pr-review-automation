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
}

export interface ValidationResult {
  status: "passed" | "failed";
  stop_on_validation_failure: boolean;
  steps: Record<ValidationStepName, ValidationStepResult>;
}

const VALIDATION_ORDER: ValidationStepName[] = ["lint", "typecheck", "test", "build"];

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
      steps[name] = { status: "skipped", exit_code: null };
      continue;
    }

    const result = await executor({
      command,
      cwd,
      shell: true,
      outputPath: logPath,
      commandLogPath
    });

    steps[name] = {
      status: result.exitCode === 0 ? "passed" : "failed",
      exit_code: result.exitCode,
      log_path: logPath
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
