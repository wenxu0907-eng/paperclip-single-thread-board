import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md", "HEARTBEAT.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

/**
 * How an agent's memory is managed, derived from its adapter type.
 * - `harness`: the Claude Code harness manages memory as auto-memory (push/auto-injected).
 *   No para-memory-files skill and no manual HEARTBEAT memory lifecycle.
 * - `para`: the agent runs the file-based para-memory-files lifecycle itself.
 */
type AgentMemoryMode = "harness" | "para";

/**
 * Claude-family adapters (`claude_local`, etc.) get harness auto-memory; every other
 * adapter (Codex, Gemini, Cursor, ...) keeps the para-memory-files lifecycle. Matches the
 * board-approved per-adapter memory strategy. Defaults to `para` when adapterType is unknown.
 */
export function resolveAgentMemoryMode(adapterType?: string | null): AgentMemoryMode {
  return typeof adapterType === "string" && adapterType.startsWith("claude") ? "harness" : "para";
}

/**
 * Harness-mode replacement text, keyed by the `id` of the `<!-- MEMORY:BEGIN id=... -->`
 * block in the onboarding-asset markdown. In `para` mode the block body is kept verbatim
 * (only the marker comments are stripped); in `harness` mode the whole block is swapped for
 * the text below. Every marker id present in the assets MUST have an entry here.
 */
const HARNESS_MEMORY_BLOCKS: Record<string, string> = {
  "default-memory": `## Memory

Your memory is managed by the Claude Code harness as **auto-memory**: durable facts are
written to a per-agent memory store and the relevant ones are injected into your context
automatically each session (push, not pull). You do NOT run a manual memory lifecycle and you
do NOT use the \`para-memory-files\` skill.

To remember something durable, write a one-fact file under your harness memory directory using
the documented frontmatter, then add a one-line pointer in \`MEMORY.md\` (the index loaded into
context each session). Before saving, check for an existing file that already covers the fact and
update it instead of duplicating; delete memories that turn out to be wrong. Save only what is
non-obvious and not already recorded in the repo or task threads.`,
  "ceo-memory": `## Memory and Planning

Your memory is managed by the Claude Code harness as **auto-memory**: durable facts are
written to a per-agent memory store and the relevant ones are injected into your context
automatically each session (push, not pull). You do NOT run a manual memory lifecycle and you
do NOT use the \`para-memory-files\` skill.

To remember something durable, write a one-fact file under your harness memory directory using
the documented frontmatter, then add a one-line pointer in \`MEMORY.md\` (the index loaded into
context each session). Update an existing file rather than duplicating, and delete memories that
turn out to be wrong. For planning, keep work-in-progress in your \`plan\` documents and task
threads rather than a separate para plan layer.`,
  "ceo-hb-planning": `## 2. Local Planning Check

Review your active plan and assignments before acting.

1. Re-read the relevant \`plan\` document and the issue thread for what's done, blocked, and next.
2. Review each planned item: what's completed, what's blocked, and what is up next.
3. For any blockers, resolve them yourself or escalate to the board.
4. If you're ahead, start on the next highest priority.
5. Rely on harness auto-memory for recall -- relevant past context is injected automatically;
   you do not run a manual recall step.`,
  "ceo-hb-extraction": `## 7. Memory (harness-managed)

Your durable memory is managed by the Claude Code harness as auto-memory -- there is no manual
fact-extraction lifecycle to run before exit. When you learn a durable, non-obvious fact, write a
one-fact file under your harness memory directory and add a one-line pointer in \`MEMORY.md\`.
Do not maintain para \`items.yaml\`/\`summary.md\` files or run weekly synthesis.`,
};

const MEMORY_BLOCK_RE = /[ \t]*<!-- MEMORY:BEGIN id=([\w-]+) -->\n([\s\S]*?)\n[ \t]*<!-- MEMORY:END id=\1 -->/g;

/**
 * Apply the agent's memory mode to a single bundle file's content by resolving every
 * `<!-- MEMORY:BEGIN id=... -->` block: keep the body in `para` mode, swap it for the
 * harness variant in `harness` mode. Throws if a harness variant is missing so a renamed
 * marker can never silently ship a literal placeholder.
 */
function applyMemoryMode(content: string, mode: AgentMemoryMode): string {
  const result = content.replace(MEMORY_BLOCK_RE, (_match, id: string, body: string) => {
    if (mode === "para") return body;
    const replacement = HARNESS_MEMORY_BLOCKS[id];
    if (replacement === undefined) {
      throw new Error(`Missing harness memory block for marker id "${id}"`);
    }
    return replacement;
  });
  return result;
}

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(
  role: DefaultAgentBundleRole,
  opts: { adapterType?: string | null } = {},
): Promise<Record<string, string>> {
  const mode = resolveAgentMemoryMode(opts.adapterType);
  // The default-role HEARTBEAT.md is purely the para memory lifecycle, so harness agents omit it.
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role].filter(
    (fileName) => !(mode === "harness" && role === "default" && fileName === "HEARTBEAT.md"),
  );
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const raw = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, applyMemoryMode(raw, mode)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}
