# MMH 飞牛包与速度安全改造计划

本文记录 MMH 面向飞牛 fnOS 的专用 `.fpk` 落地方向。

现有 NAS 安装与更新主线仍然是 Docker，继续使用 `deploy/nas/` 和 `docs/nas-install-manual.md`。飞牛只新增一个专用应用：

```text
appname=mmh
```

飞牛 `.fpk` 内部使用 SQLite 原生运行方式，不再额外发布 `mmh-native.fpk`，也不把旧 Docker Compose FPK 作为飞牛用户安装包。因为包内包含 Node runtime 和 `better-sqlite3` 原生依赖，正式 Release 资产只发布两个架构包：`mmh-x86_64.fpk` 和 `mmh-arm64.fpk`。这些包的 `appname` 和 `version` 必须一致。

## 目标

- 用户安装飞牛版架构匹配的 `.fpk` 后，不需要理解 Node、Prisma、Next.js、Docker 或数据库构建流程。
- 飞牛版直接运行包内 Next standalone、Linux Node runtime、Prisma runtime 和 SQLite 数据库。
- 飞牛版没有 PostgreSQL 连接密码；系统初始化、删除账簿等敏感操作验证当前登录用户自己的密码（仅管理员可执行），不使用部署级系统密码。
- 普通 NAS 安装与更新仍保持 Docker 路线，不被飞牛 SQLite 包替代。
- 飞牛包必须在 Linux/fnOS 构建环境生成，不能用 Windows 构建产物冒充正式包。
- 数据目录必须持久化，升级不得删除用户的 SQLite 数据库文件；SQLite 数据库必须位于飞牛应用数据目录，不允许回退到应用安装目录。
- 飞牛版正常更新必须是同一 `appname=mmh` 的覆盖升级，走 `cmd/upgrade_init` / `cmd/upgrade_callback`；不要把先卸载旧包再安装新版作为常规升级方案。
- FN 软仓更新必须静默执行直到成功，并沿用已安装 MMH 的在用端口；包内不得包含安装类向导，`wizard/install`、`wizard/upgrade`、`wizard/uninstall` 都不允许。原因已实测确认：FN 软仓客户端（`fn-appstores-client`）只解析 `wizard/install`，只要该文件存在，更新时就会渲染向导、等待用户输入服务端口，并通过 `--env <extract>/wizard.env` 把输入传给 `appcenter-cli install-fpk`；没有该文件时客户端跳过向导直接安装，静默更新才成立。端口沿用顺序必须是已持久化 `.port` -> 已持久化 `mmh.env` 中的 `PORT` -> `TRIM_SERVICE_PORT` -> 默认 `7777`，避免重装时把已确认端口重置为包默认值。
- 改端口只能走 `wizard/config`（应用设置），不能走安装向导。软仓客户端不解析 `wizard/config`，它只在用户在应用中心主动打开 MMH 设置时显示；保存后由 `cmd/config_callback` 校验端口、停服、写入新端口并重启。因为 `resolve_port()` 优先读已持久化的 `.port`，`config_callback` 必须把向导值**显式**传给 `write_env_file`，否则新端口会被旧值覆盖。
- 没有安装向导后，首次安装不能再用固定的 `7777`。`resolve_port()` 在没有持久化端口时改为从 `TRIM_SERVICE_PORT` / `7777` 开始用 `/dev/tcp` 探测空闲端口，被占用则顺延，避免安装时卡在已被占用的默认端口上。重装和更新会命中持久化端口，不会走到探测分支。
- FN 软仓客户端的“更新”实测是**先卸载再带向导重装**，而不是覆盖升级（客户端日志：`卸载: mmh` -> `向导安装命令: ... install-fpk ... --env .../wizard.env` -> `安装完成: mmh 带向导安装`）。因此端口沿用依赖卸载时保留的 `var` 目录（`.port` / `mmh.env`）；`uninstall_init` 的 appdata 备份必须继续保留，不能假设升级会走 `upgrade_init` / `upgrade_callback`。
- `cmd/main` 启动服务时读的是 `mmh.env` 里的 `PORT`（`export PORT="${PORT:-${env_port:-7777}}"`），**不读** `.port`；`.port` 是安装/改端口时 `resolve_port()` 的持久化依据。改端口后必须两者都写入，否则服务仍会按 `mmh.env` 的旧值启动。
- 飞牛版数据库升级不能依赖备份恢复来避免丢数据。新增字段必须通过幂等 SQLite 迁移补列；字段重命名、拆分、类型调整或表重组必须写显式迁移和数据回填，不能重建库、清空表或让旧库停留在不兼容结构。
- 飞牛包生命周期脚本不能默认以 `mmh` 包用户执行。安装、升级和卸载初始化需要应用中心/root 权限处理包目录、权限和同级备份；真正启动服务时再降权到 `mmh` 用户运行 Node。
- `config/privilege` 只声明 `username`/`groupname`，不声明 `defaults: { "run-as": "package" }`。fnOS 应用中心下载暂存目录会把 `cmd/*` 解压为 `700 root`；若生命周期脚本以包用户执行，`install_init` 会因无法读取 root 拥有的脚本而报 `fork/exec ... permission denied`（0.1.8、0.1.33 均因此失败）。移除 `run-as: package` 后脚本以 root 执行，暂存权限不再影响安装；服务启动时才降权到 `mmh`（`restart_start_as_package_user`）。
- 通过 FN 软仓客户端（fn-appstores-client，下载地址：`https://gitee.com/hhxs2025/fn-appstores-client/releases/download/2.5.2/fn-appstores-client-2.5.2-x86.fpk`）或 `appcenter-cli install-fpk` 安装时，CLI 需要 `--volume` 或已配置的默认卷。若 NAS 未设置默认卷，会返回 `Use --volume to specify the volume index, or configure a default using appcenter-cli default-volume [index]`，且退出码仍可能为 0，客户端因此会误判为“安装成功”。请先执行 `sudo appcenter-cli default-volume 1`（或对应当前存储卷的索引）修复；排查安装失败时优先查看应用中心 error.log 与 FN 软仓 app.log 中的 CLI 输出。
- 默认安全边界清楚：只暴露 Web 端口，不包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。

