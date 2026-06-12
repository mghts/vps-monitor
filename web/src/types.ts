export type ViewMode = 'cards' | 'list' | 'map';
export type PublicSection = 'overview' | 'servers' | 'ping' | 'map';
export type Language = 'zh' | 'en';

export type AgentCommands = {
  docker?: {
    install?: string;
    uninstall?: string;
  };
  native?: {
    install?: string;
    uninstall?: string;
  };
};

export type ServerNode = {
  id: string;
  name: string;
  online: boolean;
  public_visible: boolean;
  last_seen_at?: string | null;
  ip_masked?: string;
  ip_full?: string;
  hostname?: string;
  os_name?: string;
  kernel_version?: string;
  arch?: string;
  note?: string;
  group?: string;
  enabled?: boolean;
  ping_mode?: 'inherit_append' | 'override';
  traffic_limit_bytes?: number | null;
  traffic_direction?: 'up_down' | 'download' | 'upload';
  traffic_reset_day?: number;
  uninstall_command?: string;
  uninstall_commands?: AgentCommands;
  location: {
    source?: 'manual' | 'geoip' | null;
    country?: string;
    region?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  };
  manual_location?: {
    country?: string;
    region?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  };
  geoip_location?: {
    country?: string;
    region?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
    updated_at?: string;
  };
  metrics: {
    captured_at?: string;
    cpu_usage?: number;
    memory_total_bytes?: number;
    memory_used_bytes?: number;
    disk_total_bytes?: number;
    disk_used_bytes?: number;
    net_rx_bytes?: number;
    net_tx_bytes?: number;
    month_rx_bytes?: number;
    month_tx_bytes?: number;
    today_rx_bytes?: number;
    today_tx_bytes?: number;
    net_rx_bps?: number;
    net_tx_bps?: number;
    uptime_seconds?: number;
    load1?: number;
    load5?: number;
    load15?: number;
  };
};

export type PingTarget = {
  id: string;
  scope?: 'global' | 'server';
  server_id?: string | null;
  name: string;
  host: string;
  mode: 'icmp' | 'tcp';
  tcp_port?: number | null;
  interval_seconds?: number;
  timeout_ms?: number;
  enabled?: boolean;
};

export type PublicSummary = {
  servers: ServerNode[];
  ping_targets: PingTarget[];
  settings: {
    brand_name?: string;
    center_location_mode?: 'auto' | 'manual';
    center_latitude?: number | null;
    center_longitude?: number | null;
    center_name?: string;
    center_auto_ip?: string | null;
    center_auto_country?: string | null;
    center_auto_region?: string | null;
    center_auto_city?: string | null;
    center_auto_latitude?: number | null;
    center_auto_longitude?: number | null;
    center_auto_updated_at?: string | null;
    center_auto_status?: string | null;
    default_view?: ViewMode;
    default_language?: Language;
    default_map_mode?: '2d' | '3d';
    default_server_view?: 'table' | 'cards';
    refresh_interval_seconds?: number;
    background?: {
      enabled?: boolean;
      image_url?: string;
      fit?: 'cover' | 'contain';
      position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
      blur?: number;
      brightness?: number;
      overlay?: number;
    };
  };
};

export type MetricHistoryPoint = {
  ts: string;
  cpu_usage?: number | null;
  memory_used_bytes?: number | null;
  disk_used_bytes?: number | null;
  net_rx_bytes?: number | null;
  net_tx_bytes?: number | null;
  sample_count?: number;
};

export type AlertRule = {
  key: string;
  label: string;
  enabled: boolean;
  threshold: number;
  duration_seconds: number;
  repeat_seconds: number;
};

export type AlertRecord = {
  id: string;
  server_name: string;
  rule_label: string;
  state: string;
  severity: string;
  value?: number | null;
  message: string;
  triggered_at: string;
  resolved_at?: string | null;
  notify_error?: string | null;
};

export type Settings = {
  telegram?: { enabled?: boolean; bot_token?: string; chat_id?: string; message_template?: string };
  public?: PublicSummary['settings'];
  geoip?: {
    enabled?: boolean;
    provider?: string;
    download_url?: string;
    last_update_at?: string | null;
    last_update_status?: string | null;
  };
  alert_rules?: AlertRule[];
};

export type FleetSample = {
  timestamp: number;
  time: string;
  cpu: number;
  memory: number;
  disk: number;
  load: number;
  netRxBytes: number;
  netTxBytes: number;
};
