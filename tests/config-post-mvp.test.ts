import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";
import { createDefaultConfig } from "../src/config/schema.js";
import { withTempDir } from "./helpers.js";

describe("post-mvp configuration", () => {
  it("applies new default values", () => {
    const config = createDefaultConfig("demo");
    expect(config.agents.fixer_mode).toBe("sequential");
    expect(config.limits.stop_on_validation_failure).toBe(false);
    expect(config.limits.max_changed_files).toBe(50);
    expect(config.limits.max_diff_lines).toBe(5000);
    expect(config.limits.lockfile_change_warn_lines).toBe(200);
    expect(config.git.pr_command).toBe("gh pr create --fill");
    expect(config.safety.important_file_patterns.length).toBeGreaterThan(0);
  });

  it("loads custom post-mvp keys", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, ".ai-dev-loop", "config.yml");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        [
          "agents:",
          "  fixer_mode: failover",
          "limits:",
          "  max_changed_files: 10",
          "  max_diff_lines: 1000",
          "  lockfile_change_warn_lines: 50",
          "claude:",
          "  review_timeout_sec: 600",
          "  final_review_timeout_sec: 900",
          "safety:",
          "  important_file_patterns:",
          "    - secrets/**"
        ].join("\n"),
        "utf8"
      );

      const config = await loadConfig(dir);
      expect(config.agents.fixer_mode).toBe("failover");
      expect(config.limits.max_changed_files).toBe(10);
      expect(config.claude.review_timeout_sec).toBe(600);
      expect(config.safety.important_file_patterns).toEqual(["secrets/**"]);
    });
  });

  it("rejects invalid fixer_mode values", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, ".ai-dev-loop", "config.yml");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, "agents:\n  fixer_mode: parallel\n", "utf8");
      await expect(loadConfig(dir)).rejects.toThrow("agents.fixer_mode");
    });
  });
});
