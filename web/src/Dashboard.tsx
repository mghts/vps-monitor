import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CardsThree,
  ChartLine,
  Cpu,
  Crosshair,
  DownloadSimple,
  Funnel,
  GlobeHemisphereWest,
  HardDrive,
  Info,
  ListBullets,
  MagnifyingGlass,
  MapTrifold,
  Memory,
  Network,
  Pulse,
  Rows,
  SlidersHorizontal,
  UploadSimple
} from '@phosphor-icons/react';
import { divIcon, type Map as LeafletMap } from 'leaflet';
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip as LeafletTooltip } from 'react-leaflet';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis
} from 'recharts';
import { api } from './api';
import { demoMetricHistory, demoPingPoints } from './demo';
import { average, fmtLoad, fmtPct, formatBytes, formatUptime, percent } from './format';
import { SelectDrawer } from './SelectDrawer';
import type { GlobeMapHandle, GlobeNode } from './GlobeMap';
import { useI18n } from './i18n';
import type { FleetSample, MetricHistoryPoint, PublicSection, PublicSummary, ServerNode } from './types';

const ranges = [
  ['1h', '1H'],
  ['6h', '6H'],
  ['24h', '24H'],
  ['7d', '7D'],
  ['30d', '30D'],
  ['180d', '6M'],
  ['365d', '1Y']
] as const;

const GlobeMap = lazy(() => import('./GlobeMap'));
const pingColors = ['#8ddad2', '#b8d792', '#c6a7df', '#e0ba72', '#e3948c', '#8fb9dd', '#d69eca', '#91c7a5'];
const pingColorsLight = ['#4ea3a1', '#74ad82', '#9b7fca', '#d79a4d', '#d97974', '#6b9fd8', '#bb79a8', '#6fa583'];
const worldShifts = [-360, 0, 360];

type Coordinate = [number, number];
type LocationClusterStatus = 'online' | 'offline' | 'mixed';
type LocationCluster = {
  key: string;
  latitude: number;
  longitude: number;
  servers: ServerNode[];
  onlineCount: number;
  status: LocationClusterStatus;
};
type MapCenter = {
  latitude: number;
  longitude: number;
  name: string;
  city?: string;
  region?: string;
  country?: string;
  ipMasked?: string;
};
type PingPoint = {
  ts: string;
  target_id?: string | null;
  target_name?: string | null;
  host?: string | null;
  mode?: string | null;
  avg_latency_ms?: number | null;
  loss_rate?: number | null;
};

function greatCircleArc(start: Coordinate, end: Coordinate, steps = 72): Coordinate[] {
  const toVector = ([latitude, longitude]: Coordinate) => {
    const lat = latitude * Math.PI / 180;
    const lon = longitude * Math.PI / 180;
    return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)] as const;
  };
  const a = toVector(start);
  const b = toVector(end);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  const sinAngle = Math.sin(angle);
  const points: Coordinate[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const aWeight = sinAngle < 0.0001 ? 1 - t : Math.sin((1 - t) * angle) / sinAngle;
    const bWeight = sinAngle < 0.0001 ? t : Math.sin(t * angle) / sinAngle;
    const x = a[0] * aWeight + b[0] * bWeight;
    const y = a[1] * aWeight + b[1] * bWeight;
    const z = a[2] * aWeight + b[2] * bWeight;
    points.push([
      Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI,
      Math.atan2(z, x) * 180 / Math.PI
    ]);
  }
  return points.reduce<Coordinate[]>((unwrapped, point) => {
    const previous = unwrapped[unwrapped.length - 1];
    let longitude = point[1];
    if (previous) {
      while (longitude - previous[1] > 180) longitude -= 360;
      while (longitude - previous[1] < -180) longitude += 360;
    }
    unwrapped.push([point[0], longitude]);
    return unwrapped;
  }, []);
}

function arcPointAt(arc: Coordinate[], ratio: number): Coordinate {
  const index = Math.max(0, Math.min(arc.length - 1, Math.round((arc.length - 1) * ratio)));
  return arc[index] || arc[0] || [0, 0];
}

