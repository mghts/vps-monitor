import { createContext, useContext } from 'react';
import type { Language } from './types';

const english: Record<string, string> = {
  '总览': 'Overview',
  '观测台': 'Desk',
  '服务器': 'Servers',
  '节点': 'Nodes',
  '节点簿': 'Node Book',
  'Ping 监控': 'Ping Monitor',
  '延迟线': 'Latency Lines',
  '延迟记录': 'Latency Notes',
  '全球地图': 'Global Map',
  '节点地图': 'Node Map',
  '管理设置': 'Admin Settings',
  '配置本': 'Config Book',
  '配置': 'Config',
  '索引': 'Index',
  '工具': 'Tools',
  '管理中心': 'Admin Center',
  '节点总览': 'Node Overview',
  '最后更新：{time}': 'Last updated: {time}',
  '等待首次数据': 'Waiting for data',
  '搜索节点、IP 或位置…': 'Search nodes, IPs, or locations...',
  '切换主题': 'Toggle theme',
  '切换语言': 'Switch language',
  '打开导航': 'Open navigation',
  '关闭导航': 'Close navigation',
  '关闭导航遮罩': 'Close navigation overlay',
  '查看告警': 'View alerts',
  '中心节点位置': 'Center Location',
  '中心节点': 'Center Node',
  '（中心节点）': '(Center Node)',
  '系统状态': 'System Status',
  '运行正常': 'Operational',
  '连接异常': 'Connection error',
  '在线': 'Online',
  '离线': 'Offline',
  '平均 CPU': 'Average CPU',
  '本月流量': 'Monthly Traffic',
  '活动告警': 'Active Alerts',
  '节点资源、系统信息与在线状态': 'Node resources, system information, and availability',
  '节点概览': 'Node overview',
  '节点状态筛选': 'Node status filter',
  '真实采样与聚合数据': 'Real samples and aggregates',
  '全球节点分布': 'Global Node Distribution',
  '全部节点': 'All nodes',
  '异常': 'Offline',
  '异常连接': 'Fault link',
  '搜索地区': 'Search location',
  '地图数据来源': 'Map data sources',
  '暂无可显示的节点坐标': 'No node coordinates to display',
  '节点健康': 'Node Health',
  '本次会话的实时采样趋势': 'Live sampling trends for this session',
  '健康度': 'Health',
  '节点统计': 'Node Statistics',
  '节点概况': 'Node Notes',
  '在线比例': 'Online Ratio',
  '在线节点': 'Online Nodes',
  '每 {seconds} 秒刷新一次状态': 'Status refreshes every {seconds} seconds',
  '等待 Agent 接入': 'Waiting for Agent',
  'CPU 使用率': 'CPU Usage',
  '内存使用率': 'Memory Usage',
  '磁盘使用率': 'Disk Usage',
  '平均负载': 'Average Load',
  '容量风险': 'Capacity Risk',
  '无明显风险': 'No notable risk',
  '本月总流量': 'Monthly Traffic',
  '最高负载节点': 'Highest Load Node',
  '服务器列表': 'Server List',
  '节点清单': 'Node List',
  '显示 {count} / {total} 台': 'Showing {count} / {total}',
  '每 {seconds} 秒动态刷新': 'Refreshes every {seconds} seconds',
  '未分组': 'Ungrouped',
  '分组': 'Group',
  '分组（可选）': 'Group (optional)',
  '全部分组': 'All groups',
  '显示分组名': 'Show group names',
  '亚洲节点 / 生产 / 备用': 'Asia / Production / Backup',
  '刷新间隔（秒）': 'Refresh interval (sec)',
  '刷新间隔说明': 'Controls public dashboard polling and related refresh text. Range: 2-60 seconds.',
  '控制公开面板轮询频率，节点统计和节点清单里的刷新文案会同步变化。范围：2-60 秒。': 'Controls public dashboard polling. Refresh text in node statistics and node list updates with it. Range: 2-60 seconds.',
  '全部状态': 'All statuses',
  '列表视图': 'Table view',
  '卡片视图': 'Card view',
  '没有符合条件的服务器': 'No matching servers',
  '名称': 'Name',
  '状态': 'Status',
  '内存': 'Memory',
  '磁盘': 'Disk',
  '资源': 'Resources',
  '网络': 'Network',
  '网络累计': 'Network Total',
  'Agent 上报的网卡累计计数，通常从系统启动或网卡计数器重置开始。': 'Agent-reported network interface counters, usually since system boot or counter reset.',
  '今日流量': 'Today Traffic',
  '今日': 'Today',
  '速率': 'Rate',
  '负载': 'Load',
  '位置': 'Location',
  '在线时长': 'Uptime',
  '近 24 小时在线覆盖': 'Last 24h availability',
  '未知': 'Unknown',
  '等待上报': 'Waiting for report',
  'IP 待上报': 'Waiting for IP',
  '节点详情': 'Node Details',
  '返回服务器列表': 'Back to server list',
  '资源趋势': 'Resource Trends',
  '网络速率': 'Network Throughput',
  '本月流量统计': 'Monthly Traffic',
  '系统信息': 'System Information',
  '主机名': 'Hostname',
  '操作系统': 'Operating System',
  '内核版本': 'Kernel Version',
  '架构': 'Architecture',
  '最近采样': 'Latest Sample',
  '下载速率': 'Download',
  '上传速率': 'Upload',
  '下载': 'Download',
  '上传': 'Upload',
  '月度下载': 'Monthly Download',
  '月度上传': 'Monthly Upload',
  '暂无历史指标': 'No historical metrics',
  'Agent 上报并完成分钟聚合后，这里会显示资源曲线。': 'Resource charts appear after Agent reports are aggregated.',
  '服务器选择': 'Server',
  '目标选择': 'Target',
  '全部目标': 'All targets',
  '更多目标': 'More targets',
  '收起目标': 'Collapse targets',
  '平均延迟': 'Average Latency',
  '平均丢包': 'Average Loss',
  '延迟': 'Latency',
  '丢包': 'Packet Loss',
  '延迟 + 丢包': 'Latency + Loss',
  '还没有 Ping 数据': 'No Ping data yet',
  '延迟 ms': 'Latency ms',
  '丢包率 %': 'Loss %',
  'Ping 图表显示内容': 'Ping chart display mode',
  '正在加载监控数据': 'Loading monitoring data',
  '连接中心端并读取节点状态': 'Connecting to the center and loading node status',
  '正在检查管理状态': 'Checking admin status',
  '正在建立安全会话。': 'Establishing a secure session.',
  '创建唯一管理员': 'Create the sole administrator',
  '注册成功后入口将永久关闭': 'Registration closes permanently after setup',
  '管理员用户名': 'Admin username',
  '管理员密码': 'Admin password',
  '创建管理员': 'Create administrator',
  'SETUP_TOKEN 来自中心端 `.env`，只在首次注册时使用。': 'SETUP_TOKEN comes from the center `.env` and is only used during setup.',
  '管理员登录': 'Administrator login',
  '配置节点、告警与展示设置': 'Configure nodes, alerts, and display settings',
  '用户名': 'Username',
  '密码': 'Password',
  '登录': 'Sign in',
  '重置管理员密码': 'Reset administrator password',
  '使用 SETUP_TOKEN 更新唯一管理员账号': 'Use SETUP_TOKEN to update the sole administrator account',
  '新密码': 'New password',
  '重置密码': 'Reset password',
  '返回登录': 'Back to sign in',
  '重置成功后，旧登录会话会自动失效。': 'Old sign-in sessions are invalidated after a successful reset.',
  '密码已重置，请使用新密码登录': 'Password reset. Please sign in with the new password.',
  '忘记密码？使用 SETUP_TOKEN 重置': 'Forgot password? Reset with SETUP_TOKEN',
  '返回公开面板': 'Back to public dashboard',
  '节点配置、探测任务、告警和公开页面设置': 'Node configuration, probes, alerts, and public display settings',
  '节点、延迟、告警与展示偏好': 'Nodes, latency, alerts, and display preferences',
  '演示模式：配置本使用本地示例数据，不会保存修改。': 'Demo mode: Config Book uses local sample data and does not save changes.',
  '退出登录': 'Sign out',
  'Ping 目标': 'Ping Targets',
  '告警': 'Alerts',
  '系统设置': 'System Settings',
  '站点名称': 'Site Name',
  'GeoIP': 'GeoIP',
  '自动定位节点，也可由单机设置手动覆盖。': 'Locate nodes automatically with optional per-node overrides.',
  '启用 GeoIP 定位': 'Enable GeoIP',
  '测试 IP': 'Test IP',
  '测试': 'Test',
  '更新 GeoIP': 'Update GeoIP',
  'MaxMind 本地 MMDB': 'MaxMind local MMDB',
  '公开页面': 'Public Display',
  '控制中心位置与默认展示方式。': 'Configure center location and default presentation.',
  '中心名称': 'Center name',
  '中心位置来源': 'Center location source',
  '自动检测中心端位置': 'Auto-detect center server location',
  '手动填写中心位置': 'Manually set center location',
  '自动中心位置说明': 'Auto mode uses the center server public IP and current GeoIP provider. It refreshes after server startup and periodically afterward.',
  '当前自动位置': 'Current auto location',
  '尚未检测到中心端位置': 'Center location has not been detected yet',
  '最近检测': 'Last detected',
  '中心纬度': 'Center latitude',
  '中心经度': 'Center longitude',
  '默认入口': 'Default landing view',
  '默认语言': 'Default language',
  '默认地图模式': 'Default map mode',
  '默认服务器视图': 'Default server view',
  '中文': 'Chinese',
  '英文': 'English',
  '卡片': 'Cards',
  '列表': 'Table',
  '地图': 'Map',
  '保存系统设置': 'Save system settings',
  '自定义背景': 'Custom Background',
  '等比例显示图片，可调节裁切位置、模糊度、亮度和内容遮罩。': 'Preserve aspect ratio and adjust crop, blur, brightness, and overlay.',
  '尚未上传背景图片': 'No background image uploaded',
  '启用自定义背景': 'Enable custom background',
  '上传图片': 'Upload image',
  '替换图片': 'Replace image',
  '正在上传': 'Uploading',
  '移除背景': 'Remove background',
  '图片填充': 'Image fit',
  '裁切焦点': 'Crop focus',
  '覆盖区域（推荐）': 'Cover area (recommended)',
  '完整显示': 'Contain',
  '居中': 'Center',
  '顶部': 'Top',
  '底部': 'Bottom',
  '左侧': 'Left',
  '右侧': 'Right',
  '背景模糊': 'Background blur',
  '背景亮度': 'Background brightness',
  '内容遮罩': 'Content overlay',
  '支持 JPEG、PNG、WebP，最大 12 MB。图片始终保持原始宽高比，不会拉伸变形。': 'JPEG, PNG, and WebP up to 12 MB. Images keep their original aspect ratio.',
  '保存背景设置': 'Save background settings',
  '背景图片已上传并应用': 'Background uploaded and applied',
  '自定义背景已移除': 'Custom background removed'
  ,'立即刷新': 'Refresh now'
  ,'复位到中心节点': 'Reset to center node'
  ,'未知位置': 'Unknown location'
  ,'台节点': 'nodes'
  ,'部分异常': 'Partial issue'
  ,'选择要查看的节点': 'Choose a node to open'
  ,'正在加载三维地球': 'Loading 3D globe'
  ,'三维地球纹理加载失败': 'Failed to load globe texture'
  ,'等待具有经纬度的节点接入': 'Waiting for nodes with coordinates'
  ,'需要关注': 'Needs attention'
  ,'添加服务器': 'Add Server'
  ,'创建后会生成仅展示一次的独立 Agent token 与安装命令。': 'A one-time Agent token and installation commands will be generated.'
  ,'例如 Tokyo-01': 'Example: Tokyo-01'
  ,'公网 IP（可选，用于预定位）': 'Public IP (optional, for pre-location)'
  ,'Agent 安装命令': 'Agent Installation Commands'
  ,'Token 明文只在本次显示，请立即保存或执行。': 'The plaintext token is shown only once. Save or run it now.'
  ,'还没有服务器': 'No servers yet'
  ,'添加第一台 VPS 后，安装命令会显示在这里。': 'Installation commands appear after adding the first VPS.'
  ,'等待 Agent 上报': 'Waiting for Agent report'
  ,'系统未知': 'Unknown system'
  ,'未定位': 'Not located'
  ,'基础信息': 'Basic Information'
  ,'节点名称、备注与展示状态': 'Node name, notes, and visibility'
  ,'备注': 'Notes'
  ,'Ping 目标策略': 'Ping Target Policy'
  ,'继承全局并追加': 'Inherit global and append'
  ,'仅使用单机目标': 'Use node-specific targets only'
  ,'启用 Agent 接入': 'Enable Agent access'
  ,'公开页面展示': 'Show on public dashboard'
  ,'关闭 Agent 接入后，该节点 token 会被拒绝，公开页和告警也会忽略此节点。': 'When Agent access is disabled, this node token is rejected, and the public dashboard and alerts ignore the node.'
  ,'流量额度': 'Traffic Quota'
  ,'按自然周期统计 Agent 累计计数': 'Track Agent counters by billing cycle'
  ,'月流量额度（GB）': 'Monthly traffic quota (GB)'
  ,'重置日（1–28）': 'Reset day (1–28)'
  ,'统计方向': 'Traffic direction'
  ,'上传 + 下载': 'Upload + Download'
  ,'仅下载': 'Download only'
  ,'仅上传': 'Upload only'
  ,'位置覆盖': 'Location Override'
  ,'留空时使用 GeoIP 自动定位': 'Leave blank to use GeoIP'
  ,'国家/地区': 'Country/Region'
  ,'省/州': 'State/Region'
  ,'城市': 'City'
  ,'纬度': 'Latitude'
  ,'经度': 'Longitude'
  ,'GeoIP 识别：{location}': 'GeoIP result: {location}'
  ,'使用 GeoIP 填入': 'Fill from GeoIP'
  ,'清空覆盖': 'Clear override'
  ,'亚洲节点': 'Asia Nodes'
  ,'美洲节点': 'Americas Nodes'
  ,'欧洲节点': 'Europe Nodes'
  ,'大洋洲节点': 'Oceania Nodes'
  ,'中东节点': 'Middle East Nodes'
  ,'日本': 'Japan'
  ,'东京': 'Tokyo'
  ,'美国': 'United States'
  ,'洛杉矶': 'Los Angeles'
  ,'德国': 'Germany'
  ,'法兰克福': 'Frankfurt'
  ,'新加坡': 'Singapore'
  ,'澳大利亚': 'Australia'
  ,'悉尼': 'Sydney'
  ,'中国': 'China'
  ,'香港': 'Hong Kong'
  ,'阿联酋': 'United Arab Emirates'
  ,'迪拜': 'Dubai'
  ,'巴西': 'Brazil'
  ,'圣保罗': 'Sao Paulo'
  ,'保存修改': 'Save changes'
  ,'重置 token': 'Rotate token'
  ,'删除服务器': 'Delete server'
  ,'卸载 Agent': 'Uninstall Agent'
  ,'分别提供 Docker 与 systemd 版本。': 'Docker and systemd variants are provided.'
  ,'复制命令': 'Copy command'
  ,'添加 Ping 目标': 'Add Ping Target'
  ,'全局最多 20 个，单台服务器可额外配置 20 个。': 'Up to 20 global targets and 20 additional targets per server.'
  ,'作用范围': 'Scope'
  ,'全局目标': 'Global target'
  ,'单机目标': 'Server target'
  ,'选择服务器': 'Select server'
  ,'目标名称': 'Target name'
  ,'协议': 'Protocol'
  ,'TCP 端口': 'TCP port'
  ,'间隔（秒）': 'Interval (seconds)'
  ,'超时（ms）': 'Timeout (ms)'
  ,'创建后立即启用': 'Enable immediately'
  ,'添加目标': 'Add target'
  ,'已配置目标': 'Configured Targets'
  ,'{count} 个探测任务': '{count} probe tasks'
  ,'单机': 'Server'
  ,'全局': 'Global'
  ,'删除目标': 'Delete target'
  ,'没有 Ping 目标': 'No Ping targets'
  ,'创建目标后，Agent 会在下一次拉取配置时开始探测。': 'The Agent starts probing after its next configuration refresh.'
  ,'告警规则': 'Alert Rules'
  ,'持续时间用于避免短暂波动触发通知。': 'Durations prevent brief spikes from triggering alerts.'
  ,'规则': 'Rule'
  ,'阈值': 'Threshold'
  ,'触发阈值': 'Trigger threshold'
  ,'持续时间': 'Duration'
  ,'重复通知': 'Repeat notice'
  ,'秒': 'sec'
  ,'额度': 'quota'
  ,'由阈值控制': 'By threshold'
  ,'即时判断': 'Instant'
  ,'服务器离线': 'Server offline'
  ,'CPU 使用率过高': 'High CPU usage'
  ,'内存使用率过高': 'High memory usage'
  ,'磁盘使用率过高': 'High disk usage'
  ,'月流量超额': 'Monthly traffic exceeded'
  ,'阈值表示离线超过多少秒后触发。': 'Threshold means how many offline seconds trigger the alert.'
  ,'按持续时间窗口计算平均 CPU。': 'Average CPU is calculated over the duration window.'
  ,'按最近一次上报的内存比例判断。': 'Uses the latest reported memory ratio.'
  ,'按最近一次上报的磁盘比例判断。': 'Uses the latest reported disk ratio.'
  ,'按每台服务器配置的月流量额度判断。': 'Uses each server monthly traffic quota.'
  ,'满足条件后触发告警。': 'Triggers when the condition is met.'
  ,'Telegram 通知': 'Telegram Notifications'
  ,'全局 Bot 与 Chat ID': 'Global Bot and Chat ID'
  ,'启用 Telegram 告警': 'Enable Telegram alerts'
  ,'通知模板': 'Message template'
  ,'Telegram 模板变量说明': 'Available variables: {state}, {server}, {rule}, {value}, {message}, {time}.'
  ,'恢复默认模板': 'Restore default template'
  ,'通知预览': 'Notification preview'
  ,'触发': 'Triggered'
  ,'保存告警设置': 'Save alert settings'
  ,'告警记录': 'Alert History'
  ,'最近 300 条，历史保留 30 天': 'Latest 300 records, retained for 30 days'
  ,'活动中': 'Active'
  ,'已恢复': 'Resolved'
  ,'暂无告警记录': 'No alert history'
  ,'所有节点状态正常时，这里会保持安静。': 'This area stays quiet while all nodes are healthy.'
};

export function translate(language: Language, source: string, variables: Record<string, string | number> = {}) {
  const template = language === 'en' ? english[source] || source : source;
  return Object.entries(variables).reduce(
    (value, [key, replacement]) => value.split(`{${key}}`).join(String(replacement)),
    template
  );
}

type TranslateFunction = (source: string, variables?: Record<string, string | number>) => string;

const I18nContext = createContext<{ language: Language; t: TranslateFunction }>({
  language: 'zh',
  t: (source, variables) => translate('zh', source, variables)
});

export function I18nProvider({ language, children }: { language: Language; children: React.ReactNode }) {
  return (
    <I18nContext.Provider value={{ language, t: (source, variables) => translate(language, source, variables) }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
