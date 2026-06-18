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

## 0. 先看一页版流程

如果你只是想把探针跑起来，先按下面这条线走。后面的章节只是把每一步拆开解释。

### 0.1 你需要提前准备

| 要准备什么 | 用在哪里 | 不准备会怎样 |
| --- | --- | --- |
| 一个域名，例如 `monitor.example.com` | 访问中心端网页、生成 Agent 安装命令 | Agent 仍可用 IP 接入，但 HTTPS 和 Cookie 配置会更麻烦 |
| Docker Hub 账号 | 发布 `server` 和 `agent` 镜像 | VPS 没有镜像可拉取 |
| GitHub 仓库 | 自动构建镜像、提供 `agent/install.sh`、发布 systemd Agent 二进制 | Docker Agent 仍可用，但 systemd/native Agent 没法一键下载二进制 |
| 中心端 VPS | 部署 PostgreSQL、中心端服务和 Nginx | 没有地方保存监控数据 |
| 一个长随机 `SETUP_TOKEN` | 首次注册管理员、忘记密码重置 | token 太弱会增加管理入口风险 |

### 0.2 最短部署顺序

1. 在 Docker Hub 创建 `vps-monitor-server` 和 `vps-monitor-agent` 两个仓库。
2. 在 GitHub 仓库添加 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` 两个 Actions Secrets。
3. 运行 `Publish Docker Images` workflow，发布多架构 Docker 镜像。
4. 如果你要用 systemd/native Agent，再运行 `Release Agent Binaries` workflow，发布 Agent Linux 二进制。
5. SSH 登录中心端 VPS，安装 Docker、Docker Compose 插件、Nginx。
6. 创建 `/docker/vps-monitor`，只放两个文件：
   - `docker-compose.yml`
   - `.env`
7. 在 `.env` 里把 `BASE_URL`、`SERVER_IMAGE`、`AGENT_IMAGE`、`POSTGRES_PASSWORD`、`SETUP_TOKEN` 改成自己的。
8. 执行 `docker compose pull && docker compose up -d`。
9. 用 `curl -fsS http://127.0.0.1:8080/api/health` 确认中心端本机可访问。
10. 配置 Nginx，把域名反代到 `127.0.0.1:8080`，再签发 HTTPS。
11. 浏览器访问 `https://monitor.example.com`，进入管理页，用 `SETUP_TOKEN` 注册第一个管理员。
12. 在管理后台添加服务器节点，复制 Docker 版或 systemd 版 Agent 安装命令到目标 VPS 执行。

### 0.3 部署完成后应该长这样

```text
/docker/vps-monitor/
├── .env
├── docker-compose.yml
├── data/
│   ├── GeoLite2-City.mmdb          # 可选，后台更新 GeoIP 后出现
│   └── backgrounds/                # 可选，上传自定义背景后出现
└── postgres/                       # PostgreSQL 数据，务必备份
```

中心端 VPS 上只需要这个目录。不要把 Mac 上的 `server/`、`agent/`、`web/` 源码目录上传到 VPS。

### 0.4 Docker Agent 和 systemd Agent 怎么选

| 安装方式 | 目标 VPS 需要什么 | 依赖什么发布物 | 推荐场景 |
| --- | --- | --- | --- |
| Docker Agent | Docker | `AGENT_IMAGE` 指向的多架构 Docker 镜像 | 推荐优先使用，升级和卸载简单 |
| systemd/native Agent | systemd、curl 或 wget | GitHub Releases 里的 `vps-monitor-agent-linux-*` 二进制 | 不想在节点上装 Docker 时使用 |

如果你没有发布 GitHub Release 二进制，systemd/native 安装命令会失败；这不是中心端问题，而是目标 VPS 找不到可下载的 Agent 程序。Docker 版不需要这些二进制，只需要 Agent Docker 镜像能拉取。

### 0.5 最容易填错的变量

