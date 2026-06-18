import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  ChartLineUp,
  Translate,
  Gear,
  GlobeHemisphereWest,
  HardDrives,
  List,
  MapPin,
  MagnifyingGlass,
  Moon,
  Pulse,
  ShieldCheck,
  SidebarSimple,
  Sun,
  X
} from '@phosphor-icons/react';
import AdminPanel from './AdminPanel';
import { api } from './api';
import Dashboard from './Dashboard';
import { demoSummary } from './demo';
import { average, percent } from './format';
import { I18nProvider, translate } from './i18n';
import type { FleetSample, Language, PublicSection, PublicSummary } from './types';

const navigation = [
  { id: 'overview', label: '观测台', icon: Pulse },
  { id: 'servers', label: '节点簿', icon: HardDrives },
  { id: 'ping', label: '延迟线', icon: ChartLineUp },
  { id: 'map', label: '节点地图', icon: GlobeHemisphereWest }
] as const;

type AppRoute = {
  section: PublicSection;
  selectedServerId: string | null;
  adminOpen: boolean;
};

type HistoryMode = 'push' | 'replace';

const publicSections = new Set<PublicSection>(['overview', 'servers', 'ping', 'map']);

function isPublicSection(value: string | null): value is PublicSection {
  return Boolean(value && publicSections.has(value as PublicSection));
}

function hasRouteState() {
  const params = new URLSearchParams(window.location.search);
  return params.has('view') || params.has('server') || params.has('admin');
}

function routeFromLocation(): AppRoute {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get('view');
  const section = rawView === 'list'
    ? 'servers'
    : isPublicSection(rawView)
      ? rawView
      : 'overview';
  const adminOpen = params.get('admin') === '1';
  const selectedServerId = adminOpen ? null : params.get('server');
  return {
    section,
    selectedServerId: selectedServerId || null,
    adminOpen
  };
}

