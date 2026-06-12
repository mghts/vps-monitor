UPDATE settings
SET value = jsonb_build_object(
    'default_language', COALESCE(value->'default_language', '"zh"'::jsonb),
    'default_map_mode', COALESCE(value->'default_map_mode', '"2d"'::jsonb),
    'default_server_view', COALESCE(value->'default_server_view', '"table"'::jsonb)
) || value,
updated_at = now()
WHERE key = 'public';
