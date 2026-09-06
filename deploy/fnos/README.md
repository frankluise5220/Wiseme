# MMH 飞牛 fnOS 应用包

这个目录用于准备同一个飞牛 fnOS 应用在不同 CPU 架构下的安装包，`appname` 固定为：

```text
mmh
```

现有 MMH 普通 NAS 安装与更新主线仍然是 Docker，继续参考 `docs/nas-install-manual.md` 和 `deploy/nas/`。飞牛版只是额外的 `.fpk` 分发形式，不把普通 NAS 安装改成 SQLite。

飞牛专用 `.fpk` 使用 SQLite 原生运行方式：包内包含 Next standalone、Linux Node runtime、Prisma runtime、SQLite 初始化脚本和应用入口，不依赖 Docker/PostgreSQL。它不是源码包，也不是调试归档。由于包含原生二进制，正式 Release 资产只按架构发布两个文件：`mmh-fnos-v0.1.x-x86_64.fpk` 和 `mmh-fnos-v0.1.x-arm64.fpk`，但应用 ID 仍然是同一个 `mmh`。

## 用户安装

### 推荐：FN 软仓安装和更新

如果飞牛里还没有 FN 软仓客户端，请先按 FN 软仓项目说明安装客户端：

```text
https://gitee.com/hhxs2025/fn-appstores/releases
```

打开 FN 软仓客户端，搜索 `MMH` 或 `MMH 家庭财务工作台`，点击安装。当前软仓已经内置 MMH 源，不需要手动添加应用源。软仓源提供 x86_64 和 arm64 两个架构的正式 `.fpk`，客户端会按设备架构下载对应安装包。

以后更新时，在 FN 软仓客户端里查看 MMH，看到新版本后直接点击更新。更新不会弹出任何向导：MMH 包内不包含 `wizard/install`、`wizard/upgrade`、`wizard/uninstall`，`0.1.47` 起 FN 软仓客户端的更新是完全静默的。更新会沿用已安装 MMH 写入 `.port` / `mmh.env` 的在用端口，不会用包内默认的 `7777` 覆盖已有端口。

> 说明：`0.1.46` 及更早版本的包内带 `wizard/install`，FN 软仓客户端只解析这个文件，解析到后会在每次更新时把它当安装向导渲染，弹出“服务端口”输入页。这是旧包的行为，升级到 `0.1.47` 之后不会再出现。

### 修改服务端口

安装后如果需要换端口，在飞牛应用中心里打开 MMH 的设置页修改“服务端口”并保存。这个设置页来自包内的 `wizard/config`，FN 软仓客户端不会解析它，所以不会让更新重新弹向导。保存后 MMH 会自动停服、写入新端口并重启，新端口会持久化到 `.port` / `mmh.env`，后续更新继续沿用。

首次安装不提供端口输入，端口从 `7777` 开始自动探测，若已被占用则顺延到下一个空闲端口。

### 备用：手动安装 `.fpk`

1. 下载 Release 资产中适合当前飞牛设备架构的 `.fpk`。x86_64 设备使用 `mmh-fnos-v0.1.x-x86_64.fpk`，ARM64 设备使用 `mmh-fnos-v0.1.x-arm64.fpk`。
2. 在飞牛应用中心或支持手动安装 `.fpk` 的入口上传安装包。
3. 安装过程没有向导，直接安装完成。首次安装的服务端口从 `7777` 开始自动探测，若已被占用则顺延到下一个空闲端口；覆盖安装或更新会沿用已有的持久端口。装好后可在应用中心的 MMH 设置页里改端口。系统初始化、删除账簿等敏感操作验证当前登录用户的密码（操作仅管理员可见）。
4. 启动后访问：

```text
http://飞牛IP:7777/
```

首次启动会在飞牛应用数据目录创建并初始化 SQLite 数据库：

```text
mmh.db
```

手动更新时，下载更高版本、同架构的 `.fpk`，然后在已安装的 MMH 上直接执行更新/覆盖升级。更新不会弹向导，端口沿用已安装 MMH 保留在应用数据目录里的 `.port` / `mmh.env`。卸载只属于用户主动删除应用或异常恢复流程；卸载会保留应用数据目录，重新安装后仍会沿用原来的端口与数据。

## 打包

