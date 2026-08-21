import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentFallbackChainState,
  agentFallbackChains,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
} from "@paperclipai/db";
import { agentService } from "../agents.js";
import { issueService } from "../issues.js";
import { isQuotaOrBillingFailure, type AdapterRunExitInfo } from "../quota-windows.js";
import { applyMemoryBridgeForFallbackStep } from "./fallback-chain-memory-bridge.js";

/**
 * Fleet-wide coding-agent fallback chain (COM-413).
 *
 * When a run fails with a *reactive* quota/billing signature (see
 * `isQuotaOrBillingFailure`), `evaluateFallbackChainSwitch` walks the agent's
 * configured chain to the next step, updates the agent's live
 * `adapterType`/`adapterConfig` (reusing the existing agent update + secret
 * binding sync path), and reports what happened so the caller can post a
 * notification and re-trigger the task. This module never resumes a failed
 * run in place — the caller starts a fresh run on the new adapter/credential.
 */

export type AgentRow = typeof agents.$inferSelect;

export interface FallbackChainStep {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  label?: string;
  /** Informational pointer at the `company_secret_bindings` row this step's credential comes
   *  from, if any. Not required — the credential is really carried by `adapterConfig`'s embedded
   *  `secret_ref` env bindings (see `agent-secret-bindings.ts`), same as any other agent config. */
  secretBindingId?: string | null;
  /** True for steps that are structurally defined (e.g. by the fleet default chain) but need a
   *  company or agent override to fill in a real credential before they're usable. Switching into
   *  an unconfigured step is skipped (treated as already exhausted) rather than attempted, so a
   *  placeholder leg never silently becomes the "active" adapter with no working credential. */
  requiresConfiguration?: boolean;
}

interface FallbackChainExhaustionEntry extends Record<string, unknown> {
  stepIndex: number;
  adapterType: string;
  reason: string;
  exhaustedAt: string;
  cooldownUntil: string;
}

/** Default per-step cooldown before a step could be retried again (COM-413 plan: switch, don't resume). */
export const FALLBACK_CHAIN_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Fleet-wide default chain (COM-413 plan, wiring step 6): claude_local (agent's default
 * credential) -> codex_local (agent's codex credential, if configured) -> claude_local (Kimi K3
 * coding-plan credential) -> claude_local (a second Claude-CLI-compatible account). Legs 3 and 4
 * are placeholders — they only differ from leg 1 by which secret binding is active, and there is
 * no real Kimi/second-account credential to bind by default, so they're marked
 * `requiresConfiguration` until a company (or agent-specific override row in
 * `agent_fallback_chains`) supplies real `adapterConfig.env` secret refs for them.
 */