| 变量 | 正确示例 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://monitor.example.com` | 必须是浏览器和 Agent 都能访问的公开地址，不要写 `127.0.0.1` |
| `SERVER_PORT` | `127.0.0.1:8080` | 推荐只监听本机，让 Nginx 对外暴露 80/443 |
| `SERVER_IMAGE` | `alice/vps-monitor-server:v0.2.0` | 中心端镜像 |
| `AGENT_IMAGE` | `alice/vps-monitor-agent:v0.2.0` | Docker Agent 镜像 |
| `AGENT_INSTALLER_URL` | `https://raw.githubusercontent.com/mghts/vps-monitor/refs/heads/main/agent/install.sh` | 后台生成一键安装命令时使用 |
| `AGENT_RELEASE_REPOSITORY` | 留空或 `mghts/vps-monitor` | systemd/native Agent 的 GitHub Release 仓库，当前脚本默认已写入 `mghts/vps-monitor` |
| `COOKIE_SECURE` | `true` | 正式 HTTPS 部署保持 `true`；纯 HTTP 临时测试才改成 `false` |

## 1. 准备镜像

你需要先把两个镜像发布到 Docker Hub：

- `<你的 DockerHub 用户名>/vps-monitor-server:v0.2.0`
- `<你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0`

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
alice/vps-monitor-server:v0.2.0
alice/vps-monitor-agent:v0.2.0
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

必须添加在页面下方的 **Repository secrets** 区域，不要添加到 `Variables`，也不要只添加成某个 `Environment secret`。Secret 名称区分大小写，必须与下面完全一致：

```text
DOCKERHUB_USERNAME
DOCKERHUB_TOKEN
```

添加完成后，`Repository secrets` 列表中应该能同时看到这两个名称。GitHub 不会再次显示 Secret 的值，这是正常现象。可以直接打开下面的仓库设置页面检查：

```text
https://github.com/mghts/vps-monitor/settings/secrets/actions
```

如果 workflow 显示 `Missing DOCKERHUB_USERNAME secret`，说明 Actions 读取到的 `DOCKERHUB_USERNAME` 是空值，通常是 Secret 没有创建、名称拼错、被创建成了 Variable，或者 Secret 建在了错误的仓库中。修正后不需要修改代码，回到失败的 workflow 点击 `Re-run all jobs` 即可。

#### 1.4 运行镜像发布 workflow

进入 GitHub 仓库的 `Actions` 页面，左侧选择：

```text
Publish Docker Images
```

如果你已经推送了 `v0.2.0` tag，这一步会自动运行，无需再次手动触发。只有自动任务没有出现时，才点击 `Run workflow`：

```text
version     = v0.2.0
push_latest = 勾选
```

然后点击绿色的 `Run workflow` 按钮，等待任务完成。

`v0.2.0` 是当前文档对应的正式版本。每次推送新的 `v*` tag（例如 `v0.2.1`）后，GitHub Actions 都会自动发布同版本 Docker 镜像和 Agent 二进制；不要重复使用旧 tag 覆盖新代码。

#### 1.5 检查镜像是否发布成功

在 Mac 或任意装了 Docker 的机器上执行：

```bash
docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-server:v0.2.0
docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0
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
SERVER_IMAGE=<你的 DockerHub 用户名>/vps-monitor-server:v0.2.0
AGENT_IMAGE=<你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0
```

不建议生产环境长期使用 `latest`。`latest` 适合测试，但一旦你以后发布新镜像，VPS 重新 `docker compose pull` 时可能直接升级，出了问题不好回滚。固定 `v0.2.0` 这种版本号更稳。

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
  -t <你的 DockerHub 用户名>/vps-monitor-server:v0.2.0 \
  -t <你的 DockerHub 用户名>/vps-monitor-server:latest \
  --push \
  .

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/agent.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0 \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:latest \
  --push \
  .

docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-server:v0.2.0
docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0
```

检查输出里应该同时能看到 `linux/amd64` 和 `linux/arm64`。如果你的 VPS 是普通 x86_64，一定要至少包含 `linux/amd64`。

如果你确定所有 VPS 都是普通 x86_64/amd64，也可以只构建 amd64 镜像：

```bash
docker login

docker buildx build \
  --platform linux/amd64 \
  -f deploy/server.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-server:v0.2.0 \
  --push \
  .

docker buildx build \
  --platform linux/amd64 \
  -f deploy/agent.Dockerfile \
  -t <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0 \
  --push \
  .

docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0
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

可以直接复制下面这份，然后只替换中文占位内容：

```env
POSTGRES_DB=vps_monitor
POSTGRES_USER=vps_monitor
POSTGRES_PASSWORD=换成超长随机数据库密码
SETUP_TOKEN=换成超长随机首次注册令牌
BASE_URL=https://monitor.example.com
SERVER_PORT=127.0.0.1:8080

SERVER_IMAGE=<你的 DockerHub 用户名>/vps-monitor-server:v0.2.0
AGENT_IMAGE=<你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0

# Agent 一键安装脚本，建议放在你的 GitHub 仓库。
AGENT_INSTALLER_URL=https://raw.githubusercontent.com/mghts/vps-monitor/refs/heads/main/agent/install.sh
# systemd/native Agent 二进制从这个 GitHub Releases 仓库下载。
AGENT_RELEASE_REPOSITORY=
# latest 表示使用最新 release；也可以固定为 v0.2.0。
AGENT_RELEASE_TAG=latest

GEOIP_MMDB_PATH=/data/GeoLite2-City.mmdb
BACKGROUND_DIR=/data/backgrounds
COOKIE_SECURE=true
TRUST_PROXY_HEADERS=true
RUST_LOG=info
```

关键点：

- `POSTGRES_PASSWORD` 是数据库密码，不是网页登录密码。建议用 `openssl rand -hex 32` 生成，不要用常见密码；十六进制字符也不会破坏 `DATABASE_URL` 格式。
- `SETUP_TOKEN` 不是管理员登录密码，而是首次注册管理员和忘记密码重置时使用的高权限安全令牌。中心端要求至少 32 个字符，建议用 `openssl rand -hex 32` 生成。
- `BASE_URL` 必须写公网可访问地址，例如 `https://monitor.example.com`。后台生成的 Agent 安装命令会使用它，不能写成 `http://127.0.0.1:8080`。
- `SERVER_IMAGE` 是中心端镜像，生产环境建议写固定版本号。
- `AGENT_IMAGE` 是 Docker 版 Agent 一键安装命令使用的镜像，建议和中心端使用同一个版本号。
- `AGENT_INSTALLER_URL` 是后台生成 Agent 安装命令时使用的脚本地址，推荐使用 GitHub raw 链接。
- `AGENT_RELEASE_REPOSITORY` 是 systemd/native Agent 二进制所在的 GitHub Releases 仓库。当前 `agent/install.sh` 已默认使用 `mghts/vps-monitor`，所以这里可以留空以保持安装命令更短。
- `AGENT_RELEASE_TAG=latest` 表示安装最新 release；如果你希望所有节点固定版本，可以写成 `v0.2.0`。
- 当前 `agent/install.sh` 顶部的 `DEFAULT_RELEASE_REPO` 已固定为 `mghts/vps-monitor`。因此中心端 `.env` 里的 `AGENT_RELEASE_REPOSITORY` 可以留空，后台生成的 systemd 安装命令会保持 `wget ...install.sh | sudo bash -s -- -e ... -t ...` 这种 Komari 风格。
- `SERVER_PORT=127.0.0.1:8080` 表示中心端只暴露给本机 Nginx。
- `COOKIE_SECURE=true` 表示浏览器只会在 HTTPS 下发送管理员登录 Cookie。正式部署必须保持 `true`。如果你临时用纯 HTTP 测试登录，可以临时改成 `false`，测试完再改回 `true`。
- `TRUST_PROXY_HEADERS=true` 只适用于 `SERVER_PORT=127.0.0.1:8080` 且前面使用可信 Nginx 的部署；如果直接开放中心端端口，必须改成 `false`。
- `GEOIP_MMDB_PATH` 保持默认即可，后台 MaxMind 更新会把 MMDB 保存到 `/docker/vps-monitor/data/GeoLite2-City.mmdb`。
- `BACKGROUND_DIR` 保持默认即可，后台上传的自定义背景会保存到 `/docker/vps-monitor/data/backgrounds/`。