正式包必须在 Linux/fnOS 打包环境中生成，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。x86 包要在 Linux x64 runner 构建，ARM64 包要在 Linux arm64 runner 构建。fnOS 5.149 使用 GLIBC 2.36；打包环境也必须使用 GLIBC 2.36 或更低，推荐在 fnOS 机器或 Debian 12/bookworm builder 中执行，不要用 Ubuntu 24+/`ubuntu-latest` 直接发布包。

打包脚本会在生成 `.fpk` 前检查 GLIBC 版本，并从源码重编 `better-sqlite3`，避免把高版本 GLIBC 编译出的原生 `.node` 文件放进飞牛包。
如果在 fnOS 真机上复用已验证可加载的 Linux 原生依赖、且系统没有 `gcc/cc`，可以设置 `FNOS_SKIP_NATIVE_REBUILD=1`；脚本会先用包内 Node 实际加载 `better-sqlite3` 并执行内存库查询，验证失败时仍会中止打包。

```bash
npm run build:fnos:app
FNOS_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run build:fnos
FNOS_TARGET_ARCH=arm64 FNOS_NODE_TARBALL=/path/to/node-v20.x-linux-arm64.tar.gz npm run build:fnos
```

成功后生成：

```text
release-artifacts/fnos/mmh-fnos-v0.1.x-x86_64.fpk
release-artifacts/fnos/mmh-fnos-v0.1.x-arm64.fpk
```

仅调试 FPK 工程结构时，可以运行：

```bash
npm run stage:fnos
```

它会生成：

```text
release-artifacts/fnos/mmh-fnos-v0.1.x-x86_64-fpk-source.tgz
release-artifacts/fnos/mmh-fnos-v0.1.x-arm64-fpk-source.tgz
```

这个归档只用于排查 `manifest`、`cmd`、应用文件和图标结构，不是用户安装包。正式安装和应用源下载目标只能是 `.fpk`：

```text
mmh-fnos-v0.1.x-x86_64.fpk
mmh-fnos-v0.1.x-arm64.fpk
```

## 发布

- GitHub Release 通过 `.github/workflows/fnos-release.yml` 构建并上传 `release-artifacts/fnos/*.fpk`。
- Release workflow 每次发布都必须重新构建并覆盖既有 `.fpk` 资产，不能因为 Release 已存在某个 `.fpk` 就跳过构建。
- 飞牛包版本直接使用 `package.json` 的 `0.1.x`，与 GitHub Release tag `v0.1.x` 和 GHCR 镜像 tag 一致；不要再发布 `v0.1.x-fnos` 或包内 `-fnos` 版本。
- 上传前必须运行 `FNOS_VERIFY_BUILT_FPK=1 npm run check:fnos`，确认包内 `cmd/main`、manifest 和数据目录逻辑来自当前源码。
- Release workflow 会按 x86 / arm64 安装对应架构的官方 `fnpack`；如果安装或验证失败，workflow 必须失败，不能上传 `*-fpk-source.tgz` 作为替代。
- `repository/apps.example.json` 的 `download_url` / `download_urls.x86_64` 指向 GitHub Release 中的 `mmh-fnos-v0.1.x-x86_64.fpk`，`download_urls.arm64` 指向 GitHub Release 中的 `mmh-fnos-v0.1.x-arm64.fpk`。

## 软仓源维护说明

- 当前公开源地址是 GitHub raw 目录：
  `https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/fnos/repository`
- FN 软仓当前已经内置 MMH 源，普通用户不需要手动添加源。
- 软仓源数据即仓库的 `main/deploy/fnos/repository` 目录；`api/apps` 是可直接访问的静态源文件，`fnpack.json` 作为源数据文件保留在同一目录。
- `download_url` 和 `download_urls.x86_64` 指向 GitHub Release 中的 x86_64 包 `mmh-fnos-v0.1.x-x86_64.fpk`，`download_urls.arm64` 指向 GitHub Release 中的 arm64 FPK。

## 升级边界

