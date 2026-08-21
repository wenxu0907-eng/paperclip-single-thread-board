import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Runtime pointer + cooldown bookkeeping for the coding-agent fallback chain
 * (COM-413). One row per agent that has ever switched (or attempted to switch)
 * fallback-chain legs. `currentStepIndex` mirrors which chain step (see
 * `agent_fallback_chains`) the agent's live `agents.adapter_type` /
 * `agents.adapter_config` were last set from.
 */
export const agentFallbackChainState = pgTable(
  "agent_fallback_chain_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    currentStepIndex: integer("current_step_index").notNull().default(0),
    // Array of { stepIndex, adapterType, reason, exhaustedAt, cooldownUntil }.
    exhaustedSteps: jsonb("exhausted_steps").$type<Record<string, unknown>[]>().notNull().default([]),
    blocked: boolean("blocked").notNull().default(false),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    lastSwitchAt: timestamp("last_switch_at", { withTimezone: true }),
    lastSwitchReason: text("last_switch_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUq: uniqueIndex("agent_fallback_chain_state_agent_uq").on(table.agentId),
    companyIdx: index("agent_fallback_chain_state_company_idx").on(table.companyId),
  }),
);
