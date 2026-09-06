# 外部 Agent API 接入说明

文档版本：`v0.1.1`

适用 API 版本：`/api/v1`

最后更新：`2026-09-04`

本文档给 Hermes、Codex、Claude 等外部 Agent 接入 MMH 后端使用。它说明如何通过 HTTP API 读取和修改数据，以及哪些接口不应直接用于财务业务写入。

## 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| `v0.1.1` | `2026-09-04` | 外部 Agent 认证改为独立访问 Key；访问 Key 只存哈希，创建后列表仅返回脱敏预览，不再使用管理员密码作为 Bearer / X-Api-Key。 |
| `v0.1.0` | `2026-07-02` | 初版。记录外部 Agent 认证方式、推荐业务 API、受控通用 DB API、账簿隔离、敏感模型屏蔽、加密与密钥安全边界。 |

## 基本信息

- Base URL：由部署环境决定，例如 `http://127.0.0.1:7777` 或 NAS 上的 MMH 访问地址。
- API 前缀：`/api/v1`。
- 返回格式：成功通常为 `{ "ok": true, ... }`，失败通常为 `{ "ok": false, "error": "..." }`。
- 日期时间字段使用 ISO 字符串。
- 金额、份额、净值等 Decimal 字段在通用 DB API 中以字符串返回，避免精度丢失。

## 认证

外部 Agent 调用支持以下 header：

```http
Authorization: Bearer <访问 Key>
```

或：

```http
X-Api-Key: <访问 Key>
```

访问 Key 由 Web 设置页的“外接 API Key”创建。服务端只保存哈希；新建时页面会显示明文一次，保存后列表只返回 `keyPreview`，不会再返回完整明文。旧版本已保存的明文 Key 仍可兼容校验，并会在首次成功使用后自动升级为哈希存储。

不要使用管理员登录密码作为 Bearer / X-Api-Key。管理员密码只用于 Web 登录和需要确认身份的敏感操作。

浏览器内访问也可以使用登录后的签名 cookie session。跨站浏览器 API 请求默认拒绝；原生 App、CLI 和 Agent 这类不发送浏览器 `Origin` 的客户端不受 CORS 限制。

访问 Key 是受限的业务数据凭据，不是管理员会话。它不能访问通用数据库 API、用户/设置/认证、初始化、调试、清理、AI、邮件或移动同步接口；Android 移动端当前使用登录 Cookie。

## 加密与密钥安全

MMH 里有几类数据必须按敏感数据处理：

- 管理员密码、登录密码、重置 token、cookie/session。
- `DATABASE_URL`、`STATEMENT_API_KEY`、邮件授权码、SMTP/IMAP 密码。
- AI 渠道密钥、基金查询 API Key、Resend API Key。
- `SystemSetting` 中保存的系统配置，尤其是 `api_key_encryption_master`。

当前通用 DB API 已经屏蔽这些敏感模型：

- `User`
- `UserSettings`
- `AccessKey`
- `ApiKey`
- `AiChannel`
- `EmailAccount`
- `FundQueryApi`
- `SystemSetting`
- `PasswordResetToken`

`src/lib/auth/encrypt.ts` 使用 AES-256-GCM 加密部分 API Key，主密钥保存在 `SystemSetting.api_key_encryption_master`。因此外部 Agent 不允许读取 `SystemSetting`，也不允许通过通用 DB API 读取或写入保存密钥/密码的模型。

安全要求：

- 不要把管理员密码、访问 Key、数据库连接串、NAS 私有地址写进公开文档、Git 提交或 Agent 回复。
- Agent 日志只能记录字段名、记录 ID、操作结果，不记录明文密钥、密码、token。
- 如果未来要让 Hermes 管理密钥，应新增专门的密钥 API：只允许写入或轮换，不返回明文；返回值只能是 `configured`、`keyPreview`、`updatedAt` 这类摘要。
- 当前访问 Key 已支持撤销和哈希存储；后续可继续扩展作用域、过期时间和审计。

## 推荐优先级

外部 Agent 操作数据时，优先使用业务 API；只有业务 API 不覆盖目标操作时，才使用通用 DB API。

优先使用：

