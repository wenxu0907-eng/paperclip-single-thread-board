import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminated-run issue create guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// COM-322: issue creation tagged with a terminal heartbeat run id is a zombie
// write — a cancelled ACPX-lane run kept executing and created a duplicate
// issue (CMP-575) minutes after cancellation. These tests pin the write-path
// backstop: terminal runs get 409 on every issue-create surface, live runs
// and untagged callers pass through.
describeEmbeddedPostgres("terminated-run issue create guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-terminated-run-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ZombieAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status,
    });
    return runId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    }).returning();
    return parent;
  }

  it("rejects root issue creation from a cancelled run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId, "cancelled");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("x-paperclip-run-id", runId)
      .send({ title: "Zombie-created duplicate" })
      .expect(409);

    expect(res.body.error).toContain("cancelled");
    expect(res.body.details).toMatchObject({ runId, runStatus: "cancelled" });
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("rejects child issue creation from a timed-out run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId, "timed_out");
    const parent = await seedParent(companyId);
    const app = createApp();

    await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .set("x-paperclip-run-id", runId)
      .send({ title: "Zombie child" })
      .expect(409);

    const remaining = await db.select().from(issues);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(parent.id);
  });

  it("rejects accepted-plan decomposition from a failed run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId, "failed");
    const parent = await seedParent(companyId);
    const app = createApp();

    await request(app)
      .post(`/api/issues/${parent.id}/accepted-plan-decompositions`)
      .set("x-paperclip-run-id", runId)
      .send({
        acceptedPlanRevisionId: randomUUID(),
        children: [{ title: "Zombie decomposition child" }],
      })
      .expect(409);

    const remaining = await db.select().from(issues);
    expect(remaining).toHaveLength(1);
  });

  it("allows issue creation from a live (running) run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId, "running");
    const app = createApp();

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("x-paperclip-run-id", runId)
      .send({ title: "Healthy create" })
      .expect(201);
  });

  it("allows issue creation without a run id header", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Board-created issue" })
      .expect(201);
  });
});
