# VPS 中心端部署教程

这份教程按生产部署写：中心端 VPS 不上传源码，只放两个文件：

- `/docker/vps-monitor/docker-compose.yml`
- `/docker/vps-monitor/.env`

镜像从 Docker Hub 或其他镜像仓库拉取。源码和构建工作留在 Mac、CI 或你的构建服务器上。

以下示例默认：

- 中心端域名：`monitor.example.com`
- 中心端目录：`/docker/vps-monitor`
- 中心端服务监听：`127.0.0.1:8080`
- 系统：Ubuntu 22.04/24.04 或 Debian 12
- 反向代理：Nginx + HTTPS

## 1. 准备镜像

你需要先把两个镜像发布到 Docker Hub：

- `<你的 DockerHub 用户名>/vps-monitor-server:v0.1.0`
- `<你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0`

Docker Hub 的账号、仓库和 Access Token 需要你自己创建。原因很简单：这是你的账号凭据，不能写进项目，也不应该交给别人保管。你创建好 token 后，GitHub Actions 会自动帮你构建并推送镜像。

### 推荐方式：GitHub Actions 自动发布

这种方式最省心，也最不容易再遇到 `exec format error`，因为 workflow 会一次性构建 `linux/amd64` 和 `linux/arm64` 两种镜像。

#### 1.1 在 Docker Hub 创建仓库

打开 Docker Hub，进入 `Repositories`，创建两个公开仓库：

```text
vps-monitor-server
vps-monitor-agent
```

假设你的 Docker Hub 用户名是 `alice`，那么最终镜像名就是：

```text
alice/vps-monitor-server:v0.1.0
alice/vps-monitor-agent:v0.1.0
```

仓库建议设为 `Public`。如果你设为 `Private`，中心端 VPS 和各个 Agent VPS 拉取镜像前都需要先 `docker login`，部署会麻烦很多。

#### 1.2 创建 Docker Hub Access Token

在 Docker Hub：

1. 点击右上角头像。
2. 进入 `Account settings`。
3. 找到 `Personal access tokens`。
4. 创建新 token，例如命名为 `github-vps-monitor`。
5. 权限至少选择 `Read & Write`。
6. 创建后立刻复制 token。

这个 token 只显示一次。如果关掉页面后忘了，就删除旧 token 再创建一个新的。

#### 1.3 在 GitHub 添加 Actions Secrets

进入你的 GitHub 仓库：

```text
https://github.com/mghts/vps-monitor
```

依次打开：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

添加两个 Secret：

```text
DOCKERHUB_USERNAME = 你的 Docker Hub 用户名
DOCKERHUB_TOKEN    = 刚才复制的 Docker Hub Access Token
```

注意这里填的是 Docker Hub 的用户名，不是 GitHub 用户名。

#### 1.4 运行镜像发布 workflow

进入 GitHub 仓库的 `Actions` 页面，左侧选择：

```text
Publish Docker Images
```

点击 `Run workflow`：

```text
version     = v0.1.0
push_latest = 勾选
```

然后点击绿色的 `Run workflow` 按钮，等待任务完成。

注意：本项目的 `v0.1.0` tag 已经创建过一次。因为 Docker Hub 发布 workflow 是后面新增的，所以第一次发布 `v0.1.0` 镜像时需要你手动点一次 `Run workflow`。以后如果推送新的 `v*` tag，例如 `v0.1.1`，workflow 会自动发布对应版本镜像。

#### 1.5 检查镜像是否发布成功

在 Mac 或任意装了 Docker 的机器上执行：

```bash
docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-server:v0.1.0
docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```

输出里应该能看到：

```text
linux/amd64
linux/arm64
```

如果你的 VPS 是普通 x86_64，必须至少包含 `linux/amd64`。如果你的 VPS 是 ARM 服务器，必须包含 `linux/arm64`。

#### 1.6 在 VPS 的 `.env` 里使用版本镜像

后面创建 `.env` 时，把镜像写成固定版本：

```env
SERVER_IMAGE=<你的 DockerHub 用户名>/vps-monitor-server:v0.1.0
AGENT_IMAGE=<你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```

不建议生产环境长期使用 `latest`。`latest` 适合测试，但一旦你以后发布新镜像，VPS 重新 `docker compose pull` 时可能直接升级，出了问题不好回滚。固定 `v0.1.0` 这种版本号更稳。

