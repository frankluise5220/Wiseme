# 飞牛包发布源说明

正式飞牛应用只有一个：

```text
appname=mmh
```

因为包内包含 Node runtime 和 `better-sqlite3` 原生依赖，Release 资产需要按架构分包。正式发布只保留两个 FPK 文件：

```text
mmh-fnos-v0.1.x-x86_64.fpk
mmh-fnos-v0.1.x-arm64.fpk
```

不要发布 `mmh.fpk`、不带版本号的架构旧别名、`mmh-native.fpk`，也不要把 `*-fpk-source.tgz` 当成用户安装包。

发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 会按 x86 和 arm64 矩阵安装对应架构的官方 `fnpack`，构建并上传 `release-artifacts/fnos/*.fpk`。如果安装、打包或校验失败，workflow 必须失败，避免发布不可安装的替代归档。

发布时建议同时维护应用源索引。飞牛原生应用源会访问：

```text
源地址/api/apps
```

本目录下的 `api/apps` 是可直接通过 GitHub raw 访问的静态源文件。源地址可以填写：

```text
https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/fnos/repository
```

这个源返回的 `download_url` 默认指向 GitHub Release 托管的 x86_64 包 `mmh-fnos-v0.1.x-x86_64.fpk`；`download_urls.x86_64` 使用同一个地址，`download_urls.arm64` 指向 GitHub Release 中的 `mmh-fnos-v0.1.x-arm64.fpk`。

源文件字段包括：

- `id`：稳定应用 ID，使用 `mmh`。
- `version`：飞牛包版本，与 Release tag 对齐。
- `platform`：默认兼容平台，当前保留 `x86` 以兼容旧软仓。
- `platforms`：支持的平台数组，当前为 `x86` 和 `arm`。
- `download_url`：默认/旧客户端下载地址，当前指向 GitHub Release 托管的 x86_64 包 `mmh-fnos-v0.1.x-x86_64.fpk`。
- `download_urls`：按架构提供下载地址；x86_64 指向 GitHub Release 的 `mmh-fnos-v0.1.x-x86_64.fpk`，arm64 指向 GitHub Release 中的 `mmh-fnos-v0.1.x-arm64.fpk`。
- `changelog`：面向用户的更新说明。
- `type`：应用类型，固定为 `原生`，供 FN 软仓「Docker应用 / 原生应用」筛选使用。
- `updated_at`：发布日期，使用 `YYYY-MM-DD`，供 FN 软仓首页「新应用」卡片排序使用。
- `downloads`：下载量统计，当前固定为 `0`。
- `screenshots`：详情页预览图地址数组，当前指向 GitHub raw 的 `public/branding/` 品牌图。

`apps.example.json` 是字段草案。正式字段以飞牛应用源规范为准；但原则保持不变：同一个 `id=mmh` 和同一个 `version=0.1.x` 下，源索引必须能给 x86 与 arm64 机器拿到对应架构的 `.fpk`。

更新时，源或应用中心应让飞牛在已安装的 `appname=mmh` 上直接安装更高版本、同架构的 `.fpk`。不要把常规更新做成先卸载再安装；卸载只属于用户主动删除应用或异常恢复流程。

版本历史只保留最近 5 次 release。发布新版本时，仓库索引和 VPS 上对应的旧版本文件都应同步清理，避免旧版本无限堆积。