生成随机密码/token：

```bash
openssl rand -hex 32
```

生成后建议把 `POSTGRES_PASSWORD` 和 `SETUP_TOKEN` 临时保存在你的密码管理器里。`SETUP_TOKEN` 不会在网页上显示，忘了只能回 VPS 查看 `.env`。

然后限制 `.env` 读取权限：

```bash
chmod 600 /docker/vps-monitor/.env
```

## 6. 启动中心端

```bash
cd /docker/vps-monitor
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f server
```

`docker compose logs -f server` 会持续跟随日志。看到中心端正常启动后，可以按 `Ctrl+C` 退出日志界面，不会停止容器。

中心端本机自检：

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

正常会返回一段 JSON。如果这里失败，先不要配置 Nginx，应该先看：

```bash
docker compose ps
docker compose logs --tail=200 server
docker compose logs --tail=200 postgres
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

签发完成后检查：

```bash
nginx -t
systemctl reload nginx
curl -fsS https://monitor.example.com/api/health
```

如果 `curl -fsS https://monitor.example.com/api/health` 能返回 JSON，说明 Nginx 已经能访问中心端。

### 7.1 生产安全检查

部署完成后建议逐项确认：

- `SERVER_PORT` 保持 `127.0.0.1:8080`，不要写成 `0.0.0.0:8080`，除非你明确知道自己在做什么。
- 防火墙只放行 `22`、`80`、`443`，不要额外放行 `8080`。
- `BASE_URL` 使用 HTTPS 域名。
- `COOKIE_SECURE=true`。
- `POSTGRES_PASSWORD` 和 `SETUP_TOKEN` 都是随机长字符串。
- `SETUP_TOKEN` 至少 32 个字符，并保存在密码管理器中；它可以重置管理员密码，安全级别等同于管理员凭据。
- `.env` 权限设为仅 root 可读：`chmod 600 /docker/vps-monitor/.env`。
- 使用 Nginx 反代且 `SERVER_PORT=127.0.0.1:8080` 时设置 `TRUST_PROXY_HEADERS=true`；如果直接暴露中心端端口则必须设为 `false`。
- Docker Hub 和 GitHub token 只放在 GitHub Actions Secrets，不写进仓库文件。
- `agent/install.sh` 会以 root 身份执行。测试阶段可使用 `refs/heads/main`，生产部署应把 `AGENT_INSTALLER_URL` 固定到已审核的 release tag 或完整 commit SHA，避免分支被意外修改后影响新节点安装。
- `/docker/vps-monitor/postgres/` 和 `/docker/vps-monitor/data/` 要定期备份。
- 管理员密码使用强密码；公开页面不需要登录，但管理操作必须登录。

确认 8080 没有对公网暴露，可以在中心端 VPS 上看监听地址：

```bash
ss -lntp | grep 8080
```

理想输出里应该能看到 `127.0.0.1:8080`，而不是 `0.0.0.0:8080`。

## 8. Agent 安装方式

在管理后台添加服务器后，会显示两种安装命令：

添加服务器时可以先填公网 IP。中心端会按当前 GeoIP Provider 预定位该节点；Agent 后续上线并上报真实公网 IP 后，会继续自动刷新 GeoIP。如果识别不准，进入该节点的“位置覆盖”，点击“使用 GeoIP 填入”后手动修正国家、城市或经纬度并保存。

