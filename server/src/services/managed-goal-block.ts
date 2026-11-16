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
  // Render invariant (COM-361 recurrence): no matter how the decisions list was
  // assembled — a board fold, an agent's run-end re-distillation, or a mix — at most
  // the newest accepted board approval may carry the active "execute now" imperative.
  // This is the single write funnel both the fold and the run-end sync paths pass
  // through, so enforcing here makes supersession durable (P14 single source of truth).
  const block = renderManagedGoalBlock(
    fields.decisions
      ? { ...fields, decisions: enforceSingleActiveBoardApproval(fields.decisions) }
      : fields,
  );
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

/** Upper bounds so an agent-distilled update can never bloat the block. */
export const MANAGED_GOAL_MAX_DECISIONS = 8;
export const MANAGED_GOAL_DECISION_MAX_CHARS = 240;
export const MANAGED_GOAL_OBJECTIVE_MAX_CHARS = 400;

export type SyncManagedGoalBlockOptions = {
  /**
   * Objective distilled by the agent for this run. Wins over the static
   * first-paragraph derivation so evolving goals actually reach the block. Null /
   * empty falls back to the description-derived objective.
   */
  objectiveOverride?: string | null;
  /**
   * Confirmed decisions / constraints to render. This is the authoritative set for
   * the block (the caller preserves prior decisions when the agent emits none), so
   * it replaces — never appends to — whatever the block currently shows.
   */
  extraDecisions?: string[];
};

/**
 * Run-end sync: returns the description with an up-to-date managed goal block, or
 * the description unchanged when nothing needs to change. Deterministic and
 * idempotent, so callers can compare against the current value and only write on a
 * real diff (avoids churn / notification noise).
 *
 * `objectiveOverride` / `extraDecisions` let the caller fold in fields distilled
 * elsewhere (COM-294 Option B: the agent distills them from the comment thread);
 * omit both for the objective-only baseline.
 */
export function syncManagedGoalBlockInDescription(
  description: string | null | undefined,
  opts?: SyncManagedGoalBlockOptions,
): string {
  const current = description ? normalizeText(description) : "";
  const override = opts?.objectiveOverride?.trim();
  const objective =
    (override ? override.replace(/\s+/g, " ").slice(0, MANAGED_GOAL_OBJECTIVE_MAX_CHARS) : null) ??
    deriveGoalObjectiveFromDescription(current);
  if (!objective) return current; // nothing to anchor a block on; leave as-is
  const decisions = sanitizeDecisions(opts?.extraDecisions);
  const next = upsertManagedGoalBlock(current, {
    objective,
    decisions,
  });
  return next === current ? current : next;
}

/** Normalize / de-dupe / bound a decisions list for rendering into the block. */
function sanitizeDecisions(decisions: string[] | null | undefined): string[] {
  if (!decisions || decisions.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of decisions) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, MANAGED_GOAL_DECISION_MAX_CHARS);
    if (!cleaned) continue;
    const dedupeKey = cleaned.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(cleaned);
    if (out.length >= MANAGED_GOAL_MAX_DECISIONS) break;
  }
  return out;
}

/**
 * Board-authored decision folding (COM-294 recurrence, 2026-08-12).
 *
 * The Option B mechanism only carries *agent-distilled* decisions into the block.
 * A decision the board makes by accepting/declining a confirmation card was never
 * folded in, so on the next fresh session the agent read a stale standing
 * preference from the block and overrode the just-approved action (observed on
 * TRA-6). The more authoritative direction — board → block — was left open.
 *
 * Fix: when a confirmation is accepted/declined, the platform folds the outcome
 * into the block as the newest, most-authoritative decision, phrased as an
 * imperative must-execute item. These lines carry a stable prefix so the run-end
 * agent-distillation sync PRESERVES them (they are not wiped by an agent that
 * forgot to re-emit them). Single source of truth (P14): the block already rides
 * in the description that every fresh session reloads, so folding here also
 * satisfies "restate the accepted proposal in the resume context".
 */
export const BOARD_DECISION_ACCEPTED_PREFIX = "✅ Board approved";
export const BOARD_DECISION_DECLINED_PREFIX = "⛔ Board declined";

/** True when a decision line was folded in from a board confirmation outcome. */
export function isBoardAuthoredDecision(line: string | null | undefined): boolean {
  if (!line) return false;
  const t = line.trim();
  return (
    t.startsWith(BOARD_DECISION_ACCEPTED_PREFIX) || t.startsWith(BOARD_DECISION_DECLINED_PREFIX)
  );
}

