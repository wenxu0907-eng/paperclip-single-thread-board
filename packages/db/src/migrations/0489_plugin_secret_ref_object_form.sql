-- paperclip:migration-compat online_compatible: The previous release accepts both the bare-UUID and the object form of a secret-ref field, so rewriting these values changes nothing it depends on, and any row it writes after this runs is normalized by the config-save route on that row's next save. plugin_config holds one small row per (plugin, company) and the UPDATE is keyed on that pair, so only a handful of row locks are held, for the length of one short statement.
-- COM-467: upgrade legacy bare-UUID plugin secret refs to the canonical
-- `{ type: "secret_ref", secretId, version }` object form.
--
-- Config saved before the object form existed stores a bare secret UUID at
-- `format: "secret-ref"` fields. The board UI round-trips that string back on
-- any unrelated edit, which the config-save route then rejected, freezing the
-- whole plugin config. The route now normalizes on write; this backfills rows
-- that have not been saved since.
--
-- Scope: top-level secret-ref properties only, and only where the manifest does
-- not declare the field as a plain `type: "string"`. Nested paths and string-
-- typed fields are intentionally left to the write path, which normalizes them
-- on the next save. (Ported from fork migration 0185 and renumbered for the
-- upstream base, where 0488 is the previous entry. The string-typed carve-out
-- is now conservative rather than required: upstream's config validator
-- substitutes a binding with its secret id before validating, so the object
-- form no longer fails a string-typed field.)
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