### 备用方式：本地手动 buildx 推送

如果你暂时不想用 GitHub Actions，也可以在 Mac 本地手动构建并推送镜像。

如果你是在 Apple Silicon Mac，也就是 M1/M2/M3/M4 上构建镜像，生产环境不要直接用普通 `docker build`。普通构建会默认生成 `linux/arm64` 镜像，而大多数 VPS 是 `linux/amd64`，部署时会出现：

```text
The requested image's platform (linux/arm64) does not match the detected host platform (linux/amd64/v3)
exec /usr/local/bin/vps-monitor-server: exec format error
```

推荐直接构建并推送多架构镜像：

```bash
docker login

docker buildx create --use --name vps-monitor-builder 2>/dev/null || docker buildx use vps-monitor-builder
docker buildx inspect --bootstrap

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/server.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-server:v0.1.0 \
  -t <你的 DockerHub 用户名>/vps-monitor-server:latest \
  --push \
  .

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/agent.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0 \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:latest \
  --push \
  .

docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-server:v0.1.0
docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```

检查输出里应该同时能看到 `linux/amd64` 和 `linux/arm64`。如果你的 VPS 是普通 x86_64，一定要至少包含 `linux/amd64`。

如果你确定所有 VPS 都是普通 x86_64/amd64，也可以只构建 amd64 镜像：

```bash
docker login

docker buildx build \
  --platform linux/amd64 \
  -f deploy/server.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-server:v0.1.0 \
  --push \
  .

docker buildx build \
  --platform linux/amd64 \
  -f deploy/agent.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0 \
  --push \
  .

docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```

如果你还想用非 Docker/systemd Agent，不需要在中心端放二进制文件。推荐把本项目推到 GitHub，然后用本项目自带的 `.github/workflows/release-agent.yml` 自动编译并发布 GitHub Releases。中心端只需要在 `.env` 里配置 GitHub raw 安装脚本地址和 Releases 仓库名。

## 2. 安装 Docker 与 Nginx

登录中心端 VPS：

```bash
ssh root@<中心端 VPS IP>
```

安装基础组件：

```bash
apt update
apt install -y ca-certificates curl gnupg nginx ufw
```

安装 Docker Engine 和 Compose 插件，建议按 Docker 官方文档操作：

