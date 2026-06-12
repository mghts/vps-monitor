import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Check,
  ClipboardText,
  CloudArrowDown,
  Copy,
  Database,
  Gear,
  GlobeHemisphereWest,
  HardDrives,
  ImageSquare,
  Key,
  LockKey,
  MapPin,
  Minus,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  SignOut,
  Terminal,
  Trash,
  UploadSimple,
  User,
  WarningCircle
} from '@phosphor-icons/react';
import { api, patchJson, postJson, putJson } from './api';
import { demoSummary } from './demo';
import { formatLocation } from './format';
import { useI18n } from './i18n';
import type {
  AgentCommands,
  AlertRecord,
  AlertRule,
  PingTarget,
  ServerNode,
  Settings
} from './types';

type AdminTab = 'servers' | 'ping' | 'alerts' | 'settings';
const defaultTelegramTemplate = '【{state}】{server}\n规则：{rule}\n当前值：{value}\n时间：{time}\n说明：{message}';

const demoSettings: Settings = {
  public: demoSummary.settings,
  geoip: {
    enabled: true,
    provider: 'geojs',
    last_update_status: 'Demo 模式使用内置示例位置，不会请求真实 GeoIP 服务。'
  },
  telegram: {
    enabled: false,
    bot_token: '',
    chat_id: '',
    message_template: defaultTelegramTemplate
  },
  alert_rules: [
    { key: 'offline', label: '离线超过 60 秒', enabled: true, threshold: 60, duration_seconds: 60, repeat_seconds: 1800 },
    { key: 'cpu_high', label: 'CPU 超过 90%', enabled: true, threshold: 90, duration_seconds: 300, repeat_seconds: 1800 },
    { key: 'memory_high', label: '内存超过 90%', enabled: true, threshold: 90, duration_seconds: 60, repeat_seconds: 1800 },
    { key: 'disk_high', label: '磁盘超过 85%', enabled: true, threshold: 85, duration_seconds: 60, repeat_seconds: 1800 },
    { key: 'traffic_high', label: '月流量超过额度', enabled: true, threshold: 100, duration_seconds: 60, repeat_seconds: 86400 }
  ]
};

export default function AdminPanel({ demo = false, onChanged, onExit }: { demo?: boolean; onChanged: () => void; onExit: () => void }) {
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [authed, setAuthed] = useState(false);
  const [message, setMessage] = useState('');

  async function refreshAuth() {
    if (demo) {
      setAuthed(true);
      setHasAdmin(true);
      return;
    }
    setHasAdmin(null);
    const status = await api<{ has_admin: boolean }>('/api/bootstrap/status');
    if (!status.has_admin) {
      setAuthed(false);
      setHasAdmin(false);
      return;
    }
    try {
      await api('/api/admin/me');
      setAuthed(true);
    } catch {
      setAuthed(false);
    }
    setHasAdmin(true);
  }

  useEffect(() => {
    refreshAuth().catch((error) => {
      setAuthed(false);
      setHasAdmin(true);
      setMessage(error.message);
    });
  }, [demo]);

  if (hasAdmin === null) return <AdminLoading />;
  if (!hasAdmin) return <RegisterForm onDone={refreshAuth} onExit={onExit} />;
  if (!authed) return <LoginForm onDone={() => { setAuthed(true); onChanged(); }} onExit={onExit} message={message} />;
  return <AdminWorkspace demo={demo} onChanged={onChanged} onLogout={() => demo ? onExit() : postJson('/api/auth/logout', {}).finally(onExit)} />;
}

function AdminLoading() {
  const { t } = useI18n();
  return (
    <div className="auth-layout">
      <div className="auth-card">
        <ShieldCheck size={34} />
        <h1>{t('正在检查管理状态')}</h1>
        <p>{t('正在建立安全会话。')}</p>
      </div>
    </div>
  );
}

function RegisterForm({ onDone, onExit }: { onDone: () => void; onExit: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ username: 'admin', password: '', setup_token: '' });
  const [error, setError] = useState('');
  return (
    <AuthShell title="创建唯一管理员" subtitle="注册成功后入口将永久关闭" icon={<ShieldCheck size={30} />} onExit={onExit}>
      <FormInput label="管理员用户名" value={form.username} icon={<User size={17} />} onChange={(username) => setForm({ ...form, username })} />
      <FormInput label="管理员密码" type="password" value={form.password} icon={<LockKey size={17} />} onChange={(password) => setForm({ ...form, password })} />
      <FormInput label="SETUP_TOKEN" type="password" value={form.setup_token} icon={<Key size={17} />} onChange={(setup_token) => setForm({ ...form, setup_token })} />
      {error && <InlineError text={error} />}
      <button className="button primary full" onClick={() => postJson('/api/bootstrap/register', form).then(onDone).catch((reason) => setError(reason.message))}>
        {t('创建管理员')}
      </button>
      <p className="auth-note">{t('SETUP_TOKEN 来自中心端 `.env`，只在首次注册时使用。')}</p>
    </AuthShell>
  );
}

