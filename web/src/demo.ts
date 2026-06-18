import type { MetricHistoryPoint, PublicSummary, ServerNode } from './types';

const locations = [
  ['Tokyo-01', '日本', '东京', 35.6762, 139.6503],
  ['Los Angeles-02', '美国', '洛杉矶', 34.0522, -118.2437],
  ['Frankfurt-01', '德国', '法兰克福', 50.1109, 8.6821],
  ['Singapore-03', '新加坡', '新加坡', 1.3521, 103.8198],
  ['Singapore-04', '新加坡', '新加坡', 1.3521, 103.8198],
  ['Singapore-Edge', '新加坡', '新加坡', 1.3521, 103.8198],
  ['Sydney-01', '澳大利亚', '悉尼', -33.8688, 151.2093],
  ['Hong Kong-01', '中国', '香港', 22.3193, 114.1694],
  ['Dubai-01', '阿联酋', '迪拜', 25.2048, 55.2708],
  ['São Paulo-01', '巴西', '圣保罗', -23.5505, -46.6333]
] as const;

const groups = ['亚洲节点', '美洲节点', '欧洲节点', '亚洲节点', '亚洲节点', '亚洲节点', '大洋洲节点', '亚洲节点', '中东节点', '美洲节点'];

export const demoServers: ServerNode[] = locations.map(([name, country, city, latitude, longitude], index) => {
  const online = name !== 'Dubai-01';
  const memoryTotal = 8 * 1024 ** 3;
  const diskTotal = 120 * 1024 ** 3;
  return {
    id: `demo-${index + 1}`,
    name,
    online,
    is_center: name === 'Hong Kong-01',
    public_visible: true,
    enabled: true,
    last_seen_at: new Date(Date.now() - (online ? 18_000 : 2.4 * 60 * 60 * 1000)).toISOString(),
    ip_masked: `${index + 31}.${index + 84}.x.x`,
    hostname: name.toLowerCase(),
    os_name: index % 2 ? 'Debian 12' : 'Ubuntu 24.04 LTS',
    arch: 'x86_64',
    group: groups[index],
    location: {
      source: 'geoip',
      country,
      city,
      latitude,
      longitude
    },
    geoip_location: {
      country,
      city,
      latitude,
      longitude,
      updated_at: new Date(Date.now() - 8 * 60 * 1000).toISOString()
    },
    metrics: online ? {
      captured_at: new Date().toISOString(),
      cpu_usage: 18 + index * 3.2,
      memory_total_bytes: memoryTotal,
      memory_used_bytes: memoryTotal * (0.44 + index * 0.025),
      disk_total_bytes: diskTotal,
      disk_used_bytes: diskTotal * (0.37 + index * 0.03),
      net_rx_bytes: (80 + index * 12) * 1024 ** 3,
      net_tx_bytes: (28 + index * 5) * 1024 ** 3,
      month_rx_bytes: (320 + index * 52) * 1024 ** 3,
      month_tx_bytes: (110 + index * 21) * 1024 ** 3,
      today_rx_bytes: (5.6 + index * 1.1) * 1024 ** 3,
      today_tx_bytes: (1.8 + index * 0.55) * 1024 ** 3,
      net_rx_bps: (18 + index * 4.2) * 1024 ** 2,
      net_tx_bps: (5.5 + index * 1.6) * 1024 ** 2,
      uptime_seconds: (7 + index) * 86400 + 12400,
      load1: 0.22 + index * 0.08,
      load5: 0.18 + index * 0.07,
      load15: 0.16 + index * 0.06
    } : {}
  };
});

export const demoSummary: PublicSummary = {
  servers: demoServers,
  ping_targets: [
    { id: 'target-cloudflare', name: 'Cloudflare', host: '1.1.1.1', mode: 'icmp', enabled: true },
    { id: 'target-google', name: 'Google DNS', host: '8.8.8.8', mode: 'icmp', enabled: true },
    { id: 'target-tcp', name: '自定义 TCP 443', host: 'example.com', mode: 'tcp', tcp_port: 443, enabled: true }
  ],
  settings: {
    brand_name: 'Notebook Atlas',
    center_location_mode: 'auto',
    center_name: '中心节点',
    center_latitude: 22.3193,
    center_longitude: 114.1694,
    center_auto_ip: '38.91.x.x',
    center_auto_country: 'Hong Kong',
    center_auto_city: 'Hong Kong',
    center_auto_latitude: 22.3193,
    center_auto_longitude: 114.1694,
    center_auto_updated_at: new Date().toISOString(),
    center_auto_status: '中心端位置已自动更新',
    default_view: 'cards',
    default_language: 'zh',
    default_map_mode: '2d',
    default_server_view: 'table',
    refresh_interval_seconds: 3
  }
};

export function demoMetricHistory(server: ServerNode, range: string): MetricHistoryPoint[] {
  const count = range === '1h' ? 60 : range === '6h' ? 72 : range === '24h' ? 96 : range === '7d' ? 112 : 120;
  const interval = range === '1h' ? 60_000 : range === '6h' ? 5 * 60_000 : range === '24h' ? 15 * 60_000 : range === '7d' ? 90 * 60_000 : 6 * 60 * 60_000;
  const now = Date.now();
  const memoryBase = Number(server.metrics.memory_used_bytes || 0);
  const diskBase = Number(server.metrics.disk_used_bytes || 0);
  const rxBase = Number(server.metrics.net_rx_bytes || 0);
  const txBase = Number(server.metrics.net_tx_bytes || 0);
  return Array.from({ length: count }, (_, index) => {
    const progress = index / Math.max(1, count - 1);
    const wave = Math.sin(index / 7) * 5 + Math.sin(index / 17) * 2;
    return {
      ts: new Date(now - (count - 1 - index) * interval).toISOString(),
      cpu_usage: Math.max(2, Number(server.metrics.cpu_usage || 20) + wave),
      memory_used_bytes: Math.max(0, memoryBase * (0.94 + Math.sin(index / 12) * 0.045)),
      disk_used_bytes: Math.max(0, diskBase * (0.985 + progress * 0.015)),
      net_rx_bytes: Math.max(0, rxBase - (count - 1 - index) * 48 * 1024 ** 2),
      net_tx_bytes: Math.max(0, txBase - (count - 1 - index) * 17 * 1024 ** 2),
      sample_count: 30
    };
  });
}

export function demoPingPoints(range: string) {
  const count = range === '1h' ? 72 : range === '6h' ? 96 : 120;
  const now = Date.now();
  const targets = demoSummary.ping_targets;
  return targets.flatMap((target, targetIndex) =>
    Array.from({ length: count }, (_, index) => {
      const wave = Math.sin(index / (5 + targetIndex)) * (9 + targetIndex * 3)
        + Math.sin(index / 13) * 5;
      const incident = index === 36 + targetIndex * 5 ? 28 + targetIndex * 16 : 0;
      return {
        ts: new Date(now - (count - index) * 60_000).toISOString(),
        target_id: target.id,
        target_name: target.name,
        host: target.host,
        mode: target.mode,
        avg_latency_ms: 26 + targetIndex * 22 + wave + incident,
        loss_rate: incident
          ? 0.8 + targetIndex * 0.65
          : Math.max(0, Math.sin(index / (8 + targetIndex)) * 0.1)
      };
    })
  );
}
