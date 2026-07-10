ALTER TABLE "plugin_config" ADD COLUMN IF NOT EXISTS "company_id" uuid;

UPDATE "plugin_config"
SET "company_id" = (
  SELECT "id"
  FROM "companies"
  ORDER BY "created_at" ASC
  LIMIT 1
)
WHERE "company_id" IS NULL;

DELETE FROM "plugin_config"
WHERE "company_id" IS NULL;

ALTER TABLE "plugin_config" ALTER COLUMN "company_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'plugin_config_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "plugin_config"
      ADD CONSTRAINT "plugin_config_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_plugin_company_idx"
  ON "plugin_config" USING btree ("plugin_id", "company_id");
