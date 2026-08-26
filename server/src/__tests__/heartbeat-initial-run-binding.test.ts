import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, resolveInitialRunBinding } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat initial-run binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat initial run binding", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-initial-run-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Binding Co",
        issuePrefix: "COM",
        requireBoardApprovalForNewAgents: false,
        boardOnlyOnParents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
        boardOnlyOnParents: false,
      },
    ]);
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Platform" },
      { id: otherProjectId, companyId, name: "Other Project" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        projectId,
        issueNumber: 425,
        identifier: "COM-425",
        title: "Original multi-project run",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        projectId: otherProjectId,
        issueNumber: 426,
        identifier: "COM-426",
        title: "Follow-up fix",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        issueNumber: 425,
        identifier: "OTH-425",
        title: "Other company issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    return { companyId, agentId, projectId, otherProjectId, issueId, otherIssueId };
  }

  it("canonicalizes a COM-425-style initial-run payload when structured IDs and text agree", async () => {
    const { companyId, projectId, issueId } = await seedFixture();

    const result = await resolveInitialRunBinding({
      db,
      companyId,
      reason: "issue_assigned",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "COM-425",
        taskId: "COM-425",
        projectId,
      },
      payload: {
        reason: "issue_assigned",
        issueId,
        projectId,
        issue: {
          identifier: "COM-425",
          title: "Original multi-project run",
          description: "Initial run should stay on COM-425 and not drift to COM-426.",
        },
        fallbackFetchNeeded: false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      issue: { id: issueId, identifier: "COM-425", projectId },
      projectId,
    });
  });

  it("rejects conflicting payload and text issue references before queueing a run", async () => {
    const { agentId, projectId, issueId } = await seedFixture();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { wakeReason: "issue_assigned", issueId, taskId: issueId, projectId },
      payload: {
        issueId,
        projectId,
        message: "Regression payload asks the agent to start on COM-426.",
        issue: {
          identifier: "COM-425",
          description: "Source: follow-up from COM-424.",
        },
      },
    });

    expect(run).toBeNull();
    await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(0);
    const [wake] = await db.select().from(agentWakeupRequests);
    expect(wake).toMatchObject({
      status: "skipped",
      reason: "initial_run_issue_binding_ambiguous",
    });
  });

  it("rejects issue-scoped wakes with no issue id", async () => {
    const { agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { wakeReason: "issue_assigned" },
      payload: { reason: "issue_assigned", fallbackFetchNeeded: true },
    });

    expect(run).toBeNull();
    await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(0);
    const [wake] = await db.select().from(agentWakeupRequests);
    expect(wake?.reason).toBe("initial_run_issue_binding_missing");
  });

  it("does not manufacture issue candidates out of UUID substrings", async () => {
    const { companyId, projectId } = await seedFixture();

    // "a040f860-8a7f-4c3d-…" contains "A040F860-8" and "A7F-4", which look like
    // issue identifiers to the free-text scanner. A project-scoped wake carrying
    // only a UUID must not be blocked by those phantom references.
    await expect(resolveInitialRunBinding({
      db,
      companyId,
      reason: null,
      contextSnapshot: { projectId },
      payload: null,
    })).resolves.toBeNull();
  });

  it("rejects cross-company, stale, and mismatched-project bindings", async () => {
    const { companyId, projectId, otherProjectId, issueId } = await seedFixture();

    await expect(resolveInitialRunBinding({
      db,
      companyId,
      reason: "issue_assigned",
      contextSnapshot: { issueId: "OTH-425" },
      payload: null,
    })).resolves.toMatchObject({ ok: false, code: "initial_run_issue_binding_unresolved" });

    // issues.project_id is nullable, so a project-less issue is still exactly
    // one binding — it must resolve, not fail closed.
    await db.update(issues).set({ projectId: null }).where(eq(issues.id, issueId));
    await expect(resolveInitialRunBinding({
      db,
      companyId,
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: null,
    })).resolves.toMatchObject({ ok: true, projectId: null, issue: { id: issueId } });

    // …but a project reference that the project-less issue cannot satisfy is a conflict.
    await expect(resolveInitialRunBinding({
      db,
      companyId,
      reason: "issue_assigned",
      contextSnapshot: { issueId, projectId: otherProjectId },
      payload: null,
    })).resolves.toMatchObject({ ok: false, code: "initial_run_project_binding_conflict" });

    await db.update(issues).set({ projectId, status: "cancelled" }).where(eq(issues.id, issueId));
    await expect(resolveInitialRunBinding({
      db,
      companyId,
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: null,
    })).resolves.toMatchObject({ ok: false, code: "initial_run_issue_binding_stale" });

    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    await expect(resolveInitialRunBinding({
      db,
      companyId,
      reason: "issue_assigned",
      contextSnapshot: { issueId, projectId: otherProjectId },
      payload: null,
    })).resolves.toMatchObject({ ok: false, code: "initial_run_project_binding_conflict" });
  });
});
