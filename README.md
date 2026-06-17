# VPS Monitor

Docker 部署的中心端 + Agent 服务器探针。第一版支持在线状态、CPU、内存、磁盘、网络计数、月流量、uptime、负载、脱敏 IP、系统信息、ICMP/TCP Ping、公开面板、管理员配置和 Telegram 告警。

## 部署入口

如果你要把中心端部署到一台真实 VPS，并通过域名 + Nginx + HTTPS 对外访问，请优先看：

- [VPS 中心端部署教程](docs/vps-deploy.md)

生产部署只需要把项目根目录的 `docker-compose.yml` 和 `.env` 放到中心端 VPS 的 `/docker/vps-monitor`，镜像从 Docker Hub 或其他镜像仓库拉取，不需要上传源码目录。

如果你在 Apple Silicon Mac 上构建要部署到 VPS 的镜像，请使用部署教程里的 `docker buildx build --platform linux/amd64,linux/arm64 --push`，中心端镜像和 Agent 镜像都要这样构建。不要直接用普通 `docker build` 推生产镜像，否则很容易把 `linux/arm64` 镜像推到 Docker Hub，导致 amd64 VPS 启动时报 `exec format error`。

## Docker Hub 镜像发布

Docker Hub 账号、仓库和 Access Token 需要你自己创建，因为这是你的账号凭据，不应该交给项目保存。创建好以后，本项目提供的 GitHub Actions 会自动构建并发布多架构镜像，你不需要在 Mac 上手动 build 镜像。

你需要做的只有：

