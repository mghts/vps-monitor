UPDATE settings
SET value = jsonb_build_object(
    'center_location_mode',
    COALESCE(value->'center_location_mode', '"auto"'::jsonb)
) || value,
updated_at = now()
WHERE key = 'public';
