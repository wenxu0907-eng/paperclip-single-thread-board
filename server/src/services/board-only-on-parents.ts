/**
 * Phase 2 — single-thread board model enforcement (COM-85 / COM-86).
 *
 * In the single-thread board model, a board member (human user) should only ever be
 * the assignee of a top-level "intent" issue — never of a child task. That keeps the
 * board out of the org's internal fan-out: they track one thread per intent, and the
 * CEO owns everything underneath it.
 *
 * This guard is gated behind the PAPERCLIP_BOARD_ONLY_ON_PARENTS flag and defaults OFF,
 * so it never changes existing behavior until a deployment explicitly opts in.
 */

export const BOARD_ONLY_ON_PARENTS_MESSAGE =
  "Board members can only be assigned to top-level issues, not child tasks. " +
  "Assign the human to the parent intent instead (single-thread board model).";

export const BOARD_ONLY_ON_PARENTS_REVIEWER_MESSAGE =
  "Board members can only review top-level issues, not child tasks. " +
  "Add the human as a reviewer on the parent intent instead (single-thread board model).";

/** Whether child-issue human-assignment enforcement is enabled for this deployment. */
export function boardOnlyOnParentsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.PAPERCLIP_BOARD_ONLY_ON_PARENTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * Resolves whether the single-thread board guard is active for a given company.
 * The env flag is a global force-on override (deployment-wide); otherwise the guard
 * is a per-company opt-in via the `boardOnlyOnParents` company setting.
 */
export function boardOnlyOnParentsActive(input: {
  envEnabled: boolean;
  companySetting: boolean | null | undefined;
}): boolean {
  return input.envEnabled || input.companySetting === true;
}

/**
 * Returns true when the given assignment would place a human (board) user on a child
 * issue — the exact violation the single-thread model forbids. Agent assignees are
 * always allowed; only human `assigneeUserId` on a parented issue is rejected.
 */
export function violatesBoardOnlyOnParents(input: {
  hasParent: boolean;
  assigneeUserId: string | null | undefined;
}): boolean {
  return (
    input.hasParent &&
    typeof input.assigneeUserId === "string" &&
    input.assigneeUserId.trim().length > 0
  );
}

/**
 * Returns true when the given reviewer would place a human (board) user as a reviewer on
 * a child issue — the single-thread model forbids this exactly as it forbids child human
 * assignees. Agent reviewers are always allowed; only a human `reviewerUserId` on a
 * parented issue is rejected.
 */
export function violatesBoardOnlyOnParentsReviewer(input: {
  hasParent: boolean;
  reviewerUserId: string | null | undefined;
}): boolean {
  return (
    input.hasParent &&
    typeof input.reviewerUserId === "string" &&
    input.reviewerUserId.trim().length > 0
  );
}
