# MMH NAS / 飞牛 fnOS / 群晖 DSM 安装与更新

| 运行方式 | 适合谁 | 入口 |
| --- | --- | --- |
| 飞牛 fnOS 原生 | 飞牛 NAS 用户，想直接用原生应用包 | [查看飞牛 fnOS 原生](#飞牛-fnos-原生) |
| 群晖 DSM 原生 | 群晖 NAS 用户，想直接用套件中心安装包 | [查看群晖 DSM 原生](#群晖-dsm-原生) |
| Docker 图形界面 | 普通 NAS 用户，习惯用容器管理器界面 | [查看 Docker 图形界面](#docker-图形界面) |
| Docker 命令行 | 需要 SSH / 终端部署或远程协助 | [查看 Docker 命令行](#docker-命令行) |

## 飞牛 fnOS 原生

飞牛版是原生 `.fpk` 应用包，不依赖 Docker 和 PostgreSQL。安装后使用 SQLite 数据库，数据保存在飞牛应用数据目录里。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装) | 第一次在飞牛上安装 MMH。 |
| [2. 更新](#2-更新) | 已经安装 MMH 后升级到新版本。 |
| [3. 使用](#3-使用) | 安装完成后打开 MMH，并了解数据保存位置。 |

### 1. 安装

推荐使用 FN 软仓安装：

1. 如果飞牛里还没有 FN 软仓客户端，先按 FN 软仓项目说明安装客户端：

```text
https://gitee.com/hhxs2025/fn-appstores/releases
```

2. 打开 FN 软仓客户端，搜索 `MMH` 。
3. 点击安装。
4. `0.1.47` 起安装过程没有向导，直接安装完成；服务端口默认 `7777`，如被占用会在安装前拦截提示。旧版本包在安装时会弹一次端口确认页。

也可以手动安装 `.fpk`：

1. 打开 GitHub Release 页面：

```text
https://github.com/frankluise5220/MMH/releases
```

2. 下载适合当前飞牛设备架构的安装包：
   - x86_64 设备：`mmh-fnos-v0.1.x-x86_64.fpk`
   - ARM64 设备：`mmh-fnos-v0.1.x-arm64.fpk`
3. 在飞牛应用中心或支持手动安装 `.fpk` 的入口上传安装包。

### 2. 更新

推荐在 FN 软仓客户端里更新：

1. 打开 FN 软仓客户端，查看 MMH。
2. 看到新版本后点击更新；如果入口显示覆盖安装，也应当走更新/覆盖升级流程。
3. 更新过程应静默执行，并沿用已安装 MMH 的在用端口；更新完成后重新打开 MMH。

手动安装的用户也可以下载更高版本、同架构的 `.fpk`，然后在应用中心对已安装的 MMH 执行更新/覆盖升级。更新会优先读取已安装应用数据目录中的 `.port` / `mmh.env`，不会把包内默认的 `7777` 覆盖到已经在用的端口。

> 为什么旧版本会弹“服务端口”：FN 软仓客户端只读取包内的 `wizard/install`，只要该文件存在，更新时就会把它当安装向导渲染并要求输入端口。`0.1.47` 起包内不再包含 `wizard/install`、`wizard/upgrade`、`wizard/uninstall`，更新才是真正静默的。
>
> 想改端口怎么办：装好后打开飞牛应用中心里的 MMH 设置页修改“服务端口”再保存即可。这个设置页来自 `wizard/config`，软仓客户端不会解析它，所以不会让更新重新弹向导；保存后 MMH 会自动停服、写入新端口并重启。首次安装不提供端口输入，端口从 `7777` 开始自动探测，被占用则顺延到下一个空闲端口。

覆盖升级会保留飞牛应用数据目录里的 `mmh.db` 数据库。高风险操作前，仍建议先在 MMH 里导出备份。

### 3. 使用

安装完成后，在浏览器打开：

```text
http://飞牛IP:7777/
```
首次启动会在飞牛应用数据目录创建并初始化 SQLite 数据库 `mmh.db`。系统初始化、删除账簿等敏感操作验证当前登录用户自己的密码，操作仅管理员可见。

## 群晖 DSM 原生

群晖版是原生 `.spk` 套件包，不依赖 Docker 和 PostgreSQL，套件元数据尽量保持 DSM 7.0 及更新版本可安装，当前优先面向 DSM 7.2 及更新版本做实际测试。安装后使用 SQLite 数据库，数据保存在群晖套件数据目录里。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装-1) | 第一次在群晖 DSM 上安装 MMH。 |
| [2. 更新](#2-更新-1) | 已经安装 MMH 后升级到新版本。 |
| [3. 使用](#3-使用-1) | 安装完成后打开 MMH，并了解数据保存位置。 |

### 1. 安装

1. 打开 GitHub Release 页面：

```text
https://github.com/frankluise5220/MMH/releases
```

2. 下载适合当前群晖设备架构的安装包：
   - x86_64 设备：`mmh-synology-v0.1.x-x86_64.spk`
   - ARM64 设备：`mmh-synology-v0.1.x-arm64.spk`
3. 打开 DSM 套件中心。
4. 选择手动安装，上传刚下载的 `.spk` 文件。
5. 按套件中心提示确认安装。默认服务端口是：

```text
7777
```

请下载同一个 Release 里的正式 `.spk` 文件，不要下载 `*-spk-source.tgz`，那只是调试包结构用的归档。

### 2. 更新

下载更高版本、同架构的 `.spk`，然后在 DSM 套件中心里对已安装的 MMH 直接覆盖安装。

不要把“卸载旧版再安装新版”当作日常更新方式。覆盖升级会保留群晖套件数据目录里的 `mmh.db` 数据库。高风险操作前，仍建议先在 MMH 里导出备份。

### 3. 使用

安装完成后，在浏览器打开：

```text
http://群晖IP:7777/
```

把 `群晖IP` 换成群晖设备的实际 IP。

群晖版没有 PostgreSQL 连接密码。首次启动会在群晖套件数据目录创建并初始化 SQLite 数据库 `mmh.db`。系统初始化、删除账簿等敏感操作验证当前登录用户自己的密码，操作仅管理员可见。

## Docker 图形界面

普通 NAS 用户优先使用 Docker、Container Manager、容器管理器、Compose、项目、应用栈或 Stack 的图形界面安装。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装-2) | 用 NAS 的 Docker 图形界面创建 MMH 项目。 |
| [2. 更新](#2-更新-2) | 通过 MMH 网页或 Docker 图形界面更新容器。 |
| [3. 使用](#3-使用-2) | 安装完成后打开 MMH，并连接 Android 客户端。 |

### 1. 安装

1. 在 NAS 上安装 Docker、Container Manager、容器管理器或类似功能。
2. 在 NAS 文件管理里新建一个目录，用来放 MMH 的部署文件。例如：

```text
docker/mmh
```

3. 下载下面三个文件，放进刚才创建的目录：
   - `docker-compose.yml`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
   - `postgres-entrypoint.sh`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
   - `env.example`：https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example
4. 把 `env.example` 改名为 `.env`。
5. 打开 `.env`，修改数据库密码：

```env
POSTGRES_PASSWORD="REPLACE_WITH_YOUR_OWN_LONG_RANDOM_PASSWORD"
```

密码建议使用 24 位以上的字母和数字。图形界面安装使用静态 `.env` 文件，Docker 不会自动生成这个密码。

6. 如果你的 `docker-compose.yml` 里 `MMH_UPDATE_TOKEN` 是 `${MMH_UPDATE_TOKEN:-...}` 形式（新版部署文件），在同一份 `.env` 里设置网页更新令牌；如果该行写的是 `${POSTGRES_PASSWORD:-...}`（旧版派生），跳过这一步：

```env
MMH_UPDATE_TOKEN="REPLACE_WITH_YOUR_OWN_LONG_RANDOM_TOKEN"
```

令牌是应用与更新器容器之间的共享口令，网页里的“系统更新”（刷新远端版本、一键更新）依赖它。用 24 位以上随机字符串，生成示例：`openssl rand -hex 24`。不设置（且 compose 不再自动派生）时，更新页会提示“未配置宿主机更新执行器”，或报“获取远端版本失败：spawnSync /bin/sh ETIMEDOUT”（GitHub 直连超时），且“更新”按钮不可用。

7. 在 NAS 的 Docker 图形界面里创建项目：
   - 项目名称填写 `mmh`。
   - 项目目录选择刚才放部署文件的目录。
   - Compose 文件选择 `docker-compose.yml`。
   - 点击部署、创建或启动。

首次启动需要拉取镜像，等待时间取决于 NAS 网络和镜像下载速度。

### 2. 更新

优先在 MMH 网页里更新：

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

网页更新会自动拉取新的应用镜像并重启服务。正常更新不需要重新安装，也不需要在 NAS 上重新构建源码。

如果使用 NAS 的 Docker 图形界面更新，只需要更新 MMH 的应用镜像，然后重启 `mmh-app` 和 `mmh-updater`。数据库容器 `mmh-db` 不需要删除，也不要选择“源码重新构建”。

### 3. 使用

部署完成后，在浏览器打开：

```text
http://NAS_IP:7777/
```

把 `NAS_IP` 换成 NAS 的实际 IP。

Android 客户端可以到同一个 GitHub Release 页面下载安装：

```text
https://github.com/frankluise5220/MMH/releases
```

文件名通常是 `mmh-android-v0.1.x.apk`，其中 `0.1.x` 与服务端版本一致。安装后，服务器地址填写 `http://NAS_IP:7777/`。

## Docker 命令行

只有在 NAS 图形界面不支持 Compose、无法上传 `.env`、或需要远程协助时，才使用命令行。

| 操作 | 你要做什么 |
| --- | --- |
| [1. 安装](#1-安装-3) | 用终端命令下载部署文件、生成密码并启动服务。 |
| [2. 更新](#2-更新-3) | 可用 MMH 网页、Docker 图形界面或终端命令更新。 |
| [3. 使用](#3-使用-3) | 安装完成后打开 MMH，并记住实际安装目录。 |

### 1. 安装
ssh user_name@NAS_IP

```bash
mkdir -p ~/mmh
cd ~/mmh

curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/docker-compose.yml
curl -fsSL -o postgres-entrypoint.sh https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/postgres-entrypoint.sh
curl -fsSL -o .env https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/nas/env.example

chmod +x postgres-entrypoint.sh

POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || date +%s%N | sha256sum | cut -c1-48)"
sed -i "s/CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD/$POSTGRES_PASSWORD/g" .env

# 网页更新令牌：新部署文件用独立的 MMH_UPDATE_TOKEN；旧部署文件由
# POSTGRES_PASSWORD 自动派生，无需此行（保留也无害，升级到新部署文件后即生效）。
MMH_UPDATE_TOKEN="$(openssl rand -hex 24 2>/dev/null || date +%s%N | sha256sum | cut -c1-48)"
if grep -qE '^MMH_UPDATE_TOKEN=..*' .env; then
  sed -i "s|^MMH_UPDATE_TOKEN=.*|MMH_UPDATE_TOKEN=\"$MMH_UPDATE_TOKEN\"|" .env
else
  echo "MMH_UPDATE_TOKEN=\"$MMH_UPDATE_TOKEN\"" >> .env
fi
echo "网页更新令牌: $MMH_UPDATE_TOKEN"

sudo docker compose -p mmh up -d

echo "MMH 安装完成"
echo "访问地址: http://NAS_IP:7777/"
echo "数据库密码: $POSTGRES_PASSWORD"
echo "配置文件: ~/mmh/.env"
```

安装完成后，请把输出的数据库密码保存下来。`.env` 里也会保留同一个密码。

### 2. 更新

命令行安装完成后，日常更新不一定要继续用命令行。你可以优先在 MMH 网页里更新：

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

也可以在 NAS 的 Docker 图形界面里更新 MMH 的应用镜像，然后重启 `mmh-app` 和 `mmh-updater`。数据库容器 `mmh-db` 不需要删除。

只有在网页打不开、图形界面不方便操作或更新异常中断时，才进入安装目录执行终端更新：

```bash
cd ~/mmh
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater
```

这个过程只更新应用和更新器，不会删除数据库。

### 3. 使用

安装完成后，在浏览器打开：

```text
http://NAS_IP:7777/
```

把 `NAS_IP` 换成 NAS 的实际 IP。如果你的安装目录不是 `~/mmh`，后续更新和排查时请进入实际安装目录再执行命令。

Android 客户端可以到 GitHub Release 页面下载安装：

```text
https://github.com/frankluise5220/MMH/releases
```

安装后，服务器地址填写 `http://NAS_IP:7777/`。

## 通用操作

### 清空重装

清空重装会删除 MMH 数据库数据。确认不需要旧数据后再执行。

Docker 用户：

```bash
cd ~/mmh
sudo docker compose -p mmh down -v
```

如果还需要删除安装目录：

```bash
cd ~
rm -rf ~/mmh
```

飞牛用户请优先在飞牛应用中心卸载应用，并按飞牛系统界面确认是否保留应用数据。

群晖用户请优先在 DSM 套件中心卸载套件，并按套件中心提示确认是否保留套件数据。

### 常见问题

飞牛软仓安装后找不到应用或打不开：

先在飞牛应用中心确认 MMH 是否已经安装并正在运行。如果 FN 软仓客户端很快提示安装成功，但应用中心里没有 MMH，或 MMH 没有真正启动，可能是飞牛没有设置默认安装卷。可以在飞牛终端里设置默认卷后重试：

```bash
sudo appcenter-cli default-volume 1
```

如果你的应用安装卷不是 `1`，请换成当前飞牛设备实际使用的卷索引。排查时也可以查看飞牛应用中心日志和 FN 软仓客户端日志。

Docker 页面打不开：

先在 Docker 图形界面确认：

- `mmh-app` 是运行中。
- `mmh-db` 是运行中。
- `mmh-updater` 是运行中。
- `7777` 端口没有被其他服务占用。

如果容器在反复重启，查看 `mmh-app` 和 `mmh-db` 的日志。

群晖提示“套件文件格式不正确，请联系套件开发人员”：

先确认上传的是正式 `.spk` 文件，例如 `mmh-synology-v0.1.x-x86_64.spk` 或 `mmh-synology-v0.1.x-arm64.spk`，不要上传 `*-spk-source.tgz`。如果正式 `.spk` 仍提示格式不正确，说明该 Release 的群晖包需要重新发布修复版；修复包应包含 `checksum`、`extractsize`、正确的 `conf/privilege`，并确保 `scripts/` 下的生命周期脚本在 tar header 中是可执行文件。请改用下一个补丁版本的同架构 `.spk`。

群晖提示“MMH 以 root 权限运行，因此无法安装”：

这是套件权限配置没有被 DSM 正确识别。请改用修复后的同架构 `.spk`；修复包的 `conf/privilege` 会使用 Synology 认可的 `"run-as": "package"`，让 MMH 以套件用户运行，而不是 root。

群晖提示“System failed to start [MMH]”：

这通常需要查看套件自己的启动日志，而不是只看 DSM 通知中心。修复包会把 SQLite 数据库、日志、pid 和运行环境文件写到 DSM 的 `SYNOPKG_PKGVAR` 持久数据目录，而不是只读/受限的套件程序目录。启动脚本会先执行 bundled Node 自检；若 Node/glibc、SQLite 初始化、端口占用或权限失败，错误会写入日志。若仍失败，请在 DSM SSH 里查看 `/var/packages/mmh/var/mmh.log` 和 `/var/log/synopkg.log`。

数据库密码错误：

如果是全新安装，最简单的处理方式是清空重装。如果已有重要数据，不要删除数据库卷。先备份，再排查 `.env` 里的 `POSTGRES_PASSWORD` 是否和数据库初始化时一致。

更新页面提示“未配置宿主机更新执行器”或“获取远端版本失败：spawnSync /bin/sh ETIMEDOUT”：

网页检查/更新依赖应用与更新器（`mmh-updater`）之间的共享令牌。旧部署文件由 `POSTGRES_PASSWORD` 自动派生令牌；新部署文件（`MMH_UPDATE_TOKEN` 行为 `${MMH_UPDATE_TOKEN:-...}` 形式）需要在部署目录的 `.env` 里显式设置。注意：复制 `env.example` 生成的 `.env` 里会有一行空占位 `MMH_UPDATE_TOKEN=""`，命令的守卫按"非空"判断（`grep -E '^MMH_UPDATE_TOKEN=..*'`），空占位会被正确替换：

```bash
cd ~/mmh
grep -qE '^MMH_UPDATE_TOKEN=..*' .env || echo 'MMH_UPDATE_TOKEN="'$(openssl rand -hex 24)'"' >> .env
sudo docker compose -p mmh up -d app updater
```

该命令幂等：令牌已配置（非空）时跳过写入，重复执行无副作用。若 `.env` 里是空占位行 `MMH_UPDATE_TOKEN=""`，追加的新行会在 Compose 读取时覆盖空值（同名键后者生效），无需手动删除旧行。

同时确认 `mmh-updater` 容器在运行。设置后回到 系统设置 -> 系统更新 重新刷新远端版本；版本检查会改走镜像源测速（国内网络更稳），“更新”按钮也会可用。如果只想手动更新一次，也可以直接执行：

```bash
cd ~/mmh
sudo docker compose -p mmh pull app updater
sudo docker compose -p mmh up -d app updater
```

更新页面提示“更新失败 / Failed to fetch”，但系统实际已更新：

网页更新会拉取新镜像并重启 `mmh-app`。应用冷启动在低功耗 NAS 上可能超过一分钟，期间页面会显示“服务正在重启，正在重新连接...”。

如果页面在应用恢复之前就提示失败，先不要急着重试：

1. 等 1 分钟，重新打开 `http://NAS_IP:7777/`。
2. 进入 系统设置 -> 系统更新，看“当前版本”是否已经是新版本；如果是，说明更新实际已经成功，直接使用即可。
3. 如果应用仍然打不开，在 NAS 终端检查：

```bash
cd ~/mmh
sudo docker compose -p mmh ps
sudo docker compose -p mmh logs --tail 50 app
sudo docker compose -p mmh up -d app
```