1. 在 Docker Hub 创建两个公开仓库：`vps-monitor-server` 和 `vps-monitor-agent`。
2. 在 Docker Hub 创建一个 Access Token。
3. 在 GitHub 仓库的 Actions Secrets 添加 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`。
4. 运行 GitHub Actions 里的 `Publish Docker Images` workflow，版本填 `v0.1.0`。
5. 在 VPS 的 `.env` 里填写：

```env
SERVER_IMAGE=<你的 DockerHub 用户名>/vps-monitor-server:v0.1.0
AGENT_IMAGE=<你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```

完整傻瓜式步骤见 [VPS 中心端部署教程](docs/vps-deploy.md) 的“准备镜像”部分。

## 快速本地验证

```bash
cp deploy/env.example .env
# 修改 .env：POSTGRES_PASSWORD、SETUP_TOKEN、BASE_URL 必须换成你自己的值
docker build -f deploy/server.Dockerfile -t vps-monitor-server:local .
docker build -f deploy/agent.Dockerfile -t vps-monitor-agent:local .
# 修改 .env：SERVER_IMAGE=vps-monitor-server:local，AGENT_IMAGE=vps-monitor-agent:local
docker compose up -d
```

访问 `BASE_URL` 后，打开“管理”，首次创建管理员时输入 `.env` 里的 `SETUP_TOKEN`。管理员创建后注册入口会关闭。

如果忘记管理员密码，可以在登录页点击“忘记密码？使用 SETUP_TOKEN 重置”，输入中心端 `.env` 里的 `SETUP_TOKEN` 后重新设置唯一管理员账号和密码。重置成功后旧登录会话会自动失效。

## GeoIP 定位

中心端默认启用 GeoIP，并使用 `geojs.io` 作为无需账号的在线 Provider。管理员登录后可以在“告警与公开设置”里的 GeoIP 区域切换：

- `geojs.io`：默认选项，HTTPS，无需账号。
- `ipinfo.io`：HTTPS，无需账号，但公开接口有请求限制。
- `ip-api.com`：无需账号，但免费接口只支持 HTTP 且有限流。
- `MaxMind 本地 MMDB`：点击“更新 GeoIP”后自动下载 City 级 MMDB 到本地持久化目录，也支持自定义下载 URL。
- `None`：关闭自动 GeoIP。

后台的“更新 GeoIP”按钮会用当前 Provider 重新刷新已接入服务器的 GeoIP 缓存；如果当前 Provider 是 MaxMind，会先下载并热加载 MMDB，再刷新缓存。“测试”可以用指定 IP 验证当前 Provider 返回结果。

Docker 部署默认把 MMDB 保存到容器内 `/data/GeoLite2-City.mmdb`，对应项目目录的 `data/GeoLite2-City.mmdb`。默认下载 URL 是无需账号的 `https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz`，也可以在后台改成自己的 MMDB 或 `.mmdb.gz` 下载源。

中心节点位置默认使用“自动检测中心端位置”：中心端启动后会检测自身公网 IP，并使用当前 GeoIP Provider 定位。公开地图和左下角中心节点卡片会使用这个自动位置；如果你把中心端迁移到另一台 VPS，中心服务启动后会重新检测并更新位置。管理员也可以在“公开页面”设置里改为“手动填写中心位置”，手动经纬度会优先生效。

如果你想手动放置数据库，也可以把 MaxMind GeoLite2 City 或兼容的 MMDB 文件放到项目的 `data/GeoLite2-City.mmdb` 后重启中心端：

```bash
mkdir -p data
# 将 GeoLite2-City.mmdb 放入 data/GeoLite2-City.mmdb
docker compose restart server
```

每台 VPS 都可以在管理后台手动填写国家/地区、城市和经纬度；公开地图优先使用手动坐标，未填写时才使用 GeoIP 自动位置。

## 自定义背景

管理员可以在“管理设置 → 系统设置 → 自定义背景”上传 JPEG、PNG 或 WebP 图片，并设置：

- 覆盖区域或完整显示，图片始终保持原始宽高比。
- 裁切焦点、模糊度、亮度和内容遮罩强度。
- 是否在公开页和管理后台启用该背景。

上传文件默认保存在容器内 `/data/backgrounds`，对应部署目录的 `data/backgrounds/`。该目录已经通过 `docker-compose.yml` 持久化，更新或重建中心端容器不会丢失背景图片。

## 接入 Agent

在管理后台添加服务器后，页面会展示一次性安装命令。第一版同时提供 Docker 版和非 Docker/systemd 版：

添加服务器时可以先填写公网 IP。中心端会立刻按当前 GeoIP Provider 尝试预定位；Agent 后续上线并上报真实公网 IP 后，中心端仍会自动刷新 GeoIP。每台 VPS 的“位置覆盖”留空时使用 GeoIP 自动位置；如果识别不准，可以点击“使用 GeoIP 填入”后手动修正并保存。

- 非 Docker/systemd 版默认生成类似下面的短命令，脚本建议来自你的 GitHub 仓库：

```bash
wget -qO- https://raw.githubusercontent.com/mghts/vps-monitor/refs/heads/main/agent/install.sh | sudo bash -s -- -e https://monitor.example.com -t <agent-token>
```

- 安装脚本会自动识别目标 VPS 架构，并从 `AGENT_RELEASE_REPOSITORY` 指向的 GitHub Releases 下载 `vps-monitor-agent-linux-amd64`、`vps-monitor-agent-linux-arm64` 或 `vps-monitor-agent-linux-armv7`，安装到 `/opt/vps-monitor-agent/` 并创建 systemd 服务。
- Docker 版使用同一个安装脚本，但命令会追加 `-m docker -i <agent-image>`，仍然会自动检测目标 VPS 架构并拉取对应平台镜像。
- 卸载命令同样使用这个 GitHub 安装脚本的 `uninstall` 子命令，后台会分别提供 Docker 和 systemd 两种卸载命令。

Docker 版 Agent 参数：

- 安装脚本会自动检测目标 VPS 架构，并用 `docker pull --platform ...` 拉取 Agent 镜像；如果镜像缺少对应架构，会在安装阶段直接失败，避免生成无法启动的容器。
- `--network host`：读取主机网络计数并减少 NAT 干扰。
- `--pid host`：更贴近主机运行环境。
- `--cap-add NET_RAW`：允许 ICMP Ping。
- `-v /:/host:ro`：读取主机磁盘和系统信息。

如果安装命令丢失，需要在管理后台“重置 token”重新生成。数据库只保存 token 哈希，明文 token 不会再次展示。

## 本地开发

中心端：

```bash
docker run --rm --name vps-monitor-postgres -p 5432:5432 \
  -e POSTGRES_DB=vps_monitor \
  -e POSTGRES_USER=vps_monitor \
  -e POSTGRES_PASSWORD=dev-password \
  postgres:16-alpine
export DATABASE_URL=postgres://vps_monitor:dev-password@127.0.0.1:5432/vps_monitor
export SETUP_TOKEN=dev-setup-token
export BASE_URL=http://127.0.0.1:8080
cargo run -p vps-monitor-server
```

前端：

```bash
cd web
npm install
npm run dev
```

Agent：

```bash
export VPS_MONITOR_SERVER_URL=https://monitor.example.com
export VPS_MONITOR_AGENT_TOKEN=your-agent-token
cargo run -p vps-monitor-agent
```

## 安全说明

- 公开页面只展示脱敏 IP 和只读监控数据。
- 管理 API 使用 HttpOnly + SameSite=Strict Cookie 登录态。
- 每台服务器独立 Agent token。
- 管理员账号只允许创建一个，首次注册必须提供 `SETUP_TOKEN`。
- 忘记管理员密码时，可以通过登录页的 `SETUP_TOKEN` 重置入口更新唯一管理员账号，旧会话会被清理。
- 建议中心端只通过 HTTPS 反向代理对外服务，并设置强密码。
