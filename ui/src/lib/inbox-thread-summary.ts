import type {
  ActivityEvent,
  Agent,
  IssueComment,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueStatus,
  IssueThreadInteraction,
} from "@paperclipai/shared";

import type { CompanyUserProfile } from "./company-members";

/**
 * Glanceable, synthesized orientation header for an inbox/issue thread.
 *
 * Computed entirely client-side from data already in scope on the chat tab.
 * `null` means "nothing meaningful changed since the user's last visit" — the
 * caller should render nothing in that case.
 */
export interface InboxThreadSummary {
  /** One short clause: who acted + what's new. e.g. "CTO replied (3 new messages)". */
  whatChanged: string;
  /** Single highest-priority suggested next action, or null. */
  nextAction: string | null;
  /** Count of new, non-self, non-deleted items since last visit. */
  newCount: number;
}

type PendingInteractionKind = IssueThreadInteraction["kind"];

interface BuildInboxThreadSummaryArgs {
  comments: readonly IssueComment[];
  activity: readonly ActivityEvent[];
  interactions: readonly IssueThreadInteraction[];
  myLastTouchAt: Date | null | undefined;
  currentUserId: string | null;
  agentMap: ReadonlyMap<string, Agent>;
  userProfileMap: ReadonlyMap<string, CompanyUserProfile> | null;
  issueStatus: IssueStatus;
  blockedBy?: readonly IssueRelationIssueSummary[] | null;
  recoveryAction?: IssueRecoveryAction | null;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function actorLabel(args: {
  authorType: IssueComment["authorType"];
  authorAgentId: string | null;
  authorUserId: string | null;
  agentMap: ReadonlyMap<string, Agent>;
  userProfileMap: ReadonlyMap<string, CompanyUserProfile> | null;
}): string {
  const { authorType, authorAgentId, authorUserId, agentMap, userProfileMap } = args;
  if (authorType === "agent" && authorAgentId) {
    return agentMap.get(authorAgentId)?.name ?? "Agent";
  }
  if (authorType === "user" && authorUserId) {
    return userProfileMap?.get(authorUserId)?.label ?? "Someone";
  }
  return "System";
}

/** Join a small set of distinct actor names into natural language. */
function joinActors(names: string[]): string {
  if (names.length === 0) return "Someone";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const PENDING_INTERACTION_ACTION: Record<PendingInteractionKind, string> = {
  request_confirmation: "waiting on your confirmation",
  request_checkbox_confirmation: "waiting on your confirmation",
  ask_user_questions: "waiting on your answers",
  suggest_tasks: "waiting on your review of suggested tasks",
};

// Priority order for picking the single pending interaction action.
const PENDING_INTERACTION_PRIORITY: PendingInteractionKind[] = [
  "request_confirmation",
  "request_checkbox_confirmation",
  "ask_user_questions",
  "suggest_tasks",
];

export function buildInboxThreadSummary(
  args: BuildInboxThreadSummaryArgs,
): InboxThreadSummary | null {
  const {
    comments,
    activity,
    interactions,
    myLastTouchAt,
    currentUserId,
    agentMap,
    userProfileMap,
    issueStatus,
    blockedBy,
    recoveryAction,
  } = args;

  const lastTouch = toTime(myLastTouchAt);
  // Null marker => first-time / never-touched: treat everything as already seen.
  if (lastTouch === null) return null;

  // --- "Who acted + what's new" from new comments. ---
  const actorOrder: string[] = [];
  const actorSeen = new Set<string>();
  let newCommentCount = 0;
  let sawStatusChange = false;
  let newStatusLabel: string | null = null;

  for (const comment of comments) {
    if (comment.deletedAt) continue;
    const created = toTime(comment.createdAt);
    if (created === null || created <= lastTouch) continue;
    // Exclude the current user's own actions.
    if (
      comment.authorType === "user"
      && currentUserId
      && comment.authorUserId === currentUserId
    ) {
      continue;
    }
    newCommentCount += 1;
    const label = actorLabel({
      authorType: comment.authorType,
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
      agentMap,
      userProfileMap,
    });
    if (!actorSeen.has(label)) {
      actorSeen.add(label);
      actorOrder.push(label);
    }
  }

  // --- Detect a status change from activity since last visit. ---
  for (const evt of activity) {
    const created = toTime(evt.createdAt);
    if (created === null || created <= lastTouch) continue;
    if (evt.actorType === "user" && currentUserId && evt.actorId === currentUserId) continue;
    if (evt.action === "issue.status_changed" || evt.action === "issue.status_updated") {
      sawStatusChange = true;
      const details = evt.details ?? {};
      const to = details["to"] ?? details["status"] ?? details["newStatus"];
      if (typeof to === "string") newStatusLabel = humanizeStatus(to);
    }
  }

  let whatChanged: string | null = null;
  if (newCommentCount > 0) {
    const actors = joinActors(actorOrder);
    if (newCommentCount === 1) {
      whatChanged = `${actors} replied`;
    } else {
      whatChanged = `${actors} replied (${newCommentCount} new messages)`;
    }
  } else if (sawStatusChange) {
    whatChanged = newStatusLabel
      ? `Status changed to ${newStatusLabel}`
      : "Status changed";
  }

  // Nothing meaningful to say.
  if (!whatChanged) return null;

  // --- Suggested next action (single, highest priority). ---
  const nextAction = pickNextAction({
    interactions,
    currentUserId,
    issueStatus,
    blockedBy,
    recoveryAction,
    hasNewReply: newCommentCount > 0,
  });

  return { whatChanged, nextAction, newCount: newCommentCount };
}

function pickNextAction(args: {
  interactions: readonly IssueThreadInteraction[];
  currentUserId: string | null;
  issueStatus: IssueStatus;
  blockedBy?: readonly IssueRelationIssueSummary[] | null;
  recoveryAction?: IssueRecoveryAction | null;
  hasNewReply: boolean;
}): string | null {
  const { interactions, currentUserId, issueStatus, blockedBy, recoveryAction, hasNewReply } = args;

  // 1) A pending interaction addressed to the user.
  const pendingKinds = new Set<PendingInteractionKind>();
  for (const interaction of interactions) {
    if (interaction.status !== "pending") continue;
    // Interactions targeted at the user; if a resolver user is recorded and is
    // someone else we still treat pending interactions as user-facing prompts.
    if (
      interaction.resolvedByUserId
      && currentUserId
      && interaction.resolvedByUserId !== currentUserId
    ) {
      continue;
    }
    pendingKinds.add(interaction.kind);
  }
  for (const kind of PENDING_INTERACTION_PRIORITY) {
    if (pendingKinds.has(kind)) return PENDING_INTERACTION_ACTION[kind];
  }

  // 2) In review -> review and approve or request changes.
  if (issueStatus === "in_review") return "review and approve or request changes";

  // 3) Blocked / has blockers -> unblock to proceed.
  const hasBlockers = !!blockedBy && blockedBy.length > 0;
  const hasOpenRecovery = !!recoveryAction && recoveryAction.status !== "resolved";
  if (issueStatus === "blocked" || hasBlockers || hasOpenRecovery) {
    return "unblock to proceed";
  }

  // 4) A new reply awaiting the user -> reply.
  if (hasNewReply) return "reply";

  return null;
}

function humanizeStatus(status: string): string {
  const map: Record<string, string> = {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled",
  };
  return (
    map[status]
    ?? status
      .split(/[_\s]+/)
      .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
      .join(" ")
  );
}
