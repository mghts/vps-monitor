UPDATE settings
SET value = value || '{"download_url":"https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz"}'::jsonb,
    updated_at = now()
WHERE key = 'geoip'
  AND NOT (value ? 'download_url');