- FN 软仓测试源只能验证“源里有新版本、下载地址可用、版本号能比较”这条测试链路。它不能替代飞牛官方应用中心的升级发布。
- 正常更新必须是同一 `appname=mmh` 的覆盖升级：安装更高版本、同架构的 `.fpk` 时，飞牛应走 `cmd/upgrade_init` / `cmd/upgrade_callback`，不得把常规更新实现为先卸载再安装。
- 手动安装的 `.fpk` 在飞牛应用中心里可能标记为 `manualInstall`。这会影响官方应用中心是否主动提示更新，但不应改变包自身的覆盖升级目标。
- 覆盖升级后必须验证 `/var/apps/mmh/manifest`、`/vol1/@appcenter/mmh/server/package.json` 和关键 API，确认实际运行代码与 manifest 版本都已更新。
- 包内不得包含安装类向导，`wizard/install`、`wizard/upgrade`、`wizard/uninstall` 都不允许。FN 软仓客户端（`fn-appstores-client`）只解析 `wizard/install`：只要该文件存在，更新时就会渲染向导、等待用户输入，并把输入写入 `wizard.env` 后传给 `appcenter-cli install-fpk --env`；没有该文件时客户端直接安装，更新才是静默的。端口必须先读取已安装 MMH 的 `.port` / `mmh.env`，只有两者都不存在时才从 `TRIM_SERVICE_PORT` / 默认 `7777` 开始用 `/dev/tcp` 探测空闲端口。
- 改端口只能走 `wizard/config`（应用中心 MMH 设置页），不能改回安装向导。软仓客户端不解析 `wizard/config`，只有用户主动打开设置页时才显示；`cmd/config_callback` 校验端口后停服、把新端口写入 `.port` 与 `mmh.env` 再启动。因为 `resolve_port()` 优先读已持久化的 `.port`，`config_callback` 必须把向导值显式传给 `write_env_file`，否则新端口会被旧值覆盖。
- `cmd/main` 启动服务时读的是 `mmh.env` 里的 `PORT`（`export PORT="${PORT:-${env_port:-7777}}"`），不读 `.port`。所以改端口必须同时更新这两个文件，只改 `.port` 不会生效。
- 实测记录：FN 软仓客户端的“更新”实际执行的是**先卸载再重装**（客户端日志依次为 `卸载: mmh`、`向导安装命令: ... install-fpk ... --env .../wizard.env`、`安装完成: mmh 带向导安装`），并不调用 `cmd/upgrade_init` / `cmd/upgrade_callback`。因此端口与数据的沿用完全依赖卸载时保留的应用数据目录，`uninstall_init` 的备份兜底不能移除。
- 数据库结构变化必须通过包内 SQLite 运行时迁移处理。新增字段应使用幂等 `ALTER TABLE ADD COLUMN`；字段重命名、拆分或表结构重组必须写显式迁移和数据回填，不能靠重建数据库或清空表来“适配”新版。
- `uninstall_init` 只作为用户主动卸载或异常恢复时的数据兜底；正常升级验收不能依赖卸载重装。生命周期在检测到 `data/mmh.db` 时，会先把应用数据目录复制到同级的 `mmh-upgrade-backups` 目录。用户仍应优先在 MMH 里导出 `.mmh-backup` 后再做高风险操作。
- 生命周期脚本不能默认以 `mmh` 包用户运行。`install_init` / `upgrade_init` / `uninstall_init` 需要由应用中心/root 完成安装前权限准备和同级备份；`cmd/main start` 再把数据目录归属修正为 `mmh:mmh`，并降权到 `mmh` 用户运行 Node 服务。
- 面向普通用户的正式升级必须走飞牛官方应用中心上架/审核后的版本发布链路。只有官方应用中心记录了同一个 `appname` 的新版本，后续用户才应在飞牛自身应用中心里看到并执行升级。

## 安全边界

- 飞牛包默认只暴露 MMH Web 端口 `7777`。
- 飞牛包使用 SQLite，没有 PostgreSQL 连接密码。页面中要求输入“当前用户密码”的敏感操作，验证的是当前登录用户自己的密码（该用户须为管理员）。
- 数据保存在飞牛应用数据目录中的 SQLite 文件，升级包不得删除用户数据目录。
- 升级/卸载前的生命周期备份也只复制飞牛应用数据目录，不会把数据库放回应用安装目录。
- 应用中心生命周期脚本可以用 root 做包安装和备份准备，但长期运行的 Next/Node 进程必须降权为 `mmh` 包用户。
- 运行端口会保存到 `.port` 和 `mmh.env`，覆盖升级沿用该端口；为兼容旧版本，启动脚本仍会生成 `MMH_SYSTEM_PASSWORD` 并保存到 `mmh.env` 和 `mmh-system-password.txt`（文件权限尽量收紧为仅应用用户可读写），敏感操作验证不再使用该密码。
- 包内不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
