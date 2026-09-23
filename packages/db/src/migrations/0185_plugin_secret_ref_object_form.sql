-- COM-467: upgrade legacy bare-UUID plugin secret refs to the canonical
-- `{ type: "secret_ref", secretId, version }` object form.
--
-- Config saved before the object form existed stores a bare secret UUID at
-- `format: "secret-ref"` fields. The board UI round-trips that string back on
-- any unrelated edit, which the config-save route then rejected, freezing the
-- whole plugin config. The route now normalizes on write; this backfills rows
-- that have not been saved since.
--
-- Scope: top-level secret-ref properties only. Nested secret-ref paths (and
-- plugins whose manifest declares the field as a plain `type: "string"`, which
-- would reject the object form) are intentionally left alone; the write path
-- handles those shapes without rewriting them.
UPDATE plugin_config AS pc
SET config_json = pc.config_json || legacy.patch,
    updated_at = now()
FROM (
  SELECT
    cfg.plugin_id,
    cfg.company_id,
    jsonb_object_agg(
      prop.key,
      jsonb_build_object(
        'type', 'secret_ref',
        'secretId', cfg.config_json ->> prop.key,
        'version', 'latest'
      )
    ) AS patch
  FROM plugin_config AS cfg
  JOIN plugins AS p ON p.id = cfg.plugin_id
  CROSS JOIN LATERAL jsonb_each(
    COALESCE(p.manifest_json -> 'instanceConfigSchema' -> 'properties', '{}'::jsonb)
  ) AS prop(key, value)
  WHERE prop.value ->> 'format' = 'secret-ref'
    AND COALESCE(prop.value ->> 'type', '') <> 'string'
    AND jsonb_typeof(cfg.config_json -> prop.key) = 'string'
    AND (cfg.config_json ->> prop.key) ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  GROUP BY cfg.plugin_id, cfg.company_id
) AS legacy
WHERE pc.plugin_id = legacy.plugin_id
  AND pc.company_id = legacy.company_id;
