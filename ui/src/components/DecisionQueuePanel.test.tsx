// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionQueuePanel } from "./DecisionQueuePanel";
import type { IssueDecisionQueue, IssueDecisionQueueItem } from "../api/issues";
import {
  pendingRequestConfirmationInteraction,
  pendingSuggestedTasksInteraction,
} from "../fixtures/issueThreadInteractionFixtures";

const mockGetDecisionQueue = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: {
    getDecisionQueue: mockGetDecisionQueue,
  },
}));

// Render the company-scoped Link as a plain anchor so we can assert hrefs
// without wiring up CompanyContext / issue quicklook.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(
  interaction: IssueDecisionQueueItem,
  sourceIssue: IssueDecisionQueueItem["sourceIssue"],
): IssueDecisionQueueItem {
  return { ...interaction, sourceIssue };
}

const confirmationItem = makeItem(
  pendingRequestConfirmationInteraction as unknown as IssueDecisionQueueItem,
  { id: "issue-a", identifier: "PAP-101", title: "Ship the pricing page", status: "todo" },
);

const suggestItem = makeItem(
  pendingSuggestedTasksInteraction as unknown as IssueDecisionQueueItem,
  { id: "issue-b", identifier: "PAP-202", title: "Draft the launch plan", status: "in_review" },
);

describe("DecisionQueuePanel", () => {
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
          <DecisionQueuePanel companyId="company-1" issueId="issue-root" />
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

  it("renders each pending decision with its source-issue label and link", async () => {
    const queue: IssueDecisionQueue = {
      rootIssueId: "issue-root",
      count: 2,
      items: [confirmationItem, suggestItem],
    };
    mockGetDecisionQueue.mockResolvedValue(queue);

    await renderPanel();

    expect(mockGetDecisionQueue).toHaveBeenCalledWith("issue-root");

    // Wait for the query to resolve and the panel to commit its content.
    await flushUntil(() => (container.textContent ?? "").includes("Decision Queue"));

    const text = container.textContent ?? "";
    expect(text).toContain("Decision Queue");
    // Count badge.
    expect(text).toContain("2");
    // Interaction summaries.
    expect(text).toContain("Requested confirmation");
    expect(text).toContain("Suggested 4 tasks");
    // Source issue titles.
    expect(text).toContain("Ship the pricing page");
    expect(text).toContain("Draft the launch plan");

    // Source-issue links point at the source thread by identifier.
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/issues/PAP-101");
    expect(links).toContain("/issues/PAP-202");
  });

  it("preserves the server-provided order of items", async () => {
    mockGetDecisionQueue.mockResolvedValue({
      rootIssueId: "issue-root",
      count: 2,
      items: [confirmationItem, suggestItem],
    } satisfies IssueDecisionQueue);

    await renderPanel();
    await flushUntil(() => container.querySelectorAll("a").length >= 2);

    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links.indexOf("/issues/PAP-101")).toBeLessThan(links.indexOf("/issues/PAP-202"));
  });

  it("renders nothing when the queue is empty", async () => {
    mockGetDecisionQueue.mockResolvedValue({
      rootIssueId: "issue-root",
      count: 0,
      items: [],
    } satisfies IssueDecisionQueue);

    await renderPanel();

    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
  });

  it("fails quiet (renders nothing) when the fetch errors", async () => {
    mockGetDecisionQueue.mockRejectedValue(new Error("boom"));

    await renderPanel();

    expect(container.textContent).toBe("");
  });
});
