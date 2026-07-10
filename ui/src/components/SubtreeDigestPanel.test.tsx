// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtreeDigestPanel } from "./SubtreeDigestPanel";
import type { IssueSubtreeDigest } from "../api/issues";

const mockGetSubtreeDigest = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: {
    getSubtreeDigest: mockGetSubtreeDigest,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const digestWithFanOut: IssueSubtreeDigest = {
  rootIssueId: "issue-root",
  descendantCount: 5,
  countsByStatus: {
    backlog: 0,
    todo: 1,
    in_progress: 2,
    in_review: 0,
    done: 1,
    blocked: 1,
    cancelled: 0,
  },
  openCount: 4,
  blockedCount: 1,
  pendingDecisionCount: 3,
  lastActivityAt: "2026-07-05T00:00:00.000Z",
};

describe("SubtreeDigestPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPanel() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SubtreeDigestPanel issueId="issue-root" />
        </QueryClientProvider>,
      );
    });
    // Flush the react-query fetch microtasks + resulting state update.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  // Poll the DOM until a condition holds, yielding real macrotasks so react-query's
  // resolved promise can settle and commit. Microtask ticks alone are not enough.
  async function flushUntil(predicate: () => boolean, tries = 50) {
    for (let i = 0; i < tries; i++) {
      if (predicate()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("renders the rolled-up summary line when the intent has fanned out", async () => {
    mockGetSubtreeDigest.mockResolvedValue(digestWithFanOut);

    await renderPanel();

    expect(mockGetSubtreeDigest).toHaveBeenCalledWith("issue-root");

    await flushUntil(() => (container.textContent ?? "").includes("subtasks"));

    const text = container.textContent ?? "";
    expect(text).toContain("5 subtasks");
    expect(text).toContain("2 in progress");
    expect(text).toContain("1 blocked");
    expect(text).toContain("1 done");
    expect(text).toContain("3 decisions pending");
    expect(text).toContain("updated");
  });

  it("omits the pending-decisions clause when there are none", async () => {
    mockGetSubtreeDigest.mockResolvedValue({
      ...digestWithFanOut,
      pendingDecisionCount: 0,
    } satisfies IssueSubtreeDigest);

    await renderPanel();
    await flushUntil(() => (container.textContent ?? "").includes("subtasks"));

    const text = container.textContent ?? "";
    expect(text).toContain("5 subtasks");
    expect(text).not.toContain("decisions pending");
  });

  it("renders nothing when there is no fan-out yet", async () => {
    mockGetSubtreeDigest.mockResolvedValue({
      rootIssueId: "issue-root",
      descendantCount: 0,
      countsByStatus: {
        backlog: 0,
        todo: 0,
        in_progress: 0,
        in_review: 0,
        done: 0,
        blocked: 0,
        cancelled: 0,
      },
      openCount: 0,
      blockedCount: 0,
      pendingDecisionCount: 0,
      lastActivityAt: null,
    } satisfies IssueSubtreeDigest);

    await renderPanel();

    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
  });

  it("fails quiet (renders nothing) when the fetch errors", async () => {
    mockGetSubtreeDigest.mockRejectedValue(new Error("boom"));

    await renderPanel();

    expect(container.textContent).toBe("");
  });
});