- [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Debian](https://docs.docker.com/engine/install/debian/)

验证：

```bash
docker --version
docker compose version
```

防火墙建议：

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

## 3. 创建容器目录

```bash
mkdir -p /docker/vps-monitor
cd /docker/vps-monitor
```

这个目录会保存：

- `postgres/`：PostgreSQL 数据。
- `data/`：GeoIP MMDB、网页自定义背景等中心端数据。
- `docker-compose.yml` 和 `.env`：部署配置。

## 4. 放置 `docker-compose.yml`

把项目根目录的 `docker-compose.yml` 上传到中心端：

```bash
scp docker-compose.yml root@<中心端 VPS IP>:/docker/vps-monitor/docker-compose.yml
```

或者在 VPS 上用编辑器创建同名文件，内容使用本项目根目录的 `docker-compose.yml`。

## 5. 创建 `.env`

在中心端 VPS：

```bash
cd /docker/vps-monitor
nano .env
```

示例：

```env
POSTGRES_DB=vps_monitor
POSTGRES_USER=vps_monitor
POSTGRES_PASSWORD=换成超长随机数据库密码
SETUP_TOKEN=换成超长随机首次注册令牌
BASE_URL=https://monitor.example.com
SERVER_PORT=127.0.0.1:8080

SERVER_IMAGE=<你的 DockerHub 用户名>/vps-monitor-server:v0.1.0
AGENT_IMAGE=<你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0

# Agent 一键安装脚本，建议放在你的 GitHub 仓库。
AGENT_INSTALLER_URL=https://raw.githubusercontent.com/mghts/vps-monitor/refs/heads/main/agent/install.sh
# systemd/native Agent 二进制从这个 GitHub Releases 仓库下载。
AGENT_RELEASE_REPOSITORY=
# latest 表示使用最新 release；也可以固定为 v0.1.0。
AGENT_RELEASE_TAG=latest

GEOIP_MMDB_PATH=/data/GeoLite2-City.mmdb
BACKGROUND_DIR=/data/backgrounds
COOKIE_SECURE=true
RUST_LOG=info
```

关键点：

- `SERVER_IMAGE` 是中心端镜像，生产环境建议写固定版本号。
- `AGENT_IMAGE` 是 Docker 版 Agent 一键安装命令使用的镜像，建议和中心端使用同一个版本号。
- `AGENT_INSTALLER_URL` 是后台生成 Agent 安装命令时使用的脚本地址，推荐使用 GitHub raw 链接。
- `AGENT_RELEASE_REPOSITORY` 是 systemd/native Agent 二进制所在的 GitHub Releases 仓库。当前 `agent/install.sh` 已默认使用 `mghts/vps-monitor`，所以这里可以留空以保持安装命令更短。
- `AGENT_RELEASE_TAG=latest` 表示安装最新 release；如果你希望所有节点固定版本，可以写成 `v0.1.0`。
- 当前 `agent/install.sh` 顶部的 `DEFAULT_RELEASE_REPO` 已固定为 `mghts/vps-monitor`。因此中心端 `.env` 里的 `AGENT_RELEASE_REPOSITORY` 可以留空，后台生成的 systemd 安装命令会保持 `wget ...install.sh | sudo bash -s -- -e ... -t ...` 这种 Komari 风格。
- `SERVER_PORT=127.0.0.1:8080` 表示中心端只暴露给本机 Nginx。
- `GEOIP_MMDB_PATH` 保持默认即可，后台 MaxMind 更新会把 MMDB 保存到 `/docker/vps-monitor/data/GeoLite2-City.mmdb`。
- `BACKGROUND_DIR` 保持默认即可，后台上传的自定义背景会保存到 `/docker/vps-monitor/data/backgrounds/`。

生成随机密码/token：

```bash
openssl rand -base64 32
```

## 6. 启动中心端

```bash
cd /docker/vps-monitor
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f server
```

访问 `BASE_URL`，进入管理页，首次创建管理员时输入 `.env` 里的 `SETUP_TOKEN`。

如果后续忘记管理员密码，进入管理登录页点击“忘记密码？使用 SETUP_TOKEN 重置”，使用 VPS 上 `.env` 中的 `SETUP_TOKEN` 设置新的管理员用户名和密码。重置后旧登录会话会自动失效。

## 7. 配置 Nginx 反向代理

创建配置：

```bash
nano /etc/nginx/sites-available/vps-monitor.conf
```

HTTP 版本：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name monitor.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用：

```bash
ln -s /etc/nginx/sites-available/vps-monitor.conf /etc/nginx/sites-enabled/vps-monitor.conf
nginx -t
systemctl reload nginx
```

签发 HTTPS：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d monitor.example.com
```

## 8. Agent 安装方式

在管理后台添加服务器后，会显示两种安装命令：

添加服务器时可以先填公网 IP。中心端会按当前 GeoIP Provider 预定位该节点；Agent 后续上线并上报真实公网 IP 后，会继续自动刷新 GeoIP。如果识别不准，进入该节点的“位置覆盖”，点击“使用 GeoIP 填入”后手动修正国家、城市或经纬度并保存。

- 非 Docker/systemd 版：后台会生成类似下面的短命令。脚本来自你的 GitHub 仓库，安装时会自动检测目标 VPS 架构，并从 GitHub Releases 下载对应 Agent 二进制：

```bash
wget -qO- https://raw.githubusercontent.com/mghts/vps-monitor/refs/heads/main/agent/install.sh | sudo bash -s -- -e https://monitor.example.com -t <agent-token>
```

- Docker 版：使用同一个安装脚本，但后台命令会追加 `-m docker -i <agent-image>`。脚本会自动检测当前 VPS 架构，并用 `docker pull --platform ...` 拉取和运行 `AGENT_IMAGE`，挂载 `/:/host:ro`，支持 ICMP Ping 的 `NET_RAW` 权限。
- 卸载命令同样使用 GitHub 安装脚本的 `uninstall` 子命令，后台会分别提供 Docker 和 systemd 两种卸载命令。

如果你之后把 `agent/install.sh` 里的 `DEFAULT_RELEASE_REPO` 改回空值，后台会在 systemd 安装命令后追加 `-r <AGENT_RELEASE_REPOSITORY>`。这同样可用，只是命令会比 Komari 示例多一个仓库参数。

### GitHub Releases 编译 Agent 二进制

项目已经包含 `.github/workflows/release-agent.yml`。你把代码推到 GitHub 后，可以用两种方式发布二进制：

方式一：推送 tag 自动发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

方式二：在 GitHub 仓库页面进入 `Actions -> Release Agent Binaries -> Run workflow`，填写 tag，例如 `v0.1.0`。

Workflow 会生成并上传这些 release assets：

```text
vps-monitor-agent-linux-amd64
vps-monitor-agent-linux-amd64.sha256
vps-monitor-agent-linux-arm64
vps-monitor-agent-linux-arm64.sha256
vps-monitor-agent-linux-armv7
vps-monitor-agent-linux-armv7.sha256
```

安装脚本会根据 `uname -m` 自动选择：

```text
x86_64  -> vps-monitor-agent-linux-amd64
aarch64 -> vps-monitor-agent-linux-arm64
armv7l  -> vps-monitor-agent-linux-armv7
```

如果你不使用 GitHub Actions，也可以手动编译二进制后上传到 GitHub Release。最稳妥的方式是在对应 Linux 架构机器上编译：

```bash
cargo build --release -p vps-monitor-agent
cp target/release/vps-monitor-agent vps-monitor-agent-linux-amd64
```

如果在 amd64 Linux 上需要交叉编译，可以使用 `cross`：

```bash
cargo install cross --locked
cross build --release -p vps-monitor-agent --target x86_64-unknown-linux-musl
cross build --release -p vps-monitor-agent --target aarch64-unknown-linux-musl
cross build --release -p vps-monitor-agent --target armv7-unknown-linux-musleabihf

cp target/x86_64-unknown-linux-musl/release/vps-monitor-agent vps-monitor-agent-linux-amd64
cp target/aarch64-unknown-linux-musl/release/vps-monitor-agent vps-monitor-agent-linux-arm64
cp target/armv7-unknown-linux-musleabihf/release/vps-monitor-agent vps-monitor-agent-linux-armv7
chmod +x vps-monitor-agent-linux-*
```

Apple Silicon Mac 上不建议直接把本地编译产物当 Linux Agent 用，因为 macOS 产物不能在 Linux VPS 上运行。要么用 GitHub Actions，要么在 Linux 构建环境里编译。

修改 `.env` 的 `AGENT_INSTALLER_URL`、`AGENT_RELEASE_REPOSITORY` 或 `AGENT_RELEASE_TAG` 后，需要重建中心端容器，让后台新生成的安装命令生效：

```bash
cd /docker/vps-monitor
docker compose up -d
```

验证 release 下载地址：

```bash
curl -I https://github.com/mghts/vps-monitor/releases/latest/download/vps-monitor-agent-linux-amd64
curl -L https://github.com/mghts/vps-monitor/releases/latest/download/vps-monitor-agent-linux-amd64 -o /tmp/vps-monitor-agent
file /tmp/vps-monitor-agent
```

`amd64` 文件应显示类似 `x86-64`，`arm64` 文件应显示类似 `aarch64`。如果你使用的是私有仓库，目标 VPS 必须能访问这些 release assets；否则建议把 Agent 仓库设为公开，或单独建立一个公开的 agent release 仓库。

## 9. GeoIP

默认 Provider 是 `geojs.io`，不需要账号。

中心节点位置默认是自动模式：中心端启动后会检测自身公网 IP，并通过当前 GeoIP Provider 得到国家、城市和经纬度。公开页左下角中心节点卡片、全球地图中的中心点和连接线都会使用这个位置。迁移到另一台中心端 VPS 后，只要中心服务重新启动，就会重新检测新的部署位置；公开页请求也会在缓存超过约 6 小时后自动刷新一次。

如果自动定位不符合你的实际机房位置，进入“管理设置 → 公开页面”，把“中心位置来源”改成“手动填写中心位置”，再填写中心纬度和中心经度即可。手动模式不会被自动检测覆盖。

如果选择 `MaxMind 本地 MMDB`，后台点击“更新 GeoIP”会自动下载 City 级 MMDB、验证后热加载，并保存到：

```text
/docker/vps-monitor/data/GeoLite2-City.mmdb
```

默认 MMDB 下载 URL：

```text
https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz
```

这是第三方自动更新的 GeoLite2-City 镜像，不是 MaxMind 官方免登录下载接口。如果你有自己的合规下载源，可以在后台 `MMDB 下载 URL` 改成自己的 `.mmdb` 或 `.mmdb.gz` 地址。

## 10. 自定义背景

进入“管理设置 → 系统设置 → 自定义背景”即可上传背景图片。系统支持 JPEG、PNG 和 WebP，单张最大 12 MB，并提供等比例覆盖、完整显示、裁切焦点、模糊度、亮度和内容遮罩设置。

图片保存在：

```text
/docker/vps-monitor/data/backgrounds/
```

因为整个 `data/` 目录已经挂载到中心端容器，所以执行 `docker compose pull`、重新创建容器或升级镜像不会删除背景图片。迁移中心端时，需要和 GeoIP 数据一起备份整个 `/docker/vps-monitor/data/` 目录。

## 11. 更新中心端

当你通过 `Publish Docker Images` workflow 发布新版本镜像后，在中心端执行：

```bash
cd /docker/vps-monitor
docker compose pull
docker compose up -d --force-recreate
docker compose logs -f server
```

如果你修改了 Web UI 但 VPS 上仍然显示旧主题，优先检查这几件事：

1. `Publish Docker Images` workflow 是否已经成功完成。
2. `.env` 里的 `SERVER_IMAGE` 是否还是旧 tag。生产环境建议使用版本号，例如 `vps-monitor-server:v0.1.1`，更新 `.env` 后再执行 `docker compose pull && docker compose up -d --force-recreate`。
3. 在 VPS 上执行 `docker compose images`，确认 `server` 使用的是刚推送的新镜像。
4. 浏览器强制刷新页面；如果前面套了 CDN 或额外 Nginx 缓存，也需要清掉缓存。默认教程里的 Nginx 反代不主动缓存静态文件。

注意：生产部署只读取中心端镜像里的 `/app/web/dist`。Mac 项目目录里的 `web/src`、`web/dist` 或本地预览服务不会自动同步到 VPS。

## 12. 常用排查

查看日志：

```bash
cd /docker/vps-monitor
docker compose logs -f server
docker compose logs -f postgres
```

确认本地端口：

```bash
ss -lntp | grep 8080
```

如果其他 VPS 无法安装 Docker Agent，重点检查：

- 目标 VPS 能访问你的 `BASE_URL`。
- 目标 VPS 能访问 `.env` 里的 `AGENT_INSTALLER_URL`。
- 目标 VPS 能拉取 `.env` 里的 `AGENT_IMAGE`。
- 中心端 Nginx 已经启用 HTTPS。

如果其他 VPS 无法安装 systemd/native Agent，重点检查：

- 目标 VPS 能访问 `.env` 里的 `AGENT_INSTALLER_URL`。
- 目标 VPS 能访问 `https://github.com/mghts/vps-monitor/releases/latest/download/vps-monitor-agent-linux-amd64` 或对应架构文件。
- `AGENT_RELEASE_REPOSITORY` 是否填写为 `owner/repo`，不要只写仓库名。
- 如果 `AGENT_RELEASE_TAG` 固定为某个 tag，确认这个 release 里确实有对应架构的二进制文件。

如果 Agent 日志里出现：

```text
The requested image's platform (linux/arm64) does not match the detected host platform (linux/amd64/v3)
exec /usr/local/bin/vps-monitor-agent: exec format error
```

说明你给 amd64 VPS 使用了 arm64-only 的 Agent 镜像。通常发生在 Apple Silicon Mac 上直接 `docker build` 后推送镜像。优先修复方式是在 GitHub Actions 里重新运行 `Publish Docker Images` workflow，确认它成功发布多架构镜像。

如果你选择备用的本地手动构建方式，就在 Mac 或 CI 上重新构建并推送 `linux/amd64` 或多架构 Agent 镜像：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/agent.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0 \
  --push \
  .

docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```

然后在出错的目标 VPS 上删除坏容器并重新执行后台生成的 Agent 安装命令：

```bash
docker rm -f vps-monitor-agent
docker image rm <你的 DockerHub 用户名>/vps-monitor-agent:v0.1.0
```