function LoginForm({ onDone, onExit, message }: { onDone: () => void; onExit: () => void; message?: string }) {
  const { t } = useI18n();
  const [resetMode, setResetMode] = useState(false);
  const [form, setForm] = useState({ username: 'admin', password: '' });
  const [resetForm, setResetForm] = useState({ username: 'admin', password: '', setup_token: '' });
  const [error, setError] = useState(message || '');
  const [notice, setNotice] = useState('');

  if (resetMode) {
    return (
      <AuthShell title="重置管理员密码" subtitle="使用 SETUP_TOKEN 更新唯一管理员账号" icon={<Key size={30} />} onExit={onExit}>
        <FormInput label="管理员用户名" value={resetForm.username} icon={<User size={17} />} onChange={(username) => setResetForm({ ...resetForm, username })} />
        <FormInput label="新密码" type="password" value={resetForm.password} icon={<LockKey size={17} />} onChange={(password) => setResetForm({ ...resetForm, password })} />
        <FormInput label="SETUP_TOKEN" type="password" value={resetForm.setup_token} icon={<Key size={17} />} onChange={(setup_token) => setResetForm({ ...resetForm, setup_token })} />
        {error && <InlineError text={error} />}
        <button
          className="button primary full"
          onClick={() => postJson('/api/auth/reset-password', resetForm)
            .then(() => {
              setResetMode(false);
              setNotice('密码已重置，请使用新密码登录');
              setForm({ username: resetForm.username, password: '' });
              setError('');
            })
            .catch((reason) => setError(reason.message))}
        >
          {t('重置密码')}
        </button>
        <button className="text-button" onClick={() => { setResetMode(false); setError(''); }}>
          {t('返回登录')}
        </button>
        <p className="auth-note">{t('重置成功后，旧登录会话会自动失效。')}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="管理员登录" subtitle="配置节点、告警与展示设置" icon={<LockKey size={30} />} onExit={onExit}>
      <FormInput label="用户名" value={form.username} icon={<User size={17} />} onChange={(username) => setForm({ ...form, username })} />
      <FormInput label="密码" type="password" value={form.password} icon={<LockKey size={17} />} onChange={(password) => setForm({ ...form, password })} />
      {error && <InlineError text={error} />}
      {notice && <InlineNotice text={notice} />}
      <button className="button primary full" onClick={() => postJson('/api/auth/login', form).then(onDone).catch((reason) => setError(reason.message))}>
        {t('登录')}
      </button>
      <button className="text-button" onClick={() => { setResetMode(true); setError(''); setNotice(''); }}>
        {t('忘记密码？使用 SETUP_TOKEN 重置')}
      </button>
    </AuthShell>
  );
}

function AuthShell({
  title,
  subtitle,
  icon,
  onExit,
  children
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onExit: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="auth-layout">
      <div className="auth-card">
        <div className="auth-mark">{icon}</div>
        <h1>{t(title)}</h1>
        <p>{t(subtitle)}</p>
        <div className="auth-form">{children}</div>
        <button className="text-button" onClick={onExit}>{t('返回公开面板')}</button>
      </div>
    </div>
  );
}

function AdminWorkspace({ demo = false, onChanged, onLogout }: { demo?: boolean; onChanged: () => void; onLogout: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AdminTab>('servers');
  const [servers, setServers] = useState<ServerNode[]>([]);
  const [targets, setTargets] = useState<PingTarget[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [error, setError] = useState('');

  async function load() {
    if (demo) {
      setServers(demoSummary.servers);
      setTargets(demoSummary.ping_targets);
      setSettings(demoSettings);
      setAlerts([]);
      setError('');
      onChanged();
      return;
    }
    const [serverData, targetData, settingsData, alertData] = await Promise.all([
      api<ServerNode[]>('/api/admin/servers'),
      api<PingTarget[]>('/api/admin/ping-targets'),
      api<Settings>('/api/admin/settings'),
      api<AlertRecord[]>('/api/admin/alerts')
    ]);
    setServers(serverData);
    setTargets(targetData);
    setSettings(settingsData);
    setAlerts(alertData);
    setError('');
    onChanged();
  }

  useEffect(() => {
    load().catch((reason) => setError(reason.message));
  }, [demo]);

  const tabs = [
    { id: 'servers', label: t('节点'), icon: <HardDrives size={18} />, count: servers.length },
    { id: 'ping', label: t('Ping 目标'), icon: <GlobeHemisphereWest size={18} />, count: targets.length },
    { id: 'alerts', label: t('告警'), icon: <Bell size={18} />, count: alerts.filter((alert) => alert.state === 'active').length },
    { id: 'settings', label: t('配置'), icon: <Gear size={18} /> }
  ] as const;

  return (
    <div className="admin-workspace">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">CONTROL CENTER</span>
          <h1>{t('配置本')}</h1>
          <p>{t('节点、延迟、告警与展示偏好')}</p>
        </div>
        <button className="button ghost" onClick={onLogout}><SignOut size={17} />{t('退出登录')}</button>
      </div>
      <nav className="admin-tabs">
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
            {item.icon}
            <span>{item.label}</span>
            {'count' in item && <b>{item.count}</b>}
          </button>
        ))}
      </nav>
      {demo && <InlineNotice text={t('演示模式：配置本使用本地示例数据，不会保存修改。')} />}
      {error && <InlineError text={error} />}
      {tab === 'servers' && <ServerAdmin demo={demo} servers={servers} onChanged={load} />}
      {tab === 'ping' && <PingTargetAdmin demo={demo} servers={servers} targets={targets} onChanged={load} />}
      {tab === 'alerts' && <AlertsAdmin demo={demo} alerts={alerts} rules={settings.alert_rules || []} settings={settings} onChanged={load} />}
      {tab === 'settings' && <SettingsAdmin demo={demo} settings={settings} onChanged={load} />}
    </div>
  );
}

function ServerAdmin({ demo = false, servers, onChanged }: { demo?: boolean; servers: ServerNode[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [publicIp, setPublicIp] = useState('');
  const [groupName, setGroupName] = useState('');
  const [commands, setCommands] = useState<AgentCommands | null>(null);
  const [error, setError] = useState('');

  async function addServer() {
    if (!name.trim()) return;
    if (demo) {
      setError('演示模式不会创建真实服务器，请在实际中心端登录后添加。');
      return;
    }
    const response = await postJson<{ install_command: string; install_commands?: AgentCommands }>('/api/admin/servers', {
      name: name.trim(),
      server_group: groupName.trim() || null,
      public_ip: publicIp.trim() || null
    });
    setCommands(response.install_commands || { docker: { install: response.install_command } });
    setName('');
    setPublicIp('');
    setGroupName('');
    await onChanged();
  }

  return (
    <div className="admin-section">
      <section className="surface admin-create">
        <div>
          <h2>{t('添加服务器')}</h2>
          <p>{t('创建后会生成仅展示一次的独立 Agent token 与安装命令。')}</p>
        </div>
        <div className="create-server-form">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('例如 Tokyo-01')} />
          <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t('分组（可选）')} />
          <input value={publicIp} onChange={(event) => setPublicIp(event.target.value)} placeholder={t('公网 IP（可选，用于预定位）')} />
          <button className="button primary" onClick={() => addServer().catch((reason) => setError(reason.message))}><Plus size={17} />{t('添加服务器')}</button>
        </div>
        {error && <InlineError text={error} />}
      </section>
      {commands && <CommandBox title="Agent 安装命令" description="Token 明文只在本次显示，请立即保存或执行。" commands={commands} mode="install" />}
      <div className="admin-list">
        {servers.map((server) => <ServerEditor key={server.id} demo={demo} server={server} onChanged={onChanged} onCommands={setCommands} />)}
        {!servers.length && <AdminEmpty icon={<HardDrives size={28} />} title="还没有服务器" detail="添加第一台 VPS 后，安装命令会显示在这里。" />}
      </div>
    </div>
  );
}

