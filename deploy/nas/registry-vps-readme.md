# MMH Docker 镜像自建源（VPS 107.175.62.109 / fnapp.floatingice.win）

在 VPS 上运行 Docker Registry，定时从 GHCR 同步 `mmh` / `mmh-updater` 镜像，让用户可以从 VPS 直连拉取，不依赖第三方加速源。

## 源地址

- Registry：`fnapp.floatingice.win:5000`（HTTP，非 HTTPS；域名解析到 VPS，IP 变化不影响）
- 应用镜像：`fnapp.floatingice.win:5000/frankluise5220/mmh:latest`
- 更新器镜像：`fnapp.floatingice.win:5000/frankluise5220/mmh-updater:latest`

## 用户侧使用方法

1. NAS 的 Docker 配置（`/etc/docker/daemon.json`）的 `insecure-registries` 加入：

```json
"insecure-registries": ["fnapp.floatingice.win:5000"]
```

然后重启 Docker。因为自建 registry 使用 HTTP，Docker 默认 HTTPS 会拒绝连接。

2. MMH 系统设置 → 系统更新 → 镜像源选择「FN VPS」，或 `.env` 里设置：

```env
MMH_IMAGE_SOURCE="fnvps"
MMH_APP_IMAGE="fnapp.floatingice.win:5000/frankluise5220/mmh:latest"
MMH_UPDATER_IMAGE="fnapp.floatingice.win:5000/frankluise5220/mmh-updater:latest"
```

## VPS 部署结构

```text
/opt/mmh-registry/
├── sync-mirror.sh        # 同步脚本（cron 每小时执行）
└── sync.log              # 同步日志
/opt/mmh-registry/        # 同时作为 registry 数据卷（挂载 /var/lib/registry）
```

Registry 容器：

```bash
docker run -d --name mmh-registry --restart unless-stopped \
  -p 5000:5000 \
  -v /opt/mmh-registry:/var/lib/registry \
  -e REGISTRY_STORAGE_DELETE_ENABLED=true \
  registry:2
```

VPS Docker 守护进程 `insecure-registries` 需要包含 `127.0.0.1:5000` 才能 push 到本地 registry（同步脚本用 localhost push）：

```json
{ "insecure-registries": ["127.0.0.1:5000"] }
```

防火墙放行 `5000/tcp`。

## 同步

`deploy/nas/registry-sync-mirror.sh` 已部署到 `/opt/mmh-registry/sync-mirror.sh`，cron 每小时执行：

```text
10 * * * * /opt/mmh-registry/sync-mirror.sh >> /opt/mmh-registry/sync.log 2>&1
```

逻辑：`docker pull ghcr.io/frankluise5220/{mmh,mmh-updater}:latest` → 打 `fnapp.floatingice.win:5000/...` 标签 → push 到本地 registry（127.0.0.1:5000）。发布新版后最多 1 小时在 VPS 上可用；想立即生效执行 `bash /opt/mmh-registry/sync-mirror.sh`。

## 注意

- registry 无鉴权（公网可拉取/推送）。只有镜像内容，无敏感数据；如需加固可加 basic auth 或只允许白名单 IP。
- 每个用户更新一次约传输几百 MB 镜像层，留意 VPS 流量配额。
- 代码侧的镜像源映射：`scripts/mmh-updater-server.mjs`（updater 端）与 `src/app/(sidebar)/settings/system-update/page.tsx`（前端选项）已加入 `fnvps` 源。