function normalizeLongitude(longitude: number) {
  let next = longitude;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

function locationClusterKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(3)}:${normalizeLongitude(longitude).toFixed(3)}`;
}

function serverIsCenter(server: ServerNode) {
  return Boolean(server.is_center);
}

function clusterIsCenter(cluster: LocationCluster) {
  return cluster.servers.some(serverIsCenter);
}

function centerLocationText(center: MapCenter, fallback: string) {
  return [center.city, center.region, center.country].filter(Boolean).join(' · ') || fallback;
}

function locationClusters(servers: ServerNode[]): LocationCluster[] {
  const groups = new Map<string, Array<{ server: ServerNode; latitude: number; longitude: number; order: number }>>();
  servers.forEach((server, order) => {
    const latitude = Number(server.location.latitude);
    const longitude = Number(server.location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const key = locationClusterKey(latitude, longitude);
    const group = groups.get(key) || [];
    group.push({ server, latitude, longitude, order });
    groups.set(key, group);
  });

  return [...groups.entries()].flatMap(([clusterKey, group]) => {
    const ordered = group.sort((a, b) => a.order - b.order);
    const latitude = ordered.reduce((sum, item) => sum + item.latitude, 0) / ordered.length;
    const longitude = ordered.reduce((sum, item) => sum + item.longitude, 0) / ordered.length;
    const servers = ordered.map((item) => item.server);
    const onlineCount = servers.filter((server) => server.online).length;
    const status: LocationClusterStatus = onlineCount === servers.length
      ? 'online'
      : onlineCount === 0
        ? 'offline'
        : 'mixed';
    return [{
      key: clusterKey,
      latitude,
      longitude,
      servers,
      onlineCount,
      status
    }];
  });
}

function clusterColor(status: LocationClusterStatus, theme: 'dark' | 'light') {
  if (status === 'offline') return theme === 'light' ? '#d97974' : '#e58b83';
  if (status === 'mixed') return theme === 'light' ? '#d79a4d' : '#e0ba72';
  return theme === 'light' ? '#74ad82' : '#9ec989';
}

function clusterLineColor(status: LocationClusterStatus, theme: 'dark' | 'light') {
  if (status === 'offline') return theme === 'light' ? '#d97974' : '#e58b83';
  if (status === 'mixed') return theme === 'light' ? '#d79a4d' : '#e0ba72';
  return theme === 'light' ? '#6aa8a5' : '#8ddad2';
}

function clusterLabel(cluster: LocationCluster, t: (source: string, variables?: Record<string, string | number>) => string) {
  const first = cluster.servers[0];
  const place = first ? serverLocationText(first, t, t('未知位置')) : t('未知位置');
  return cluster.servers.length > 1
    ? `${place} · ${cluster.servers.length} ${t('台节点')}`
    : first?.name || place;
}

function uptimeBlocks(server: ServerNode) {
  const total = 24;
  const lastSeenTime = server.last_seen_at ? new Date(server.last_seen_at).getTime() : NaN;
  const offlineHours = server.online
    ? 0
    : Math.min(total, Math.max(1, Number.isFinite(lastSeenTime) ? Math.ceil((Date.now() - lastSeenTime) / 3_600_000) : 1));
  const uptimeHours = Math.min(total - offlineHours, Math.max(0, Math.ceil(Number(server.metrics.uptime_seconds || 0) / 3600)));
  return Array.from({ length: total }, (_, index) => {
    if (index >= total - offlineHours) return 'down';
    return index >= total - offlineHours - uptimeHours ? 'up' : 'unknown';
  });
}

type Props = {
  summary: PublicSummary;
  section: PublicSection;
  history: FleetSample[];
  search: string;
  demo: boolean;
  theme: 'dark' | 'light';
  refreshIntervalSeconds: number;
  selectedServerId: string | null;
  onSelectServer: (serverId: string) => void;
  onCloseServer: () => void;
  onRefresh: () => void;
};

export default function Dashboard({
  summary,
  section,
  history,
  search,
  demo,
  theme,
  refreshIntervalSeconds,
  selectedServerId,
  onSelectServer,
  onCloseServer,
  onRefresh
}: Props) {
  const { language, t } = useI18n();
  const selectedServer = summary.servers.find((server) => server.id === selectedServerId);
  if (selectedServer) {
    return <ServerDetail server={selectedServer} summary={summary} demo={demo} theme={theme} onBack={onCloseServer} />;
  }
  if (section === 'servers') {
    return (
      <PageSection title={t('节点簿')}>
        <ServerRoster
          servers={summary.servers}
          search={search}
          defaultView={summary.settings.default_server_view}
          refreshIntervalSeconds={refreshIntervalSeconds}
          onSelectServer={onSelectServer}
          expanded
        />
      </PageSection>
    );
  }
  if (section === 'ping') {
    return (
      <PageSection title={t('延迟线')}>
        <PingPanel summary={summary} demo={demo} theme={theme} expanded />
      </PageSection>
    );
  }
  if (section === 'map') {
    return (
      <PageSection title={t('节点地图')}>
        <WorldMapPanel summary={summary} theme={theme} onSelectServer={onSelectServer} expanded />
      </PageSection>
    );
  }

  return (
    <div className="dashboard-stack">
      <div className="dashboard-primary">
        <WorldMapPanel summary={summary} theme={theme} onSelectServer={onSelectServer} />
        <FleetHealth summary={summary} history={history} refreshIntervalSeconds={refreshIntervalSeconds} />
      </div>
      <div className="dashboard-secondary">
        <ServerRoster
          servers={summary.servers}
          search={search}
          defaultView={summary.settings.default_server_view}
          refreshIntervalSeconds={refreshIntervalSeconds}
          onSelectServer={onSelectServer}
        />
        <PingPanel summary={summary} demo={demo} theme={theme} />
      </div>
      <button className="refresh-fab" onClick={onRefresh} aria-label={t('立即刷新')} title={t('立即刷新')}>
        <ArrowsClockwise size={19} />
      </button>
    </div>
  );
}

function PageSection({ children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="page-section section-no-heading">
      {children}
    </div>
  );
}

function WorldMapPanel({
  summary,
  theme,
  onSelectServer,
  expanded = false
}: {
  summary: PublicSummary;
  theme: 'dark' | 'light';
  onSelectServer: (serverId: string) => void;
  expanded?: boolean;
}) {
  const { language, t } = useI18n();
  const mapRef = useRef<LeafletMap | null>(null);
  const globeRef = useRef<GlobeMapHandle | null>(null);
  const [mode, setMode] = useState<'2d' | '3d'>(() => {
    const saved = window.localStorage.getItem('vps-monitor-map-mode');
    if (saved === '2d' || saved === '3d') return saved;
    return summary.settings.default_map_mode === '3d' ? '3d' : '2d';
  });
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [query, setQuery] = useState('');
  const points = useMemo(
    () => summary.servers
      .filter((server) => server.location.latitude != null && server.location.longitude != null)
      .filter((server) => filter === 'all' || (filter === 'online' ? server.online : !server.online))
      .filter((server) => !query || `${server.name} ${server.location.city || ''} ${server.location.country || ''} ${serverLocationText(server, t)}`.toLowerCase().includes(query.toLowerCase())),
    [filter, language, query, summary.servers]
  );
  const center: MapCenter | null = summary.settings.center_latitude != null && summary.settings.center_longitude != null
    ? {
        latitude: Number(summary.settings.center_latitude),
        longitude: Number(summary.settings.center_longitude),
        name: summary.settings.center_name ? t(summary.settings.center_name) : t('中心节点'),
        city: localizedText(summary.settings.center_auto_city, t),
        region: localizedText(summary.settings.center_auto_region, t),
        country: localizedText(summary.settings.center_auto_country, t),
        ipMasked: summary.settings.center_auto_ip || undefined
      }
    : null;
  const mapCenter: [number, number] = center
    ? [center.latitude, center.longitude]
    : [Number(points[0]?.location.latitude ?? 22), Number(points[0]?.location.longitude ?? 104)];
  const clusters = useMemo(() => locationClusters(points), [points]);
  const centerCluster = center ? clusters.find(clusterIsCenter) : undefined;
  const globeNodes: GlobeNode[] = useMemo(() => clusters.map((cluster) => {
    const first = cluster.servers[0];
    const isCenter = Boolean(center && clusterIsCenter(cluster));
    return {
      id: cluster.key,
      name: clusterLabel(cluster, t),
      online: cluster.status !== 'offline',
      status: cluster.status,
      isCenter,
      latitude: cluster.latitude,
      longitude: cluster.longitude,
      city: localizedText(first?.location.city, t),
      region: localizedText(first?.location.region, t),
      country: localizedText(first?.location.country, t),
      ipMasked: first?.ip_masked,
      members: cluster.servers.map((server) => ({
        id: server.id,
        name: server.name,
        online: server.online,
        city: localizedText(server.location.city, t),
        region: localizedText(server.location.region, t),
        country: localizedText(server.location.country, t),
        ipMasked: server.ip_masked,
        isCenter: Boolean(center && serverIsCenter(server))
      }))
    };
  }), [
    language,
    clusters,
    center?.latitude,
    center?.longitude,
    center?.name,
    center?.city,
    center?.region,
    center?.country,
    center?.ipMasked
  ]);
  const offlineBreakIcon = useMemo(() => divIcon({
    className: 'map-offline-break-marker',
    html: '<span><i></i><i></i></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  }), []);

  function resetMap() {
    if (mode === '2d') {
      mapRef.current?.flyTo(mapCenter, expanded ? 4 : 3, { duration: 0.8 });
    } else {
      globeRef.current?.resetView();
    }
  }

  function changeMode(next: '2d' | '3d') {
    setMode(next);
    window.localStorage.setItem('vps-monitor-map-mode', next);
  }

  return (
    <section className={`surface map-surface ${expanded ? 'expanded' : ''}`}>
      <div className="surface-header map-header">
        {!expanded && <div><h2>{t('节点地图')}</h2></div>}
        <div className="map-toolbar">
          <div className="segmented compact">
            <button className={mode === '2d' ? 'active' : ''} onClick={() => changeMode('2d')}>
              <MapTrifold size={15} /> 2D
            </button>
            <button className={mode === '3d' ? 'active' : ''} onClick={() => changeMode('3d')}>
              <GlobeHemisphereWest size={15} /> 3D
            </button>
          </div>
          <SelectDrawer
            className="map-status-select"
            value={filter}
            ariaLabel={t('节点状态筛选')}
            onChange={(next) => setFilter(next as typeof filter)}
            options={[
              { value: 'all', label: t('全部节点') },
              { value: 'online', label: t('在线') },
              { value: 'offline', label: t('异常') }
            ]}
          />
          <label className="map-search">
            <MagnifyingGlass size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索地区')} />
          </label>
        </div>
      </div>
      <div className="map-frame">
        {mode === '2d' ? (
          <MapContainer
            ref={mapRef}
            center={mapCenter}
            zoom={expanded ? 3 : 2}
            minZoom={2}
            attributionControl={false}
            maxBounds={[[-85, -360], [85, 360]]}
            maxBoundsViscosity={1}
            worldCopyJump={false}
            scrollWheelZoom
            className="map"
          >
            <TileLayer
              attribution="Tiles &copy; Esri"
              detectRetina
              url={`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${theme === 'light' ? 'World_Light_Gray_Base' : 'World_Dark_Gray_Base'}/MapServer/tile/{z}/{y}/{x}`}
            />
            <TileLayer
              attribution="Tiles &copy; Esri"
              detectRetina
              url={`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${theme === 'light' ? 'World_Light_Gray_Reference' : 'World_Dark_Gray_Reference'}/MapServer/tile/{z}/{y}/{x}`}
            />
            {center && worldShifts.map((shift) => (
              <Fragment key={`center-${shift}`}>
                <CircleMarker
                  center={[center.latitude, center.longitude + shift]}
                  radius={18}
                  interactive={false}
                  pathOptions={{ color: theme === 'light' ? '#4ea3a1' : '#7dc9c2', fillColor: theme === 'light' ? '#4ea3a1' : '#7dc9c2', fillOpacity: 0.08, opacity: 0.54, weight: 1.8 }}
                />
                {!centerCluster && (
                  <CircleMarker
                    center={[center.latitude, center.longitude + shift]}
                    radius={10}
                    className="map-center-node"
                    pathOptions={{ color: theme === 'light' ? '#fffdf6' : '#efe6d2', fillColor: theme === 'light' ? '#4ea3a1' : '#7dc9c2', fillOpacity: 1, weight: 4 }}
                  >
                    <LeafletTooltip className="map-node-tooltip map-cluster-tooltip" direction="top" offset={[0, -12]} opacity={1}>
                      <b>{center.name}</b>
                      <span>{centerLocationText(center, t('未知位置'))}</span>
                      <span className="cluster-node-line center-node-line">
                        <i className="center" />
                        {t('中心节点')} · {center.ipMasked || t('IP 待上报')}
                      </span>
                    </LeafletTooltip>
                  </CircleMarker>
                )}
              </Fragment>
            ))}
            {clusters.flatMap((cluster) => worldShifts.map((shift) => {
              const primary = cluster.servers[0];
              const position: [number, number] = [
                cluster.latitude,
                cluster.longitude + shift
              ];
              const location = primary ? serverLocationText(primary, t, t('未知位置')) : t('未知位置');
              const fillColor = clusterColor(cluster.status, theme);
              return (
                <Fragment key={`cluster-node-${cluster.key}-${shift}`}>
                  {cluster.servers.length > 1 && (
                    <CircleMarker
                      center={position}
                      radius={Math.min(20, 11 + cluster.servers.length * 1.15)}
                      interactive={false}
                      pathOptions={{
                        color: fillColor,
                        fillColor,
                        fillOpacity: 0.055,
                        opacity: 0.36,
                        weight: 1.15,
                        dashArray: '4 7'
                      }}
                    />
                  )}
                  <CircleMarker
                    center={position}
                    radius={cluster.servers.length > 1 ? Math.min(11, 7 + cluster.servers.length * 0.75) : 6}
                    eventHandlers={cluster.servers.length === 1 ? { click: () => onSelectServer(cluster.servers[0].id) } : undefined}
                    pathOptions={{
                      color: theme === 'light' ? '#fffdf6' : '#211f1a',
                      fillColor,
                      fillOpacity: 1,
                      weight: cluster.servers.length > 1 ? 2.8 : 2
                    }}
                  >
                    <LeafletTooltip className="map-node-tooltip map-cluster-tooltip" direction="top" offset={[0, -12]} opacity={1}>
                      <b>{clusterLabel(cluster, t)}</b>
                      <span>{location}</span>
                      {cluster.servers.map((server) => (
                        <span className="cluster-node-line" key={server.id}>
                          <i className={server.online ? 'online' : 'offline'} />
                          {server.name}{center && serverIsCenter(server) ? ` ${t('（中心节点）')}` : ''} · {server.online ? t('在线') : t('离线')} · {server.ip_masked || t('IP 待上报')}
                        </span>
                      ))}
                    </LeafletTooltip>
                    <Popup className="map-cluster-popup">
                      {cluster.servers.length === 1 ? (
                        <>
                          <b>{cluster.servers[0].name}{center && serverIsCenter(cluster.servers[0]) ? ` ${t('（中心节点）')}` : ''}</b><br />
                          {serverLocationLabel(cluster.servers[0], t, t('未知位置'))}<br />
                          {cluster.servers[0].online ? t('在线') : t('离线')}
                        </>
                      ) : (
                        <div className="map-cluster-picker">
                          <b>{clusterLabel(cluster, t)}</b>
                          <span>{t('选择要查看的节点')}</span>
                          {cluster.servers.map((server) => (
                            <button key={server.id} onClick={() => onSelectServer(server.id)}>
                              <i className={server.online ? 'online' : 'offline'} />
                              <span>{server.name}{center && serverIsCenter(server) ? ` ${t('（中心节点）')}` : ''}</span>
                              <small>{server.ip_masked || t('IP 待上报')}</small>
                            </button>
                          ))}
                        </div>
                      )}
                    </Popup>
                  </CircleMarker>
                </Fragment>
              );
            }))}
            {center && clusters.filter((cluster) => cluster.status !== 'offline').map((cluster, index) => {
              const arc = greatCircleArc(
                [center.latitude, center.longitude],
                [cluster.latitude, cluster.longitude]
              );
              const color = clusterLineColor(cluster.status, theme);
              return worldShifts.map((shift) => {
                const shiftedArc = arc.map(([latitude, longitude]) => [latitude, longitude + shift] as Coordinate);
                return (
                <Fragment key={`line-${cluster.key}-${shift}`}>
                  <Polyline
                    interactive={false}
                    positions={shiftedArc}
                    pathOptions={{ color, weight: cluster.servers.length > 1 ? 4.4 : 5, opacity: 0.07, lineCap: 'round', lineJoin: 'round' }}
                  />
                  <Polyline
                    interactive={false}
                    positions={shiftedArc}
                    pathOptions={{ color, weight: cluster.servers.length > 1 ? 1.15 : 1.25, opacity: cluster.status === 'mixed' ? 0.72 : 0.62, lineCap: 'round', lineJoin: 'round' }}
                  />
                  <Polyline
                    interactive={false}
                    className={`map-flow-line flow-${index % 4}`}
                    positions={shiftedArc}
                    pathOptions={{
                      color,
                      weight: 2,
                      opacity: 0.9,
                      dashArray: '1 14',
                      lineCap: 'round',
                      lineJoin: 'round'
                    }}
                  />
                </Fragment>
                );
              });
            })}
            {center && clusters.filter((cluster) => cluster.status === 'offline').map((cluster) => {
              const arc = greatCircleArc(
                [center.latitude, center.longitude],
                [cluster.latitude, cluster.longitude]
              );
              const color = clusterLineColor(cluster.status, theme);
              return worldShifts.map((shift) => {
                const shiftedArc = arc.map(([latitude, longitude]) => [latitude, longitude + shift] as Coordinate);
                const crossPoints = [0.36, 0.58, 0.8].map((ratio) => {
                  const [latitude, longitude] = arcPointAt(shiftedArc, ratio);
                  return [latitude, longitude] as [number, number];
                });
                return (
                  <Fragment key={`offline-line-${cluster.key}-${shift}`}>
                    <Polyline
                      interactive={false}
                      positions={shiftedArc}
                      pathOptions={{ color, weight: cluster.servers.length > 1 ? 4 : 4.4, opacity: 0.09, lineCap: 'round', lineJoin: 'round' }}
                    />
                    <Polyline
                      interactive={false}
                      className="map-offline-link"
                      positions={shiftedArc}
                      pathOptions={{
                        color,
                        weight: 1.6,
                        opacity: 0.78,
                        dashArray: '8 10',
                        lineCap: 'round',
                        lineJoin: 'round'
                      }}
                    />
                    {crossPoints.map((position, breakIndex) => (
                      <Marker
                        key={`offline-break-${cluster.key}-${shift}-${breakIndex}`}
                        position={position}
                        icon={offlineBreakIcon}
                        interactive={false}
                        zIndexOffset={350}
                      />
                    ))}
                  </Fragment>
                );
              });
            })}
          </MapContainer>
        ) : (
          <Suspense fallback={<div className="map-empty">{t('正在加载三维地球')}</div>}>
            <GlobeMap ref={globeRef} nodes={globeNodes} center={center} theme={theme} onSelectNode={onSelectServer} />
          </Suspense>
        )}
        {mode === '2d' && (
          <div className="map-attribution" aria-label={t('地图数据来源')}>
            © <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a>
          </div>
        )}
        <button className="map-reset-button" onClick={resetMap} title={t('复位到中心节点')}>
          <Crosshair size={16} />
          <span>{t('中心节点')}</span>
        </button>
        {!points.length && !center && mode === '2d' && (
          <div className="map-empty">
            <MapTrifold size={28} />
            <span>{t('暂无可显示的节点坐标')}</span>
          </div>
        )}
        <div className="map-legend">
          <span><i className="legend-node online" /> {t('在线')}</span>
          <span><i className="legend-node offline" /> {t('离线')}</span>
          {clusters.some((cluster) => cluster.status === 'mixed') && <span><i className="legend-node mixed" /> {t('部分异常')}</span>}
          {center && points.some((server) => !server.online) && <span><i className="legend-break" /> {t('异常连接')}</span>}
          {center && <span><i className="legend-node center" /> {center.name}</span>}
        </div>
      </div>
    </section>
  );
}

function FleetHealth({
  summary,
  history,
  refreshIntervalSeconds
}: {
  summary: PublicSummary;
  history: FleetSample[];
  refreshIntervalSeconds: number;
}) {
  const { t } = useI18n();
  const servers = summary.servers;
  const online = servers.filter((server) => server.online);
  const onlineRate = servers.length ? online.length / servers.length * 100 : 0;
  const offlineRate = Math.max(0, 100 - onlineRate);
  const ringData = servers.length
    ? [
        { name: 'online', value: onlineRate, color: '#74ad82' },
        { name: 'offline', value: offlineRate, color: '#d97974' }
      ].filter((item) => item.value > 0)
    : [{ name: 'empty', value: 100, color: 'var(--surface-3)' }];
  const metrics = [
    { key: 'cpu', label: t('CPU 使用率'), value: average(online.map((server) => server.metrics.cpu_usage)), color: '#4ea3a1' },
    { key: 'memory', label: t('内存使用率'), value: average(online.map((server) => percent(server.metrics.memory_used_bytes, server.metrics.memory_total_bytes))), color: '#6b9fd8' },
    { key: 'disk', label: t('磁盘使用率'), value: average(online.map((server) => percent(server.metrics.disk_used_bytes, server.metrics.disk_total_bytes))), color: '#74ad82' },
    { key: 'load', label: t('平均负载'), value: average(online.map((server) => server.metrics.load1)), color: '#d79a4d', raw: true }
  ] as const;
  const networkHistory = history.slice(1).map((sample, index) => {
    const previous = history[index];
    const elapsed = Math.max(1, (sample.timestamp - previous.timestamp) / 1000);
    return {
      time: sample.time,
      rx: Math.max(0, (sample.netRxBytes - previous.netRxBytes) / elapsed),
      tx: Math.max(0, (sample.netTxBytes - previous.netTxBytes) / elapsed)
    };
  });
  const latestNetwork = networkHistory[networkHistory.length - 1] || { rx: 0, tx: 0 };
  return (
    <section className="surface health-surface">
      <div className="surface-header">
        <div>
          <h2>{t('节点概况')}</h2>
        </div>
        <span className="live-label"><Pulse size={15} /> LIVE</span>
      </div>
      <div className="health-overview">
        <div className="health-ring">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={ringData}
                dataKey="value"
                startAngle={90}
                endAngle={-270}
                innerRadius="70%"
                outerRadius="90%"
                paddingAngle={ringData.length > 1 ? 2 : 0}
                stroke="none"
                isAnimationActive={false}
              >
                {ringData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="health-ring-label">
            <b style={{ color: onlineRate > 0 ? 'var(--green)' : 'var(--red)' }}>{onlineRate.toFixed(1)}%</b>
            <span>{t('在线比例')}</span>
          </div>
        </div>
        <div className="health-copy">
          <span>{t('在线节点')}</span>
          <b>{online.length} / {servers.length}</b>
          <small>{servers.length ? t('每 {seconds} 秒刷新一次状态', { seconds: refreshIntervalSeconds }) : t('等待 Agent 接入')}</small>
        </div>
      </div>
      <div className="metric-sparks">
        {metrics.map((metric) => (
          <div className="metric-spark" key={metric.key}>
            <div className="metric-spark-head">
              <span>{metric.label}</span>
              <b style={{ color: metric.color }}>
                {'raw' in metric && metric.raw ? metric.value.toFixed(2) : `${metric.value.toFixed(1)}%`}
              </b>
            </div>
            <ResponsiveContainer width="100%" height={68}>
              <AreaChart data={history}>
                <Area
                  type="monotone"
                  dataKey={metric.key}
                  stroke={metric.color}
                  fill={metric.color}
                  fillOpacity={0.08}
                  strokeWidth={1.7}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
      <div className="health-telemetry">
        <div className="health-mini-chart network">
          <div className="health-mini-chart-head">
            <div>
              <span>{t('网络速率')}</span>
              <b>{formatBytes(latestNetwork.rx)}/s <i>↓</i> · {formatBytes(latestNetwork.tx)}/s <i>↑</i></b>
            </div>
            <Network size={17} />
          </div>
          <ResponsiveContainer width="100%" height={72}>
            <AreaChart data={networkHistory}>
              <ChartTooltip
                content={<NetworkTooltip />}
                cursor={{ stroke: '#b9ac97', strokeDasharray: '3 4' }}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 900, pointerEvents: 'none' }}
              />
              <Area type="monotone" dataKey="rx" name={t('下载速率')} stroke="#4ea3a1" fill="#4ea3a1" fillOpacity={0.1} strokeWidth={1.8} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="tx" name={t('上传速率')} stroke="#a98bd4" fill="#a98bd4" fillOpacity={0.07} strokeWidth={1.8} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function ServerRoster({
  servers,
  search,
  defaultView,
  refreshIntervalSeconds,
  onSelectServer,
  expanded = false
}: {
  servers: ServerNode[];
  search: string;
  defaultView?: 'table' | 'cards';
  refreshIntervalSeconds: number;
  onSelectServer: (serverId: string) => void;
  expanded?: boolean;
}) {
  const { language, t } = useI18n();
  const [view, setView] = useState<'table' | 'cards'>(() => {
    const saved = window.localStorage.getItem('vps-monitor-server-view');
    if (saved === 'table' || saved === 'cards') return saved;
    return defaultView === 'cards' ? 'cards' : 'table';
  });
  const [status, setStatus] = useState<'all' | 'online' | 'offline'>('all');
  const [groupFilter, setGroupFilter] = useState(() => window.localStorage.getItem('vps-monitor-group-filter') || 'all');
  const [showGroupNames, setShowGroupNames] = useState(() => window.localStorage.getItem('vps-monitor-show-group-names') !== '0');
  const groupOptions = useMemo(() => serverGroupOptions(servers, t), [language, servers]);
  useEffect(() => {
    if (groupFilter !== 'all' && !groupOptions.some((group) => group.key === groupFilter)) {
      setGroupFilter('all');
      window.localStorage.setItem('vps-monitor-group-filter', 'all');
    }
  }, [groupFilter, groupOptions]);
  const filtered = servers
    .map((server, index) => ({ server, index }))
    .filter(({ server }) => {
      const haystack = `${server.name} ${server.group || ''} ${server.ip_masked || ''} ${server.location.city || ''} ${server.location.country || ''} ${serverGroupLabel(server, t)} ${serverLocationText(server, t)}`;
      const matchesSearch = !search || haystack.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = status === 'all' || (status === 'online' ? server.online : !server.online);
      const matchesGroup = groupFilter === 'all' || serverGroupKey(server) === groupFilter;
      return matchesSearch && matchesStatus && matchesGroup;
    })
    .sort((a, b) => {
      if (a.server.online !== b.server.online) return a.server.online ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ server }) => server);
  const renderGrouped = groupFilter === 'all' && showGroupNames;
  const groupedServers = renderGrouped ? groupServersForRoster(filtered, t) : [];
  const renderServerRow = (server: ServerNode) => (
    <tr key={server.id} className="clickable-row" onClick={() => onSelectServer(server.id)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onSelectServer(server.id)}>
      <td>
        <div className="node-name">
          <b>{server.name}</b>
          <span>{server.ip_masked || t('IP 待上报')}</span>
        </div>
      </td>
      <td><StatusBadge online={server.online} /></td>
      <td><MetricCell value={server.metrics.cpu_usage} /></td>
      <td><MetricCell value={percent(server.metrics.memory_used_bytes, server.metrics.memory_total_bytes)} /></td>
      <td><MetricCell value={percent(server.metrics.disk_used_bytes, server.metrics.disk_total_bytes)} /></td>
      <td>
        <TrafficPair upload={server.metrics.net_tx_bytes} download={server.metrics.net_rx_bytes} />
      </td>
      <td><TrafficPair upload={server.metrics.today_tx_bytes} download={server.metrics.today_rx_bytes} /></td>
      <td><TrafficPair upload={server.metrics.net_tx_bps} download={server.metrics.net_rx_bps} rate /></td>
      <td>{fmtLoad(server)}</td>
      <td>{serverLocationLabel(server, t, '-')}</td>
      <td><UptimeTimeline server={server} language={language} /></td>
    </tr>
  );
  return (
    <section className={`surface roster-surface view-${view} ${expanded ? 'expanded' : ''}`}>
      {!expanded && (
        <div className="surface-header roster-header">
          <div><h2>{t('节点清单')}</h2></div>
        </div>
      )}
      <div className="roster-toolbar">
        <SelectDrawer
          className="roster-filter-select roster-group-select"
          icon={<Rows size={15} />}
          value={groupFilter}
          onChange={(next) => {
            setGroupFilter(next);
            window.localStorage.setItem('vps-monitor-group-filter', next);
          }}
          options={[
            { value: 'all', label: t('全部分组') },
            ...groupOptions.map((group) => ({ value: group.key, label: `${group.label} (${group.count})` }))
          ]}
        />
        {groupFilter === 'all' && (
          <label className="roster-check">
            <input
              type="checkbox"
              checked={showGroupNames}
              onChange={(event) => {
                setShowGroupNames(event.target.checked);
                window.localStorage.setItem('vps-monitor-show-group-names', event.target.checked ? '1' : '0');
              }}
            />
            <span>{t('显示分组名')}</span>
          </label>
        )}
        <SelectDrawer
          className="roster-filter-select roster-status-select"
          icon={<Funnel size={15} />}
          value={status}
          onChange={(next) => setStatus(next as typeof status)}
          options={[
            { value: 'all', label: t('全部状态') },
            { value: 'online', label: t('在线') },
            { value: 'offline', label: t('离线') }
          ]}
        />
        <p className="roster-refresh-summary">
          {t('显示 {count} / {total} 台', { count: filtered.length, total: servers.length })} · {t('每 {seconds} 秒动态刷新', { seconds: refreshIntervalSeconds })}
        </p>
        <div className="segmented icon-only">
          <button className={view === 'table' ? 'active' : ''} onClick={() => { setView('table'); window.localStorage.setItem('vps-monitor-server-view', 'table'); }} title={t('列表视图')}>
            <ListBullets size={17} />
          </button>
          <button className={view === 'cards' ? 'active' : ''} onClick={() => { setView('cards'); window.localStorage.setItem('vps-monitor-server-view', 'cards'); }} title={t('卡片视图')}>
            <CardsThree size={17} />
          </button>
        </div>
      </div>
      {!filtered.length ? (
        <EmptyState icon={<Rows size={28} />} title={t('没有符合条件的服务器')} />
      ) : view === 'table' ? (
        <div className="table-scroll">
          <table className="node-table">
            <thead>
              <tr>
                <th>{t('名称')}</th>
                <th>{t('状态')}</th>
                <th>CPU</th>
                <th>{t('内存')}</th>
                <th>{t('磁盘')}</th>
                <th>
                  <span className="table-heading-note" title={t('Agent 上报的网卡累计计数，通常从系统启动或网卡计数器重置开始。')}>
                    {t('网络累计')}
                  </span>
                </th>
                <th>{t('今日流量')}</th>
                <th>{t('网络速率')}</th>
                <th>{t('负载')}</th>
                <th>{t('位置')}</th>
                <th>{t('在线时长')}</th>
              </tr>
            </thead>
            <tbody>
              {renderGrouped
                ? groupedServers.map((group) => (
                  <Fragment key={group.key}>
                    <tr className="node-group-row">
                      <td colSpan={11}>
                        <span>{group.label}</span>
                        <b>{group.onlineCount} / {group.servers.length} {t('在线')}</b>
                      </td>
                    </tr>
                    {group.servers.map(renderServerRow)}
                  </Fragment>
                ))
                : filtered.map(renderServerRow)}
            </tbody>
          </table>
        </div>
      ) : renderGrouped ? (
        <div className="node-card-groups">
          {groupedServers.map((group) => (
            <section className="node-card-group" key={group.key}>
              <div className="node-group-title">
                <span>{group.label}</span>
                <b>{group.onlineCount} / {group.servers.length} {t('在线')}</b>
              </div>
              <div className="node-card-grid">
                {group.servers.map((server) => <NodeCard key={server.id} server={server} onSelect={() => onSelectServer(server.id)} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="node-card-grid standalone">
          {filtered.map((server) => <NodeCard key={server.id} server={server} onSelect={() => onSelectServer(server.id)} />)}
        </div>
      )}
    </section>
  );
}

function groupServersForRoster(servers: ServerNode[], t: (source: string, variables?: Record<string, string | number>) => string) {
  const groups = new Map<string, { key: string; label: string; servers: ServerNode[]; onlineCount: number; firstIndex: number }>();
  servers.forEach((server, index) => {
    const label = serverGroupLabel(server, t);
    const key = serverGroupKey(server);
    if (!groups.has(key)) {
      groups.set(key, { key, label, servers: [], onlineCount: 0, firstIndex: index });
    }
    const group = groups.get(key)!;
    group.servers.push(server);
    if (server.online) group.onlineCount += 1;
  });
  return [...groups.values()].sort((a, b) => {
    if (Boolean(a.onlineCount) !== Boolean(b.onlineCount)) return a.onlineCount ? -1 : 1;
    return a.firstIndex - b.firstIndex;
  });
}

function serverGroupOptions(servers: ServerNode[], t: (source: string, variables?: Record<string, string | number>) => string) {
  const groups = new Map<string, { key: string; label: string; count: number; firstIndex: number }>();
  servers.forEach((server, index) => {
    const key = serverGroupKey(server);
    if (!groups.has(key)) {
      groups.set(key, { key, label: serverGroupLabel(server, t), count: 0, firstIndex: index });
    }
    groups.get(key)!.count += 1;
  });
  return [...groups.values()].sort((a, b) => a.firstIndex - b.firstIndex);
}

function serverGroupKey(server: ServerNode) {
  return server.group?.trim().toLowerCase() || '__ungrouped__';
}

function serverGroupLabel(server: ServerNode, t: (source: string, variables?: Record<string, string | number>) => string) {
  return localizedText(server.group, t) || t('未分组');
}

function localizedText(value: string | null | undefined, t: (source: string, variables?: Record<string, string | number>) => string) {
  const text = value?.trim();
  return text ? t(text) : '';
}

function serverLocationLabel(
  server: ServerNode,
  t: (source: string, variables?: Record<string, string | number>) => string,
  fallback: string
) {
  return localizedText(server.location.city, t) || localizedText(server.location.country, t) || fallback;
}

function serverLocationText(
  server: ServerNode,
  t: (source: string, variables?: Record<string, string | number>) => string,
  fallback = ''
) {
  return [
    localizedText(server.location.city, t),
    localizedText(server.location.region, t),
    localizedText(server.location.country, t)
  ].filter(Boolean).join(' · ') || fallback;
}

function TrafficPair({ upload, download, rate = false }: { upload?: number; download?: number; rate?: boolean }) {
  const suffix = rate ? '/s' : '';
  return (
    <div className={`network-cell ${rate ? 'rate' : ''}`}>
      <span className="upload">↑ {formatBytes(upload)}{suffix}</span>
      <span className="download">↓ {formatBytes(download)}{suffix}</span>
    </div>
  );
}

function UptimeTimeline({ server, language, compact = false }: { server: ServerNode; language: 'zh' | 'en'; compact?: boolean }) {
  const { t } = useI18n();
  const blocks = uptimeBlocks(server);
  const label = formatUptime(server.metrics.uptime_seconds, language);
  return (
    <div className={`uptime-cell ${compact ? 'compact' : ''}`}>
      <span className="uptime-text">{label}</span>
      <div className="uptime-timeline" aria-label={t('近 24 小时在线覆盖')} title={t('近 24 小时在线覆盖')}>
        {blocks.map((state, index) => (
          <i
            key={`${server.id}-${index}`}
            className={state}
            title={`${index + 1}h · ${state === 'up' ? t('在线') : state === 'down' ? t('离线') : t('未知')}`}
          />
        ))}
      </div>
    </div>
  );
}

function NodeCard({ server, onSelect }: { server: ServerNode; onSelect: () => void }) {
  const { language, t } = useI18n();
  const locationLabel = serverLocationLabel(server, t, '') || server.os_name || t('等待上报');
  return (
    <button className="node-card" onClick={onSelect}>
      <div className="node-card-head">
        <div>
          <b>{server.name}</b>
          <span>{locationLabel || server.os_name || t('等待上报')}</span>
        </div>
        <StatusBadge online={server.online} />
      </div>
      <div className="node-card-metrics">
        <MetricCell label="CPU" value={server.metrics.cpu_usage} />
        <MetricCell label={t('内存')} value={percent(server.metrics.memory_used_bytes, server.metrics.memory_total_bytes)} />
        <MetricCell label={t('磁盘')} value={percent(server.metrics.disk_used_bytes, server.metrics.disk_total_bytes)} />
      </div>
      <div className="node-card-network">
        <div>
          <span>{t('今日流量')}</span>
          <TrafficPair upload={server.metrics.today_tx_bytes} download={server.metrics.today_rx_bytes} />
        </div>
        <div>
          <span>{t('网络速率')}</span>
          <TrafficPair upload={server.metrics.net_tx_bps} download={server.metrics.net_rx_bps} rate />
        </div>
      </div>
      <UptimeTimeline server={server} language={language} compact />
      <div className="node-card-foot">
        <span>{server.ip_masked || '-'}</span>
        <span>{serverLocationLabel(server, t, t('未知位置'))}</span>
      </div>
    </button>
  );
}

function ServerDetail({
  server,
  summary,
  demo,
  theme,
  onBack
}: {
  server: ServerNode;
  summary: PublicSummary;
  demo: boolean;
  theme: 'dark' | 'light';
  onBack: () => void;
}) {
  const { language, t } = useI18n();
  const [range, setRange] = useState('24h');
  const [points, setPoints] = useState<MetricHistoryPoint[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (demo) {
      setPoints(demoMetricHistory(server, range));
      return;
    }
    api<{ points: MetricHistoryPoint[] }>(`/api/public/servers/${server.id}/history?range=${range}`)
      .then((data) => {
        setPoints(data.points);
        setError('');
      })
      .catch((reason) => setError(reason.message));
  }, [demo, range, server]);

  const chartData = useMemo(() => points.map((point, index) => {
    const previous = points[index - 1];
    const elapsed = previous
      ? Math.max(1, (new Date(point.ts).getTime() - new Date(previous.ts).getTime()) / 1000)
      : 1;
    return {
      time: point.ts,
      cpu: Number(point.cpu_usage || 0),
      memory: percent(Number(point.memory_used_bytes || 0), server.metrics.memory_total_bytes),
      disk: percent(Number(point.disk_used_bytes || 0), server.metrics.disk_total_bytes),
      rx: previous ? Math.max(0, (Number(point.net_rx_bytes || 0) - Number(previous.net_rx_bytes || 0)) / elapsed) : 0,
      tx: previous ? Math.max(0, (Number(point.net_tx_bytes || 0) - Number(previous.net_tx_bytes || 0)) / elapsed) : 0
    };
  }), [language, points, range, server.metrics.disk_total_bytes, server.metrics.memory_total_bytes]);

  const resourceCards = [
    { label: 'CPU', value: fmtPct(server.metrics.cpu_usage), icon: <Cpu size={19} />, tone: 'cyan' },
    { label: t('内存'), value: fmtPct(percent(server.metrics.memory_used_bytes, server.metrics.memory_total_bytes)), icon: <Memory size={19} />, tone: 'green' },
    { label: t('磁盘'), value: fmtPct(percent(server.metrics.disk_used_bytes, server.metrics.disk_total_bytes)), icon: <HardDrive size={19} />, tone: 'amber' },
    { label: t('平均负载'), value: fmtLoad(server), icon: <ChartLine size={19} />, tone: 'violet' }
  ];
  const detailRanges = [['1h', '1H'], ['6h', '6H'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D']] as const;

  return (
    <div className="page-section server-detail-page">
      <div className="page-heading server-detail-heading">
        <div>
          <button className="detail-back" onClick={onBack}><ArrowLeft size={17} />{t('返回服务器列表')}</button>
          <div className="detail-title-row">
            <h1>{server.name}</h1>
            <StatusBadge online={server.online} />
          </div>
          <p>{serverLocationLabel(server, t, t('未知位置'))} · {server.ip_masked || t('IP 待上报')}</p>
        </div>
        <div className="range-tabs detail-ranges">
          {detailRanges.map(([value, label]) => (
            <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="detail-stat-grid">
        {resourceCards.map((item) => (
          <section className={`surface detail-stat ${item.tone}`} key={item.label}>
            <div>{item.icon}<span>{item.label}</span></div>
            <b>{item.value}</b>
          </section>
        ))}
      </div>

      {error && <div className="inline-error">{error}</div>}
      <div className="detail-chart-grid">
        <section className="surface detail-chart-card">
          <div className="surface-header"><div><h2>{t('资源趋势')}</h2><p>CPU · {t('内存')} · {t('磁盘')}</p></div><ChartLine size={21} /></div>
          {chartData.length ? (
            <div className="detail-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 12, right: 12, bottom: 2, left: -12 }}>
                  <CartesianGrid vertical={false} stroke={theme === 'light' ? '#e2d5c2' : '#3c352b'} strokeDasharray="3 7" />
                  <XAxis dataKey="time" tick={{ fill: theme === 'light' ? '#8b7e69' : '#b2a58f', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={42} tickFormatter={(value) => formatDetailAxisTime(String(value), range, language)} />
                  <YAxis domain={[0, 100]} tick={{ fill: theme === 'light' ? '#8b7e69' : '#b2a58f', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} />
                  <ChartTooltip content={<DetailResourceTooltip />} cursor={{ stroke: theme === 'light' ? '#b9ac97' : '#5f5242', strokeDasharray: '3 4' }} />
                  <Line type="monotone" dataKey="cpu" name="CPU" stroke="#4ea3a1" strokeWidth={2.1} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="memory" name={t('内存')} stroke="#74ad82" strokeWidth={2.1} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="disk" name={t('磁盘')} stroke="#d79a4d" strokeWidth={2.1} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState icon={<ChartLine size={28} />} title={t('暂无历史指标')} detail={t('Agent 上报并完成分钟聚合后，这里会显示资源曲线。')} />}
        </section>

        <section className="surface detail-chart-card">
          <div className="surface-header"><div><h2>{t('网络速率')}</h2><p>{t('下载速率')} · {t('上传速率')}</p></div><Network size={21} /></div>
          {chartData.length ? (
            <div className="detail-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 12, right: 12, bottom: 2, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={theme === 'light' ? '#e2d5c2' : '#3c352b'} strokeDasharray="3 7" />
                  <XAxis dataKey="time" tick={{ fill: theme === 'light' ? '#8b7e69' : '#b2a58f', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={42} tickFormatter={(value) => formatDetailAxisTime(String(value), range, language)} />
                  <YAxis tick={{ fill: theme === 'light' ? '#8b7e69' : '#b2a58f', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => formatBytes(value)} />
                  <ChartTooltip content={<DetailNetworkTooltip />} cursor={{ stroke: theme === 'light' ? '#b9ac97' : '#5f5242', strokeDasharray: '3 4' }} />
                  <Line type="monotone" dataKey="rx" name={t('下载速率')} stroke="#4ea3a1" strokeWidth={2.1} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="tx" name={t('上传速率')} stroke="#a98bd4" strokeWidth={2.1} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState icon={<Network size={28} />} title={t('暂无历史指标')} detail={t('Agent 上报并完成分钟聚合后，这里会显示资源曲线。')} />}
        </section>
      </div>

      <div className="detail-info-grid">
        <section className="surface detail-info-card">
          <div className="surface-header"><div><h2>{t('系统信息')}</h2><p>{server.os_name || t('等待上报')}</p></div><Info size={21} /></div>
          <dl>
            <div><dt>{t('主机名')}</dt><dd>{server.hostname || '-'}</dd></div>
            <div><dt>{t('操作系统')}</dt><dd>{server.os_name || '-'}</dd></div>
            <div><dt>{t('内核版本')}</dt><dd>{server.kernel_version || '-'}</dd></div>
            <div><dt>{t('架构')}</dt><dd>{server.arch || '-'}</dd></div>
            <div><dt>{t('在线时长')}</dt><dd>{formatUptime(server.metrics.uptime_seconds, language)}</dd></div>
            <div><dt>{t('最近采样')}</dt><dd>{server.metrics.captured_at ? new Date(server.metrics.captured_at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : '-'}</dd></div>
          </dl>
        </section>
        <section className="surface detail-info-card traffic-detail-card">
          <div className="surface-header"><div><h2>{t('本月流量')}</h2><p>{t('网络累计')}</p></div><Network size={21} /></div>
          <div className="traffic-detail-values">
            <div><DownloadSimple size={21} /><span>{t('月度下载')}</span><b>{formatBytes(server.metrics.month_rx_bytes)}</b></div>
            <div><UploadSimple size={21} /><span>{t('月度上传')}</span><b>{formatBytes(server.metrics.month_tx_bytes)}</b></div>
          </div>
        </section>
      </div>

      <PingPanel summary={summary} demo={demo} theme={theme} initialServerId={server.id} compact />
    </div>
  );
}

function MetricCell({ value, label }: { value?: number | null; label?: string }) {
  const normalized = Math.max(0, Math.min(100, value || 0));
  const tone = normalized >= 90 ? 'critical' : normalized >= 75 ? 'warning' : 'normal';
  return (
    <div className={`metric-cell ${tone}`}>
      {label && <span>{label}</span>}
      <b>{fmtPct(value)}</b>
      <div className="metric-track"><i style={{ width: `${normalized}%` }} /></div>
    </div>
  );
}

function StatusBadge({ online }: { online: boolean }) {
  const { t } = useI18n();
  return <span className={`status-badge ${online ? 'online' : 'offline'}`}><i />{online ? t('在线') : t('离线')}</span>;
}

function PingPanel({
  summary,
  demo,
  theme,
  initialServerId,
  expanded = false,
  compact = false
}: {
  summary: PublicSummary;
  demo: boolean;
  theme: 'dark' | 'light';
  initialServerId?: string;
  expanded?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const firstServer = initialServerId || summary.servers[0]?.id || '';
  const [serverId, setServerId] = useState(firstServer);
  const [targetId, setTargetId] = useState('');
  const [range, setRange] = useState('1h');
  const [displayMode, setDisplayMode] = useState<'latency' | 'loss' | 'both'>('latency');
  const [points, setPoints] = useState<PingPoint[]>([]);
  const [error, setError] = useState('');
  const [legendExpanded, setLegendExpanded] = useState(false);
  const [legendOverflow, setLegendOverflow] = useState(false);
  const legendTargetsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!serverId && firstServer) setServerId(firstServer);
  }, [firstServer, serverId]);

  useEffect(() => {
    if (!serverId) {
      setPoints([]);
      return;
    }
    if (demo) {
      setPoints(demoPingPoints(range).filter((point) => !targetId || point.target_id === targetId));
      return;
    }
    const params = new URLSearchParams({ server_id: serverId, range });
    if (targetId) params.set('target_id', targetId);
    api<{ points: PingPoint[] }>(`/api/public/ping-series?${params}`)
      .then((data) => {
        setPoints(data.points);
        setError('');
      })
      .catch((reason) => setError(reason.message));
  }, [demo, range, serverId, targetId]);

  useEffect(() => {
    setLegendExpanded(false);
  }, [serverId, targetId]);

  const availableTargets = summary.ping_targets.filter((target) => !target.server_id || target.server_id === serverId);
  const series = useMemo(() => {
    const found = new Map<string, { key: string; name: string; host?: string | null; mode?: string | null }>();
    points.forEach((point) => {
      const key = point.target_id || `${point.target_name || '未知目标'}:${point.host || ''}:${point.mode || ''}`;
      if (!found.has(key)) {
        found.set(key, {
          key,
          name: point.target_name || availableTargets.find((target) => target.id === point.target_id)?.name || 'Ping 目标',
          host: point.host,
          mode: point.mode
        });
      }
    });
    const palette = theme === 'light' ? pingColorsLight : pingColors;
    return [...found.values()].map((item, index) => ({ ...item, color: palette[index % palette.length] }));
  }, [availableTargets, points, theme]);
  const chartPoints = useMemo(() => {
    const buckets = new Map<number, Record<string, string | number | null>>();
    points.forEach((point) => {
      const timestamp = new Date(point.ts).getTime();
      const bucket = Math.round(timestamp / 5000) * 5000;
      const row = buckets.get(bucket) || {
        ts: bucket,
        time: range === '1h' || range === '6h'
          ? new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : new Date(bucket).toLocaleDateString([], { month: '2-digit', day: '2-digit' })
      };
      const key = point.target_id || `${point.target_name || '未知目标'}:${point.host || ''}:${point.mode || ''}`;
      row[`latency:${key}`] = point.avg_latency_ms == null ? null : Number(point.avg_latency_ms);
      row[`loss:${key}`] = point.loss_rate == null ? null : Number(point.loss_rate);
      buckets.set(bucket, row);
    });
    return [...buckets.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  }, [points, range]);
  const latencyAverage = average(points
    .filter((point) => point.avg_latency_ms != null)
    .map((point) => Number(point.avg_latency_ms)));
  const lossAverage = average(points
    .filter((point) => point.loss_rate != null)
    .map((point) => Number(point.loss_rate)));

  useEffect(() => {
    const element = legendTargetsRef.current;
    if (!element || legendExpanded) return;
    const updateOverflow = () => setLegendOverflow(element.scrollHeight > element.clientHeight + 1);
    const frame = window.requestAnimationFrame(updateOverflow);
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [legendExpanded, series]);

  const selectorControls = (
    <div className="ping-selectors">
      <label>
        <span>{t('服务器选择')}</span>
        <SelectDrawer
          className="ping-select-drawer"
          value={serverId}
          onChange={setServerId}
          options={summary.servers.map((server) => ({ value: server.id, label: server.name }))}
        />
      </label>
      <label>
        <span>{t('目标选择')}</span>
        <SelectDrawer
          className="ping-select-drawer"
          value={targetId}
          onChange={setTargetId}
          options={[
            { value: '', label: t('全部目标') },
            ...availableTargets.map((target) => ({ value: target.id, label: target.name }))
          ]}
        />
      </label>
    </div>
  );
  return (
    <section className={`surface ping-surface ${expanded ? 'expanded' : ''} ${compact ? 'detail-compact' : ''}`}>
      {!expanded && !compact ? (
        <div className="surface-header ping-header">
          <div><h2>{t('延迟记录')}</h2></div>
          {selectorControls}
        </div>
      ) : !expanded ? (
        <div className="surface-header ping-header">
          {selectorControls}
        </div>
      ) : null}
      <div className={`ping-meta ${expanded ? 'expanded-controls' : ''}`}>
        <div><span>{t('平均延迟')}</span><b>{points.length ? `${latencyAverage.toFixed(1)} ms` : '--'}</b></div>
        <div><span>{t('平均丢包')}</span><b className={lossAverage > 1 ? 'text-bad' : ''}>{points.length ? `${lossAverage.toFixed(2)}%` : '--'}</b></div>
        <div className="segmented ping-mode" aria-label={t('Ping 图表显示内容')}>
          <button className={displayMode === 'latency' ? 'active' : ''} onClick={() => setDisplayMode('latency')}>{t('延迟')}</button>
          <button className={displayMode === 'loss' ? 'active' : ''} onClick={() => setDisplayMode('loss')}>{t('丢包')}</button>
          <button className={displayMode === 'both' ? 'active' : ''} onClick={() => setDisplayMode('both')}>{t('延迟 + 丢包')}</button>
        </div>
        {expanded && selectorControls}
        <div className="range-tabs">
          {ranges.map(([value, label]) => (
            <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>
          ))}
        </div>
      </div>
      {!!series.length && (
        <div className="ping-series-legend">
          <div className="ping-legend-target-zone">
            <div ref={legendTargetsRef} className={`ping-target-legends ${legendExpanded ? 'expanded' : ''}`}>
              {series.map((item) => (
                <span className="ping-target-legend" key={item.key} title={[item.name, item.host, item.mode?.toUpperCase()].filter(Boolean).join(' · ')}>
                  <i style={{ background: item.color }} />
                  <span className="ping-target-name">{item.name}</span>
                </span>
              ))}
            </div>
            {(legendOverflow || legendExpanded) && (
              <button
                className="ping-legend-toggle"
                type="button"
                aria-expanded={legendExpanded}
                onClick={() => setLegendExpanded((value) => !value)}
              >
                {legendExpanded ? t('收起目标') : t('更多目标')}
                {legendExpanded ? <CaretUp size={13} /> : <CaretDown size={13} />}
              </button>
            )}
          </div>
          <div className="ping-measure-legends">
            {(displayMode === 'latency' || displayMode === 'both') && <span><i className="solid" /> {t('延迟 ms')}</span>}
            {(displayMode === 'loss' || displayMode === 'both') && <span><i className="dashed" /> {t('丢包率 %')}</span>}
          </div>
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
      {!summary.servers.length ? (
        <EmptyState icon={<Pulse size={28} />} title={t('还没有 Ping 数据')} />
      ) : (
        <div className="ping-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartPoints} margin={{ top: 12, right: 8, bottom: 4, left: -12 }}>
              <CartesianGrid
                vertical={false}
                stroke={theme === 'light' ? '#e2d5c2' : '#3c352b'}
                strokeDasharray="3 7"
              />
              <XAxis dataKey="time" tick={{ fill: theme === 'light' ? '#8b7e69' : '#b2a58f', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={52} />
              {(displayMode === 'latency' || displayMode === 'both') && (
                <YAxis yAxisId="latency" tick={{ fill: theme === 'light' ? '#4ea3a1' : '#8ddad2', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}`} />
              )}
              {(displayMode === 'loss' || displayMode === 'both') && (
                <YAxis yAxisId="loss" orientation="right" tick={{ fill: theme === 'light' ? '#d97974' : '#e58b83', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} />
              )}
              <ChartTooltip content={<PingTooltip />} cursor={{ stroke: theme === 'light' ? '#b9ac97' : '#5f5242', strokeDasharray: '3 4' }} />
              {series.map((item) => (
                (displayMode === 'latency' || displayMode === 'both') && (
                  <Line
                    key={`latency:${item.key}`}
                    yAxisId="latency"
                    type="monotone"
                    dataKey={`latency:${item.key}`}
                    name={`${item.name} · 延迟`}
                    stroke={item.color}
                    dot={false}
                    activeDot={{ r: 4, fill: theme === 'light' ? '#fffdf6' : '#211f1a', stroke: item.color, strokeWidth: 2 }}
                    strokeWidth={2.1}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    connectNulls
                    isAnimationActive={false}
                  />
                )
              ))}
              {series.map((item) => (
                (displayMode === 'loss' || displayMode === 'both') && (
                  <Line
                    key={`loss:${item.key}`}
                    yAxisId="loss"
                    type="monotone"
                    dataKey={`loss:${item.key}`}
                    name={`${item.name} · 丢包率`}
                    stroke={item.color}
                    strokeDasharray="5 5"
                    dot={false}
                    activeDot={{ r: 3, fill: theme === 'light' ? '#fffdf6' : '#211f1a', stroke: item.color, strokeWidth: 2 }}
                    strokeWidth={1.7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    connectNulls
                    isAnimationActive={false}
                  />
                )
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function PingTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>{label}</span>
      {payload.map((item: any) => (
        <b key={item.dataKey} style={{ color: item.color }}>
          <span>{item.name}</span>
          {String(item.dataKey).startsWith('latency:')
            ? `${Number(item.value).toFixed(1)} ms`
            : `${Number(item.value).toFixed(2)}%`}
        </b>
      ))}
    </div>
  );
}

function DetailResourceTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip compact">
      {payload.map((item: any) => (
        <b key={item.dataKey} style={{ color: item.color }}>
          <span>{item.name}</span>
          {`${Number(item.value || 0).toFixed(1)}%`}
        </b>
      ))}
    </div>
  );
}

function DetailNetworkTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip compact network-rate-tooltip">
      {payload.map((item: any) => (
        <b key={item.dataKey} style={{ color: item.color }}>
          <span>{item.name}</span>
          {`${formatBytes(Number(item.value || 0))}/s`}
        </b>
      ))}
    </div>
  );
}

function NetworkTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip compact network-rate-tooltip">
      {payload.map((item: any) => (
        <b key={item.dataKey} style={{ color: item.color }}>
          <span>{item.name}</span>
          {`${formatBytes(Number(item.value || 0))}/s`}
        </b>
      ))}
    </div>
  );
}

function formatDetailAxisTime(value: string, range: string, language: 'zh' | 'en') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const locale = language === 'en' ? 'en-US' : 'zh-CN';
  if (range === '1h' || range === '6h' || range === '24h') {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (range === '7d') {
    return date.toLocaleDateString(locale, { weekday: 'short' });
  }
  return date.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' });
}

function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <b>{title}</b>
      {detail && <span>{detail}</span>}
    </div>
  );
}
