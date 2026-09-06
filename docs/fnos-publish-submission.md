# MMH 飞牛官方上架提交材料

本文记录 MMH 提交飞牛官方应用中心前的包信息、测试结论和提交文案。

## 当前状态

`v0.1.2-fnos` 与 `v0.1.3-fnos` Release 中的既有 `mmh.fpk` 不再作为官方上架提交包使用。现场验证发现这些包存在发布级问题：

- `cmd/main` 仍把 SQLite 数据放到应用安装目录，未使用飞牛应用数据目录。
- `better-sqlite3.node` 来自不兼容目标系统的构建环境，可能要求高于 fnOS 1.2 / Debian 12 的 GLIBC 版本。
- `wizard/uninstall` 会阻塞自动化升级验证；常规更新必须按同一 `appname=mmh` 覆盖安装新版 `.fpk`，不能把卸载重装当作升级方案。

下一次官方提交必须为 x86 和 ARM64 重新生成同一版本 `.fpk`，并通过 `npm run check:release-version` 与 `FNOS_VERIFY_BUILT_FPK=1 npm run check:fnos` 验证后再上传 Release。

## 历史作废包

- 作废应用包：`release-artifacts/fnos/mmh-0.1.2-fnpack.fpk`
- GitHub Release 下载：`https://github.com/frankluise5220/MMH/releases/download/v0.1.2-fnos/mmh.fpk`
- 版本：`0.1.2`
- 平台：`x86_64` / `x86`
- SHA256：`21130206794C3D09074FEC323A333F2EBC394423C08CA3F7801750644E9B55E1`
- 大小：`139,661,052` bytes
- 生成方式：在 fnOS 测试机使用 `/usr/local/bin/fnpack build` 生成。

## 下一次提交包要求

- 版本必须使用 `package.json` 的统一 `0.1.x`，当前下一版为 `0.1.10`。
- Release 中只允许保留两个 FPK：x86 `mmh-x86_64.fpk` 与 ARM64 `mmh-arm64.fpk`，必须由 `.github/workflows/fnos-release.yml` 重新构建并覆盖上传。
- 包内 `manifest` 版本、仓库源 `version`、GitHub Release tag `v0.1.x`、GHCR 镜像 tag 和文件名必须一致；不再使用 `v0.1.x-fnos`。
- 包内 `cmd/main` 必须使用飞牛应用数据目录保存 SQLite，不能回退到应用安装目录。
- 包内 `better-sqlite3.node` 必须在 fnOS 目标 GLIBC 版本可加载。
- 包内不得包含安装类向导：`wizard/install`、`wizard/upgrade`、`wizard/uninstall` 都不允许。FN 软仓客户端只解析 `wizard/install`，只要该文件存在，更新时就会弹向导要求填写服务端口；去掉它之后更新才能真正静默。端口优先沿用已安装 MMH 的 `.port` / `mmh.env`，不能把包默认 `7777` 写回覆盖已有端口。
- 包内必须保留 `wizard/config`：改端口只能通过应用设置，软仓客户端不解析该文件，只有用户在应用中心主动打开 MMH 设置时才显示。保存后由 `cmd/config_callback` 校验端口、停服、把新端口写入 `.port` 与 `mmh.env`（`cmd/main` 只认 `mmh.env` 的 `PORT`）再启动。首次安装没有向导，端口改为从 `7777` 起自动探测空闲端口。
- 两个架构包必须保持同一个 `appname=mmh` 和同一个版本号；x86 manifest 使用 `arch=x86_64`、`platform=x86`，ARM64 manifest 使用 `arch=aarch64`、`platform=arm`。

## Manifest 摘要

x86 包：

```text
appname               = mmh
version               = 0.1.10
display_name          = MMH
arch                  = x86_64
platform              = x86
source                = thirdparty
service_port          = 7777
checkport             = true
os_min_version        = 0.9.0
changelog             = 修复飞牛覆盖升级链路：使用同一 appname 的新版 FPK 直接覆盖安装，并继续包含首次使用向导、当前图标和 SQLite 数据目录修复。
```

ARM64 包：

```text
appname               = mmh
version               = 0.1.10
display_name          = MMH
arch                  = aarch64
platform              = arm
source                = thirdparty
service_port          = 7777
checkport             = true
os_min_version        = 0.9.0
changelog             = 与 x86 包保持同版本、同应用 ID，只替换为 ARM64 Linux Node runtime 与原生 SQLite 依赖。
```

## 应用信息

- 应用名称：MMH
- 应用分类：财务 / 记账 / 家庭资产管理
- 开发者：frankluise5220
- 项目主页：`https://github.com/frankluise5220/MMH`
- 默认端口：`7777`
- 数据存储：飞牛应用数据目录中的 SQLite 数据库 `mmh.db`
- 权限说明：默认以应用用户运行，只读写自身应用数据目录，不需要 Docker、不暴露数据库端口。

## 应用简介

MMH 是一套本地部署的家庭记账与资产管理工具，支持账户流水、信用卡账单、基金持仓、统计报表和数据导入。飞牛版会把数据保存在自己的 NAS 上，安装后可直接通过浏览器访问 `http://飞牛IP:7777/` 使用。

## 提交说明

请帮忙审核 MMH 飞牛应用包：

```text
应用名：MMH
版本：0.1.10
平台：x86_64 / x86；aarch64 / arm
端口：7777
包 SHA256：发布后分别填写 x86 与 ARM64
下载地址：
- x86：https://github.com/frankluise5220/MMH/releases/download/v0.1.10/mmh-x86_64.fpk
- ARM64：https://github.com/frankluise5220/MMH/releases/download/v0.1.10/mmh-arm64.fpk
项目主页：https://github.com/frankluise5220/MMH
说明：本包为飞牛 SQLite 原生包，不依赖 Docker/PostgreSQL。数据保存在应用数据目录，同一 appname 的新版 FPK 支持覆盖升级，升级不删除用户账本数据。
```

## 已验证

- `npm run check:fnos` 通过。
- Release 包 manifest 版本为 `0.1.10`。
- 正式提交包由 fnOS 测试机上的 `fnpack build` 生成。
- GitHub Release 只应包含 x86 `mmh-x86_64.fpk` 和 ARM64 `mmh-arm64.fpk` 两个 FPK。
- FN 软仓源应识别已安装旧版本到源版本 `0.1.10` 的更新；升级必须以同一 `appname=mmh` 覆盖安装新版 `.fpk`，完成后不应继续提示更新，且端口保持旧版 MMH 的在用端口。

## 待人工补充

- 官方要求的应用截图。
- 官方要求的测试视频或操作录屏。
- 提交人联系方式和飞牛开发者先锋交流群内的审核沟通记录。
