import { describe, expect, it } from "vitest";
import { shouldResumeReviewedIssueOnRunStart } from "../services/heartbeat.ts";

// COM-111: when a working run actually starts against an `in_review` issue it
// owns, and no active review path parks the review, the run-start invariant must
// resume the issue to `in_progress` so the board never sees a live run under a
// review label. This covers the non-comment triggers (automation/system wakes,
// monitors, scheduled retries) that the comment-route resume never reached.
describe("shouldResumeReviewedIssueOnRunStart", () => {
  it("resumes an in_review issue when the run owns the lock and no review path is active", () => {
    expect(
      shouldResumeReviewedIssueOnRunStart({
        issueStatus: "in_review",
        runOwnsExecutionLock: true,
        hasActiveReviewPath: false,
      }),
    ).toBe(true);
  });

  it("leaves a legitimately-parked review alone (pending interaction / approval / participant)", () => {
    expect(
      shouldResumeReviewedIssueOnRunStart({
        issueStatus: "in_review",
        runOwnsExecutionLock: true,
        hasActiveReviewPath: true,
      }),
    ).toBe(false);
  });

  it("does not touch a run that does not own the execution lock", () => {
    expect(
      shouldResumeReviewedIssueOnRunStart({
        issueStatus: "in_review",
        runOwnsExecutionLock: false,
        hasActiveReviewPath: false,
      }),
    ).toBe(false);
  });

  it("only fires for in_review — other statuses are untouched", () => {
    for (const issueStatus of ["todo", "in_progress", "blocked", "done", "cancelled", null, undefined]) {
      expect(
        shouldResumeReviewedIssueOnRunStart({
          issueStatus,
          runOwnsExecutionLock: true,
          hasActiveReviewPath: false,
        }),
      ).toBe(false);
    }
  });
});
