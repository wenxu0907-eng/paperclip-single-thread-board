// Derives a single, human-readable "why is this ticket not moving right now?"
// status for the ticket detail header (COM-356, fast-follow of COM-355).
//
// A stationary ticket is ambiguous: it can be legitimately waiting for a board
// decision/review, or it can be genuinely stuck with nothing queued. This module
// collapses the existing signals the UI already loads — live runs, issue status,
// and pending thread interactions — into one of three states. It is a *read-only*
// derivation over the single source of truth; it introduces no new stored state.

export type IssueLiveStatusKind = "running" | "waiting" | "parked";

export type IssueLiveWaitingReason =
  | "pending_interaction"
  | "in_review"
  | "blocked";

export interface IssueLiveStatusRunInput {
  id: string;
  status: string;
  startedAt: string | null;
  createdAt: string;
}

export interface IssueLiveStatusInteractionInput {
  id: string;
  status: string;
  createdAt: string | Date;
}

export interface DeriveIssueLiveStatusInput {
  issueStatus: string;
  /** Fallback "since" for in_review when no pending interaction pins a time. */
  issueUpdatedAt?: string | Date | null;
  hasBlocker?: boolean;
  liveRuns: readonly IssueLiveStatusRunInput[];
  interactions: readonly IssueLiveStatusInteractionInput[];
}

export interface IssueLiveStatus {
  kind: IssueLiveStatusKind;
  /** ISO timestamp the current state began, when known. */
  since: string | null;
  /** Running run to link to run details, when kind === "running". */
  runId: string | null;
  /** Pending interaction to jump to, when reason === "pending_interaction". */
  interactionId: string | null;
  /** Only set when kind === "waiting". */
  waitingReason: IssueLiveWaitingReason | null;
}

// A run occupying the issue right now — actively executing or queued to execute.
const ACTIVE_RUN_STATUSES = new Set(["running", "queued"]);
// Statuses where the ticket is closed; no "stuck vs waiting" question applies.
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function pickActiveRun(
  liveRuns: readonly IssueLiveStatusRunInput[],
): IssueLiveStatusRunInput | null {
  // Prefer an actually-running run over a merely-queued one so "Running now"
  // reflects live execution.
  return (
    liveRuns.find((run) => run.status === "running") ??
    liveRuns.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ??
    null
  );
}

function earliestPendingInteraction(
  interactions: readonly IssueLiveStatusInteractionInput[],
): IssueLiveStatusInteractionInput | null {
  let earliest: IssueLiveStatusInteractionInput | null = null;
  let earliestTime = Number.POSITIVE_INFINITY;
  for (const interaction of interactions) {
    if (interaction.status !== "pending") continue;
    const t = new Date(toIso(interaction.createdAt) ?? 0).getTime();
    const time = Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    if (time < earliestTime) {
      earliest = interaction;
      earliestTime = time;
    }
  }
  return earliest;
}

/**
 * Collapse live runs + issue status + pending interactions into a single badge
 * state. Returns null when the badge should not render (terminal ticket with no
 * live run — nothing is "stuck").
 */
export function deriveIssueLiveStatus(
  input: DeriveIssueLiveStatusInput,
): IssueLiveStatus | null {
  const activeRun = pickActiveRun(input.liveRuns);

  // A live run always wins: the truthful answer to "why isn't it moving?" is
  // that it *is* moving — even on an otherwise-terminal ticket.
  if (activeRun) {
    return {
      kind: "running",
      since: toIso(activeRun.startedAt) ?? toIso(activeRun.createdAt),
      runId: activeRun.id,
      interactionId: null,
      waitingReason: null,
    };
  }

  if (TERMINAL_ISSUE_STATUSES.has(input.issueStatus)) return null;

  // Pending board interaction is the most specific "legitimately waiting"
  // signal — the board must act before work can continue.
  const pending = earliestPendingInteraction(input.interactions);
  if (pending) {
    return {
      kind: "waiting",
      since: toIso(pending.createdAt),
      runId: null,
      interactionId: pending.id,
      waitingReason: "pending_interaction",
    };
  }

  if (input.issueStatus === "in_review") {
    return {
      kind: "waiting",
      since: toIso(input.issueUpdatedAt ?? null),
      runId: null,
      interactionId: null,
      waitingReason: "in_review",
    };
  }

  if (input.issueStatus === "blocked" && input.hasBlocker) {
    return {
      kind: "waiting",
      since: toIso(input.issueUpdatedAt ?? null),
      runId: null,
      interactionId: null,
      waitingReason: "blocked",
    };
  }

  return {
    kind: "parked",
    since: null,
    runId: null,
    interactionId: null,
    waitingReason: null,
  };
}