function routeUrl(route: AppRoute) {
  const url = new URL(window.location.href);
  url.searchParams.delete('view');
  url.searchParams.delete('server');
  url.searchParams.delete('admin');
  if (route.adminOpen) {
    url.searchParams.set('admin', '1');
  } else {
    url.searchParams.set('view', route.section);
    if (route.selectedServerId) url.searchParams.set('server', route.selectedServerId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function sampleFromSummary(summary: PublicSummary, time = new Date(), phase = 0): FleetSample {
  const online = summary.servers.filter((server) => server.online);
  const cpu = average(online.map((server) => server.metrics.cpu_usage));
  const memory = average(online.map((server) => percent(server.metrics.memory_used_bytes, server.metrics.memory_total_bytes)));
  const disk = average(online.map((server) => percent(server.metrics.disk_used_bytes, server.metrics.disk_total_bytes)));
  const load = average(online.map((server) => server.metrics.load1));
  const netRxBytes = summary.servers.reduce((sum, server) => sum + Number(server.metrics.net_rx_bytes || 0), 0);
  const netTxBytes = summary.servers.reduce((sum, server) => sum + Number(server.metrics.net_tx_bytes || 0), 0);
  return {
    timestamp: time.getTime(),
    time: time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu: Math.max(0, cpu + Math.sin(phase / 3) * 3.5),
    memory: Math.max(0, memory + Math.sin(phase / 5) * 2.1),
    disk: Math.max(0, disk + Math.sin(phase / 11) * 0.6),
    load: Math.max(0, load + Math.sin(phase / 4) * 0.12),
    netRxBytes: netRxBytes + phase * 8_400_000 + Math.sin(phase / 3) * 8_000_000,
    netTxBytes: netTxBytes + phase * 3_100_000 + Math.sin(phase / 4) * 3_600_000
  };
}

function initialDemoHistory(summary: PublicSummary) {
  return Array.from({ length: 32 }, (_, index) =>
    sampleFromSummary(summary, new Date(Date.now() - (31 - index) * 5_000), index)
  );
}

function refreshSecondsFromSummary(summary: PublicSummary | null) {
  const configured = Number(summary?.settings.refresh_interval_seconds ?? 5);
  if (!Number.isFinite(configured)) return 5;
  return Math.max(2, Math.min(60, Math.round(configured)));
}

export default function App() {
  const demo = new URLSearchParams(window.location.search).get('demo') === '1';
  const initialRoute = routeFromLocation();
  const [summary, setSummary] = useState<PublicSummary | null>(demo ? demoSummary : null);
  const [section, setSection] = useState<PublicSection>(initialRoute.section);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(initialRoute.selectedServerId);
  const [adminOpen, setAdminOpen] = useState(initialRoute.adminOpen);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(demo ? new Date() : null);
  const [history, setHistory] = useState<FleetSample[]>(demo ? initialDemoHistory(demoSummary) : []);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    window.localStorage.getItem('vps-monitor-theme') === 'dark' ? 'dark' : 'light'
  );
  const [language, setLanguage] = useState<Language>(() =>
    window.localStorage.getItem('vps-monitor-language') === 'en' ? 'en' : 'zh'
  );
  const defaultViewApplied = useRef(demo || hasRouteState());
  const defaultLanguageApplied = useRef(Boolean(window.localStorage.getItem('vps-monitor-language')));
  const background = summary?.settings.background;
  const showBackground = Boolean(background?.enabled && background.image_url);
  const brandName = summary?.settings.brand_name?.trim() || 'Notebook Atlas';
  const refreshIntervalSeconds = refreshSecondsFromSummary(summary);

  function commitRoute(route: AppRoute) {
    setAdminOpen(route.adminOpen);
    setSelectedServerId(route.adminOpen ? null : route.selectedServerId);
    setSection(route.section);
    setMobileNavOpen(false);
  }

  function writeRoute(route: AppRoute, mode: HistoryMode) {
    const nextUrl = routeUrl(route);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;
    window.history[mode === 'replace' ? 'replaceState' : 'pushState']({ vpsMonitorRoute: route }, '', nextUrl);
  }

  function openRoute(route: AppRoute, mode: HistoryMode = 'push') {
    defaultViewApplied.current = true;
    commitRoute(route);
    writeRoute(route, mode);
  }

  async function loadSummary() {
    if (demo) {
      setSummary(demoSummary);
      setHistory((current) => [...current, sampleFromSummary(demoSummary, new Date(), current.length)].slice(-48));
      setLastRefresh(new Date());
      return;
    }
    try {
      const next = await api<PublicSummary>('/api/public/summary');
      setSummary(next);
      if (!defaultLanguageApplied.current) {
        setLanguage(next.settings.default_language === 'en' ? 'en' : 'zh');
        defaultLanguageApplied.current = true;
      }
      if (!defaultViewApplied.current) {
        const defaultSection = next.settings.default_view === 'map' ? 'map' : next.settings.default_view === 'list' ? 'servers' : 'overview';
        openRoute({ section: defaultSection, selectedServerId: null, adminOpen: false }, 'replace');
        defaultViewApplied.current = true;
      }
      setHistory((current) => [...current, sampleFromSummary(next)].slice(-48));
      setLastRefresh(new Date());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '监控数据加载失败');
    }
  }

  useEffect(() => {
    if (!demo) loadSummary();
    const timer = window.setInterval(loadSummary, refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [demo, refreshIntervalSeconds]);

  useEffect(() => {
    const syncFromHistory = () => {
      defaultViewApplied.current = true;
      commitRoute(routeFromLocation());
    };
    window.addEventListener('popstate', syncFromHistory);
    return () => window.removeEventListener('popstate', syncFromHistory);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('vps-monitor-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  }, [language]);

  const t = (source: string, variables?: Record<string, string | number>) => translate(language, source, variables);
  const pageTitle = useMemo(() => {
    if (adminOpen) return t('配置本');
    const selectedServer = selectedServerId ? summary?.servers.find((server) => server.id === selectedServerId) : null;
    if (selectedServer) return selectedServer.name;
    return {
      overview: t('观测台'),
      servers: t('节点簿'),
      ping: t('延迟线'),
      map: t('节点地图')
    }[section];
  }, [adminOpen, language, section, selectedServerId, summary]);

  function navigate(next: PublicSection) {
    openRoute({ section: next, selectedServerId: null, adminOpen: false });
  }

  return (
    <I18nProvider language={language}>
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Pulse size={23} weight="bold" /></div>
          <div className="brand-name"><b>{brandName}</b></div>
          <button className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label={t('关闭导航')}><X size={20} /></button>
        </div>
        <nav className="main-nav">
          <span className="nav-label">{t('索引')}</span>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={!adminOpen && section === item.id ? 'active' : ''} onClick={() => navigate(item.id)}>
                <Icon size={19} />
                <span>{t(item.label)}</span>
              </button>
            );
          })}
          <span className="nav-label">{t('工具')}</span>
          <button className={adminOpen ? 'active' : ''} onClick={() => openRoute({ section, selectedServerId: null, adminOpen: true })}>
            <Gear size={19} />
            <span>{t('配置本')}</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          {summary?.settings.center_latitude != null && summary.settings.center_longitude != null && (
            <div className="center-location-card">
              <MapPin size={19} />
              <div>
                <span>{t('中心节点位置')}</span>
                <b>{summary.settings.center_name ? t(summary.settings.center_name) : t('中心节点')}</b>
                <small>
                  {Number(summary.settings.center_latitude).toFixed(2)}°, {Number(summary.settings.center_longitude).toFixed(2)}°
                </small>
              </div>
            </div>
          )}
          <div className="sidebar-status">
            <ShieldCheck size={21} />
            <div><span>{t('系统状态')}</span><b>{error ? t('连接异常') : t('运行正常')}</b></div>
            <i className={error ? 'bad' : ''} />
          </div>
        </div>
      </aside>

      {mobileNavOpen && <button className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-label={t('关闭导航遮罩')} />}

      <main className={`main-content ${showBackground ? 'has-custom-background' : ''}`}>
        {showBackground && (
          <div className="app-background-layer" aria-hidden="true">
            <div
              className="app-background-image"
              style={{
                backgroundImage: `url("${background?.image_url}")`,
                backgroundSize: background?.fit || 'cover',
                backgroundPosition: background?.position || 'center',
                filter: `blur(${Math.max(0, Math.min(24, Number(background?.blur || 0)))}px) brightness(${Math.max(50, Math.min(130, Number(background?.brightness || 100)))}%)`
              }}
            />
            <div
              className="app-background-overlay"
              style={{ opacity: Math.max(0, Math.min(85, Number(background?.overlay ?? 42))) / 100 }}
            />
          </div>
        )}
        <header className="app-header">
          <div className="header-title">
            <button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label={t('打开导航')}><SidebarSimple size={21} /></button>
            <div>
              <h1>{pageTitle}</h1>
                <span>{t('最后更新：{time}', { time: lastRefresh ? lastRefresh.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : t('等待首次数据') })}</span>
            </div>
          </div>
          <div className="header-actions">
            {!adminOpen && (
              <label className="global-search">
                <MagnifyingGlass size={17} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('搜索节点、IP 或位置…')} />
                <kbd>⌘K</kbd>
              </label>
            )}
            <button
              className="icon-button header-icon language-toggle"
              onClick={() => {
                const next = language === 'zh' ? 'en' : 'zh';
                setLanguage(next);
                window.localStorage.setItem('vps-monitor-language', next);
                defaultLanguageApplied.current = true;
              }}
              title={t('切换语言')}
            >
              <Translate size={18} />
              <span>{language === 'zh' ? 'EN' : '中'}</span>
            </button>
            <button className="icon-button header-icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={t('切换主题')}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <button className="icon-button header-icon alert-button" onClick={() => openRoute({ section, selectedServerId: null, adminOpen: true })} title={t('查看告警')}>
              <Bell size={19} />
            </button>
            <button
              className={`profile-button ${adminOpen ? 'active' : ''}`}
              onClick={() => openRoute({ section, selectedServerId: null, adminOpen: !adminOpen }, adminOpen ? 'replace' : 'push')}
            >
              <span>A</span>
              <b>Admin</b>
            </button>
          </div>
        </header>

        <div className="content-viewport">
          {error && <div className="global-error">{error}</div>}
          {adminOpen ? (
            <AdminPanel demo={demo} onChanged={loadSummary} onExit={() => openRoute({ section, selectedServerId: null, adminOpen: false }, 'replace')} />
          ) : summary ? (
            <Dashboard
              summary={summary}
              section={section}
              selectedServerId={selectedServerId}
              onSelectServer={(serverId) => openRoute({ section, selectedServerId: serverId, adminOpen: false })}
              onCloseServer={() => openRoute({ section, selectedServerId: null, adminOpen: false }, 'replace')}
              history={history}
              search={search}
              demo={demo}
              theme={theme}
              refreshIntervalSeconds={refreshIntervalSeconds}
              onRefresh={loadSummary}
            />
          ) : (
            <div className="loading-screen">
              <Pulse size={34} />
              <b>{t('正在加载监控数据')}</b>
              <span>{t('连接中心端并读取节点状态')}</span>
            </div>
          )}
        </div>
      </main>
    </div>
    </I18nProvider>
  );
}