/** Reads the objective (`**Goal:** …`) currently rendered in a description's block. */
export function readManagedGoalBlockObjective(
  description: string | null | undefined,
): string | null {
  const inner = extractManagedGoalBlock(description);
  if (!inner) return null;
  for (const line of inner.split("\n")) {
    const m = /^\*\*Goal:\*\*\s*(.+)$/.exec(line.trim());
    if (m) {
      const objective = m[1].replace(/\s+/g, " ").trim();
      return objective.length > 0 ? objective : null;
    }
  }
  return null;
}

/** Max chars of the underlying confirmation prompt to echo into the block line. */
const BOARD_DECISION_SUMMARY_MAX_CHARS = 150;

/** Formats a `YYYY-MM-DD` stamp from a Date without pulling in a date library. */
function formatBoardDecisionDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The top-authority imperative appended to an accepted board decision. Only the
 * NEWEST accepted decision is allowed to carry it (see COM-361 supersession below).
 */
export const BOARD_DECISION_ACCEPTED_IMPERATIVE =
  " — execute this now; overrides any standing preference to the contrary.";

/**
 * A stable, un-truncatable head of the accepted imperative. `sanitizeDecisions`'
 * 240-char cap can clip the tail of a long (e.g. CJK) summary line mid-imperative
 * ("…overrides any standing preference to t"), so supersession detection keys off
 * this prefix rather than the full suffix — it survives truncation.
 */
const BOARD_DECISION_IMPERATIVE_MARKER = " — execute this now";

/**
 * Replacement suffix for a superseded (demoted) accepted decision: it records the
 * approval as history but strips the "overrides everything" imperative so a fresh
 * session no longer treats a stale approval as still-binding.
 */
export const BOARD_DECISION_SUPERSEDED_SUFFIX =
  " — superseded by a newer board decision; kept for history, no longer overriding.";

/**
 * Renders a single board-decision line for the managed block. `summary` is the
 * confirmation's prompt; `reason` is an optional decline reason. The line is
 * imperative so a fresh session treats it as a must-execute item, and self-bounded
 * so `sanitizeDecisions`' 240-char cap never truncates the trailing directive.
 */
export function renderBoardDecisionLine(input: {
  outcome: "accepted" | "declined";
  summary: string;
  reason?: string | null;
  date: Date;
}): string | null {
  const summary = input.summary.replace(/\s+/g, " ").trim().slice(0, BOARD_DECISION_SUMMARY_MAX_CHARS);
  if (!summary) return null;
  const stamp = formatBoardDecisionDate(input.date);
  if (input.outcome === "accepted") {
    return `${BOARD_DECISION_ACCEPTED_PREFIX} (${stamp}): ${summary}${BOARD_DECISION_ACCEPTED_IMPERATIVE}`;
  }
  const reason = input.reason?.replace(/\s+/g, " ").trim();
  const reasonSuffix = reason ? ` — reason: ${reason.slice(0, 80)}` : "";
  return `${BOARD_DECISION_DECLINED_PREFIX} (${stamp}): ${summary}${reasonSuffix}; do not pursue this.`;
}

/**
 * Recency-precedence supersession (COM-361, 2026-08-12).
 *
 * Root cause of the "agent forgot what we discussed" recurrence: every accepted
 * confirmation was permanently stamped "execute this now; overrides any standing
 * preference to the contrary", and the fold logic only case-deduped — it never
 * retired an older approval when a newer direction arrived. So a fresh session read
 * a weeks-old approval as still top-authority and re-did / undid the board's latest
 * direction (observed on TRA-6: a superseded 720p/5s试镜 approval kept shouting
 * "already done" over a just-agreed 1080p/8s rework).
 *
 * Fix: when a NEW accepted board direction is folded in, demote every PRIOR accepted
 * line — rewrite its imperative tail into a past-tense "superseded … no longer
 * overriding" note. Only the newest accepted decision keeps top authority. Declined
 * lines ("do not pursue this") are prohibitions, not preferences, so they are left
 * intact. Pure + idempotent (a line already demoted has no marker and is untouched).
 */
/** True when a line is an accepted board approval still carrying the active imperative. */
function isActiveBoardApproval(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith(BOARD_DECISION_ACCEPTED_PREFIX) &&
    t.lastIndexOf(BOARD_DECISION_IMPERATIVE_MARKER) !== -1
  );
}