export const DEFAULT_FALLBACK_CHAIN: readonly FallbackChainStep[] = [
  {
    adapterType: "claude_local",
    adapterConfig: {},
    label: "claude_local (primary credential)",
  },
  {
    adapterType: "codex_local",
    adapterConfig: {},
    label: "codex_local (agent's codex credential)",
  },
  {
    adapterType: "claude_local",
    adapterConfig: {},
    label: "claude_local (Kimi K3 coding-plan credential)",
    requiresConfiguration: true,
  },
  {
    adapterType: "claude_local",
    adapterConfig: {},
    label: "claude_local (secondary account credential)",
    requiresConfiguration: true,
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseFallbackChainStep(raw: unknown): FallbackChainStep | null {
  const record = asRecord(raw);
  const adapterType = asNonEmptyString(record.adapterType);
  if (!adapterType) return null;
  return {
    adapterType,
    adapterConfig: asRecord(record.adapterConfig),
    label: asNonEmptyString(record.label) ?? undefined,
    secretBindingId: asNonEmptyString(record.secretBindingId),
    requiresConfiguration: record.requiresConfiguration === true,
  };
}

function parseFallbackChainSteps(raw: unknown): FallbackChainStep[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed = raw.map(parseFallbackChainStep).filter((step): step is FallbackChainStep => step !== null);
  return parsed.length > 0 ? parsed : null;
}

/**
 * Resolve the ordered chain for an agent, most-specific-first: an
 * agent-specific row, then a company default row, then the single fleet-wide
 * default row (if a company or platform operator has configured one in the
 * DB), then finally the in-code `DEFAULT_FALLBACK_CHAIN`.
 */
export async function resolveFallbackChainSteps(db: Db, agent: Pick<AgentRow, "id" | "companyId">): Promise<readonly FallbackChainStep[]> {
  const agentRow = await db
    .select({ steps: agentFallbackChains.steps })
    .from(agentFallbackChains)
    .where(eq(agentFallbackChains.agentId, agent.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const fromAgent = agentRow ? parseFallbackChainSteps(agentRow.steps) : null;
  if (fromAgent) return fromAgent;

  const companyRow = await db
    .select({ steps: agentFallbackChains.steps })
    .from(agentFallbackChains)
    .where(and(eq(agentFallbackChains.companyId, agent.companyId), isNull(agentFallbackChains.agentId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const fromCompany = companyRow ? parseFallbackChainSteps(companyRow.steps) : null;
  if (fromCompany) return fromCompany;

  const fleetRow = await db
    .select({ steps: agentFallbackChains.steps })
    .from(agentFallbackChains)
    .where(and(isNull(agentFallbackChains.companyId), isNull(agentFallbackChains.agentId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const fromFleet = fleetRow ? parseFallbackChainSteps(fleetRow.steps) : null;
  if (fromFleet) return fromFleet;

  return DEFAULT_FALLBACK_CHAIN;
}

async function ensureFallbackChainState(db: Db, agent: Pick<AgentRow, "id" | "companyId">) {
  const existing = await db
    .select()
    .from(agentFallbackChainState)
    .where(eq(agentFallbackChainState.agentId, agent.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

  return db
    .insert(agentFallbackChainState)
    .values({
      companyId: agent.companyId,
      agentId: agent.id,
      currentStepIndex: 0,
      exhaustedSteps: [],
      blocked: false,
    })
    // Another concurrent caller may have inserted the row first; fall back to reading it.
    .onConflictDoNothing()
    .returning()
    .then(async (rows) => rows[0] ?? (await db
      .select()
      .from(agentFallbackChainState)
      .where(eq(agentFallbackChainState.agentId, agent.id))
      .limit(1)
      .then((rows2) => rows2[0]!)));
}

function isStepUsable(step: FallbackChainStep): boolean {
  if (!step.requiresConfiguration) return true;
  return Object.keys(step.adapterConfig).length > 0;
}

export type FallbackChainSwitchResult =
  | { outcome: "not_quota_failure" }
  | { outcome: "no_chain_configured" }
  | {
      outcome: "blocked";
      lastStep: FallbackChainStep;
      lastStepIndex: number;
      chainLength: number;
      reason: string;
    }
  | {
      outcome: "switched";
      fromStep: FallbackChainStep;
      fromStepIndex: number;
      toStep: FallbackChainStep;
      toStepIndex: number;
      reason: string;
    };

/**
 * Reactive quota/billing switch: classifies the failure, and if it's a
 * quota/billing failure, marks the agent's current chain step exhausted
 * (with a cooldown) and advances to the next usable step, updating the
 * agent's live adapterType/adapterConfig via the existing agent update path
 * (which also syncs secret bindings). Does not re-trigger a run or post a
 * notification — see `handleQuotaOrBillingFailureForRun` for the full flow.
 */
export async function evaluateFallbackChainSwitch(
  db: Db,
  input: {
    agent: AgentRow;
    exitInfo: AdapterRunExitInfo;
    reason: string;
    now?: Date;
  },
): Promise<FallbackChainSwitchResult> {
  if (!isQuotaOrBillingFailure(input.agent.adapterType, input.exitInfo)) {
    return { outcome: "not_quota_failure" };
  }

  const steps = await resolveFallbackChainSteps(db, input.agent);
  if (steps.length < 2) return { outcome: "no_chain_configured" };

  const state = await ensureFallbackChainState(db, input.agent);
  const now = input.now ?? new Date();
  const currentIndex = Math.min(Math.max(state.currentStepIndex, 0), steps.length - 1);
  const currentStep = steps[currentIndex]!;

  const cooldownUntil = new Date(now.getTime() + FALLBACK_CHAIN_DEFAULT_COOLDOWN_MS);
  const exhaustionEntry: FallbackChainExhaustionEntry = {
    stepIndex: currentIndex,
    adapterType: currentStep.adapterType,
    reason: input.reason,
    exhaustedAt: now.toISOString(),
    cooldownUntil: cooldownUntil.toISOString(),
  };
  const nextExhaustedSteps = [
    ...(state.exhaustedSteps as FallbackChainExhaustionEntry[]).filter((entry) => entry.stepIndex !== currentIndex),
    exhaustionEntry,
  ];

  let nextIndex = -1;
  for (let candidate = currentIndex + 1; candidate < steps.length; candidate += 1) {
    if (isStepUsable(steps[candidate]!)) {
      nextIndex = candidate;
      break;
    }
  }

  if (nextIndex === -1) {
    await db
      .update(agentFallbackChainState)
      .set({
        exhaustedSteps: nextExhaustedSteps,
        blocked: true,
        blockedAt: now,
        blockedReason: `Fallback chain exhausted after step ${currentIndex} (${currentStep.label ?? currentStep.adapterType}): ${input.reason}`,
        updatedAt: now,
      })
      .where(eq(agentFallbackChainState.agentId, input.agent.id));
    return {
      outcome: "blocked",
      lastStep: currentStep,
      lastStepIndex: currentIndex,
      chainLength: steps.length,
      reason: input.reason,
    };
  }

  const nextStep = steps[nextIndex]!;
  const bridgedAdapterConfig = await applyMemoryBridgeForFallbackStep({
    sourceAgent: input.agent,
    targetAdapterType: nextStep.adapterType,
    targetAdapterConfig: nextStep.adapterConfig,
  });

  await agentService(db).update(input.agent.id, {
    adapterType: nextStep.adapterType,
    adapterConfig: bridgedAdapterConfig,
  });

  await db
    .update(agentFallbackChainState)
    .set({
      currentStepIndex: nextIndex,
      exhaustedSteps: nextExhaustedSteps,
      blocked: false,
      blockedAt: null,
      blockedReason: null,
      lastSwitchAt: now,
      lastSwitchReason: input.reason,
      updatedAt: now,
    })
    .where(eq(agentFallbackChainState.agentId, input.agent.id));

  return {
    outcome: "switched",
    fromStep: currentStep,
    fromStepIndex: currentIndex,
    toStep: nextStep,
    toStepIndex: nextIndex,
    reason: input.reason,
  };
}

function fallbackChainStepDescription(step: FallbackChainStep): string {
  return step.label ?? step.adapterType;
}

/** Post the after-the-fact "switched from X to Y" issue comment (COM-413 step 5). */
export async function postFallbackChainSwitchComment(
  db: Db,
  input: { issueId: string; fromStep: FallbackChainStep; toStep: FallbackChainStep; reason: string; agentId: string },
) {
  const body = [
    "Paperclip switched this agent's coding-agent adapter/credential after a quota or billing " +
      "failure on the previous one.",
    "",
    `- Switched from: \`${fallbackChainStepDescription(input.fromStep)}\``,
    `- Switched to: \`${fallbackChainStepDescription(input.toStep)}\``,
    `- Reason: ${input.reason}`,
    "",
    "This task is being retried fresh on the new adapter/credential; the failed run was not resumed in place.",
  ].join("\n");
  await issueService(db).addComment(input.issueId, body, {}, { authorType: "system" });
}

/** Post the "fallback chain exhausted, human intervention needed" comment (COM-413 step 4). */
export async function postFallbackChainBlockedComment(
  db: Db,
  input: {
    issueId: string;
    agentId: string;
    lastStep: FallbackChainStep;
    lastStepIndex: number;
    chainLength: number;
    reason: string;
  },
) {
  const body = [
    "Paperclip's coding-agent fallback chain is exhausted for this agent — every configured " +
      "adapter/credential leg has hit a quota or billing failure.",
    "",
    `- Last leg tried: \`${fallbackChainStepDescription(input.lastStep)}\` (step ${input.lastStepIndex + 1} of ${input.chainLength})`,
    `- Reason: ${input.reason}`,
    "",
    `Fallback-chain owner: agent \`${input.agentId}\`. A human needs to either wait for a leg's cooldown to clear, ` +
      "provision another credential, or reconfigure this agent's fallback chain before automatic recovery can continue.",
  ].join("\n");
  await issueService(db).addComment(input.issueId, body, {}, { authorType: "system" });
}

/**
 * Re-enqueue the same issue/task on the agent's new adapter, immediately
 * (no cooldown — the new leg hasn't failed yet). Mirrors the existing
 * provider-quota scheduled-retry pattern in `recovery/service.ts`
 * (`ensureProviderQuotaWaitRecoveryMonitor`), but with `scheduledRetryAt` set
 * to now instead of a future quota-reset time, since we're not waiting on
 * this credential's quota — we already moved off it.
 */
export async function scheduleFallbackChainRetry(
  db: Db,
  input: { issueId: string; companyId: string; agentId: string; previousRunId: string | null; toStepIndex: number },
) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const wakeup = await tx
      .insert(agentWakeupRequests)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "fallback_chain_switch",
        payload: {
          issueId: input.issueId,
          retryOfRunId: input.previousRunId,
          retryReason: "fallback_chain_switch",
          fallbackChainStepIndex: input.toStepIndex,
        },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: null,
        idempotencyKey: `fallback_chain_switch:${input.issueId}:${input.previousRunId ?? "none"}:${input.toStepIndex}`,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]!);
    const scheduledRun = await tx
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        wakeupRequestId: wakeup.id,
        retryOfRunId: input.previousRunId,
        scheduledRetryAt: now,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "fallback_chain_switch",
        contextSnapshot: {
          issueId: input.issueId,
          taskId: input.issueId,
          wakeReason: "fallback_chain_switch",
          retryReason: "fallback_chain_switch",
          fallbackChainStepIndex: input.toStepIndex,
        },
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]!);
    await tx
      .update(agentWakeupRequests)
      .set({ runId: scheduledRun.id, updatedAt: now })
      .where(eq(agentWakeupRequests.id, wakeup.id));
    return scheduledRun;
  });
}

/**
 * Full reactive quota/billing switch flow for a failed run (COM-413 steps
 * 3-5): classify, switch-or-block, and notify. Does not schedule the retry
 * itself when switched — see `scheduleFallbackChainRetry`, called separately
 * by the caller once it also has the failed run id at hand.
 */
export async function handleQuotaOrBillingFailureForRun(
  db: Db,
  input: {
    issueId: string;
    agent: AgentRow;
    exitInfo: AdapterRunExitInfo;
    reason: string;
  },
): Promise<FallbackChainSwitchResult> {
  const result = await evaluateFallbackChainSwitch(db, {
    agent: input.agent,
    exitInfo: input.exitInfo,
    reason: input.reason,
  });

  if (result.outcome === "switched") {
    await postFallbackChainSwitchComment(db, {
      issueId: input.issueId,
      fromStep: result.fromStep,
      toStep: result.toStep,
      reason: result.reason,
      agentId: input.agent.id,
    });
  } else if (result.outcome === "blocked") {
    await postFallbackChainBlockedComment(db, {
      issueId: input.issueId,
      agentId: input.agent.id,
      lastStep: result.lastStep,
      lastStepIndex: result.lastStepIndex,
      chainLength: result.chainLength,
      reason: result.reason,
    });
  }

  return result;
}
