/**
 * Backfill the managed instruction files (AGENTS.md + HEARTBEAT.md) for existing
 * agents from the current default onboarding bundle. New agents already receive
 * these at hire time; this brings already-onboarded agents up to date.
 *
 * - Only touches AGENTS.md and HEARTBEAT.md (other bundle files like SOUL.md,
 *   TOOLS.md, and any knowledge/ files are left untouched).
 * - Skips agents on an external (non-managed) instructions bundle.
 * - Skips files that are already identical (idempotent).
 *
 * Usage (from repo root):
 *   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:54329/paperclip \
 *     pnpm agents:backfill-instructions [--apply]
 */
import { ne } from "drizzle-orm";
import { agents, createDb } from "@paperclipai/db";
import { agentInstructionsService } from "../src/services/agent-instructions.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../src/services/default-agent-instructions.js";

const FILES_TO_REFRESH = ["AGENTS.md", "HEARTBEAT.md"] as const;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);
  const instructions = agentInstructionsService();

  const bundleCache = new Map<string, Record<string, string>>();
  async function bundleFor(role: string): Promise<Record<string, string>> {
    const key = resolveDefaultAgentInstructionsBundleRole(role);
    let files = bundleCache.get(key);
    if (!files) {
      files = await loadDefaultAgentInstructionsBundle(key);
      bundleCache.set(key, files);
    }
    return files;
  }

  const allAgents = await db.select().from(agents).where(ne(agents.status, "terminated"));
  let updatedAgents = 0;
  let writtenFiles = 0;
  let skippedExternal = 0;
  let skippedUnconfigured = 0;
  let unchanged = 0;

  for (const agent of allAgents) {
    const bundleFiles = await bundleFor(agent.role);

    let bundle;
    try {
      bundle = await instructions.getBundle(agent);
    } catch (error) {
      console.warn(
        `! ${agent.name} (${agent.id}): could not read bundle — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (bundle.mode === "external") {
      skippedExternal += 1;
      continue;
    }
    if (bundle.mode !== "managed") {
      // No managed bundle configured; leave the agent's setup as-is.
      skippedUnconfigured += 1;
      continue;
    }

    const filesForAgent: string[] = [];
    for (const fileName of FILES_TO_REFRESH) {
      const desired = bundleFiles[fileName];
      if (desired == null) continue;

      // Skip if already identical.
      const current = await instructions
        .readFile(agent, fileName)
        .then((f) => f.content ?? "")
        .catch(() => null);
      if (current === desired) {
        unchanged += 1;
        continue;
      }

      if (apply) {
        await instructions.writeFile(agent, fileName, desired);
      }
      filesForAgent.push(fileName);
      writtenFiles += 1;
    }

    if (filesForAgent.length > 0) {
      updatedAgents += 1;
      console.log(
        `${apply ? "updated" : "would update"} ${agent.name} [${agent.role}] -> ${filesForAgent.join(", ")}`,
      );
    }
  }

  console.log(
    `\n${apply ? "Applied" : "Dry run"}: ${updatedAgents} agents, ${writtenFiles} files ` +
      `(${unchanged} already current, ${skippedExternal} external skipped, ${skippedUnconfigured} unconfigured skipped)`,
  );
  if (!apply) console.log("Re-run with --apply to persist changes.");
  process.exit(0);
}

void main();
