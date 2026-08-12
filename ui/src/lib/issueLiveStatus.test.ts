import { describe, expect, it } from "vitest";
import {
  deriveIssueLiveStatus,
  type IssueLiveStatusInteractionInput,
  type IssueLiveStatusRunInput,
} from "./issueLiveStatus";

function run(overrides: Partial<IssueLiveStatusRunInput> = {}): IssueLiveStatusRunInput {
  return {
    id: "run-1",
    status: "running",
    startedAt: "2026-08-12T10:00:00.000Z",
    createdAt: "2026-08-12T09:59:00.000Z",
    ...overrides,
  };
}

function interaction(
  overrides: Partial<IssueLiveStatusInteractionInput> = {},
): IssueLiveStatusInteractionInput {
  return {
    id: "int-1",
    status: "pending",
    createdAt: "2026-08-12T08:00:00.000Z",
    ...overrides,
  };
}

describe("deriveIssueLiveStatus", () => {
  it("reports running when a run is executing, linking to that run", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [run({ id: "run-42" })],
      interactions: [],
    });
    expect(status).toEqual({
      kind: "running",
      since: "2026-08-12T10:00:00.000Z",
      runId: "run-42",
      interactionId: null,
      waitingReason: null,
      parkedReason: null,
    });
  });

  it("prefers a running run over a queued one", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [run({ id: "q", status: "queued" }), run({ id: "r", status: "running" })],
      interactions: [],
    });
    expect(status?.runId).toBe("r");
  });

  it("falls back to createdAt when a running run has no startedAt", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [run({ startedAt: null })],
      interactions: [],
    });
    expect(status?.since).toBe("2026-08-12T09:59:00.000Z");
  });

  it("reports waiting on a pending interaction, pinned to its createdAt", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_review",
      liveRuns: [],
      interactions: [interaction({ id: "confirm-9" })],
    });
    expect(status).toMatchObject({
      kind: "waiting",
      waitingReason: "pending_interaction",
      interactionId: "confirm-9",
      since: "2026-08-12T08:00:00.000Z",
    });
  });

  it("picks the earliest pending interaction and ignores resolved ones", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [],
      interactions: [
        interaction({ id: "late", createdAt: "2026-08-12T09:00:00.000Z" }),
        interaction({ id: "accepted", status: "accepted", createdAt: "2026-08-12T06:00:00.000Z" }),
        interaction({ id: "early", createdAt: "2026-08-12T07:00:00.000Z" }),
      ],
    });
    expect(status?.interactionId).toBe("early");
  });

  it("reports waiting for review when in_review with no pending interaction", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_review",
      issueUpdatedAt: "2026-08-12T05:00:00.000Z",
      liveRuns: [],
      interactions: [interaction({ status: "accepted" })],
    });
    expect(status).toMatchObject({
      kind: "waiting",
      waitingReason: "in_review",
      since: "2026-08-12T05:00:00.000Z",
      interactionId: null,
    });
  });

  it("reports waiting/blocked only when a blocker is present", () => {
    expect(
      deriveIssueLiveStatus({
        issueStatus: "blocked",
        hasBlocker: true,
        issueUpdatedAt: "2026-08-12T05:00:00.000Z",
        liveRuns: [],
        interactions: [],
      }),
    ).toMatchObject({ kind: "waiting", waitingReason: "blocked" });

    expect(
      deriveIssueLiveStatus({
        issueStatus: "blocked",
        hasBlocker: false,
        liveRuns: [],
        interactions: [],
      }),
    ).toMatchObject({ kind: "parked" });
  });

  it("reports parked when nothing is running or awaiting", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [],
      interactions: [],
    });
    expect(status).toMatchObject({
      kind: "parked",
      runId: null,
      interactionId: null,
      parkedReason: null,
    });
  });

  it("attributes the parked reason to the last run and links to it", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [],
      interactions: [],
      latestRun: {
        id: "run-99",
        errorCode: "issue_continuation_waiting_on_review",
        finishedAt: "2026-08-12T04:00:00.000Z",
      },
    });
    expect(status).toMatchObject({
      kind: "parked",
      runId: "run-99",
      parkedReason: "issue_continuation_waiting_on_review",
      since: "2026-08-12T04:00:00.000Z",
    });
  });

  it("prefers errorCode, then retryExhaustedReason, then livenessReason for the park reason", () => {
    expect(
      deriveIssueLiveStatus({
        issueStatus: "in_progress",
        liveRuns: [],
        interactions: [],
        latestRun: { id: "r", retryExhaustedReason: "max_attempts", livenessReason: "silent" },
      })?.parkedReason,
    ).toBe("max_attempts");

    expect(
      deriveIssueLiveStatus({
        issueStatus: "in_progress",
        liveRuns: [],
        interactions: [],
        latestRun: { id: "r", livenessReason: "process_lost" },
      })?.parkedReason,
    ).toBe("process_lost");
  });

  it("falls back to the last run's createdAt for parked 'since' when unfinished", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "in_progress",
      liveRuns: [],
      interactions: [],
      latestRun: { id: "r", createdAt: "2026-08-12T03:00:00.000Z", finishedAt: null },
    });
    expect(status?.since).toBe("2026-08-12T03:00:00.000Z");
  });

  it("hides the badge for terminal tickets with no live run", () => {
    expect(
      deriveIssueLiveStatus({ issueStatus: "done", liveRuns: [], interactions: [] }),
    ).toBeNull();
    expect(
      deriveIssueLiveStatus({ issueStatus: "cancelled", liveRuns: [], interactions: [] }),
    ).toBeNull();
  });

  it("still reports running for a terminal ticket that has a live run", () => {
    const status = deriveIssueLiveStatus({
      issueStatus: "done",
      liveRuns: [run()],
      interactions: [],
    });
    expect(status?.kind).toBe("running");
  });
});
