# 安全加固说明

本文档记录 MMH 在多环境登录、HTTPS 访问和 NAS 部署下的基础安全边界。

## 不应公开的入口

- 不要把 Prisma Studio 暴露到局域网或公网。Prisma Studio 是数据库管理工具，会绕过 MMH 的登录、角色和账簿隔离逻辑。
- 不要把 Postgres 端口暴露到公网。默认 `docker-compose.yml` 和 `deploy/nas/docker-compose.yml` 只将数据库绑定到 `127.0.0.1:5433`，应用容器通过 Docker 内网访问数据库。
- 飞牛包默认不映射 Postgres 宿主端口；如果为了排查临时开放数据库端口，排查结束后应立即关闭。
- 不要公开调试脚本、临时查询脚本或开发服务器调试端口。

## HTTPS 与 Cookie

- 正式远程访问应通过 HTTPS 反向代理，例如 Caddy、Nginx、NAS 自带反代或可信网关。
- 登录 Cookie 使用签名 session 值，包含用户 ID、过期时间和随机 nonce，并用服务端 HMAC 校验；旧版固定 `ok` cookie 不再被接受，升级后旧登录态需要重新登录。
- 生产环境下，登录 Cookie 默认使用 `HttpOnly`、`SameSite=Lax`；通过 HTTPS 访问时会使用 `Secure`。
- 可信内网 HTTP 访问不会设置 `Secure`，否则浏览器会拒收登录 Cookie，表现为登录后又回到登录页。
- 如果反向代理让应用无法识别原始请求协议，可以临时设置 `MMH_INSECURE_COOKIES=1`，不要用于公网。
- 确认站点永远通过 HTTPS 访问后，可以设置 `MMH_ENABLE_HSTS=1` 开启 HSTS。

## API 访问

- Web 同源请求使用签名 cookie session；外部 Agent、CLI 和原生移动端使用设置页创建的独立访问 Key。
- `Authorization: Bearer` 和 `X-Api-Key` 只接受 `AccessKey` 表中的访问 Key，不再把管理员密码或旧版 `access_password` 当作 API Key。
- 访问 Key 仅用于受限的业务数据接口；不能访问通用数据库 API、用户/设置/认证、初始化、调试、清理、AI、邮件和移动同步接口。Android 当前使用登录 Cookie，不依赖访问 Key。
- 新建访问 Key 只在创建弹窗显示一次明文，服务端保存哈希，列表接口只返回 `keyPreview`；旧版明文 Key 首次成功使用后会自动升级为哈希。
- 旧版 `access_password` 只作为旧用户登录时的一次性迁移桥接；备份、工厂重置、账户永久删除、保险删除等敏感操作必须先为当前用户设置 bcrypt 密码。
- `/api/v1` route 不再返回 `Access-Control-Allow-Origin: *`。带浏览器 `Origin` 的跨站 API 请求默认由 `proxy.ts` 拒绝；无 `Origin` 的原生 App、CLI 和服务端 Agent 请求不受浏览器 CORS 限制。
- 如果只允许固定域名或固定内网地址访问，请在系统设置里的“访问白名单”中维护允许访问的域名或 IP。这里的域名或 IP 指用户当前访问 MMH 的地址，不是用户设备 IP，也不是数据库服务器 IP。`localhost`、`127.0.0.1` 和 `::1` 是本机救援地址，始终由代码默认允许，不显示为白名单条目。新装且没有任何白名单条目时，该功能应处于关闭状态；点击开启时，系统会先把当前非本机访问地址写入白名单并显示出来，再保存开关状态。开启后，未列入白名单的访问 Host 会被应用层直接拒绝；保存和删除白名单时也必须阻止把当前非本机访问地址排除在外。
- `proxy.ts` 读取白名单设置超时时不会把 `false` 或空列表写入缓存；已有缓存继续生效，避免慢数据库把安全设置静默降级。

## NAS 与备份

- Docker 容器入口会先修复既有 `/app/data` volume 的归属，再降权为 `node` 用户启动应用；这样旧版 root 容器创建的数据卷升级后仍可写，同时 Next.js 进程不以 root 身份运行。
- fnOS / 群晖生命周期脚本创建的 `upgrade-backups` / `uninstall` 备份目录应为 `700`，备份出的 appdata、SQLite 数据库、环境文件、session secret 和系统密码文件都要去掉 group/other 权限。

## 账簿隔离

- 业务接口应从服务端 session 解析当前用户和账簿，不应信任前端提交的账簿 ID。
- 普通用户只能访问自己所属账簿；管理员跨账簿访问也必须经过应用层权限判断。
- 新增 API 时优先使用 `getHouseholdScope()` 或 `getCachedHouseholdScope()` 获取 `householdId`，所有查询、更新、删除都应带上账簿条件。

## 后续方向

- 对登录失败增加限流和冷却。
- 为访问 Key 增加作用域、过期时间和审计日志。
- 飞牛 / NAS 更新器 token 不应使用空值或默认弱值；系统更新页应提示当前更新能力是否可用。
- 对邮箱密码、AI API Key、更新 token 等敏感字段做应用层加密。
- 增加关键操作审计日志：登录、切换账簿、删除、批量修改、导入、系统更新。
- 增加会话管理：查看当前登录设备、退出其他设备。
