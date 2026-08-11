/**
 * Platform-managed "Current Goal & Decisions" block (COM-294 / CMP-260).
 *
 * Problem: almost every agent heartbeat starts a FRESH Claude session seeded with
 * only the newest ~8 comments, so goals/decisions hashed out earlier in a long
 * board <-> agent thread silently fall out of context and get re-litigated. The one
 * piece of state the platform reliably re-loads every session is the issue
 * description, but nothing keeps the evolving goal written there.
 *
 * Fix (board-chosen Option C, 2026-08-11): the platform owns a delimited block at
 * the TOP of the human-visible `issue.description`. It is regenerated at run-end
 * from the same distilled fields the continuation summary uses, and it is
 * clobber-protected at the description write path so an external edit that omits
 * the block does not wipe it. This makes the description a single source of truth
 * for "what are we actually trying to do right now" (Fleet Principle P14).
 *
 * This module is intentionally pure and dependency-free so it is trivially testable
 * and safe to call from both the run-end hook and the PATCH route.
 */

export const MANAGED_GOAL_BLOCK_START = "<!-- PAPERCLIP:GOAL:START -->";
export const MANAGED_GOAL_BLOCK_END = "<!-- PAPERCLIP:GOAL:END -->";
export const MANAGED_GOAL_BLOCK_HEADING =
  "## 🎯 Current Goal & Decisions · auto-maintained by Paperclip";

/** Upper bound so the block can never dominate a description. */
export const MANAGED_GOAL_BLOCK_MAX_CHARS = 2_400;

