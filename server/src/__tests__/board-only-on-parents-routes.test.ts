import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, companies, issues } from "@paperclipai/db";
import {
  BOARD_ONLY_ON_PARENTS_MESSAGE,
  BOARD_ONLY_ON_PARENTS_REVIEWER_MESSAGE,
} from "../services/board-only-on-parents.js";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * COM-536 — route-level coverage for `board_only_on_parents`.
 *
 * The Phase-2 port of this guard left the update/PATCH site and the whole
 * reviewer half unwired while `server/src/__tests__/board-only-on-parents.test.ts`
 * stayed green: the service helpers were proven, their *callers* were not. Unit
 * tests on a ported helper can never catch that. These tests drive the real
 * router over a real database, so a future port that drops an enforcement site
 * fails here instead of shipping.
 *
 * Covered: all three enforcement sites × both halves (assignee, reviewer), plus
 * the top-level-issue escape hatch that must keep working.
 */
describeEmbeddedPostgres("board_only_on_parents route enforcement", () => {
  const ctx = useEmbeddedPostgres("paperclip-board-only-on-parents-routes-", {
    // The accepted writes in this suite log activity, which carries a company FK
    // the shared fixture reset does not clear.
    resetEach: async (db) => {
      await db.delete(activityLog);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed(opts: { guardActive?: boolean } = {}) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Board only on parents");
    if (opts.guardActive !== false) {
      await ctx.db
        .update(companies)
        .set({ boardOnlyOnParents: true })
        .where(eq(companies.id, company.companyId));
    }
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
    });
    return { ...company, parentId, childId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  /** An execution policy whose review stage names a board user as reviewer. */
  function boardReviewerPolicy(userId: string) {
    return { stages: [{ type: "review", participants: [{ type: "user", userId }] }] };
  }

  // --- site 1: POST /companies/:companyId/issues -----------------------------

  it("refuses a board assignee on a created child issue", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Child", parentId: seeded.parentId, assigneeUserId: seeded.userId })
      .expect(422);
    expect(res.body.error).toBe(BOARD_ONLY_ON_PARENTS_MESSAGE);
  });

  it("refuses a board reviewer on a created child issue", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({
        title: "Child",
        parentId: seeded.parentId,
        executionPolicy: boardReviewerPolicy(seeded.userId),
      })
      .expect(422);
    expect(res.body.error).toBe(BOARD_ONLY_ON_PARENTS_REVIEWER_MESSAGE);
  });

  it("accepts a board assignee and a board reviewer on a top-level issue", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({
        title: "Top-level intent",
        assigneeUserId: seeded.userId,
        executionPolicy: boardReviewerPolicy(seeded.userId),
      })
      .expect(201);
  });

  // --- site 2: POST /issues/:id/children ------------------------------------

  it("refuses a board assignee on the children-create route", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.parentId}/children`)
      .send({ title: "Child", assigneeUserId: seeded.userId })
      .expect(422);
    expect(res.body.error).toBe(BOARD_ONLY_ON_PARENTS_MESSAGE);
  });

  it("refuses a board reviewer on the children-create route", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.parentId}/children`)
      .send({ title: "Child", executionPolicy: boardReviewerPolicy(seeded.userId) })
      .expect(422);
    expect(res.body.error).toBe(BOARD_ONLY_ON_PARENTS_REVIEWER_MESSAGE);
  });

  // --- site 3: PATCH /issues/:id (the site the Phase-2 port dropped) --------

  it("refuses reassigning an existing child issue to a board user", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ assigneeUserId: seeded.userId })
      .expect(422);
    expect(res.body.error).toBe(BOARD_ONLY_ON_PARENTS_MESSAGE);
    const [row] = await ctx.db.select().from(issues).where(eq(issues.id, seeded.childId));
    expect(row.assigneeUserId).toBeNull();
  });

  it("refuses naming a board user as reviewer on an existing child issue", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ executionPolicy: boardReviewerPolicy(seeded.userId) })
      .expect(422);
    expect(res.body.error).toBe(BOARD_ONLY_ON_PARENTS_REVIEWER_MESSAGE);
  });

  it("still allows assigning a board user to an existing top-level issue", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .patch(`/api/issues/${seeded.parentId}`)
      .send({ assigneeUserId: seeded.userId })
      .expect(200);
  });

  it("still allows a board reviewer on an existing top-level issue", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .patch(`/api/issues/${seeded.parentId}`)
      .send({ executionPolicy: boardReviewerPolicy(seeded.userId) })
      .expect(200);
  });

  it("leaves an unrelated PATCH on a child issue alone", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ priority: "high" })
      .expect(200);
  });

  // --- the guard stays opt-in ----------------------------------------------

  it("does not enforce when the company setting is off", async () => {
    const seeded = await seed({ guardActive: false });
    await request(appFor(seeded))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ assigneeUserId: seeded.userId })
      .expect(200);
  });
});
