UPDATE settings
SET value = jsonb_build_object(
    'brand_name',
    COALESCE(value->'brand_name', '"Notebook Atlas"'::jsonb)
) || value,
updated_at = now()
WHERE key = 'public';
