ALTER TABLE servers ADD COLUMN IF NOT EXISTS server_group TEXT NOT NULL DEFAULT '';

UPDATE settings
SET value = jsonb_build_object(
    'refresh_interval_seconds', COALESCE(value->'refresh_interval_seconds', '5'::jsonb)
) || value,
updated_at = now()
WHERE key = 'public';
