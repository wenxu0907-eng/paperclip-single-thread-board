import { sql } from "drizzle-orm";
import { jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Configured coding-agent fallback chain (COM-413). Each row is an ordered list of
 * `{ adapterType, adapterConfig, secretBindingId?, label? }` steps that
 * `agent-fallback-chain` switches through on a classified quota/billing failure.
 *
 * Scope is resolved most-specific-first:
 *  - `agentId` set: applies only to that agent.
 *  - `agentId` null, `companyId` set: default chain for every agent in that company
 *    without its own row.
 *  - both null: the single fleet-wide default chain (shared agent-runner service),
 *    used by agents whose company also has no default configured.
 */
export const agentFallbackChains = pgTable(
  "agent_fallback_chains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUq: uniqueIndex("agent_fallback_chains_agent_uq")
      .on(table.agentId)
      .where(sql`${table.agentId} is not null`),
    companyDefaultUq: uniqueIndex("agent_fallback_chains_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.companyId} is not null and ${table.agentId} is null`),
    // Constant-expression partial unique index: at most one row can ever have both
    // companyId and agentId null (the single fleet-wide default chain).
    fleetDefaultUq: uniqueIndex("agent_fallback_chains_fleet_default_uq")
      .on(sql`(true)`)
      .where(sql`${table.companyId} is null and ${table.agentId} is null`),
  }),
);
