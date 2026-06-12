import type { Language, ServerNode } from './types';

export function percent(used?: number, total?: number) {
  if (!used || !total) return 0;
  return used * 100 / total;
}

export function fmtPct(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '-';
  return `${value.toFixed(1)}%`;
}

export function fmtLoad(server: ServerNode) {
  const { load1, load5, load15 } = server.metrics;
  if (load1 == null) return '-';
  return [load1, load5, load15].map((value) => Number(value || 0).toFixed(2)).join(' / ');
}

export function formatBytes(value?: number) {
  const n = Math.max(0, value || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = n;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatUptime(seconds?: number, language: Language = 'zh') {
  if (!seconds) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (language === 'en') {
    return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
  }
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

export function formatLocation(location?: {
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}) {
  if (!location || (location.latitude == null && location.longitude == null && !location.country && !location.city)) {
    return '未识别';
  }
  const place = [location.country, location.region, location.city].filter(Boolean).join(' / ') || '未知地区';
  const coordinates = location.latitude != null && location.longitude != null
    ? ` (${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)})`
    : '';
  return `${place}${coordinates}`;
}

export function average(values: Array<number | undefined>) {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}
