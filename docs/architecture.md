# 架构说明

## 组件

- `server`：Rust/Axum API，负责公开面板、管理后台、Agent 接入、数据写入、历史清理和告警。
- `agent`：Rust Linux Agent，Docker 运行，每 2 秒上报系统指标，并按中心端配置执行 Ping。
- `web`：React + TypeScript 前端，由中心端容器作为静态文件提供。
- `postgres`：保存配置、指标、Ping 结果、聚合数据和告警历史。

## GeoIP 与位置

中心端支持可切换 GeoIP Provider，配置保存在 `settings.geoip`：

- `geojs`：默认 Provider，通过 `geojs.io` 在线查询，无需账号。
- `ipinfo`：通过 `ipinfo.io` 在线查询，无需账号，但公开接口有请求限制。
- `ip-api`：通过 `ip-api.com` 在线查询，无需账号；免费接口是 HTTP 且有限流。
- `maxmind`：读取 `GEOIP_MMDB_PATH` 指向的本地 MMDB 文件，Docker 部署时默认是 `/data/GeoLite2-City.mmdb`；后台“更新 GeoIP”会从 `download_url` 下载 `.mmdb` 或 `.mmdb.gz`、验证后热加载。
- `none`：关闭自动 GeoIP。

Agent 上报公网 IP 后，中心端会按当前 Provider 查询并把自动定位结果缓存到 `geoip_*` 字段。后台的“更新 GeoIP”会用当前 Provider 批量刷新已有服务器缓存；MaxMind Provider 会先更新本地数据库。“测试 GeoIP”只查询指定 IP，不修改服务器数据。

管理员手动填写的位置保存在 `location_*`、`latitude`、`longitude` 字段。公开 API 返回的 `location` 是最终展示位置：手动经纬度优先，否则使用 GeoIP 经纬度；管理 API 额外返回 `manual_location` 和 `geoip_location`，方便区分来源。

## Agent 通信

Agent 使用 HTTPS 主动推送，所有请求携带：

```http
Authorization: Bearer <agent-token>
```

中心端只保存 token 的 SHA-256 哈希。Agent 可访问：

- `GET /api/agent/config`
- `POST /api/agent/metrics`

## 历史数据策略

- `metric_samples`：原始系统指标，清理到 24 小时。
- `metric_rollups_1m`：系统指标 1 分钟聚合，保留 30 天。
- `ping_samples`：原始 Ping 点，保留 7 天。
- `ping_rollups_5m`：Ping 5 分钟聚合，保留 30 天。
- `ping_rollups_1h`：Ping 1 小时聚合，保留 365 天。
- `alerts`：已恢复告警保留 30 天。

## 权限边界

公开 API 只返回公开可见服务器、脱敏 IP 和只读数据。管理 API 全部放在 `/api/admin/*` 下，需要管理员登录。Agent API 只能通过独立 token 写入对应服务器的数据。