function ServerEditor({
  demo = false,
  server,
  onChanged,
  onCommands
}: {
  demo?: boolean;
  server: ServerNode;
  onChanged: () => void;
  onCommands: (commands: AgentCommands) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({
    name: server.name,
    note: server.note || '',
    group: server.group || '',
    enabled: server.enabled ?? true,
    public_visible: server.public_visible,
    ping_mode: server.ping_mode || 'inherit_append',
    traffic_limit_gb: server.traffic_limit_bytes ? String(Math.round(server.traffic_limit_bytes / 1024 ** 3)) : '',
    traffic_direction: server.traffic_direction || 'up_down',
    traffic_reset_day: String(server.traffic_reset_day || 1),
    location_country: server.manual_location?.country || '',
    location_region: server.manual_location?.region || '',
    location_city: server.manual_location?.city || '',
    latitude: server.manual_location?.latitude?.toString() || '',
    longitude: server.manual_location?.longitude?.toString() || ''
  });
  const geoip = server.geoip_location;
  const hasGeoip = Boolean(geoip?.country || geoip?.region || geoip?.city || geoip?.latitude || geoip?.longitude);

  function applyGeoipLocation() {
    if (!hasGeoip) return;
    setDraft({
      ...draft,
      location_country: geoip?.country || '',
      location_region: geoip?.region || '',
      location_city: geoip?.city || '',
      latitude: coordinateInput(geoip?.latitude),
      longitude: coordinateInput(geoip?.longitude)
    });
  }

  function clearLocationOverride() {
    setDraft({
      ...draft,
      location_country: '',
      location_region: '',
      location_city: '',
      latitude: '',
      longitude: ''
    });
  }

  async function save() {
    if (demo) {
      setError('演示模式不会保存节点修改。');
      return;
    }
    await patchJson(`/api/admin/servers/${server.id}`, {
      name: draft.name,
      note: draft.note,
      server_group: draft.group,
      enabled: draft.enabled,
      public_visible: draft.public_visible,
      ping_mode: draft.ping_mode,
      traffic_limit_bytes: draft.traffic_limit_gb ? Number(draft.traffic_limit_gb) * 1024 ** 3 : null,
      traffic_direction: draft.traffic_direction,
      traffic_reset_day: Number(draft.traffic_reset_day),
      location_country: draft.location_country || null,
      location_region: draft.location_region || null,
      location_city: draft.location_city || null,
      latitude: draft.latitude ? Number(draft.latitude) : null,
      longitude: draft.longitude ? Number(draft.longitude) : null
    });
    await onChanged();
    setOpen(false);
  }

  async function rotateToken() {
    if (demo) {
      setError('演示模式不会重置 Agent token。');
      return;
    }
    const response = await postJson<{ install_command: string; install_commands?: AgentCommands }>(`/api/admin/servers/${server.id}/rotate-token`, {});
    onCommands(response.install_commands || { docker: { install: response.install_command } });
  }

  async function remove() {
    if (demo) {
      setError('演示模式不会删除服务器。');
      return;
    }
    if (!window.confirm(`确定删除 ${server.name}？历史数据也将失去关联。`)) return;
    await api(`/api/admin/servers/${server.id}`, { method: 'DELETE' });
    await onChanged();
  }

  return (
    <article className={`surface server-editor ${open ? 'open' : ''}`}>
      <button className="server-editor-summary" onClick={() => setOpen((value) => !value)}>
        <div className={`server-state-icon ${server.online ? 'online' : 'offline'}`}><HardDrives size={19} /></div>
        <div className="server-editor-name">
          <b>{server.name}</b>
          <span>{server.ip_full || server.ip_masked || t('等待 Agent 上报')} · {server.os_name || t('系统未知')}</span>
        </div>
        <div className="server-editor-meta">
          <span className={`status-badge ${server.online ? 'online' : 'offline'}`}><i />{server.online ? t('在线') : t('离线')}</span>
          <span className="editor-location"><MapPin size={15} />{server.location.city || server.location.country || t('未定位')}</span>
        </div>
        <span className="editor-chevron" aria-hidden="true">{open ? <Minus size={15} weight="bold" /> : <Plus size={15} weight="bold" />}</span>
      </button>
      {open && (
        <div className="server-editor-body">
          <div className="settings-group">
            <div className="group-title"><HardDrives size={18} /><div><b>{t('基础信息')}</b><span>{t('节点名称、备注与展示状态')}</span></div></div>
            <div className="form-grid">
              <FormInput label="名称" value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} />
              <FormInput label="备注" value={draft.note} onChange={(value) => setDraft({ ...draft, note: value })} />
              <FormInput label="分组" value={draft.group} placeholder="亚洲节点 / 生产 / 备用" onChange={(value) => setDraft({ ...draft, group: value })} />
              <SelectField label="Ping 目标策略" value={draft.ping_mode} onChange={(value) => setDraft({ ...draft, ping_mode: value as typeof draft.ping_mode })}>
                <option value="inherit_append">{t('继承全局并追加')}</option>
                <option value="override">{t('仅使用单机目标')}</option>
              </SelectField>
              <div className="toggle-row">
                <Toggle checked={draft.enabled} onChange={(value) => setDraft({ ...draft, enabled: value })} label="启用 Agent 接入" />
                <Toggle checked={draft.public_visible} onChange={(value) => setDraft({ ...draft, public_visible: value })} label="公开页面展示" />
              </div>
              <p className="field-note toggle-help">{t('关闭 Agent 接入后，该节点 token 会被拒绝，公开页和告警也会忽略此节点。')}</p>
            </div>
          </div>
          <div className="settings-group">
            <div className="group-title"><HardDrives size={18} /><div><b>{t('流量额度')}</b><span>{t('按自然周期统计 Agent 累计计数')}</span></div></div>
            <div className="form-grid three">
              <FormInput label="月流量额度（GB）" value={draft.traffic_limit_gb} onChange={(value) => setDraft({ ...draft, traffic_limit_gb: value })} />
              <FormInput label="重置日（1–28）" value={draft.traffic_reset_day} onChange={(value) => setDraft({ ...draft, traffic_reset_day: value })} />
              <SelectField label="统计方向" value={draft.traffic_direction} onChange={(value) => setDraft({ ...draft, traffic_direction: value as typeof draft.traffic_direction })}>
                <option value="up_down">{t('上传 + 下载')}</option>
                <option value="download">{t('仅下载')}</option>
                <option value="upload">{t('仅上传')}</option>
              </SelectField>
            </div>
          </div>
          <div className="settings-group">
            <div className="group-title"><MapPin size={18} /><div><b>{t('位置覆盖')}</b><span>{t('留空时使用 GeoIP 自动定位')}</span></div></div>
            <div className="form-grid three">
              <FormInput label="国家/地区" value={draft.location_country} placeholder={geoip?.country || ''} onChange={(value) => setDraft({ ...draft, location_country: value })} />
              <FormInput label="省/州" value={draft.location_region} placeholder={geoip?.region || ''} onChange={(value) => setDraft({ ...draft, location_region: value })} />
              <FormInput label="城市" value={draft.location_city} placeholder={geoip?.city || ''} onChange={(value) => setDraft({ ...draft, location_city: value })} />
              <FormInput label="纬度" value={draft.latitude} placeholder={coordinateInput(geoip?.latitude)} onChange={(value) => setDraft({ ...draft, latitude: value })} />
              <FormInput label="经度" value={draft.longitude} placeholder={coordinateInput(geoip?.longitude)} onChange={(value) => setDraft({ ...draft, longitude: value })} />
            </div>
            <div className="location-helper-row">
              <p className="field-note">{t('GeoIP 识别：{location}', { location: formatLocation(server.geoip_location) })}</p>
              <div className="button-row compact">
                <button className="button ghost" disabled={!hasGeoip} onClick={applyGeoipLocation}><MapPin size={16} />{t('使用 GeoIP 填入')}</button>
                <button className="button ghost" onClick={clearLocationOverride}>{t('清空覆盖')}</button>
              </div>
            </div>
          </div>
          {error && <InlineError text={error} />}
          <div className="editor-actions">
            <button className="button primary" onClick={() => save().catch((reason) => setError(reason.message))}><Check size={17} />{t('保存修改')}</button>
            <button className="button ghost" onClick={() => rotateToken().catch((reason) => setError(reason.message))}><Key size={17} />{t('重置 token')}</button>
            <button className="button danger" onClick={() => remove().catch((reason) => setError(reason.message))}><Trash size={17} />{t('删除服务器')}</button>
          </div>
          {(server.uninstall_commands || server.uninstall_command) && (
            <CommandBox
              title="卸载 Agent"
              description="分别提供 Docker 与 systemd 版本。"
              commands={server.uninstall_commands || { docker: { uninstall: server.uninstall_command } }}
              mode="uninstall"
            />
          )}
        </div>
      )}
    </article>
  );
}

