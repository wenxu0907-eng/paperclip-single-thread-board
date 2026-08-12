import { describe, expect, it } from "vitest";
import { detectPrWake } from "../services/github-external-object-provider.js";

// COM-333 / L3 Phase 1 (Capture): pure transition detector unit tests on synthetic PR snapshot
// `data` bodies. No I/O — asserts only the null | "ci_green" | "pr_mergeable" classification.

const openPr = (over: Record<string, unknown> = {}) => ({
  state: "open",
  merged: false,
  draft: false,
  ...over,
});

describe("detectPrWake", () => {
  it("returns null when merge-readiness is unchanged (both clean)", () => {
    const clean = openPr({ mergeable: true, mergeableState: "clean" });
    expect(detectPrWake(clean, clean)).toBeNull();
  });

  it("fires pr_mergeable when a PR transitions into clean (the green-PR-pickup case)", () => {
    const prev = openPr({ mergeable: null, mergeableState: "unknown" });
    const next = openPr({ mergeable: true, mergeableState: "clean" });
    expect(detectPrWake(prev, next)).toBe("pr_mergeable");
  });

  it("fires pr_mergeable even with no prior snapshot (first observation clean)", () => {
    const next = openPr({ mergeable: true, mergeableState: "clean" });
    expect(detectPrWake(null, next)).toBe("pr_mergeable");
  });

  it("fires ci_green when checks pass but review still gates (blocked -> unstable)", () => {
    const prev = openPr({ mergeable: false, mergeableState: "blocked" });
    const next = openPr({ mergeable: false, mergeableState: "unstable" });
    expect(detectPrWake(prev, next)).toBe("ci_green");
  });

  it("does not fire when CI is still failing / dirty", () => {
    const prev = openPr({ mergeable: null, mergeableState: "unknown" });
    const next = openPr({ mergeable: false, mergeableState: "dirty" });
    expect(detectPrWake(prev, next)).toBeNull();
  });

  it("never fires for merged PRs", () => {
    const prev = openPr({ mergeable: true, mergeableState: "clean" });
    const next = openPr({ merged: true, state: "closed", mergeable: true, mergeableState: "clean" });
    expect(detectPrWake(prev, next)).toBeNull();
  });

  it("never fires for draft PRs", () => {
    const prev = openPr({ draft: true, mergeableState: "unknown" });
    const next = openPr({ draft: true, mergeable: true, mergeableState: "clean" });
    expect(detectPrWake(prev, next)).toBeNull();
  });

  it("never fires for closed (unmerged) PRs", () => {
    const next = openPr({ state: "closed", mergeable: true, mergeableState: "clean" });
    expect(detectPrWake(null, next)).toBeNull();
  });

  it("does not re-fire pr_mergeable when already clean and staying clean via CI path", () => {
    const clean = openPr({ mergeable: true, mergeableState: "clean" });
    // already merge-ready last time, still merge-ready — no duplicate wake
    expect(detectPrWake(clean, clean)).toBeNull();
  });
});
