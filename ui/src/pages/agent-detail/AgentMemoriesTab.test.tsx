// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentMemoryFileSummary,
  AgentMemoryOverview,
} from "@paperclipai/shared";

const mockAgentsApi = vi.hoisted(() => ({
  memories: vi.fn(),
  memoryFile: vi.fn(),
  saveMemoryFile: vi.fn(),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));

// MarkdownBody pulls in the whole markdown pipeline; the tab only needs to know
// that the file body reached it.
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "markdown" }, children as never),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function makeFile(overrides: Partial<AgentMemoryFileSummary> = {}): AgentMemoryFileSummary {
  return {
    relativePath: "memory/MEMORY.md",
    title: "MEMORY.md",
    kind: "markdown",
    byteSize: 128,
    modifiedAt: "2026-11-16T00:00:00Z",
    ...overrides,
  };
}

function makeOverview(overrides: Partial<AgentMemoryOverview> = {}): AgentMemoryOverview {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    memorySource: "harness",
    hasMemories: true,
    tacit: makeFile(),
    index: null,
    dailyNotes: [],
    paraEntities: [],
    harnessFacts: [],
    projectMemories: [],
    truncated: false,
    ...overrides,
  };
}

const agent = { id: "agent-1", name: "Nova" } as Agent;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const { AgentMemoriesTab } = await import("./AgentMemoriesTab");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentMemoriesTab, { agent, companyId: "company-1" }),
      ),
    );
  });
  await flushReact();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockAgentsApi.memories.mockReset();
  mockAgentsApi.memoryFile.mockReset();
  mockAgentsApi.saveMemoryFile.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("AgentMemoriesTab", () => {
  it("names the harness store in the empty state, not the para skill", async () => {
    mockAgentsApi.memories.mockResolvedValue(
      makeOverview({ hasMemories: false, tacit: null, memorySource: "harness" }),
    );
    await render();

    expect(container.textContent).toContain("No memories yet");
    expect(container.textContent).toContain("Claude harness auto-memory");
    expect(container.textContent).not.toContain("para-memory-files");
  });

  it("names the para skill when that is the backing store", async () => {
    mockAgentsApi.memories.mockResolvedValue(
      makeOverview({ hasMemories: false, tacit: null, memorySource: "para" }),
    );
    await render();

    expect(container.textContent).toContain("para-memory-files");
  });

  it("still renders when the agent has no own memory but a project does", async () => {
    // Regression guard: hasMemories is false here, and an `||` on that field
    // alone would wrongly show the empty state and hide shared project memory.
    mockAgentsApi.memories.mockResolvedValue(
      makeOverview({
        hasMemories: false,
        tacit: null,
        projectMemories: [
          {
            projectId: "proj-1",
            projectName: "Paperclip",
            tacit: makeFile({ relativePath: "proj/MEMORY.md" }),
            harnessFacts: [],
            truncated: false,
          },
        ],
      }),
    );
    await render();

    expect(container.textContent).not.toContain("No memories yet");
    expect(container.textContent).toContain("Project memory");
    expect(container.textContent).toContain("Paperclip");
  });

  it("labels the index differently for harness and para stores", async () => {
    mockAgentsApi.memories.mockResolvedValue(makeOverview({ memorySource: "harness" }));
    await render();
    expect(container.textContent).toContain("Index");

    await act(() => root.unmount());
    root = createRoot(container);
    mockAgentsApi.memories.mockResolvedValue(makeOverview({ memorySource: "para" }));
    await render();
    expect(container.textContent).toContain("Tacit");
  });

  it("opens a selected file and offers an edit affordance for the agent's own memory", async () => {
    mockAgentsApi.memories.mockResolvedValue(makeOverview());
    mockAgentsApi.memoryFile.mockResolvedValue({
      resource: {
        relativePath: "memory/MEMORY.md",
        title: "MEMORY.md",
        kind: "markdown",
        byteSize: 128,
        modifiedAt: "2026-11-16T00:00:00Z",
      },
      content: { encoding: "utf8", data: "# remembered" },
    });
    await render();

    const fileButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("MEMORY.md"),
    );
    expect(fileButton).toBeTruthy();
    await act(() => fileButton!.click());
    await flushReact();

    expect(mockAgentsApi.memoryFile).toHaveBeenCalledWith("agent-1", "memory/MEMORY.md", "company-1", undefined);
    expect(container.querySelector('[data-testid="markdown"]')?.textContent).toContain("# remembered");
    expect(container.textContent).toContain("Edit");
  });

  it("keeps project memory read-only — no edit affordance, and the projectId is sent", async () => {
    mockAgentsApi.memories.mockResolvedValue(
      makeOverview({
        hasMemories: false,
        tacit: null,
        projectMemories: [
          {
            projectId: "proj-1",
            projectName: "Paperclip",
            tacit: makeFile({ relativePath: "proj/MEMORY.md", title: "MEMORY.md" }),
            harnessFacts: [],
            truncated: false,
          },
        ],
      }),
    );
    mockAgentsApi.memoryFile.mockResolvedValue({
      resource: {
        relativePath: "proj/MEMORY.md",
        title: "MEMORY.md",
        kind: "markdown",
        byteSize: 64,
        modifiedAt: "2026-11-16T00:00:00Z",
      },
      content: { encoding: "utf8", data: "shared" },
    });
    await render();

    const projectFile = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Index"),
    );
    expect(projectFile).toBeTruthy();
    await act(() => projectFile!.click());
    await flushReact();

    expect(mockAgentsApi.memoryFile).toHaveBeenCalledWith("agent-1", "proj/MEMORY.md", "company-1", "proj-1");
    expect(container.textContent).toContain("read-only");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Edit")).toBe(false);
  });

  it("surfaces a yaml parse error without hiding the raw body", async () => {
    mockAgentsApi.memories.mockResolvedValue(
      makeOverview({
        memorySource: "para",
        harnessFacts: [makeFile({ relativePath: "life/items.yaml", title: "items.yaml", kind: "yaml" })],
      }),
    );
    mockAgentsApi.memoryFile.mockResolvedValue({
      resource: {
        relativePath: "life/items.yaml",
        title: "items.yaml",
        kind: "yaml",
        byteSize: 32,
        modifiedAt: "2026-11-16T00:00:00Z",
      },
      content: { encoding: "utf8", data: "not: [valid" },
      facts: null,
      parseError: "unexpected end of flow sequence",
    });
    await render();

    const yamlButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("items.yaml"),
    );
    await act(() => yamlButton!.click());
    await flushReact();

    expect(container.textContent).toContain("Could not parse facts");
    expect(container.textContent).toContain("unexpected end of flow sequence");
    expect(container.querySelector('[data-testid="markdown"]')?.textContent).toContain("not: [valid");
  });
});