/** Rewrites one accepted-approval line's imperative tail into a demoted history note. */
function demoteBoardApprovalLine(line: string): string {
  const t = line.trim();
  if (!t.startsWith(BOARD_DECISION_ACCEPTED_PREFIX)) return line;
  const marker = t.lastIndexOf(BOARD_DECISION_IMPERATIVE_MARKER);
  if (marker === -1) return line; // already demoted, or no imperative to strip
  return `${t.slice(0, marker).trimEnd()}${BOARD_DECISION_SUPERSEDED_SUFFIX}`;
}

function demoteSupersededBoardApprovals(decisions: string[]): string[] {
  return decisions.map(demoteBoardApprovalLine);
}

/**
 * Render invariant (COM-361 recurrence, 2026-08-13).
 *
 * `foldBoardDecisionIntoDescription` demotes older approvals only at fold time. But
 * the run-end agent-distillation path (`syncManagedGoalBlockInDescription`) rebuilds
 * the decisions list from what the agent re-emits, and an agent commonly copies a
 * PRIOR board-approved line back verbatim WITH its active imperative. That re-inflates
 * a second "execute now; overrides everything" line, so a stale approval regains top
 * authority — the exact drift observed live on CMP-517 (two active imperatives in one
 * block after a post-deploy run).
 *
 * Fix: enforce the invariant at render time regardless of how the list was assembled —
 * keep only the FIRST (top-most = newest) active approval, demote every later one.
 * Pure + idempotent: a list already satisfying the invariant is returned unchanged.
 */
export function enforceSingleActiveBoardApproval(decisions: string[]): string[] {
  let seenActive = false;
  return decisions.map((line) => {
    if (!isActiveBoardApproval(line)) return line;
    if (!seenActive) {
      seenActive = true;
      return line;
    }
    return demoteBoardApprovalLine(line);
  });
}

/**
 * Folds a board-decision line into the managed block as the newest (top-most)
 * decision, preserving the existing objective and remaining decisions. Returns the
 * description unchanged when there is no objective to anchor a block on or the line
 * is already present. Deterministic + idempotent so callers can change-gate.
 *
 * When the incoming line is an ACCEPTED direction, prior accepted approvals are
 * demoted (COM-361 recency-precedence) so only the newest one overrides everything.
 */
export function foldBoardDecisionIntoDescription(
  description: string | null | undefined,
  line: string,
): string {
  const current = description ? normalizeText(description) : "";
  const decisionLine = line.replace(/\s+/g, " ").trim();
  if (!decisionLine) return current;

  const objective =
    readManagedGoalBlockObjective(current) ?? deriveGoalObjectiveFromDescription(current);
  if (!objective) return current; // nothing to anchor a block on; leave as-is

  const existing = readManagedGoalBlockDecisions(current);
  // Idempotency: a repeat of the exact same decision is a no-op. Checked explicitly
  // (not via sanitizeDecisions' dedup) because demotion below rewrites prior lines,
  // which would otherwise let a fresh imperative copy coexist with its demoted twin.
  if (existing.some((d) => d.trim().toLowerCase() === decisionLine.toLowerCase())) {
    return current;
  }

  // A new ACCEPTED direction retires older approvals; a decline of some proposal
  // must NOT strip authority from an unrelated standing approval, so only demote
  // when the incoming line is itself an approval.
  const incomingIsAccepted = decisionLine.startsWith(BOARD_DECISION_ACCEPTED_PREFIX);
  const prior = incomingIsAccepted ? demoteSupersededBoardApprovals(existing) : existing;

  // Newest board decision first, then whatever the block already carried.
  const decisions = sanitizeDecisions([decisionLine, ...prior]);
  const next = upsertManagedGoalBlock(current, { objective, decisions });
  return next === current ? current : next;
}

/**
 * Detects an agent-distilled objective that merely CLAIMS the work is finished
 * ("already done", "nothing pending", "已完成 / 已经做过 / 无待办").
 *
 * COM-361 secondary guard: on the incident run the agent's run-end distillation
 * overwrote the block objective with "Reference-mode paid试镜 already executed …
 * Nothing pending", collapsing a live board rework into "done". When the block
 * still carries board-authored decisions, we refuse to let such a completion claim
 * replace the objective (the caller preserves the prior objective instead) — a
 * completion claim is never more authoritative than a standing board direction.
 *
 * Intentionally conservative: it only PRESERVES an existing objective, never
 * fabricates one, and only fires alongside board decisions — so a genuinely
 * finished issue with no board decisions still distills normally.
 */
