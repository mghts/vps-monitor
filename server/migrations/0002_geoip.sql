ALTER TABLE servers ADD COLUMN IF NOT EXISTS geoip_country TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS geoip_region TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS geoip_city TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS geoip_latitude DOUBLE PRECISION;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS geoip_longitude DOUBLE PRECISION;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS geoip_updated_at TIMESTAMPTZ;

INSERT INTO settings(key, value) VALUES
('geoip', '{"enabled":true,"provider":"geojs","download_url":"https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz","last_update_at":null,"last_update_status":null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
