import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { resolveAgentMemoryMode } from "../default-agent-instructions.js";
import { agentMemoryFileService } from "../agent-memory-files.js";

/**
 * Adapter-agnostic memory bridge (COM-413 step 2).
 *
 * When the fallback-chain engine switches an agent from one adapter/credential
 * to another, the new leg needs continuity with what the agent has already
 * learned. `claude_local` (and other claude-family adapters) get this for free
 * — the Claude Code harness auto-memory is native and injected automatically,
 * so bridging into a claude-family target is a no-op. Every other adapter
 * family manages its own memory lifecycle (para-memory-files) and has no way
 * to see the harness's MEMORY.md, so this module renders that harness memory
 * into a markdown bundle and points the target adapter's `instructionsFilePath`
 * at it, reusing the `instructionsFilePath` context-injection mechanism every
 * non-claude adapter in this repo already reads at process startup (see
 * packages/adapters/*\/src/server/execute.ts).
 *
 * Extending this to a future adapter family only requires deciding whether it
 * belongs in `resolveAgentMemoryMode`'s "harness" bucket (native, no-op here)
 * or gets bridged via `instructionsFilePath` like the rest.
 */

type AgentLike = {
  id: string;
  companyId: string;
  adapterType?: string | null;
  adapterConfig?: unknown;
};

const MEMORY_BRIDGE_FILE_NAME = "MEMORY_BRIDGE.md";
/** Cap the rendered bridge to a sane size so a huge memory store can't blow up a run's context. */
const MAX_BRIDGE_CHARS = 60_000;
const MAX_FACT_FILES = 40;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Where the bridge file for this agent lives — stable per agent, overwritten on every bridge. */
export function resolveMemoryBridgeFilePath(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
    MEMORY_BRIDGE_FILE_NAME,
  );
}

/**
 * Render the agent's harness auto-memory (MEMORY.md index + linked per-fact
 * files) into a single markdown document. Returns null when the agent has no
 * harness memory to bridge (fresh agent, or memory-mode isn't harness).
 */
export async function renderHarnessMemoryBridgeMarkdown(agent: AgentLike): Promise<string | null> {
  const memorySvc = agentMemoryFileService();
  const overview = await memorySvc.getOverview(agent as { id: string; companyId: string; adapterType?: string | null; adapterConfig?: unknown });
  if (!overview.hasMemories) return null;

  const sections: string[] = [
    "# Continuity memory (fallback-chain bridge)",
    "",
    "The previous adapter/credential for this agent hit a quota/billing failure and Paperclip " +
      "switched this task to a different adapter or credential. The section below is a read-only " +
      "snapshot of that agent's durable auto-memory (harness MEMORY.md + linked facts), rendered so " +
      "this adapter has the same continuity even though it doesn't natively share that memory store.",
  ];

  if (overview.tacit) {
    try {
      const tacit = await memorySvc.readMemoryFile(agent as never, overview.tacit.relativePath);
      sections.push("", "## MEMORY.md (index)", "", tacit.content.data);
    } catch {
      // Best-effort: skip an unreadable index rather than failing the bridge.
    }
  }

  const factFiles = overview.harnessFacts.slice(0, MAX_FACT_FILES);
  for (const fact of factFiles) {
    try {
      const file = await memorySvc.readMemoryFile(agent as never, fact.relativePath);
      sections.push("", `## ${fact.title}`, "", file.content.data);
    } catch {
      // Best-effort: skip an unreadable fact file rather than failing the bridge.
    }
  }

  let rendered = sections.join("\n");
  if (rendered.length > MAX_BRIDGE_CHARS) {
    rendered = `${rendered.slice(0, MAX_BRIDGE_CHARS)}\n\n_[truncated — memory bridge exceeded ${MAX_BRIDGE_CHARS} chars]_`;
  }
  return rendered;
}

/**
 * Given the adapterConfig for a fallback-chain step, apply the memory bridge
 * if the step's adapter type needs one. For claude-family targets this is a
 * no-op (native harness auto-memory). For everything else, renders the
 * source agent's harness memory, merges it with whatever instructions file
 * the step already configures (if any), writes the combined result to a
 * per-agent bridge file, and points the returned config's
 * `instructionsFilePath` at it.
 *
 * `sourceAgent` is the agent as it's configured *before* the switch (its
 * harness memory is what we're bridging from); `targetAdapterType` /
 * `targetAdapterConfig` describe the chain step being switched to.
 */
export async function applyMemoryBridgeForFallbackStep(input: {
  sourceAgent: AgentLike;
  targetAdapterType: string;
  targetAdapterConfig: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { sourceAgent, targetAdapterType, targetAdapterConfig } = input;

  if (resolveAgentMemoryMode(targetAdapterType) === "harness") {
    // Native: the harness on the target adapter will pick up its own
    // auto-memory (or start fresh if this is a brand-new credential/account).
    return targetAdapterConfig;
  }

  const memoryMarkdown = await renderHarnessMemoryBridgeMarkdown(sourceAgent);
  if (!memoryMarkdown) return targetAdapterConfig;

  const existingInstructionsPath = asNonEmptyString(targetAdapterConfig.instructionsFilePath);
  let existingInstructionsContent = "";
  if (existingInstructionsPath) {
    try {
      existingInstructionsContent = await fs.readFile(existingInstructionsPath, "utf8");
    } catch {
      // No existing instructions file (or unreadable) — bridge content stands alone.
    }
  }

  const combined = [existingInstructionsContent.trim(), memoryMarkdown].filter(Boolean).join("\n\n");
  const bridgePath = resolveMemoryBridgeFilePath(sourceAgent);
  await fs.mkdir(path.dirname(bridgePath), { recursive: true });
  await fs.writeFile(bridgePath, combined, "utf8");

  return { ...targetAdapterConfig, instructionsFilePath: bridgePath };
}

export function memoryBridgeAdapterConfig(adapterConfig: unknown): Record<string, unknown> {
  return asRecord(adapterConfig);
}
