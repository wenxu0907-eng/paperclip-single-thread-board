CREATE TABLE IF NOT EXISTS "agent_fallback_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"agent_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_fallback_chain_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"exhausted_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"last_switch_at" timestamp with time zone,
	"last_switch_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_fallback_chains_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_fallback_chains" ADD CONSTRAINT "agent_fallback_chains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_fallback_chains_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_fallback_chains" ADD CONSTRAINT "agent_fallback_chains_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_fallback_chain_state_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_fallback_chain_state" ADD CONSTRAINT "agent_fallback_chain_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_fallback_chain_state_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_fallback_chain_state" ADD CONSTRAINT "agent_fallback_chain_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallback_chains_agent_uq" ON "agent_fallback_chains" USING btree ("agent_id") WHERE "agent_fallback_chains"."agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallback_chains_company_default_uq" ON "agent_fallback_chains" USING btree ("company_id") WHERE "agent_fallback_chains"."company_id" is not null and "agent_fallback_chains"."agent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallback_chains_fleet_default_uq" ON "agent_fallback_chains" USING btree ((true)) WHERE "agent_fallback_chains"."company_id" is null and "agent_fallback_chains"."agent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallback_chain_state_agent_uq" ON "agent_fallback_chain_state" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_fallback_chain_state_company_idx" ON "agent_fallback_chain_state" USING btree ("company_id");
