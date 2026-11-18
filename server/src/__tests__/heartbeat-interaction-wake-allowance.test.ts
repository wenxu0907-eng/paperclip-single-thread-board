import { describe, expect, it } from "vitest";
import { allowsIssueInteractionWake } from "../services/heartbeat.ts";

// allowsIssueInteractionWake decides whether a wake targeting a
// dependency-blocked issue may still run (in bounded interaction mode) instead
// of being skipped as issue_dependencies_blocked. Human comment/mention wakes
// qualify via a comment id; interaction-resolution continuation wakes (a board
// accept/decline of a request_confirmation) qualify via an interaction id even
// though they carry no comment id (COM-83).
describe("allowsIssueInteractionWake", () => {
  it("allows a comment-backed interaction wake", () => {
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      commentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    })).toBe(true);
  });

  it("allows an interaction-resolution wake that carries an interactionId but no comment id", () => {
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      interactionId: "iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii",
    })).toBe(true);
  });

  it("rejects a wake with neither a comment id nor an interaction id", () => {
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
    })).toBe(false);
  });

  it("rejects a wake whose reason is not an interaction wake reason", () => {
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_assigned",
      interactionId: "iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii",
    })).toBe(false);
  });

  it("rejects an empty context snapshot", () => {
    expect(allowsIssueInteractionWake(null)).toBe(false);
    expect(allowsIssueInteractionWake(undefined)).toBe(false);
    expect(allowsIssueInteractionWake({})).toBe(false);
  });
});
