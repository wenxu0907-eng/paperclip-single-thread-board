ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "board_only_on_parents" boolean NOT NULL DEFAULT false;