// Matches the whole managed block, including the markers and any trailing
// blank lines the platform inserted after it. Non-greedy body; multiline off
// because the markers are HTML comments on their own lines.
const MANAGED_GOAL_BLOCK_RE = new RegExp(
  `${escapeRegExp(MANAGED_GOAL_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_GOAL_BLOCK_END)}\\n*`,
);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string) {
  // Collapse Windows newlines and trim trailing whitespace on each line so the
  // block round-trips identically (idempotent regeneration).
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

export type ManagedGoalBlockFields = {
  /** One-line-ish current objective. Required for the block to render. */
  objective: string;
  /** Zero or more confirmed decisions / constraints, newest-relevant first. */
  decisions?: string[];
  /** Optional next action so a fresh session knows where to resume. */
  nextAction?: string | null;
};

/** True when the string contains a platform-managed goal block. */
export function hasManagedGoalBlock(description: string | null | undefined): boolean {
  if (!description) return false;
  return MANAGED_GOAL_BLOCK_RE.test(description);
}

/**
 * Returns the inner markdown of the managed block (between the markers, heading
 * included), or null if there is no block. Useful for change-detection.
 */
export function extractManagedGoalBlock(description: string | null | undefined): string | null {
  if (!description) return null;
  const start = description.indexOf(MANAGED_GOAL_BLOCK_START);
  if (start === -1) return null;
  const end = description.indexOf(MANAGED_GOAL_BLOCK_END, start);
  if (end === -1) return null;
  const inner = description.slice(start + MANAGED_GOAL_BLOCK_START.length, end);
  return inner.trim();
}

/**
 * Removes the managed block (and its trailing blank lines) from a description,
 * returning just the human-authored remainder. Idempotent; safe on input with no
 * block.
 */
export function stripManagedGoalBlock(description: string | null | undefined): string {
  if (!description) return "";
  return normalizeText(description).replace(MANAGED_GOAL_BLOCK_RE, "").replace(/^\n+/, "");
}

/**
 * Renders the managed block body (markers + heading + fields) from distilled
 * fields, or null when there is nothing meaningful to show (no objective).
 */
export function renderManagedGoalBlock(fields: ManagedGoalBlockFields): string | null {
  const objective = fields.objective?.trim();
  if (!objective) return null;

  const decisions = (fields.decisions ?? [])
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const nextAction = fields.nextAction?.trim();

  const lines: string[] = [
    MANAGED_GOAL_BLOCK_START,
    MANAGED_GOAL_BLOCK_HEADING,
    "",
    `**Goal:** ${objective}`,
  ];
  if (decisions.length > 0) {
    lines.push("", "**Confirmed decisions / constraints:**");
    for (const decision of decisions) lines.push(`- ${decision}`);
  }
  if (nextAction) {
    lines.push("", `**Next:** ${nextAction}`);
  }
  lines.push(
    "",
    "_Edit the goal above by commenting; Paperclip keeps this block in sync. Text below is human-authored._",
    MANAGED_GOAL_BLOCK_END,
  );

  let block = lines.join("\n");
  if (block.length > MANAGED_GOAL_BLOCK_MAX_CHARS) {
    // Hard cap: truncate the body but keep the closing marker intact so the block
    // remains parseable and strippable.
    const suffix = `\n[truncated]\n${MANAGED_GOAL_BLOCK_END}`;
    const room = MANAGED_GOAL_BLOCK_MAX_CHARS - suffix.length;
    block = `${block.slice(0, Math.max(0, room)).trimEnd()}${suffix}`;
  }
  return block;
}

/**
 * Places (or replaces) the managed block at the TOP of the description, preserving
 * the human-authored remainder untouched. Returns the description unchanged if
 * `fields` yields no block AND there was no existing block to remove.
 */
export function upsertManagedGoalBlock(
  description: string | null | undefined,
  fields: ManagedGoalBlockFields,
): string {
  const remainder = stripManagedGoalBlock(description);
  const block = renderManagedGoalBlock(fields);
  if (!block) return remainder;
  return remainder.length > 0 ? `${block}\n\n${remainder}` : block;
}

/** Reads a `## Heading` section from markdown; null if absent/empty. */
function readMarkdownSection(markdown: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const section = re.exec(markdown)?.[1]?.trim();
  return section && section.length > 0 ? section : null;
}

/** First non-empty, non-heading paragraph — the objective fallback. */
function firstParagraph(markdown: string): string | null {
  for (const chunk of markdown.split(/\n{2,}/)) {
    const line = chunk.trim();
    if (line.length > 0 && !line.startsWith("#") && !line.startsWith("<!--")) return line;
  }
  return null;
}

/**
 * Derives the goal objective the platform should surface for an issue, from the
 * human-authored part of its description (the managed block, if any, is ignored).
 * Prefers an explicit `## Objective` section, then the first paragraph. Returns
 * null when nothing usable is present (e.g. an empty description).
 */
export function deriveGoalObjectiveFromDescription(
  description: string | null | undefined,
): string | null {
  const human = stripManagedGoalBlock(description);
  if (!human) return null;
  const objective = readMarkdownSection(human, "Objective") ?? firstParagraph(human);
  if (!objective) return null;
  // Keep the surfaced goal to a single tidy line.
  return objective.replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * Run-end sync: returns the description with an up-to-date managed goal block, or
 * the description unchanged when nothing needs to change. Deterministic and
 * idempotent, so callers can compare against the current value and only write on a
 * real diff (avoids churn / notification noise).
 *
 * `extraDecisions` lets a caller fold in decisions distilled elsewhere; omit for
 * the objective-only baseline.
 */
export function syncManagedGoalBlockInDescription(
  description: string | null | undefined,
  extraDecisions?: string[],
): string {
  const current = description ? normalizeText(description) : "";
  const objective = deriveGoalObjectiveFromDescription(current);
  if (!objective) return current; // nothing to anchor a block on; leave as-is
  const next = upsertManagedGoalBlock(current, {
    objective,
    decisions: extraDecisions,
  });
  return next === current ? current : next;
}

/**
 * Clobber protection for the description write path.
 *
 * When something writes a new description (`incoming`) we must not lose the
 * platform-managed block that lived in the `existing` description. Rules:
 *  - If `incoming` already carries its own managed block, respect it (the writer
 *    is the platform regenerating the block) and return it unchanged.
 *  - Otherwise, if `existing` had a managed block, re-attach it to the top of the
 *    (block-stripped) incoming text so an external edit can't silently drop it.
 *  - If neither side has a block, return `incoming` unchanged.
 *
 * `incoming` of null/undefined means "not being changed" — returns it as-is so the
 * caller's `description === undefined` no-op semantics are preserved.
 */
export function preserveManagedGoalBlockOnWrite(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null | undefined {
  if (incoming === null || incoming === undefined) return incoming;
  if (hasManagedGoalBlock(incoming)) return incoming;

  const start = existing?.indexOf(MANAGED_GOAL_BLOCK_START) ?? -1;
  if (start === -1 || !existing) return incoming;
  const end = existing.indexOf(MANAGED_GOAL_BLOCK_END, start);
  if (end === -1) return incoming;

  const existingBlock = normalizeText(
    existing.slice(start, end + MANAGED_GOAL_BLOCK_END.length),
  );
  const incomingRemainder = stripManagedGoalBlock(incoming);
  return incomingRemainder.length > 0 ? `${existingBlock}\n\n${incomingRemainder}` : existingBlock;
}