- 非 Docker/systemd 版：后台会生成类似下面的短命令。脚本来自你的 GitHub 仓库，安装时会自动检测目标 VPS 架构，从 GitHub Releases 下载对应 Agent 二进制及 `.sha256` 文件，校验一致后才安装：

```bash
wget -qO- https://raw.githubusercontent.com/mghts/vps-monitor/refs/heads/main/agent/install.sh | sudo bash -s -- -e https://monitor.example.com -t <agent-token>
```

- Docker 版：使用同一个安装脚本，但后台命令会追加 `-m docker -i <agent-image>`。脚本会自动检测当前 VPS 架构，并用 `docker pull --platform ...` 拉取和运行 `AGENT_IMAGE`。容器使用隔离网络和只读文件系统，仅挂载宿主机的 `/etc/hostname`、`/etc/os-release` 与 `/proc/net/dev`，不再暴露宿主机整个根目录；ICMP Ping 只保留 `NET_RAW` 能力。
- 卸载命令同样使用 GitHub 安装脚本的 `uninstall` 子命令，后台会分别提供 Docker 和 systemd 两种卸载命令。

如果你之后把 `agent/install.sh` 里的 `DEFAULT_RELEASE_REPO` 改回空值，后台会在 systemd 安装命令后追加 `-r <AGENT_RELEASE_REPOSITORY>`。这同样可用，只是命令会比 Komari 示例多一个仓库参数。

### 8.1 Agent 安装后自检

Docker 版 Agent：

```bash
docker ps --filter name=vps-monitor-agent
docker logs --tail=100 vps-monitor-agent
```

systemd/native 版 Agent：

```bash
systemctl status vps-monitor-agent --no-pager
journalctl -u vps-monitor-agent -n 100 --no-pager
```

正常情况下，管理后台对应节点会在几十秒内从离线变成在线，并开始出现 CPU、内存、磁盘、网络速率和 Ping 数据。

安装命令中包含该节点独立的 Agent token。只在可信终端执行，不要发到群聊、工单或公开日志；如果怀疑泄露，立即在管理后台为该节点执行“重置 token”，旧 token 会立刻失效。

如果节点一直离线，按这个顺序查：

1. 目标 VPS 能不能访问中心端：`curl -fsS https://monitor.example.com/api/health`。
2. 安装命令里的 `-e` 地址是不是你的真实 `BASE_URL`。
3. token 是否复制完整，前后不要多空格。
4. Docker 版检查 `docker logs vps-monitor-agent`。
5. systemd 版检查 `journalctl -u vps-monitor-agent -n 100 --no-pager`。

### GitHub Releases 编译 Agent 二进制

项目已经包含 `.github/workflows/release-agent.yml`。你把代码推到 GitHub 后，可以用两种方式发布二进制：

方式一：推送新的 tag 自动发布（推荐）：

```bash
git tag v0.2.0
git push origin v0.2.0
```

同一个 tag 只创建一次。下一次发布请递增版本号，例如 `v0.2.1`，不要删除并重建已有 tag。

方式二：在 GitHub 仓库页面进入 `Actions -> Release Agent Binaries -> Run workflow`，填写 tag，例如 `v0.2.0`。

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
cargo build --locked --release -p vps-monitor-agent
cp target/release/vps-monitor-agent vps-monitor-agent-linux-amd64
```

如果在 amd64 Linux 上需要交叉编译，可以使用 `cross`：

```bash
cargo install cross --locked
cross build --locked --release -p vps-monitor-agent --target x86_64-unknown-linux-musl
cross build --locked --release -p vps-monitor-agent --target aarch64-unknown-linux-musl
cross build --locked --release -p vps-monitor-agent --target armv7-unknown-linux-musleabihf