## 已落地

- `src/lib/db/prisma.ts` 可按 `DATABASE_URL` 自动选择 PostgreSQL 或 SQLite adapter。
- `prisma.config.ts` 可通过 `PRISMA_SCHEMA_PATH` 选择 native schema。
- `scripts/generate-native-sqlite-schema.cjs` 可从 PostgreSQL schema 生成 SQLite schema。
- `prisma/schema.native.prisma` 已能通过 `prisma validate`。
- `scripts/build-fnos-app.cjs` 定义 Linux SQLite standalone 构建流程。
- `scripts/build-fnos-package.cjs` 生成飞牛 FPK 工程，支持 `FNOS_TARGET_ARCH=x86|arm64`，写入对应 manifest 架构、`cmd/main`、图标、持久化数据目录解析、Prisma runtime 和 SQLite 启动链。
- `cmd/main` 启动前会运行 `init-sqlite.cjs`。空库使用 `native-init.sql` 初始化；已有库跳过全量初始化，但继续运行 `_mmh_native_schema` 记录的运行时迁移，并从 `native-init.sql` 自动补齐缺失的新表、可安全新增字段和可兼容索引。字段改名、字段类型变化、拆表合表、数据回填和破坏性调整仍需写显式运行时迁移。
- `scripts/verify-fnos-package.cjs` 校验飞牛包素材，防止 `.env` 泄露、Docker resource 混入和第二个 `.fpk` 包出现。
- `.github/workflows/fnos-release.yml` 发布时用 x86/arm64 矩阵构建并上传正式 `release-artifacts/fnos/*.fpk`。
- `.github/workflows/fnos-stage.yml` 生成 x86/arm64 调试用 FPK 工程归档；该归档不能作为用户安装包。
- `deploy/fnos/repository/apps.example.json` 只保留一个应用条目，`download_url` 指向 x86_64 包，`download_urls` 只提供 x86_64 和 arm64 下载地址。
- `deploy/fnos/repository/fnpack.json` 的历史 release 只保留最近 5 次版本；新版本发布后，旧的仓库索引和 VPS 文件要同步裁掉。
- 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛应用包更新方式，并拒绝在飞牛版内执行 Git/Docker 更新。

## 启动链

1. fnOS 启动 `cmd/main start`。
2. 脚本定位应用目录和持久化数据目录；数据目录优先使用 `TRIM_DATADEST`，其次使用 `TRIM_PKGVAR/data`，再兜底到 `/vol*/@appdata/mmh/data`。
3. 设置 `DATABASE_URL=file:$DATA_DEST/mmh.db`。
4. 设置 `PRISMA_SCHEMA_PATH=$SERVER_DIR/prisma/schema.native.prisma`。
5. 读取持久端口文件 `.port` 或持久环境文件 `mmh.env`，导出 `PORT`；`MMH_SYSTEM_PASSWORD` 仅作兼容保留（未设置时首次启动随机生成并保存到 `mmh-system-password.txt`），同时生成并持久化 `MMH_SESSION_SECRET` 到 `mmh-session-secret.txt`，用于签名登录 Cookie；敏感操作验证不再使用系统密码。
6. 如果 `cmd/main start` 是由应用中心/root 调起，先修正应用数据目录为 `mmh:mmh`，再降权到 `mmh` 用户继续启动。
7. 使用包内 Node 运行 SQLite 初始化脚本；仅在数据库没有用户表时创建初始结构，已有数据库不会被重建，但会继续执行幂等运行时迁移并记录到 `_mmh_native_schema`，随后按 `native-init.sql` 补齐缺失的新表、可安全新增字段和可兼容索引。
8. 启动包内 Next standalone `server.js`，对外暴露 `7777`。