export function isCompletionClaimObjective(objective: string | null | undefined): boolean {
  if (!objective) return false;
  const t = objective.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return false;
  const patterns: RegExp[] = [
    /\balready (?:done|executed|complete|completed|shipped|delivered|built|made)\b/,
    /\bnothing (?:is )?(?:left |further |else )?(?:pending|to do|remaining|outstanding)\b/,
    /\bno (?:further |remaining |additional |more )?(?:action|work|steps?)\b/,
    /\b(?:task|issue|work|goal)\s+(?:is\s+)?(?:already\s+)?(?:done|complete|completed|finished)\b/,
    /已(?:经)?(?:完成|做过|做完|搞定|执行完|交付)/,
    /无(?:待办|需(?:要)?(?:处理|行动|做))/,
    /没(?:有)?(?:待办|需要处理|要做)/,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * Reads the confirmed decisions currently rendered in a description's managed
 * block, so a heartbeat that emits no fresh distillation preserves the existing set
 * instead of wiping it. Returns [] when there is no block or no decisions.
 */
export function readManagedGoalBlockDecisions(
  description: string | null | undefined,
): string[] {
  const inner = extractManagedGoalBlock(description);
  if (!inner) return [];
  // Decisions render as `- ` bullets under the "Confirmed decisions" sub-heading,
  // before the "**Next:**" / trailing italic note. Collect the bullet lines in the
  // decisions section only.
  const lines = inner.split("\n");
  const out: string[] = [];
  let inDecisions = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*Confirmed decisions/i.test(trimmed)) {
      inDecisions = true;
      continue;
    }
    if (inDecisions) {
      if (trimmed.startsWith("- ")) {
        out.push(trimmed.slice(2).trim());
        continue;
      }
      // Any non-bullet, non-empty line ends the decisions section.
      if (trimmed.length > 0) break;
    }
  }
  return sanitizeDecisions(out);
}

/**
 * COM-294 Option B — extract an agent-distilled goal update from a finished run's
 * `resultJson`. The agent emits its current objective + confirmed decisions either
 * as a structured `resultJson.goalUpdate` object, or as a fenced
 * ```paperclip:goal { ... }``` JSON block in its final message (which the adapter
 * surfaces via `resultJson.result` / `summary` / `message`). Returns null when no
 * well-formed update is present, so callers fall back to preserving prior state.
 */
export function extractGoalUpdateFromRunResult(
  resultJson: Record<string, unknown> | null | undefined,
): { objective: string | null; decisions: string[] } | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;

  // 1) Structured channel: resultJson.goalUpdate = { objective?, decisions?[] }
  const structured = coerceGoalUpdate((resultJson as Record<string, unknown>).goalUpdate);
  if (structured) return structured;

  // 2) Fenced channel: a ```paperclip:goal { ... }``` block in the final message.
  const texts = [
    (resultJson as Record<string, unknown>).result,
    (resultJson as Record<string, unknown>).summary,
    (resultJson as Record<string, unknown>).message,
  ];
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) continue;
    const fenced = parseFencedGoalBlock(text);
    if (fenced) return fenced;
  }
  return null;
}

const FENCED_GOAL_RE = /```paperclip:goal\s*\n([\s\S]*?)```/i;

function parseFencedGoalBlock(text: string): { objective: string | null; decisions: string[] } | null {
  const match = FENCED_GOAL_RE.exec(text);
  if (!match) return null;
  try {
    return coerceGoalUpdate(JSON.parse(match[1].trim()));
  } catch {
    return null;
  }
}

function coerceGoalUpdate(value: unknown): { objective: string | null; decisions: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const objective =
    typeof obj.objective === "string" && obj.objective.trim().length > 0
      ? obj.objective.replace(/\s+/g, " ").trim().slice(0, MANAGED_GOAL_OBJECTIVE_MAX_CHARS)
      : null;
  const rawDecisions = Array.isArray(obj.decisions) ? (obj.decisions as unknown[]) : [];
  const decisions = sanitizeDecisions(rawDecisions.filter((d): d is string => typeof d === "string"));
  // A goalUpdate with neither an objective nor any decision carries no signal.
  if (!objective && decisions.length === 0) return null;
  return { objective, decisions };
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
