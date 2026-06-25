import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckResult } from "./index.js";

const execFileAsync = promisify(execFile);

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Checks that `qmd` (the semantic memory-recall tool the para-memory-files skill
 * uses) is installed and on PATH for agents. Optional: the skill falls back to
 * ripgrep when qmd is missing, so a missing binary is a warning, not a failure.
 */
export async function qmdCheck(): Promise<CheckResult> {
  const qmdPath = await which("qmd");
  if (qmdPath) {
    return {
      name: "Memory recall (qmd)",
      status: "pass",
      message: `qmd found at ${qmdPath}`,
    };
  }

  const installer = (await which("bun")) ? "bun" : (await which("npm")) ? "npm" : null;
  const installArgs = ["install", "-g", "@tobilu/qmd"];
  const hint = installer
    ? `Install with \`${installer} install -g @tobilu/qmd\` (needs Node >= 22; first run downloads ~2GB of models). Agents fall back to ripgrep until then.`
    : "Install Bun or Node >= 22, then `bun install -g @tobilu/qmd`. Agents fall back to ripgrep until then.";

  return {
    name: "Memory recall (qmd)",
    status: "warn",
    message: "qmd not found on PATH — agents will use the ripgrep recall fallback",
    canRepair: Boolean(installer),
    repairHint: hint,
    repair: installer
      ? async () => {
          await execFileAsync(installer, installArgs, { timeout: 600_000 });
        }
      : undefined,
  };
}