## 发布链

1. 发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 运行 `npm run check:fnos`。
2. workflow 矩阵分别运行 x86 和 arm64 runner，下载与当前 Node 版本匹配的 Linux x64 / arm64 Node runtime。
3. workflow 执行 `npm run build:fnos:app`，确保 standalone 和原生依赖都是当前 runner 架构的 Linux 产物。
4. workflow 执行 `npm run build:fnos`，x86 只生成 `mmh-x86_64.fpk`，ARM64 只生成 `mmh-arm64.fpk`。
5. workflow 上传 `release-artifacts/fnos/*.fpk` 到 Release。
6. 飞牛第三方源元数据更新 `version`、`download_url` 和 `download_urls`，其中 `version` 必须等于 `package.json` 的 `0.1.x`，下载地址必须指向同一个 `v0.1.x` Release 中的对应架构 `.fpk`。

## 限制

- 正式 `.fpk` 必须在 Linux/fnOS 环境构建，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。
- 构建正式包必须提供对应架构的 Linux Node runtime；x86 使用 `node-v20.x-linux-x64.tar.gz`，ARM64 使用 `node-v20.x-linux-arm64.tar.gz`。workflow 会自动下载，手动构建时通过 `FNOS_TARGET_ARCH` 与 `FNOS_NODE_TARBALL` 显式指定。
- Windows 本地只能生成调试 stage 包，不能产出可安装的正式包。
- 当前包包含 Linux Node runtime、Next standalone、Prisma runtime 和必要依赖，体积会明显大于 miniBill；除非后续把服务端重写为更轻的单二进制运行时，否则不承诺几 MB 级。
- 飞牛包不要求用户提供单独的系统密码；敏感操作验证当前登录用户自己的密码（仅管理员可执行）。启动脚本仍会为兼容保留自动生成 `MMH_SYSTEM_PASSWORD`。
- 飞牛包不使用独立 `-fnos` 版本号；正式发布前用 `npm run release:version` 递增一次 `package.json` 的 `0.1.x`，并保持 GitHub Release、GHCR 镜像和所有架构 `.fpk` 同号。
- 用户通过应用中心或手动选择新版 `.fpk` 时，应在已安装 `mmh` 上直接覆盖升级，并复用已安装应用数据目录里的端口配置。`uninstall_init` 仅用于用户主动卸载或异常恢复时备份 appdata，不作为升级路径。

## 待确认

- 飞牛 `.fpk` 的正式 manifest 字段、签名方式和目录结构。
- ~~飞牛手动 `.fpk` 覆盖升级在 `manualInstall` 状态下即使误触发 `wizard/install`，也必须复用已安装端口，不能把向导端口写回覆盖。~~ **已确认并解决（0.1.47）**：FN 软仓客户端只解析 `wizard/install`，因此直接不打包 `wizard/install`、`wizard/upgrade`、`wizard/uninstall`，让客户端跳过向导；端口沿用的依据是卸载时保留的 `var` 目录里的 `.port` / `mmh.env`，改端口改由 `wizard/config` 承担。已在 5.149 实测：无安装向导的包 `fnpack build` 正常，`appcenter-cli install-fpk` 在 stdin 为 `/dev/null` 时不需要任何输入；通过 `wizard/config` 把端口改成 8888 再改回 7777 均生效。
- 系统更新页在 `MMH_DEPLOY_TARGET=fnos` 时显示飞牛包更新方式，而不是 Docker updater。

## 下一步清单

- [x] 生成并校验 `prisma/schema.native.prisma`。
- [x] 建立 `npm run build:fnos:app` Linux SQLite standalone 构建脚本。
- [x] 建立 `npm run build:fnos` 正式飞牛包脚本，x86 产物只包含 `release-artifacts/fnos/mmh-x86_64.fpk`，ARM64 产物只包含 `release-artifacts/fnos/mmh-arm64.fpk`。
- [x] 建立 `npm run stage:fnos` 调试归档脚本。
- [x] 建立 `npm run check:fnos` 飞牛包素材校验。
- [x] 增加 GitHub Release workflow，发布时自动下载对应架构的 Linux Node runtime、安装对应架构官方 `fnpack` 并构建正式 `.fpk`。
- [ ] 执行 `.github/workflows/fnos-release.yml`，确认正式 x86/arm64 `.fpk` 产出并通过内置校验。
- [ ] 在 x86 与 ARM64 飞牛测试机安装旧版 `.fpk` 后，直接安装同一 `appname=mmh` 的新版 `.fpk`，验证覆盖升级沿用旧端口、SQLite 数据保留、版本号变化和日志查看。
- [x] 给系统更新页增加飞牛环境提示。
- [ ] 将大列表接口改成分页或游标，优先处理账单、明细、导入预览。
- [ ] 补 API mutation 的 Origin/CSRF 与登录失败限流。
