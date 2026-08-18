import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueThreadInteractions } from "@paperclipai/db";

/**
 * COM-399: `execution_review_participant_recovery` fires whenever a review
 * participant's run ends while `executionState.status` is still `pending` —
 * true for both "the reviewer vanished" AND "the reviewer correctly declined
 * to approve yet because a separate, still-live decision (a board
 * confirmation/approval card) hasn't landed." Only the first case is actually
 * stranded. When a real pending interaction/approval already exists on the
 * issue, the review stage is intentionally parked on it, not abandoned —
 * mirrors the `issue_continuation_needed` self-park handling in
 * `resolveContinuationWaitingOnReview` (service.ts), which never had this
 * exception on the review-participant path before.
 */
export async function issueHasLivePendingDecisionGate(db: Db, companyId: string, issueId: string) {
  const [pendingInteraction] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingInteraction) return true;

  const [pendingApproval] = await db
    .select({ id: issueApprovals.approvalId })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(
      and(
        eq(issueApprovals.companyId, companyId),
        eq(issueApprovals.issueId, issueId),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ),
    )
    .limit(1);
  return Boolean(pendingApproval);
}
