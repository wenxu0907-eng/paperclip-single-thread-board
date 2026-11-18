import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq, isNotNull } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, issues } from "@paperclipai/db";
import { SELF_REVIEW_SEAT_COLLAPSE_MESSAGE, issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * COM-335b route wiring — re-verified under COM-536.
 *
 * The legacy line enforced the seat-collapse guard on four paths: create,
 * children-create, accepted-plan decomposition, and update/PATCH. The Phase-2
 * port kept three and silently dropped the decomposition loop, which the unit
 * tests in `issue-execution-policy.test.ts` could not see. These tests drive the
 * router, so each site is proven live rather than merely present.
 */
describeEmbeddedPostgres("self-review seat collapse route enforcement", () => {
  const ctx = useEmbeddedPostgres("paperclip-self-review-seat-collapse-routes-", {
    resetEach: async (db) => {
      // FK order: activity and issues reference agents, agents reference the
      // company. The shared reset drops companies last, so agents have to go
      // between the issue deletes and it.
      await db.delete(activityLog);
      await db.delete(issues).where(isNotNull(issues.parentId));
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Seat collapse");
    const executorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values([
      { id: executorAgentId, companyId: company.companyId, name: "Executor" },
      { id: reviewerAgentId, companyId: company.companyId, name: "Reviewer" },
    ]);
    const parentId = randomUUID();
    const childId = randomUUID();
    await ctx.db.insert(issues).values({
      id: parentId,
      companyId: company.companyId,
      title: "Parent intent",
      status: "todo",
      priority: "medium",
    });
    await ctx.db.insert(issues).values({
      id: childId,
      companyId: company.companyId,
      title: "Child task",
      status: "todo",
      priority: "medium",
      parentId,
      assigneeAgentId: executorAgentId,
    });
    return { ...company, executorAgentId, reviewerAgentId, parentId, childId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  /** A review stage whose only participant is `agentId`. */
  function soleAgentReviewPolicy(agentId: string) {
    return { stages: [{ type: "review", participants: [{ type: "agent", agentId }] }] };
  }

  it("refuses seat collapse on the create route", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({
        title: "Self-reviewed",
        assigneeAgentId: seeded.executorAgentId,
        executionPolicy: soleAgentReviewPolicy(seeded.executorAgentId),
      })
      .expect(422);
    expect(res.body.error).toBe(SELF_REVIEW_SEAT_COLLAPSE_MESSAGE);
  });

  it("refuses seat collapse on the children-create route", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.parentId}/children`)
      .send({
        title: "Self-reviewed child",
        assigneeAgentId: seeded.executorAgentId,
        executionPolicy: soleAgentReviewPolicy(seeded.executorAgentId),
      })
      .expect(422);
    expect(res.body.error).toBe(SELF_REVIEW_SEAT_COLLAPSE_MESSAGE);
  });

  // The site the Phase-2 port dropped.
  it("refuses seat collapse on the accepted-plan decomposition route", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.parentId}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId: randomUUID(),
        children: [
          {
            title: "Self-reviewed decomposition child",
            assigneeAgentId: seeded.executorAgentId,
            executionPolicy: soleAgentReviewPolicy(seeded.executorAgentId),
          },
        ],
      })
      .expect(422);
    expect(res.body.error).toBe(SELF_REVIEW_SEAT_COLLAPSE_MESSAGE);
    expect(
      await ctx.db.select().from(issues).where(eq(issues.parentId, seeded.parentId)),
    ).toHaveLength(1);
  });

  it("refuses seat collapse on the update route", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ executionPolicy: soleAgentReviewPolicy(seeded.executorAgentId) })
      .expect(422);
    expect(res.body.error).toBe(SELF_REVIEW_SEAT_COLLAPSE_MESSAGE);
  });

  it("accepts a review stage held by a different agent", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ executionPolicy: soleAgentReviewPolicy(seeded.reviewerAgentId) })
      .expect(200);
  });
});