cp target/x86_64-unknown-linux-musl/release/vps-monitor-agent vps-monitor-agent-linux-amd64
cp target/aarch64-unknown-linux-musl/release/vps-monitor-agent vps-monitor-agent-linux-arm64
cp target/armv7-unknown-linux-musleabihf/release/vps-monitor-agent vps-monitor-agent-linux-armv7
chmod +x vps-monitor-agent-linux-*
sha256sum vps-monitor-agent-linux-amd64 > vps-monitor-agent-linux-amd64.sha256
sha256sum vps-monitor-agent-linux-arm64 > vps-monitor-agent-linux-arm64.sha256
sha256sum vps-monitor-agent-linux-armv7 > vps-monitor-agent-linux-armv7.sha256
```

手动创建 GitHub Release 时，二进制和对应的 `.sha256` 文件必须一起上传；安装脚本缺少校验文件时会拒绝安装。

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

这是第三方自动更新的 GeoLite2-City 镜像，不是 MaxMind 官方免登录下载接口。如果你有自己的合规下载源，可以在后台 `MMDB 下载 URL` 改成自己的 `.mmdb` 或 `.mmdb.gz` 地址。自定义地址必须使用 HTTPS；中心端会拒绝解析到内网、回环、链路本地或保留 IP 的地址，并禁止下载重定向，以避免 GeoIP 更新功能被用于访问内网服务。

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
2. `.env` 里的 `SERVER_IMAGE` 是否还是旧 tag。当前版本应使用 `vps-monitor-server:v0.2.0`，更新 `.env` 后再执行 `docker compose pull && docker compose up -d --force-recreate`。
3. 在 VPS 上执行 `docker compose images`，确认 `server` 使用的是刚推送的新镜像。
4. 浏览器强制刷新页面；如果前面套了 CDN 或额外 Nginx 缓存，也需要清掉缓存。默认教程里的 Nginx 反代不主动缓存静态文件。

注意：生产部署只读取中心端镜像里的 `/app/web/dist`。Mac 项目目录里的 `web/src`、`web/dist` 或本地预览服务不会自动同步到 VPS。

## 12. 常用排查

先看这个表，能覆盖大部分第一次部署会遇到的问题：

| 现象 | 优先检查 | 常见修复 |
| --- | --- | --- |
| 打不开网页 | `docker compose ps`、`curl -fsS http://127.0.0.1:8080/api/health`、`nginx -t` | 先让中心端本机健康检查通过，再处理 Nginx |
| HTTPS 域名打开失败 | DNS 是否指向中心端 VPS、80/443 是否放行、Certbot 是否成功 | 修 DNS、防火墙或重新运行 `certbot --nginx -d monitor.example.com` |
| 登录后刷新又变成未登录 | `COOKIE_SECURE` 和访问协议是否匹配 | 正式 HTTPS 用 `COOKIE_SECURE=true`；纯 HTTP 临时测试才用 `false` |
| VPS 上还是旧主题 | `.env` 的 `SERVER_IMAGE` 是否还是旧 tag、镜像 workflow 是否发布成功 | 发布新镜像，改 `.env` tag，执行 `docker compose pull && docker compose up -d --force-recreate` |
| Docker Agent 报 `exec format error` | `docker buildx imagetools inspect <agent-image>` 是否包含目标架构 | 重新发布多架构 Agent 镜像 |
| systemd Agent 提示下载失败 | GitHub Release 是否有对应 `vps-monitor-agent-linux-*` asset | 运行 `Release Agent Binaries` workflow 或修正 `AGENT_RELEASE_REPOSITORY` |
| 节点一直离线 | Agent 日志、中心端 `BASE_URL`、token 是否完整 | 重新复制后台生成的安装命令；必要时重置 token |
| GeoIP 更新失败 | Provider 是否可访问、MMDB 下载 URL 是否能下载 | 换 `geojs.io` 测试，或检查自定义 MMDB URL |

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
  -t <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0 \
  --push \
  .

docker buildx imagetools inspect <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0
```

然后在出错的目标 VPS 上删除坏容器并重新执行后台生成的 Agent 安装命令：

```bash
docker rm -f vps-monitor-agent
docker image rm <你的 DockerHub 用户名>/vps-monitor-agent:v0.2.0
```
