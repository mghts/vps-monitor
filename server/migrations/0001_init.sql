CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_admin_sessions_token_hash ON admin_sessions(token_hash);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions(expires_at);

CREATE TABLE servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    server_group TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    public_visible BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    agent_token_hash TEXT UNIQUE,
    token_created_at TIMESTAMPTZ,
    ping_mode TEXT NOT NULL DEFAULT 'inherit_append' CHECK (ping_mode IN ('inherit_append', 'override')),
    traffic_limit_bytes BIGINT,
    traffic_direction TEXT NOT NULL DEFAULT 'up_down' CHECK (traffic_direction IN ('up_down', 'download', 'upload')),
    traffic_reset_day INTEGER NOT NULL DEFAULT 1 CHECK (traffic_reset_day BETWEEN 1 AND 28),
    location_country TEXT,
    location_region TEXT,
    location_city TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    geoip_country TEXT,
    geoip_region TEXT,
    geoip_city TEXT,
    geoip_latitude DOUBLE PRECISION,
    geoip_longitude DOUBLE PRECISION,
    geoip_updated_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    last_public_ip TEXT,
    last_hostname TEXT,
    last_os_name TEXT,
    last_kernel_version TEXT,
    last_arch TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_servers_public ON servers(public_visible, enabled, display_order);
CREATE INDEX idx_servers_agent_token_hash ON servers(agent_token_hash);
CREATE INDEX idx_servers_last_seen_at ON servers(last_seen_at);

CREATE TABLE metric_samples (
    id BIGSERIAL PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL,
    cpu_usage DOUBLE PRECISION NOT NULL,
    memory_total_bytes BIGINT NOT NULL,
    memory_used_bytes BIGINT NOT NULL,
    disk_total_bytes BIGINT NOT NULL,
    disk_used_bytes BIGINT NOT NULL,
    net_rx_bytes BIGINT NOT NULL,
    net_tx_bytes BIGINT NOT NULL,
    uptime_seconds BIGINT NOT NULL,
    load1 DOUBLE PRECISION NOT NULL,
    load5 DOUBLE PRECISION NOT NULL,
    load15 DOUBLE PRECISION NOT NULL,
    public_ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_metric_samples_server_time ON metric_samples(server_id, captured_at DESC);

CREATE TABLE metric_rollups_1m (
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    bucket_at TIMESTAMPTZ NOT NULL,
    cpu_avg DOUBLE PRECISION NOT NULL,
    memory_used_avg_bytes BIGINT NOT NULL,
    disk_used_avg_bytes BIGINT NOT NULL,
    net_rx_last_bytes BIGINT NOT NULL,
    net_tx_last_bytes BIGINT NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (server_id, bucket_at)
);

CREATE TABLE ping_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('global', 'server')),
    server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('icmp', 'tcp')),
    tcp_port INTEGER CHECK (tcp_port BETWEEN 1 AND 65535),
    interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK (interval_seconds BETWEEN 5 AND 3600),
    timeout_ms INTEGER NOT NULL DEFAULT 1000 CHECK (timeout_ms BETWEEN 100 AND 10000),
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'global' AND server_id IS NULL) OR (scope = 'server' AND server_id IS NOT NULL))
);

CREATE INDEX idx_ping_targets_scope ON ping_targets(scope, enabled);
CREATE INDEX idx_ping_targets_server ON ping_targets(server_id, enabled);

CREATE TABLE ping_samples (
    id BIGSERIAL PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ping_target_id UUID REFERENCES ping_targets(id) ON DELETE SET NULL,
    target_name TEXT NOT NULL,
    host TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('icmp', 'tcp')),
    checked_at TIMESTAMPTZ NOT NULL,
    success BOOLEAN NOT NULL,
    latency_ms DOUBLE PRECISION,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ping_samples_series ON ping_samples(server_id, ping_target_id, checked_at DESC);
CREATE INDEX idx_ping_samples_time ON ping_samples(checked_at DESC);

CREATE TABLE ping_rollups_5m (
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ping_target_id UUID NOT NULL,
    target_name TEXT NOT NULL,
    host TEXT NOT NULL,
    mode TEXT NOT NULL,
    bucket_at TIMESTAMPTZ NOT NULL,
    avg_latency_ms DOUBLE PRECISION,
    min_latency_ms DOUBLE PRECISION,
    max_latency_ms DOUBLE PRECISION,
    success_count INTEGER NOT NULL,
    loss_count INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (server_id, ping_target_id, bucket_at)
);

CREATE TABLE ping_rollups_1h (
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ping_target_id UUID NOT NULL,
    target_name TEXT NOT NULL,
    host TEXT NOT NULL,
    mode TEXT NOT NULL,
    bucket_at TIMESTAMPTZ NOT NULL,
    avg_latency_ms DOUBLE PRECISION,
    min_latency_ms DOUBLE PRECISION,
    max_latency_ms DOUBLE PRECISION,
    success_count INTEGER NOT NULL,
    loss_count INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (server_id, ping_target_id, bucket_at)
);

CREATE TABLE server_traffic_months (
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    rx_bytes BIGINT NOT NULL DEFAULT 0,
    tx_bytes BIGINT NOT NULL DEFAULT 0,
    last_rx_counter BIGINT,
    last_tx_counter BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, period_start)
);

CREATE TABLE alert_rules (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    threshold DOUBLE PRECISION NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    repeat_seconds INTEGER NOT NULL DEFAULT 3600,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO alert_rules(key, label, enabled, threshold, duration_seconds, repeat_seconds) VALUES
('offline', '服务器离线', true, 60, 60, 1800),
('cpu_high', 'CPU 使用率过高', true, 90, 300, 1800),
('memory_high', '内存使用率过高', true, 90, 0, 1800),
('disk_high', '磁盘使用率过高', true, 85, 0, 3600),
('traffic_high', '月流量超过额度', true, 100, 0, 86400)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    rule_key TEXT NOT NULL REFERENCES alert_rules(key) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('active', 'resolved')),
    severity TEXT NOT NULL DEFAULT 'warning',
    value DOUBLE PRECISION,
    message TEXT NOT NULL,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    last_notified_at TIMESTAMPTZ,
    notify_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alerts_active ON alerts(server_id, rule_key, state);
CREATE INDEX idx_alerts_history ON alerts(triggered_at DESC);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings(key, value) VALUES
('telegram', '{"bot_token":"","chat_id":"","enabled":false}'::jsonb),
('public', '{"default_view":"cards","center_latitude":null,"center_longitude":null,"center_name":"Center","refresh_interval_seconds":5}'::jsonb),
('geoip', '{"enabled":true,"provider":"geojs","download_url":"https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz","last_update_at":null,"last_update_status":null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