function CommandBox({
  title,
  description,
  commands,
  mode
}: {
  title: string;
  description: string;
  commands: AgentCommands;
  mode: 'install' | 'uninstall';
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState('');
  const items = [
    { id: 'docker', label: 'Docker', icon: <Database size={17} />, command: commands.docker?.[mode] },
    { id: 'native', label: 'systemd', icon: <Terminal size={17} />, command: commands.native?.[mode] }
  ].filter((item) => item.command);

  async function copy(id: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied(''), 1600);
  }

  return (
    <section className="surface command-surface">
      <div className="surface-header">
        <div><h2>{t(title)}</h2><p>{t(description)}</p></div>
        <ClipboardText size={22} />
      </div>
      <div className="command-list">
        {items.map((item) => (
          <div className="command-row" key={item.id}>
            <div className="command-label">{item.icon}<b>{item.label}</b></div>
            <code>{item.command}</code>
            <button className="icon-button" onClick={() => copy(item.id, item.command!)} title={t('复制命令')}>
              {copied === item.id ? <Check size={17} /> : <Copy size={17} />}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function PingTargetAdmin({ demo = false, servers, targets, onChanged }: { demo?: boolean; servers: ServerNode[]; targets: PingTarget[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({
    scope: 'global',
    server_id: '',
    name: '',
    host: '',
    mode: 'icmp',
    tcp_port: '443',
    interval_seconds: '30',
    timeout_ms: '1000',
    enabled: true
  });
  const [error, setError] = useState('');

  async function add() {
    if (demo) {
      setError('演示模式不会创建 Ping 目标。');
      return;
    }
    await postJson('/api/admin/ping-targets', {
      scope: draft.scope,
      server_id: draft.scope === 'server' ? draft.server_id : null,
      name: draft.name,
      host: draft.host,
      mode: draft.mode,
      tcp_port: draft.mode === 'tcp' ? Number(draft.tcp_port) : null,
      interval_seconds: Number(draft.interval_seconds),
      timeout_ms: Number(draft.timeout_ms),
      enabled: draft.enabled
    });
    setDraft({ ...draft, name: '', host: '' });
    await onChanged();
  }

  async function remove(id: string) {
    if (demo) {
      setError('演示模式不会删除 Ping 目标。');
      return;
    }
    await api(`/api/admin/ping-targets/${id}`, { method: 'DELETE' });
    await onChanged();
  }

  return (
    <div className="admin-section split">
      <section className="surface settings-card">
        <div className="surface-header"><div><h2>{t('添加 Ping 目标')}</h2><p>{t('全局最多 20 个，单台服务器可额外配置 20 个。')}</p></div><GlobeHemisphereWest size={22} /></div>
        <div className="form-grid">
          <SelectField label="作用范围" value={draft.scope} onChange={(value) => setDraft({ ...draft, scope: value })}>
            <option value="global">{t('全局目标')}</option>
            <option value="server">{t('单机目标')}</option>
          </SelectField>
          {draft.scope === 'server' && (
            <SelectField label="服务器" value={draft.server_id} onChange={(value) => setDraft({ ...draft, server_id: value })}>
              <option value="">{t('选择服务器')}</option>
              {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
            </SelectField>
          )}
          <FormInput label="目标名称" value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} placeholder="Cloudflare DNS" />
          <FormInput label="Host / IP" value={draft.host} onChange={(value) => setDraft({ ...draft, host: value })} placeholder="1.1.1.1" />
          <SelectField label="协议" value={draft.mode} onChange={(value) => setDraft({ ...draft, mode: value })}>
            <option value="icmp">ICMP Ping</option>
            <option value="tcp">TCP Ping</option>
          </SelectField>
          {draft.mode === 'tcp' && <FormInput label="TCP 端口" value={draft.tcp_port} onChange={(value) => setDraft({ ...draft, tcp_port: value })} />}
          <FormInput label="间隔（秒）" value={draft.interval_seconds} onChange={(value) => setDraft({ ...draft, interval_seconds: value })} />
          <FormInput label="超时（ms）" value={draft.timeout_ms} onChange={(value) => setDraft({ ...draft, timeout_ms: value })} />
        </div>
        <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="创建后立即启用" />
        {error && <InlineError text={error} />}
          <button className="button primary" onClick={() => add().catch((reason) => setError(reason.message))}><Plus size={17} />{t('添加目标')}</button>
      </section>
      <section className="surface settings-card">
        <div className="surface-header"><div><h2>{t('已配置目标')}</h2><p>{t('{count} 个探测任务', { count: targets.length })}</p></div></div>
        <div className="target-rows">
          {targets.map((target) => (
            <div className="target-row" key={target.id}>
              <div className={`target-protocol ${target.mode}`}>{target.mode.toUpperCase()}</div>
              <div className="target-name">
                <b>{target.name}</b>
                <span>{target.host}{target.tcp_port ? `:${target.tcp_port}` : ''}</span>
              </div>
              <span className="scope-tag">{target.scope === 'server' ? t('单机') : t('全局')}</span>
              <button className="icon-button danger" onClick={() => remove(target.id).catch((reason) => setError(reason.message))} title={t('删除目标')}><Trash size={17} /></button>
            </div>
          ))}
          {!targets.length && <AdminEmpty icon={<GlobeHemisphereWest size={28} />} title="没有 Ping 目标" detail="创建目标后，Agent 会在下一次拉取配置时开始探测。" />}
        </div>
      </section>
    </div>
  );
}

function AlertsAdmin({
  demo = false,
  alerts,
  rules,
  settings,
  onChanged
}: {
  demo?: boolean;
  alerts: AlertRecord[];
  rules: AlertRule[];
  settings: Settings;
  onChanged: () => void;
}) {
  const { language, t } = useI18n();
  const [draftRules, setDraftRules] = useState(rules);
  const [telegram, setTelegram] = useState({
    enabled: settings.telegram?.enabled || false,
    bot_token: settings.telegram?.bot_token || '',
    chat_id: settings.telegram?.chat_id || '',
    message_template: settings.telegram?.message_template || defaultTelegramTemplate
  });
  const [error, setError] = useState('');

  useEffect(() => {
    setDraftRules(rules);
    setTelegram({
      enabled: settings.telegram?.enabled || false,
      bot_token: settings.telegram?.bot_token || '',
      chat_id: settings.telegram?.chat_id || '',
      message_template: settings.telegram?.message_template || defaultTelegramTemplate
    });
  }, [rules, settings.telegram]);

  async function save() {
    if (demo) {
      setError('演示模式不会保存告警设置。');
      return;
    }
    await putJson('/api/admin/settings', {
      telegram,
      geoip: settings.geoip || {},
      public: settings.public || {},
      alert_rules: draftRules
    });
    await onChanged();
  }

  return (
    <div className="admin-section">
      <div className="admin-two-column alerts-layout">
        <section className="surface settings-card alert-rules-card">
          <div className="surface-header"><div><h2>{t('告警规则')}</h2><p>{t('持续时间用于避免短暂波动触发通知。')}</p></div><Bell size={22} /></div>
          <div className="rule-table">
            <div className="rule-head"><span>{t('规则')}</span><span>{t('触发阈值')}</span><span>{t('持续时间')}</span><span>{t('重复通知')}</span></div>
            {draftRules.map((rule, index) => (
              <div className="rule-row" key={rule.key}>
                <div className="rule-name-cell">
                  <Toggle
                    checked={rule.enabled}
                    onChange={(enabled) => setDraftRules(replaceAt(draftRules, index, { ...rule, enabled }))}
                    label={alertRuleName(rule.key, t)}
                  />
                </div>
                <label className="rule-number-field">
                  <input type="number" value={rule.threshold} onChange={(event) => setDraftRules(replaceAt(draftRules, index, { ...rule, threshold: Number(event.target.value) }))} />
                  <span>{alertRuleThresholdUnit(rule.key, t)}</span>
                </label>
                {alertRuleUsesDuration(rule.key) ? (
                  <label className="rule-number-field">
                    <input type="number" value={rule.duration_seconds} onChange={(event) => setDraftRules(replaceAt(draftRules, index, { ...rule, duration_seconds: Number(event.target.value) }))} />
                    <span>{t('秒')}</span>
                  </label>
                ) : (
                  <span className="rule-muted-value">{t(alertRuleDurationText(rule.key))}</span>
                )}
                <label className="rule-number-field">
                  <input type="number" value={rule.repeat_seconds} onChange={(event) => setDraftRules(replaceAt(draftRules, index, { ...rule, repeat_seconds: Number(event.target.value) }))} />
                  <span>{t('秒')}</span>
                </label>
              </div>
            ))}
          </div>
        </section>
        <section className="surface settings-card telegram-settings-card">
          <div className="surface-header"><div><h2>{t('Telegram 通知')}</h2><p>{t('全局 Bot 与 Chat ID')}</p></div><PaperPlaneTilt size={22} /></div>
          <div className="telegram-card-scroll">
            <Toggle checked={telegram.enabled} onChange={(enabled) => setTelegram({ ...telegram, enabled })} label="启用 Telegram 告警" />
            <FormInput label="Bot Token" type="password" value={telegram.bot_token} onChange={(bot_token) => setTelegram({ ...telegram, bot_token })} />
            <FormInput label="Chat ID" value={telegram.chat_id} onChange={(chat_id) => setTelegram({ ...telegram, chat_id })} />
            <TextAreaField
              label="通知模板"
              value={telegram.message_template}
              onChange={(message_template) => setTelegram({ ...telegram, message_template })}
              placeholder={defaultTelegramTemplate}
            />
            <p className="field-note telegram-template-help">{t('Telegram 模板变量说明')}</p>
            <div className="button-row">
              <button className="button ghost" onClick={() => setTelegram({ ...telegram, message_template: defaultTelegramTemplate })}>{t('恢复默认模板')}</button>
            </div>
            <div className="telegram-preview">
              <span>{t('通知预览')}</span>
              <pre>{renderTelegramPreview(telegram.message_template, t)}</pre>
            </div>
            {error && <InlineError text={error} />}
          </div>
          <button className="button primary" onClick={() => save().catch((reason) => setError(reason.message))}><Check size={17} />{t('保存告警设置')}</button>
        </section>
      </div>
      <section className="surface settings-card">
        <div className="surface-header"><div><h2>{t('告警记录')}</h2><p>{t('最近 300 条，历史保留 30 天')}</p></div></div>
        <div className="alert-rows">
          {alerts.map((alert) => (
            <div className="alert-row" key={alert.id}>
              <div className={`alert-icon ${alert.state === 'active' ? 'active' : 'resolved'}`}>
                {alert.state === 'active' ? <WarningCircle size={19} /> : <Check size={19} />}
              </div>
              <div>
                <b>{alert.server_name} · {alert.rule_label}</b>
                <span>{alert.message}</span>
              </div>
              <span className={`alert-state ${alert.state}`}>{alert.state === 'active' ? t('活动中') : t('已恢复')}</span>
              <time>{new Date(alert.triggered_at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</time>
            </div>
          ))}
          {!alerts.length && <AdminEmpty icon={<Bell size={28} />} title="暂无告警记录" detail="所有节点状态正常时，这里会保持安静。" />}
        </div>
      </section>
    </div>
  );
}

function SettingsAdmin({ demo = false, settings, onChanged }: { demo?: boolean; settings: Settings; onChanged: () => void }) {
  const { t } = useI18n();
  const initialBackground = settings.public?.background;
  const [publicSettings, setPublicSettings] = useState({
    brand_name: String(settings.public?.brand_name || 'Notebook Atlas'),
    center_location_mode: settings.public?.center_location_mode || 'auto',
    center_name: String(settings.public?.center_name || 'Center'),
    center_latitude: settings.public?.center_latitude == null ? '' : String(settings.public.center_latitude),
    center_longitude: settings.public?.center_longitude == null ? '' : String(settings.public.center_longitude),
    center_auto_ip: settings.public?.center_auto_ip || '',
    center_auto_country: settings.public?.center_auto_country || '',
    center_auto_region: settings.public?.center_auto_region || '',
    center_auto_city: settings.public?.center_auto_city || '',
    center_auto_latitude: settings.public?.center_auto_latitude == null ? '' : String(settings.public.center_auto_latitude),
    center_auto_longitude: settings.public?.center_auto_longitude == null ? '' : String(settings.public.center_auto_longitude),
    center_auto_updated_at: settings.public?.center_auto_updated_at || '',
    center_auto_status: settings.public?.center_auto_status || '',
    default_view: String(settings.public?.default_view || 'cards'),
    default_language: settings.public?.default_language || 'zh',
    default_map_mode: settings.public?.default_map_mode || '2d',
    default_server_view: settings.public?.default_server_view || 'table',
    refresh_interval_seconds: String(settings.public?.refresh_interval_seconds || 5),
    background: {
      enabled: initialBackground?.enabled ?? false,
      image_url: initialBackground?.image_url || '',
      fit: initialBackground?.fit || 'cover',
      position: initialBackground?.position || 'center',
      blur: Number(initialBackground?.blur || 0),
      brightness: Number(initialBackground?.brightness || 100),
      overlay: Number(initialBackground?.overlay ?? 42)
    }
  });
  const [geoip, setGeoip] = useState({
    enabled: settings.geoip?.enabled ?? true,
    provider: settings.geoip?.provider || 'geojs',
    download_url: settings.geoip?.download_url || 'https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz',
    last_update_at: settings.geoip?.last_update_at || '',
    last_update_status: settings.geoip?.last_update_status || ''
  });
  const [testIp, setTestIp] = useState('1.1.1.1');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [backgroundMessage, setBackgroundMessage] = useState('');
  const [backgroundUploading, setBackgroundUploading] = useState(false);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPublicSettings({
      brand_name: String(settings.public?.brand_name || 'Notebook Atlas'),
      center_location_mode: settings.public?.center_location_mode || 'auto',
      center_name: String(settings.public?.center_name || 'Center'),
      center_latitude: settings.public?.center_latitude == null ? '' : String(settings.public.center_latitude),
      center_longitude: settings.public?.center_longitude == null ? '' : String(settings.public.center_longitude),
      center_auto_ip: settings.public?.center_auto_ip || '',
      center_auto_country: settings.public?.center_auto_country || '',
      center_auto_region: settings.public?.center_auto_region || '',
      center_auto_city: settings.public?.center_auto_city || '',
      center_auto_latitude: settings.public?.center_auto_latitude == null ? '' : String(settings.public.center_auto_latitude),
      center_auto_longitude: settings.public?.center_auto_longitude == null ? '' : String(settings.public.center_auto_longitude),
      center_auto_updated_at: settings.public?.center_auto_updated_at || '',
      center_auto_status: settings.public?.center_auto_status || '',
      default_view: String(settings.public?.default_view || 'cards'),
      default_language: settings.public?.default_language || 'zh',
      default_map_mode: settings.public?.default_map_mode || '2d',
      default_server_view: settings.public?.default_server_view || 'table',
      refresh_interval_seconds: String(settings.public?.refresh_interval_seconds || 5),
      background: {
        enabled: settings.public?.background?.enabled ?? false,
        image_url: settings.public?.background?.image_url || '',
        fit: settings.public?.background?.fit || 'cover',
        position: settings.public?.background?.position || 'center',
        blur: Number(settings.public?.background?.blur || 0),
        brightness: Number(settings.public?.background?.brightness || 100),
        overlay: Number(settings.public?.background?.overlay ?? 42)
      }
    });
    setGeoip({
      enabled: settings.geoip?.enabled ?? true,
      provider: settings.geoip?.provider || 'geojs',
      download_url: settings.geoip?.download_url || 'https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz',
      last_update_at: settings.geoip?.last_update_at || '',
      last_update_status: settings.geoip?.last_update_status || ''
    });
  }, [settings]);

  async function save(nextPublicSettings = publicSettings) {
    if (demo) {
      setResult('演示模式不会保存系统设置。');
      return;
    }
    await putJson('/api/admin/settings', {
      telegram: settings.telegram || {},
      geoip,
      public: {
        ...nextPublicSettings,
        center_latitude: nextPublicSettings.center_latitude ? Number(nextPublicSettings.center_latitude) : null,
        center_longitude: nextPublicSettings.center_longitude ? Number(nextPublicSettings.center_longitude) : null,
        center_auto_latitude: nextPublicSettings.center_auto_latitude ? Number(nextPublicSettings.center_auto_latitude) : null,
        center_auto_longitude: nextPublicSettings.center_auto_longitude ? Number(nextPublicSettings.center_auto_longitude) : null,
        refresh_interval_seconds: clampRefreshInterval(nextPublicSettings.refresh_interval_seconds)
      },
      alert_rules: settings.alert_rules || []
    });
    await onChanged();
  }

  async function uploadBackground(file?: File) {
    if (!file) return;
    if (demo) {
      setError('演示模式不会上传背景图片。');
      if (backgroundInputRef.current) backgroundInputRef.current.value = '';
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('背景图片仅支持 JPEG、PNG 或 WebP');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setError('背景图片不能超过 12 MB');
      return;
    }
    setBackgroundUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('image', file);
      const response = await api<{ image_url: string }>('/api/admin/settings/background', {
        method: 'POST',
        body: form
      });
      const next = {
        ...publicSettings,
        background: {
          ...publicSettings.background,
          enabled: true,
          image_url: `${response.image_url}?v=${Date.now()}`
        }
      };
      setPublicSettings(next);
      await save(next);
      setBackgroundMessage(t('背景图片已上传并应用'));
    } finally {
      setBackgroundUploading(false);
      if (backgroundInputRef.current) backgroundInputRef.current.value = '';
    }
  }

  async function removeBackground() {
    if (demo) {
      setBackgroundMessage('演示模式不会移除背景图片。');
      return;
    }
    await api('/api/admin/settings/background', { method: 'DELETE' });
    const next = {
      ...publicSettings,
      background: {
        ...publicSettings.background,
        enabled: false,
        image_url: ''
      }
    };
    setPublicSettings(next);
    await save(next);
    setBackgroundMessage(t('自定义背景已移除'));
  }

  async function updateGeoip() {
    if (demo) {
      setResult('演示模式不会更新 GeoIP 数据库。');
      return;
    }
    await save();
    const response = await postJson<{ message: string }>('/api/admin/settings/geoip/update', {});
    setResult(response.message);
    await onChanged();
  }

  async function testGeoip() {
    if (demo) {
      setResult(`Demo: ${testIp} -> ${formatLocation(demoSummary.servers[0]?.location)}`);
      return;
    }
    await save();
    const response = await postJson<{ provider: string; location: any }>('/api/admin/settings/geoip/test', { ip: testIp });
    setResult(`${response.provider}: ${formatLocation(response.location)}`);
  }

  return (
    <div className="admin-section split">
      <section className="surface settings-card">
        <div className="surface-header"><div><h2>{t('GeoIP')}</h2><p>{t('自动定位节点，也可由单机设置手动覆盖。')}</p></div><GlobeHemisphereWest size={22} /></div>
        <Toggle checked={geoip.enabled} onChange={(enabled) => setGeoip({ ...geoip, enabled })} label="启用 GeoIP 定位" />
        <SelectField label="Provider" value={geoip.provider} onChange={(provider) => setGeoip({ ...geoip, provider })}>
          <option value="none">None</option>
          <option value="maxmind">{t('MaxMind 本地 MMDB')}</option>
          <option value="geojs">geojs.io</option>
          <option value="ipinfo">ipinfo.io</option>
          <option value="ip-api">ip-api.com</option>
        </SelectField>
        {geoip.provider === 'maxmind' && <FormInput label="MMDB 下载 URL" value={geoip.download_url} onChange={(download_url) => setGeoip({ ...geoip, download_url })} />}
        <div className="settings-inline">
          <FormInput label="测试 IP" value={testIp} onChange={setTestIp} />
          <button className="button ghost" onClick={() => testGeoip().catch((reason) => setError(reason.message))}>{t('测试')}</button>
        </div>
        <div className="button-row">
          <button className="button primary" onClick={() => updateGeoip().catch((reason) => setError(reason.message))}><CloudArrowDown size={17} />{t('更新 GeoIP')}</button>
        </div>
        {(result || geoip.last_update_status) && <div className="result-box">{result || geoip.last_update_status}</div>}
      </section>
      <section className="surface settings-card">
        <div className="surface-header"><div><h2>{t('公开页面')}</h2><p>{t('控制中心位置与默认展示方式。')}</p></div><Gear size={22} /></div>
        <div className="form-grid">
          <FormInput label="站点名称" value={publicSettings.brand_name} onChange={(brand_name) => setPublicSettings({ ...publicSettings, brand_name })} />
          <FormInput label="中心名称" value={publicSettings.center_name} onChange={(center_name) => setPublicSettings({ ...publicSettings, center_name })} />
        </div>
        <SelectField label="中心位置来源" value={publicSettings.center_location_mode} onChange={(center_location_mode) => setPublicSettings({ ...publicSettings, center_location_mode: center_location_mode as 'auto' | 'manual' })}>
          <option value="auto">{t('自动检测中心端位置')}</option>
          <option value="manual">{t('手动填写中心位置')}</option>
        </SelectField>
        {publicSettings.center_location_mode === 'manual' ? (
          <div className="form-grid">
            <FormInput label="中心纬度" value={publicSettings.center_latitude} onChange={(center_latitude) => setPublicSettings({ ...publicSettings, center_latitude })} />
            <FormInput label="中心经度" value={publicSettings.center_longitude} onChange={(center_longitude) => setPublicSettings({ ...publicSettings, center_longitude })} />
          </div>
        ) : (
          <div className="result-box">
            {t('自动中心位置说明')}<br />
            {t('当前自动位置')}：{formatAutoCenterLocation(publicSettings, t)}
          </div>
        )}
        <SelectField label="默认入口" value={publicSettings.default_view} onChange={(default_view) => setPublicSettings({ ...publicSettings, default_view })}>
          <option value="cards">{t('总览')}</option>
          <option value="list">{t('服务器')}</option>
          <option value="map">{t('全球地图')}</option>
        </SelectField>
        <div className="form-grid three">
          <SelectField label="默认语言" value={publicSettings.default_language} onChange={(default_language) => setPublicSettings({ ...publicSettings, default_language: default_language as 'zh' | 'en' })}>
            <option value="zh">{t('中文')}</option>
            <option value="en">{t('英文')}</option>
          </SelectField>
          <SelectField label="默认地图模式" value={publicSettings.default_map_mode} onChange={(default_map_mode) => setPublicSettings({ ...publicSettings, default_map_mode: default_map_mode as '2d' | '3d' })}>
            <option value="2d">2D</option>
            <option value="3d">3D</option>
          </SelectField>
          <SelectField label="默认服务器视图" value={publicSettings.default_server_view} onChange={(default_server_view) => setPublicSettings({ ...publicSettings, default_server_view: default_server_view as 'table' | 'cards' })}>
            <option value="table">{t('列表')}</option>
            <option value="cards">{t('卡片')}</option>
          </SelectField>
          <FormInput label="刷新间隔（秒）" value={publicSettings.refresh_interval_seconds} placeholder="2-60" onChange={(refresh_interval_seconds) => setPublicSettings({ ...publicSettings, refresh_interval_seconds })} />
        </div>
        <p className="field-note">{t('控制公开面板轮询频率，节点统计和节点清单里的刷新文案会同步变化。范围：2-60 秒。')}</p>
        {error && <InlineError text={error} />}
        <button className="button primary" onClick={() => save().catch((reason) => setError(reason.message))}><Check size={17} />{t('保存系统设置')}</button>
      </section>
      <section className="surface settings-card background-settings-card">
        <div className="surface-header">
          <div><h2>{t('自定义背景')}</h2><p>{t('等比例显示图片，可调节裁切位置、模糊度、亮度和内容遮罩。')}</p></div>
          <ImageSquare size={22} />
        </div>
        <div className="background-settings-layout">
          <div
            className={`background-preview ${publicSettings.background.image_url ? 'has-image' : ''}`}
            style={{
              backgroundImage: publicSettings.background.image_url ? `url("${publicSettings.background.image_url}")` : undefined,
              backgroundSize: publicSettings.background.fit,
              backgroundPosition: publicSettings.background.position,
              filter: `brightness(${publicSettings.background.brightness}%)`
            }}
          >
            {!publicSettings.background.image_url && <><ImageSquare size={30} /><span>{t('尚未上传背景图片')}</span></>}
            {publicSettings.background.image_url && (
              <i
                style={{
                  backdropFilter: `blur(${publicSettings.background.blur}px)`,
                  background: 'var(--background-overlay-color)',
                  opacity: publicSettings.background.overlay / 100
                }}
              />
            )}
          </div>
          <div className="background-controls">
            <Toggle
              checked={publicSettings.background.enabled}
              onChange={(enabled) => setPublicSettings({
                ...publicSettings,
                background: { ...publicSettings.background, enabled }
              })}
              label="启用自定义背景"
            />
            <div className="button-row">
              <button className="button primary" disabled={backgroundUploading} onClick={() => backgroundInputRef.current?.click()}>
                <UploadSimple size={17} />
                {backgroundUploading ? t('正在上传') : publicSettings.background.image_url ? t('替换图片') : t('上传图片')}
              </button>
              {publicSettings.background.image_url && (
                <button className="button danger" onClick={() => removeBackground().catch((reason) => setError(reason.message))}>
                  <Trash size={17} />{t('移除背景')}
                </button>
              )}
              <input
                ref={backgroundInputRef}
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => uploadBackground(event.target.files?.[0]).catch((reason) => setError(reason.message))}
              />
            </div>
            <div className="form-grid">
              <SelectField
                label="图片填充"
                value={publicSettings.background.fit}
                onChange={(fit) => setPublicSettings({
                  ...publicSettings,
                  background: { ...publicSettings.background, fit: fit as 'cover' | 'contain' }
                })}
              >
                <option value="cover">{t('覆盖区域（推荐）')}</option>
                <option value="contain">{t('完整显示')}</option>
              </SelectField>
              <SelectField
                label="裁切焦点"
                value={publicSettings.background.position}
                onChange={(position) => setPublicSettings({
                  ...publicSettings,
                  background: {
                    ...publicSettings.background,
                    position: position as 'center' | 'top' | 'bottom' | 'left' | 'right'
                  }
                })}
              >
                <option value="center">{t('居中')}</option>
                <option value="top">{t('顶部')}</option>
                <option value="bottom">{t('底部')}</option>
                <option value="left">{t('左侧')}</option>
                <option value="right">{t('右侧')}</option>
              </SelectField>
            </div>
            <RangeField
              label="背景模糊"
              value={publicSettings.background.blur}
              min={0}
              max={24}
              unit="px"
              onChange={(blur) => setPublicSettings({
                ...publicSettings,
                background: { ...publicSettings.background, blur }
              })}
            />
            <RangeField
              label="背景亮度"
              value={publicSettings.background.brightness}
              min={50}
              max={130}
              unit="%"
              onChange={(brightness) => setPublicSettings({
                ...publicSettings,
                background: { ...publicSettings.background, brightness }
              })}
            />
            <RangeField
              label="内容遮罩"
              value={publicSettings.background.overlay}
              min={0}
              max={85}
              unit="%"
              onChange={(overlay) => setPublicSettings({
                ...publicSettings,
                background: { ...publicSettings.background, overlay }
              })}
            />
            <p className="field-note">{t('支持 JPEG、PNG、WebP，最大 12 MB。图片始终保持原始宽高比，不会拉伸变形。')}</p>
            {backgroundMessage && <div className="result-box">{backgroundMessage}</div>}
            {error && <InlineError text={error} />}
            <button className="button primary" onClick={() => save().catch((reason) => setError(reason.message))}><Check size={17} />{t('保存背景设置')}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatAutoCenterLocation(
  settings: {
    center_auto_ip?: string;
    center_auto_country?: string;
    center_auto_region?: string;
    center_auto_city?: string;
    center_auto_latitude?: string;
    center_auto_longitude?: string;
    center_auto_updated_at?: string;
    center_auto_status?: string;
  },
  t: (source: string, variables?: Record<string, string | number>) => string
) {
  const location = [settings.center_auto_city, settings.center_auto_region, settings.center_auto_country]
    .filter(Boolean)
    .join(' · ');
  const coordinates = settings.center_auto_latitude && settings.center_auto_longitude
    ? `${Number(settings.center_auto_latitude).toFixed(2)}°, ${Number(settings.center_auto_longitude).toFixed(2)}°`
    : '';
  const updatedAt = settings.center_auto_updated_at
    ? `${t('最近检测')} ${new Date(settings.center_auto_updated_at).toLocaleString()}`
    : '';
  const parts = [
    location,
    settings.center_auto_ip ? `IP ${settings.center_auto_ip}` : '',
    coordinates,
    updatedAt
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : (settings.center_auto_status || t('尚未检测到中心端位置'));
}

function coordinateInput(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(5) : '';
}

function clampRefreshInterval(value: string | number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(2, Math.min(60, Math.round(parsed)));
}

function alertRuleName(key: string, t: (source: string) => string) {
  const names: Record<string, string> = {
    offline: '服务器离线',
    cpu_high: 'CPU 使用率过高',
    memory_high: '内存使用率过高',
    disk_high: '磁盘使用率过高',
    traffic_high: '月流量超额'
  };
  return t(names[key] || key);
}

function alertRuleThresholdUnit(key: string, t: (source: string) => string) {
  if (key === 'offline') return t('秒');
  if (key === 'traffic_high') return t('额度');
  return '%';
}

function alertRuleUsesDuration(key: string) {
  return key === 'cpu_high';
}

function alertRuleDurationText(key: string) {
  return key === 'offline' ? '由阈值控制' : '即时判断';
}

function renderTelegramPreview(template: string, t: (source: string) => string) {
  const source = template.trim() || defaultTelegramTemplate;
  const values: Record<string, string> = {
    state: t('触发'),
    server: 'Tokyo-01',
    rule: t('CPU 使用率过高'),
    value: '93.6',
    message: '告警：Tokyo-01 CPU 使用率过高，当前约 93.6%',
    time: new Date().toLocaleString()
  };
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    source
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  unit,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="range-field">
      <span><b>{t(label)}</b><i>{value}{unit}</i></span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  return (
    <label className="field textarea-field">
      <span>{t(label)}</span>
      <textarea value={value} placeholder={placeholder ? t(placeholder) : undefined} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function FormInput({
  label,
  value,
  onChange,
  type = 'text',
  icon,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  icon?: React.ReactNode;
  placeholder?: string;
}) {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{t(label)}</span>
      <div className={icon ? 'input-with-icon' : ''}>
        {icon}
        <input type={type} value={value} placeholder={placeholder ? t(placeholder) : undefined} onChange={(event) => onChange(event.target.value)} />
      </div>
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{t(label)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  const { t } = useI18n();
  return (
    <label className="toggle-control">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track"><i /></span>
      <b>{t(label)}</b>
    </label>
  );
}

function InlineError({ text }: { text: string }) {
  const { t } = useI18n();
  return <div className="inline-error"><WarningCircle size={18} />{t(text)}</div>;
}

function InlineNotice({ text }: { text: string }) {
  const { t } = useI18n();
  return <div className="inline-notice"><Check size={18} />{t(text)}</div>;
}

function AdminEmpty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  const { t } = useI18n();
  return (
    <div className="admin-empty">
      {icon}
      <b>{t(title)}</b>
      <span>{t(detail)}</span>
    </div>
  );
}

function replaceAt<T>(items: T[], index: number, value: T) {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}
