# MMH Synology DSM SPK

本文记录 MMH 面向群晖 DSM 的 `.spk` 分发方式。普通用户安装和更新请优先看 `docs/nas-install-manual.md`。

群晖版使用 SQLite 原生运行方式：包内包含 Next standalone、Linux Node runtime、Prisma runtime、SQLite 初始化脚本和 DSM 套件启动脚本，不依赖 Docker/PostgreSQL。当前 `.spk` 的 `os_min_ver` 兼容下限保持为 DSM `7.0-40000`，同时优先面向 DSM 7.2 及更新版本做实际安装测试。正式 Release 资产按架构发布：

```text
release-artifacts/synology/mmh-synology-v0.1.x-x86_64.spk
release-artifacts/synology/mmh-synology-v0.1.x-arm64.spk
```

调试归档不是用户安装包：

```text
release-artifacts/synology/mmh-synology-v0.1.x-x86_64-spk-source.tgz
release-artifacts/synology/mmh-synology-v0.1.x-arm64-spk-source.tgz
```

格式要求：

- `.spk` 最外层必须是未压缩 tar 归档，根目录包含 `INFO`、`scripts/`、`conf/`、图标和 `package.tgz`。
- `package.tgz` 是 `.spk` 内部的 gzip tar 归档，用来承载 `app/` 运行目录。
- `INFO` 里应写 `os_min_ver="7.0-40000"`、`checksum="<package.tgz md5>"` 和 `extractsize="<package 解压后 KB>"`；不要仅因 DSM 7.2 更常见而主动收窄 7.0/7.1 用户的安装入口，DSM 7.2 及更新版本作为优先测试面。
- `conf/privilege` 里应写 `"run-as": "package"`，不要写成无效的 `run_as`，否则 DSM 会判定套件以 root 权限运行并拒绝安装。
- 最终 `.spk` tar header 里的生命周期脚本必须是可执行文件，`scripts/start-stop-status`、`postinst`、`preuninst`、`preupgrade`、`postupgrade` 使用 `0755`，普通元数据文件使用 `0644`，并以稳定的 numeric root ownership 归档。
- 如果 DSM 提示“套件文件格式不正确，请联系套件开发人员”，先确认上传的是正式 `.spk`，不是 `*-spk-source.tgz`；如果正式 `.spk` 仍报错，应重新构建并发布下一个补丁版本。

## 用户安装

1. 打开 GitHub Release 页面。
2. 下载适合当前群晖设备架构的 `.spk`：
   - x86_64：`mmh-synology-v0.1.x-x86_64.spk`
   - ARM64：`mmh-synology-v0.1.x-arm64.spk`
3. 在 DSM 套件中心选择手动安装并上传 `.spk`。
4. 安装完成后打开 `http://群晖IP:7777/`。

## 用户更新

下载更高版本、同架构的 `.spk`，在 DSM 套件中心对已安装的 MMH 覆盖安装。不要把卸载旧版再安装新版作为日常更新方式；覆盖升级应保留套件数据目录中的 SQLite 数据库。

## 打包命令

先构建 SQLite standalone：

```bash
npm run build:synology:app
```

再按架构打包：

```bash
SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run build:synology
SYNOLOGY_TARGET_ARCH=arm64 SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-arm64.tar.gz npm run build:synology
```

只生成调试 stage 归档：

```bash
SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run stage:synology
SYNOLOGY_TARGET_ARCH=arm64 SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-arm64.tar.gz npm run stage:synology
```

打包前后校验：

```bash
npm run check:synology
SYNOLOGY_VERIFY_BUILT_SPK=1 npm run check:synology
```

## 发布规则

- 凡是正式发布包含群晖 `.spk`，必须先在发布前本地生成同版本 x86_64 / arm64 两个 `.spk`，交给真实 DSM 环境安装/覆盖升级测试；用户确认可以安装且 MMH 可以启动后，才允许创建 GitHub Release 或上传公开 SPK 资产。
- 正式 `.spk` 打包必须在 Linux 环境完成；如果当前机器是 Windows 或缺少对应 Linux Node runtime tarball，只能视为发布阻塞，不能用 GitHub Release workflow 直接替代首次安装测试。
- 本地交付测试前必须对两个架构分别执行 `SYNOLOGY_VERIFY_BUILT_SPK=1 npm run check:synology`，arm64 额外带 `SYNOLOGY_TARGET_ARCH=arm64`。
- 如果其他分发面需要先发布，而群晖本地测试尚未通过，Release 说明中必须明确“群晖 SPK 暂缓发布”，并且不得上传 `.spk` 资产。
- GitHub Release 通过 `.github/workflows/synology-release.yml` 构建并上传 `release-artifacts/synology/*.spk`。
- Release workflow 必须重新构建 `.spk`，不能把 `*-spk-source.tgz` 当成用户安装包。
- 包版本直接使用 `package.json` 的 `0.1.x`，与 GitHub Release tag、GHCR 镜像 tag、飞牛 `.fpk` 和 Android 版本保持同号。
- 群晖版运行时设置 `MMH_DEPLOY_TARGET=synology`，系统更新页只展示套件版本；更新由 DSM 套件中心或手动安装新版 `.spk` 管理。
- `.spk` 不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
