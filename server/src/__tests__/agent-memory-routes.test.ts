import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockMemoryService = vi.hoisted(() => ({
  getOverview: vi.fn(),
  readMemoryFile: vi.fn(),
  writeMemoryFile: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function servicesIndexMock() {
  return {
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn(),
    workspaceOperationService: () => ({}),
  };
}

vi.mock("../services/index.js", () => servicesIndexMock());
vi.mock("../services/agent-memory-files.js", () => ({
  agentMemoryFileService: () => mockMemoryService,
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({}) }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => servicesIndexMock());
  vi.doMock("../services/agent-memory-files.js", () => ({
    agentMemoryFileService: () => mockMemoryService,
  }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => ({}) }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => ({}) }));
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

describe("agent memory routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow", explanation: "ok" });
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockMemoryService.getOverview.mockResolvedValue({
      agentId: AGENT_ID,
      companyId: "company-1",
      hasMemories: true,
      tacit: null,
      index: null,
      dailyNotes: [],
      paraEntities: [],
      truncated: false,
    });
    mockMemoryService.readMemoryFile.mockResolvedValue({
      resource: { relativePath: "MEMORY.md", title: "MEMORY.md", kind: "markdown", byteSize: 4, modifiedAt: "x" },
      content: { encoding: "utf8", data: "hi\n" },
      facts: null,
      parseError: null,
    });
    mockMemoryService.writeMemoryFile.mockResolvedValue({
      resource: { relativePath: "MEMORY.md", title: "MEMORY.md", kind: "markdown", byteSize: 7, modifiedAt: "x" },
      content: { encoding: "utf8", data: "hello\n" },
      facts: null,
      parseError: null,
    });
  });

  it("returns 404 for an unknown agent", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const res = await request(await createApp(boardActor)).get(`/api/agents/${AGENT_ID}/memories?companyId=company-1`);
    expect(res.status).toBe(404);
  });

  it("returns the memory overview", async () => {
    const res = await request(await createApp(boardActor)).get(`/api/agents/${AGENT_ID}/memories?companyId=company-1`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hasMemories).toBe(true);
    expect(mockMemoryService.getOverview).toHaveBeenCalled();
  });

  it("requires a path query for the file endpoint", async () => {
    const res = await request(await createApp(boardActor)).get(`/api/agents/${AGENT_ID}/memories/file?companyId=company-1`);
    expect(res.status).toBe(422);
  });

  it("returns a memory file", async () => {
    const res = await request(await createApp(boardActor))
      .get(`/api/agents/${AGENT_ID}/memories/file?companyId=company-1&path=MEMORY.md`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content.data).toBe("hi\n");
    expect(mockMemoryService.readMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGENT_ID }),
      "MEMORY.md",
    );
  });

  it("writes a memory file and logs the activity", async () => {
    const res = await request(await createApp(boardActor))
      .put(`/api/agents/${AGENT_ID}/memories/file?companyId=company-1`)
      .send({ path: "MEMORY.md", content: "hello\n" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockMemoryService.writeMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGENT_ID }),
      "MEMORY.md",
      "hello\n",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.memory_file_updated" }),
    );
  });

  it("rejects a write from an actor without update permission", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny", explanation: "no" });
    const res = await request(await createApp({ ...boardActor, isInstanceAdmin: false, companyIds: [] }))
      .put(`/api/agents/${AGENT_ID}/memories/file?companyId=company-1`)
      .send({ path: "MEMORY.md", content: "hello\n" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockMemoryService.writeMemoryFile).not.toHaveBeenCalled();
  });
});