- `GET /api/v1/accounts`
- `GET /api/v1/transactions`
- `GET /api/v1/transactions/detail`
- `PUT /api/v1/fund/entry`
- `POST /api/v1/entries/batch-update`
- `POST /api/v1/entries/delete`
- `GET/POST /api/v1/fund/fee-rate`
- `GET/POST /api/v1/fund/confirm-days`
- `POST /api/v1/fund/sync-position`

通用 DB API 适合 Agent 做受控维护、补数据和核对，不适合作为普通客户端的长期业务契约。

## 通用 DB API

### 列出可访问模型

```http
GET /api/v1/db/models
Authorization: Bearer <访问 Key>
```

返回：

```json
{
  "ok": true,
  "models": [
    {
      "name": "TxRecord",
      "dbName": "transactions",
      "title": "交易记录",
      "fields": []
    }
  ]
}
```

敏感模型不会返回，例如 `User`、`UserSettings`、`AccessKey`、`ApiKey`、`SystemSetting`、`EmailAccount`、`PasswordResetToken`。

### 查询数据

```http
GET /api/v1/db/data?model=TxRecord&take=100&skip=0&orderBy=date&orderDir=desc
Authorization: Bearer <访问 Key>
```

可选参数：

- `model`：Prisma 模型名，例如 `TxRecord`、`Account`。
- `take`：每页条数，默认 `100`，最大 `500`。
- `skip`：跳过条数，默认 `0`。
- `orderBy`：排序字段，必须是该模型已有字段。
- `orderDir`：`asc` 或 `desc`。
- `where`：JSON object 字符串。模型有 `householdId` 时，服务端会自动追加当前账簿过滤。
- 对通过 `Account`、`account`、`transactions` 关联到账簿的模型，服务端也会自动追加账簿归属过滤。

示例：

```bash
curl -H "Authorization: Bearer $MMH_ACCESS_KEY" \
  "http://127.0.0.1:7777/api/v1/db/data?model=TxRecord&take=20&orderBy=date&orderDir=desc"
```

### 创建记录

```http
POST /api/v1/db/data
Content-Type: application/json
Authorization: Bearer <访问 Key>
```

Body：

```json
{
  "model": "Category",
  "data": {
    "name": "示例分类",
    "type": "expense"
  }
}
```

有 `householdId` 的模型会由服务端自动写入当前账簿，不要让 Agent 自己传入其他账簿 ID。

如果写入数据包含 `accountId`、`toAccountId`、`cashAccountId` 或 `entryId`，服务端会校验引用记录属于当前账簿。

### 更新记录

```http
PUT /api/v1/db/data
Content-Type: application/json
Authorization: Bearer <访问 Key>
```

Body：

```json
{
  "model": "TxRecord",
  "id": "目标记录 ID",
  "data": {
    "note": "修正后的备注"
  }
}
```

如果目标记录不存在，会返回 `{ "ok": false, "error": "记录不存在" }`。如果记录不属于当前账簿，会返回 403。

### 删除记录

```http
DELETE /api/v1/db/data?model=TxRecord&id=目标记录ID
Authorization: Bearer <访问 Key>
```

删除前必须确认业务影响。基金、余额、定投、保险等相关数据通常还需要调用业务 API 或服务函数做重算。

## 当前数据模型注意事项

- 当前 `prisma/schema.prisma` 里没有 `model FundEntry`。
- 基金交易字段目前主要在 `TxRecord` 上，例如 `fundCode`、`fundName`、`fundSubtype`、`fundUnits`、`fundNav`、`fundFee`、`fundConfirmDate`、`fundArrivalDate`。
- 投资买入类通常是 `TxRecord.accountId = 资金来源账户`，`TxRecord.toAccountId = 投资/基金账户`。
- 赎回类通常方向相反，修改后要按业务规则重算持仓和余额。
- 基金持仓重算应使用业务入口，例如 `POST /api/v1/fund/sync-position`，不要让 Agent 自己重复实现持仓算法。

## Agent 操作守则

- 读数据前先调用 `/api/v1/db/models` 确认模型和字段存在。
- 写数据前优先查目标记录，并确认 `accountId`、`toAccountId`、`householdId` 语义。
- 修改交易、基金、余额相关数据后，需要触发对应业务重算或刷新接口。
- 不要通过通用 DB API 访问或修改用户、密码、API Key、邮箱账号、系统设置等敏感模型。
- 不要把管理员密码、真实 Base URL、NAS 地址、数据库连接串写进公开文档或提交记录。
