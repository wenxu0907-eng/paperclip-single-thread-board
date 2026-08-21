import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentFallbackChainState,
  agentFallbackChains,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  DEFAULT_FALLBACK_CHAIN,
  evaluateFallbackChainSwitch,
  handleQuotaOrBillingFailureForRun,
  resolveFallbackChainSteps,
  scheduleFallbackChainRetry,
} from "./fallback-chain.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fallback-chain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const QUOTA_EXIT_INFO = { error: "You've hit your usage limit. Try again later." };
const CODEX_QUOTA_EXIT_INFO = { error: "insufficient_quota: you exceeded your current quota, please check your plan and billing." };
const NON_QUOTA_EXIT_INFO = { error: "workspace git worktree branch mismatch" };

describeEmbeddedPostgres("fallback-chain engine (COM-413)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fallback-chain-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentFallbackChainState);
    await db.delete(agentFallbackChains);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue(overrides?: { adapterType?: string; adapterConfig?: Record<string, unknown> }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `FB${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Fallback Chain Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      boardOnlyOnParents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: overrides?.adapterType ?? "claude_local",
      adapterConfig: overrides?.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the fallback chain",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, agent: agent!, issue: issue! };
  }

  it("resolves the in-code default chain when nothing is configured in the DB", async () => {
    const { agent } = await seedCompanyAgentIssue();
    const steps = await resolveFallbackChainSteps(db, agent);
    expect(steps).toEqual(DEFAULT_FALLBACK_CHAIN);
  });

  it("prefers an agent-specific chain over the default", async () => {
    const { agent } = await seedCompanyAgentIssue();
    await db.insert(agentFallbackChains).values({
      companyId: agent.companyId,
      agentId: agent.id,
      steps: [
        { adapterType: "claude_local", adapterConfig: {}, label: "primary" },
        { adapterType: "codex_local", adapterConfig: {}, label: "codex fallback" },
      ],
    });
    const steps = await resolveFallbackChainSteps(db, agent);
    expect(steps).toHaveLength(2);
    expect(steps[1]!.adapterType).toBe("codex_local");
  });

  it("is a no-op for a non-quota/billing failure", async () => {
    const { agent } = await seedCompanyAgentIssue();
    const result = await evaluateFallbackChainSwitch(db, {
      agent,
      exitInfo: NON_QUOTA_EXIT_INFO,
      reason: "test",
    });
    expect(result).toEqual({ outcome: "not_quota_failure" });
    const [reloaded] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(reloaded!.adapterType).toBe("claude_local");
  });

  it("does not switch into the unconfigured default Codex leg", async () => {
    const { agent } = await seedCompanyAgentIssue();
    const result = await evaluateFallbackChainSwitch(db, {
      agent,
      exitInfo: QUOTA_EXIT_INFO,
      reason: "provider_quota_recovery",
    });

    expect(result.outcome).toBe("blocked");
    const [reloaded] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(reloaded!.adapterType).toBe("claude_local");

    const [state] = await db.select().from(agentFallbackChainState).where(eq(agentFallbackChainState.agentId, agent.id));
    expect(state!.currentStepIndex).toBe(0);
    expect(state!.blocked).toBe(true);
    expect(state!.exhaustedSteps).toHaveLength(1);
    expect((state!.exhaustedSteps as Array<{ stepIndex: number }>)[0]!.stepIndex).toBe(0);
  });

  it("switches on an expired Claude credential when the next leg is configured", async () => {
    const { agent } = await seedCompanyAgentIssue();
    await db.insert(agentFallbackChains).values({
      companyId: agent.companyId,
      agentId: agent.id,
      steps: [
        { adapterType: "claude_local", adapterConfig: {}, label: "primary" },
        { adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: "secret_ref" } }, label: "codex fallback" },
      ],
    });

    const result = await evaluateFallbackChainSwitch(db, {
      agent,
      exitInfo: { errorCode: "configuration_incomplete", error: "authentication_error: OAuth token has expired" },
      reason: "credential_exhausted_recovery",
    });

    expect(result.outcome).toBe("switched");
    const [reloaded] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(reloaded!.adapterType).toBe("codex_local");
  });

  it("advances to a same-adapter-different-credential leg (claude_local -> claude_local alt binding)", async () => {
    const { agent } = await seedCompanyAgentIssue();
    await db.insert(agentFallbackChains).values({
      companyId: agent.companyId,
      agentId: agent.id,
      steps: [
        { adapterType: "claude_local", adapterConfig: {}, label: "primary" },
        { adapterType: "codex_local", adapterConfig: {}, label: "codex fallback" },
        {
          adapterType: "claude_local",
          adapterConfig: { model: "claude-alt-account" },
          label: "claude_local (alt account credential)",
        },
      ],
    });

    const first = await evaluateFallbackChainSwitch(db, { agent, exitInfo: QUOTA_EXIT_INFO, reason: "r1" });
    expect(first.outcome).toBe("switched");
    const [afterFirst] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(afterFirst!.adapterType).toBe("codex_local");

    const second = await evaluateFallbackChainSwitch(db, { agent: afterFirst!, exitInfo: CODEX_QUOTA_EXIT_INFO, reason: "r2" });
    expect(second.outcome).toBe("switched");
    if (second.outcome !== "switched") throw new Error("expected switched");
    expect(second.fromStep.adapterType).toBe("codex_local");
    expect(second.toStep.adapterType).toBe("claude_local");
    expect(second.toStep.adapterConfig).toEqual({ model: "claude-alt-account" });

    const [afterSecond] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(afterSecond!.adapterType).toBe("claude_local");
    expect(afterSecond!.adapterConfig).toMatchObject({ model: "claude-alt-account" });
  });

  it("blocks once the chain is exhausted and leaves a comment naming the agent as the fallback-chain owner", async () => {
    const { agent, issue } = await seedCompanyAgentIssue();
    await db.insert(agentFallbackChains).values({
      companyId: agent.companyId,
      agentId: agent.id,
      steps: [
        { adapterType: "claude_local", adapterConfig: {}, label: "primary" },
        { adapterType: "codex_local", adapterConfig: {}, label: "codex fallback" },
      ],
    });

    const first = await handleQuotaOrBillingFailureForRun(db, {
      issueId: issue.id,
      agent,
      exitInfo: QUOTA_EXIT_INFO,
      reason: "r1",
    });
    expect(first.outcome).toBe("switched");
    const [afterFirst] = await db.select().from(agents).where(eq(agents.id, agent.id));

    const second = await handleQuotaOrBillingFailureForRun(db, {
      issueId: issue.id,
      agent: afterFirst!,
      exitInfo: CODEX_QUOTA_EXIT_INFO,
      reason: "r2",
    });
    expect(second.outcome).toBe("blocked");

    const [state] = await db.select().from(agentFallbackChainState).where(eq(agentFallbackChainState.agentId, agent.id));
    expect(state!.blocked).toBe(true);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    const blockedComment = comments.find((c) => c.body.includes("exhausted"));
    expect(blockedComment).toBeDefined();
    expect(blockedComment!.body).toContain(agent.id);
    expect(blockedComment!.authorType).toBe("system");

    const switchComment = comments.find((c) => c.body.includes("Switched from"));
    expect(switchComment).toBeDefined();
  });

  it("treats a chain step marked requiresConfiguration with no adapterConfig as unusable and skips it", async () => {
    const { agent, issue } = await seedCompanyAgentIssue();
    await db.insert(agentFallbackChains).values({
      companyId: agent.companyId,
      agentId: agent.id,
      steps: [
        { adapterType: "claude_local", adapterConfig: {}, label: "primary" },
        { adapterType: "claude_local", adapterConfig: {}, label: "kimi (unconfigured)", requiresConfiguration: true },
        { adapterType: "claude_local", adapterConfig: { model: "alt" }, label: "alt account (configured)" },
      ],
    });

    const result = await handleQuotaOrBillingFailureForRun(db, {
      issueId: issue.id,
      agent,
      exitInfo: QUOTA_EXIT_INFO,
      reason: "r1",
    });

    expect(result.outcome).toBe("switched");
    if (result.outcome !== "switched") throw new Error("expected switched");
    expect(result.toStepIndex).toBe(2);
    expect(result.toStep.adapterConfig).toEqual({ model: "alt" });
  });

  it("schedules an immediate scheduled_retry run + wakeup request for the new leg", async () => {
    const { agent, issue, companyId } = await seedCompanyAgentIssue();
    const previousRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: previousRunId,
      companyId,
      agentId: agent.id,
      status: "failed",
      errorCode: "provider_quota",
      contextSnapshot: { issueId: issue.id },
    });

    const scheduledRun = await scheduleFallbackChainRetry(db, {
      issueId: issue.id,
      companyId,
      agentId: agent.id,
      previousRunId,
      toStepIndex: 1,
    });

    expect(scheduledRun.status).toBe("scheduled_retry");
    expect(scheduledRun.retryOfRunId).toBe(previousRunId);
    expect(scheduledRun.scheduledRetryReason).toBe("fallback_chain_switch");
    expect(scheduledRun.scheduledRetryAt).not.toBeNull();

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, scheduledRun.id));
    expect(wakeup).toBeDefined();
    expect(wakeup!.reason).toBe("fallback_chain_switch");
  });
});
