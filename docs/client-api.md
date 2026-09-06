# 客户端 API 说明

本文档用于 Web、iOS、Android 接入 MMH 后端 API。当前阶段先记录接口契约和约定，后续在接口稳定后可再生成 OpenAPI 或 typed client。

## 总体约定

- 客户端接口使用 `/api/v1` 作为版本前缀。
- Web 可以使用更完整的明细接口，移动端可以使用聚合接口，但两者必须共享同一套业务含义和计算结果。
- debug、test、cleanup、internal 类接口不是客户端接入契约，除非本文档明确列入。
- 面向客户端的 route 文件顶部应写 JSDoc，说明方法、参数、返回结构。

## 通用返回格式

推荐成功格式：

```json
{
  "ok": true,
  "data": {}
}
```

推荐失败格式：

```json
{
  "ok": false,
  "error": "错误说明"
}
```

删除、修改类接口在目标 ID 不存在时必须返回失败，不能静默成功。

## 登录与上下文

客户端访问财务数据前，需要明确以下上下文：

- 服务器：客户端连接的 Web 服务地址。
- 账簿：财务数据所在账簿。
- 用户：账簿下的登录用户。
- 角色：用户在账簿中的权限。

用户名和密码属于账簿/用户上下文，不只是 Web 服务进程本身。如果系统存在多个账簿，登录或会话接口应返回足够信息让客户端显示当前账簿并支持安全切换。

## 数据格式约定

### ID

- 客户端应使用稳定 ID 识别实体。
- API 返回列表时，应同时返回客户端展示需要的名称字段。
- 客户端不应通过显示名称推断唯一身份。

### 日期

- 日期字段必须说明是日期时间还是业务日期。
- 纯业务日期建议使用 `YYYY-MM-DD`。
- 涉及基金净值、确认日期、到账日期时，需要避免时区漂移。

### 金额和小数

- 金额、份额、净值、成本、收益字段应保持财务计算需要的精度。
- 客户端显示的小数位可以受偏好设置影响，但 API 的原始数值不应为了显示而过早截断。

### AI 模型接口方式

- AI 模型配置包含 `apiMode` 字段。
- `chat` 表示 OpenAI 兼容 Chat Completions 接口（`/v1/chat/completions`）。
- `responses` 表示 OpenAI Responses API（`/v1/responses`）。
- Ollama 渠道固定使用原生 `/api/chat`，不接受 `apiMode` 覆盖。
- 旧配置和旧备份没有 `apiMode` 时按 `chat` 处理。

### 分页、排序和筛选

列表接口应说明：

- 分页参数。
- 排序字段和方向。
- 筛选参数。
- 默认排序规则。

涉及余额、流水、基金交易明细的列表必须有确定排序，避免同一天多笔记录造成显示余额错乱。
- 交易记录可返回 `dayOrder` 作为同一显示日期内的人工业务顺序。数值越大表示越晚发生：倒序明细中越靠上，正序余额计算中越靠后。余额校准/初始余额锚点仍固定为同日最后记录。

## 模块目录

下面是计划维护的客户端 API 模块。具体接口应在实现或稳定后补充到对应章节。

### Auth

范围：

- 登录。
- 登出。
- 会话校验。
- 密码状态。
- 找回密码。

相关路径示例：

- `/api/v1/auth/verify`
- `/api/v1/auth/logout`
- `/api/v1/auth/password-status`
- `/api/v1/auth/create-ledger`
- `/api/v1/auth/password-reset/request`
- `/api/v1/auth/password-reset/confirm`

新建账簿规则：

- `/api/v1/auth/password-status` 在真正空库（没有账簿、没有用户、没有旧密码）时返回 `needsInitialLedgerSetup: true`，客户端应进入“创建第一个账簿”流程。
- `/api/v1/auth/create-ledger` 用于登录页创建账簿。首次空库初始化第一本账簿时可省略邀请码；非首次创建必须通过邀请码。
- 非首次创建时，该接口必须校验系统设置中的账簿创建邀请码，不能无门槛开放。
- 成功后应直接建立新账簿管理员账号并写入登录态，让用户进入新账簿。

敏感操作验证规则：

- `/api/v1/auth/verify` 携带 `verifySystem: true` 时用于系统初始化、删除账簿等敏感操作验证，不建立用户登录态。
- 验证要求当前登录用户是管理员，并校验当前登录用户自己的密码；不再使用部署级“数据库密码/系统密码”（`MMH_SYSTEM_PASSWORD`、`POSTGRES_PASSWORD` 等）。
- Web 登录优先携带 `userId` 验证具体用户；当多个账簿里都有 `admin` 这类同名用户时，不应只靠用户名定位。
- `/api/v1/auth/password-status` 的用户列表应返回用户 `id`、`name`、`householdId` 和 `householdName`，客户端用账簿名区分同名用户。

找回密码规则：

- `/api/v1/auth/password-reset/request` 使用用户名和绑定邮箱定位用户。
- 如果同一个用户名和邮箱匹配多个账簿，返回 `{ ok:false, code:"AMBIGUOUS_USER", households }`，客户端应让用户选择账簿后携带 `householdId` 重新请求验证码。
- 当验证码邮件实际发送成功时，接口可返回 `maskedEmail`，用于显示脱敏后的目标邮箱，如 `ab***@qq.com`。
- `/api/v1/auth/password-reset/confirm` 支持携带 `householdId`，确保验证码只重置目标账簿下的同名用户。

### Overview

范围：

- 首页/概览汇总。
- 总资产、资金账户、投资账户、近期变化。

相关路径示例：

- `/api/v1/overview/summary`

### Reports

范围：

- Web 报表页签使用的统计接口。
- 股票持仓盈亏报表读取当前 `StockHolding`，不另算一套成本和市值。

相关路径：

- `/api/v1/reports/income-expense/detail`
- `/api/v1/reports/stock-holdings`

`GET /api/v1/reports/stock-holdings` 返回当前账簿股票账户的持仓盈亏：

- Query: `accountId?` 可选，按单个股票账户过滤。
- 成功返回 `{ ok: true, data: { rows, totals } }`。
- `rows` 来自 `StockHolding`：数量、成本、收盘价、市值、浮动盈亏、已实现收益、综合盈亏。
- `floatingPnL = marketValue - cost`，`totalProfit = floatingPnL + historicalProfit`。
- 不从 `fundCode`、`FundHolding` 或基金净值推断股票值。

### Onboarding

范围：

- 首次使用向导。
- 新账簿初始化进度判断。
- 引导客户端提示账户、期初数据、日常流水、计划任务等下一步动作。

相关路径：

- `/api/v1/onboarding/status`

`GET /api/v1/onboarding/status` 返回当前账簿的首次使用进度：

```json
{
  "ok": true,
  "data": {
    "householdId": "ledger_123",
    "householdName": "张三家",
    "defaultOwnerName": "张三",
    "familyMemberCount": 1,
    "accountCount": 4,
    "cashLikeAccountCount": 2,
    "defaultMoneyAccountId": "account_cash_123",
    "defaultMoneyAccountLabel": "张三·现金账户·现金",
    "cashAccountCount": 1,
    "debitAccountCount": 1,
    "creditAccountCount": 1,
    "investmentAccountCount": 1,
    "insuranceAccountCount": 0,
    "settlementAccountCount": 0,
    "initializationEntryCount": 0,
    "transactionCount": 0,
    "fundHoldingCount": 0,
    "regularInvestPlanCount": 0,
    "shouldShowGuide": true
  }
}
```

说明：

- `transactionCount` 不包含 `source="initialization"` 的期初初始化流水。
- `householdId` 用于客户端按账簿保存“今天不再提示”等本地引导状态。
- `defaultOwnerName` 是首个账户所有人/家庭成员名称；新建账簿默认使用账簿名，用户可改为真实姓名。
- `defaultMoneyAccountId` 和 `defaultMoneyAccountLabel` 用于首次使用向导最后一步打开默认资金账户明细表；优先现金账户，其次借记卡和电子钱包。
- `cashAccountCount`、`debitAccountCount`、`creditAccountCount`、`investmentAccountCount`、`insuranceAccountCount`、`settlementAccountCount` 用于首次使用横轴节点进度。
- `shouldShowGuide` 表示当前账簿还没有用户数据，客户端可以自动显示首次使用向导。

### Statistics

- `GET /api/v1/statistics` 返回年度收支、月度收支和分类/标签汇总。
- 收支统计金额（含投资损益、分类、标签、月度合计）统一按账户币种和库内最新汇率折算为当前账簿本币，即使查询历史期间或单个外币账户也使用最新汇率；响应 `data` 新增 `baseCurrency` 和 `missingFxCurrencies`。缺汇率金额排除在合计外，不按 1:1 折算；查询统计不触发外部汇率刷新。
- `/api/v1/reports/income-expense/detail` 的 `data` 同样返回 `baseCurrency` 和 `missingFxCurrencies`；`details.rows[].amount` 与 `details.total` 是本币统计值，`entries` 仍保留原币流水用于查看和编辑。收支统计表与导出共用相同折算口径。`FxRate` 按汇率日期、更新时间取正向或反向最新记录，缺缓存时仍沿用同账簿购汇记录回退规则。
- 支出统计使用交易的业务符号：普通支出计为正支出；以正向现金流保存的退款或冲减支出计为负支出，不转换为绝对值。
- `totalExpense`、`monthData[].expense`、`expenseCategories[].value` 和 `expenseTagGroups[].value` 使用同一统计口径。
- 业务收益统计不额外生成现金收入流水：基金赎回、往来款利息等使用通用 `realizedProfit`，理财和存款赎回/支取可由 `depositInterest - fundFee` 推导，并归入对应系统统计类别。投资买入、本金归还等资产/债权转换不应计入收支支出统计。
- 统计分类项优先返回并使用分类树节点 ID；普通交易按 `categoryId` 归集，旧数据可按 `categoryName` 回挂，收益/亏损/利息等派生统计项会解析到系统内置分类节点。
- `incomeCategories[]` 和 `expenseCategories[]` 返回 `{ id, name, value, pct }`；`id` 为分类树节点 ID，只有旧数据或兜底项无法解析时才可能为空。

### Accounts

范围：

- 资金账户。
- 投资账户。
- 账户余额。
- 账户分组。
- 往来机构/人员及简称。
- 余额重算。

相关路径示例：

- `/api/v1/accounts`
- `/api/v1/accounts/balances`
- `/api/v1/accounts/investment`
- `/api/v1/account-group`
- `/api/v1/institution`

补充约定：

- `/api/v1/accounts`、`/api/v1/accounts/balances` 以及账户相关返回中的 `balance` 表示截至当前日期的展示余额。未来日期的计划任务、贷款/汽车分期、保险缴费或其他未来流水可以存在于明细/计划中，但不能提前计入账户余额。
- 信用卡账户的 `balance` 与 Web 侧边栏一致，表示当前滚动余额：本期已出账账单金额 + 当前未出账周期支出 - 当前未出账周期收入/退款/还款；服务端取当前信用卡账期的 `effectiveBill`，不是 `cumulativeRemain - cumulativeOverpaid`。
- `/api/v1/overview/summary` 的 `creditAccountList[].currentAmount` 和 `creditCurrentAmountTotal` 表示当前信用卡账期的“本期金额”，口径为 `expenseAbs - income`，用于展示本期支出扣除本期收入/退款后的净发生额；它不同于用户锁定或滚动后的 `currentBill`/待还金额。
- `/api/v1/overview/summary` 的 `creditAccountList` 按账单存储口径返回。合并账单信用卡按同一机构/账单存储分组只返回一条机构级账单行，名称使用机构全称（如“招商银行”），客户端不得再按组内每张卡重复展示同一个 `currentBill`。
- `/api/v1/overview/summary` 返回 `investmentAccountCount` 和 `insuranceAccountCount`。客户端应优先用账户数量判断概览里的投资/保险模块是否显示，不要用金额是否为 0 推断账户是否存在。
- `/api/v1/overview/summary` 的金额一律折为账簿本位币。响应顶层返回 `baseCurrency` 和 `missingFxCurrencies`；`accountList[]`、`debtAccountList[]`、`creditAccountList[]`、`topPositions[]`、`fixedAssetAccountList[]` 在保留原始币种金额的同时附带 `currency` 和折算镜像字段（`convertedBalance`、`convertedCreditLimit`、`convertedCurrentBill`、`convertedPaid`、`convertedCurrentAmount`、`convertedMarketValue`、`convertedFloatingPnL`）以及 `fxRate`、`fxRateDate`、`fxRateMissing`。折算镜像在无可用汇率时为 `null`，客户端应退回显示原始金额并提示缺汇率，不得按 1:1 显示。
- `/api/v1/overview/summary` 的合计口径与 `/api/v1/accounts/internal` 一致：所有汇总金额（净资产、流动资金、投资市值、固定资产现值、保险资产、信用卡额度/已用、本月收支等）都是本位币合计，缺少汇率的金额按 0 计入，即被排除在合计之外，不会被按 1:1 混入。因此各账户行的折算镜像之和可能与合计不完全相等，这是预期行为。
- `/api/v1/overview/summary` 的 `investmentAccountCount`、`investmentMarketValue`、`investmentCost`、`investmentAccountList` 只统计普通投资账户，不含固定资产。固定资产单独由 `fixedAssetCount`、`fixedAssetMarketValue`、`fixedAssetCost`、`fixedAssetFloatingPnL`、`fixedAssetFloatingPnLRate`、`fixedAssetAccountList` 表达，客户端应据此单独渲染“固定资产”卡片，且 `totalNetWorth` 已包含固定资产现值。固定资产底层仍是 `investment` + `property` 账户，属兼容实现，客户端不应再把它并入投资模块。
- 信用卡账单明细和汇总按账期日期窗口归属。`statementMonth` 是缓存/兼容字段，不能让一条入账日期落在其他周期内的交易进入本期，也不能把本期日期内的交易排除出去。
- `/api/v1/institution` 新增机构时，`name` 和 `shortName` 共用同一账簿内的机构名称池。提交的全称或简称只要与任何机构的全称或简称重复，或同一机构全称和简称相同，接口返回 `{ ok:false, error }`，状态码为 `409`。
- `GET /api/v1/institution?type=fund_company` 返回当前账簿中仅分类为 `fund_company` 的机构，供基金资料设置中的基金公司 SS 选择；识别基金公司资料时，如果当前账簿不存在对应机构，服务端会自动创建或归类为 `fund_company`。
- `/api/v1/fund/name?code=xxxxxx` 对合法六位基金代码会先确保 `FundProfile` 记录存在，再进行外部资料查询；即使外部查询失败，也会保留仅含基金代码、默认 `navDateOffset=0` 且待初始化 `tradingCalendar` 的基金资料记录。
- `/api/v1/accounts` 新增或编辑账户时，同一账簿内按“所有人 + 机构 + 账户类型 + 尾号/名称”阻止不可区分的重复账户。借记卡和信用卡的 `numberMasked` 都会保存并参与查重；重复时返回 `{ ok:false, error }`，状态码为 `409`。
- `/api/v1/accounts` 中 `settlement` 与 `loan` 是互斥账户类型：`settlement` 必须传当前账簿内的 `counterpartyId`，服务端不保存 `institutionId`、`loanType` 或 `isConsumerLoan`；`loan` 必须传当前账簿内的贷款机构 `institutionId`，可传 `loanType = home | mortgage | consumer | other`，服务端不保存 `counterpartyId`。
- `POST /api/v1/accounts` 省略 `currency` 或传空值时，`PUT /api/v1/accounts` 传空 `currency` 时，服务端使用当前账簿 `Household.baseCurrency` 作为账户默认币种；Web 新增/编辑账户界面也使用同一套币种下拉选项，不再让用户手填币种代码。
- 账户对象包含 `note` 作为用户自由备注；`POST /api/v1/accounts` 和 `PUT /api/v1/accounts` 接受 `note?`，空字符串按 `null` 保存，服务端不限制用户在备注里的用途。
- 基金/货币基金类投资账户新增 `tradingCalendar` 字段，当前可选值包括 `cn_fund`、`hk_fund`、`jp_fund`、`us_fund`、`generic_weekday`。
- `POST /api/v1/accounts` 与 `PUT /api/v1/accounts` 在这类账户上接受 `tradingCalendar`；当账户类型不支持该字段时，服务端会自动清空。
- `/api/v1/business-transactions/integrity` 用于迁移期检查和修复资金流水与独立业务交易表的一致性。`GET` 返回各业务类型的 expected/existing/linked/missing 统计和问题列表；`POST { limit? }` 会复用正式同步逻辑补齐缺失的业务交易和 `EntryBusinessLink`，不直接清空 `TxRecord` 兼容字段。
- `/api/v1/business-transactions/link-cash-flow` 用于从独立业务交易补建或恢复资金侧流水并建立 `EntryBusinessLink`。`POST { businessType: "wealth" | "deposit" | "insurance" | "metal" | "fund" | "stock", businessTransactionId }`，成功返回 `{ ok:true, data:{ cashEntryId, businessTransactionId, linkId? } }`；缺少资金账户、业务记录 ID 或不支持的类型时返回 `{ ok:false, error }`。
- `/api/v1/business-transactions/insurance?accountId=...` 从独立 `InsuranceTransaction` 表读取某个保险账户的业务交易明细，返回 `{ ok:true, data:{ entries } }`。保险页面保存后的刷新应使用该接口，不再通过 `/api/v1/transactions/detail` 筛选 `source=insurance` 作为业务台账来源。
- `/api/v1/accounts/internal` 返回账户刷新数据时包含当前账簿 `baseCurrency`。当账户币种与 `baseCurrency` 不同时，账户项可包含 `convertedBalance`、`baseCurrency`、`fxRate`、`fxRateDate`、`fxRateMissing`；响应可包含 `totalConvertedBalance` 和 `missingFxCurrencies`。缺少汇率的账户金额不得按 1:1 混入折算合计。

### Currency And FX Rates

- 当前显示币种是账簿级设置，保存在 `Household.baseCurrency`。交易和账户仍保存自己的原始 `currency`。
- `GET /api/v1/currencies?includeSystem=true` 返回系统内置币种和当前系统已添加的币种，统一形如 `{ code, nameZh, nameEn, countryZh, countryEn, source }`；系统内置币种当前包含 CNY、USD、JPY、EUR、HKD、GBP、KRW、SGD、TWD、AUD、CAD、CHF、THB、MYR、VND、INR、PHP、IDR、MOP。`POST /api/v1/currency-requests` 的 Body 为 `{ code, nameZh, nameEn, countryZh }`，保存成功后立即写入可用币种字典并返回 `{ ok:true, code, currency }`，不需要额外审核；四个字段均为必填，代码必须为 2-10 位英文字母。账户、系统显示设置和购汇窗口应复用同一套币种 SS。
- `GET /api/v1/fx-rates?from=JPY,USD&to=CNY&refresh=1` 返回 `{ ok:true, baseCurrency, rates }`。`from` 省略时使用当前账簿启用账户中的币种；`to` 省略时使用账簿当前显示币种；未传 `refresh=1` 时，服务端先查缓存 `FxRate`，缺缓存时可用最近一次同账簿 `FxConversion` 正向或反向推导；传 `refresh=1` 时，服务端先强制获取外部最新汇率并写入缓存，失败时才回退已有缓存或购汇记录。
- `rates[]` 形如 `{ fromCurrency, toCurrency, rate, rateDate, source, missing, refreshed? }`。`rate` 表示 `1 fromCurrency = rate toCurrency`；`source` 可为 `manual`、外部来源或 `fx_conversion`；用户主动刷新并成功获取外部最新汇率时 `refreshed=true`；`missing=true` 时客户端应提示缺少汇率，不得自行按 1:1 折算。
- `POST /api/v1/fx-rates` 支持 `{ baseCurrency }` 修改当前显示币种，也支持 `{ fromCurrency, toCurrency?, rate, rateDate?, source? }` 写入手工汇率。手工汇率必须是正数，同币种不需要写入。
- 概览页与 `/api/v1/overview/summary` 使用同一套汇率与同一套折算规则，详见上方“概览汇总”相关约定：原始金额保留在 `balance`/`marketValue` 等字段，本位币金额放在 `converted*` 镜像字段，合计排除无汇率金额。

### Transactions

- 普通转账只接受普通资金或信用卡目标账户。目标账户如果是基金/投资、存款或往来款，应按对应业务类型提交投资、存款或往来款交易，不能保存为普通转账。
- 普通转账只支持同币种账户，并会把账户币种写入交易 `currency`。跨币种转账必须走后续专用的换汇/跨币种流程，不能用一个金额同时代表两边账户。
- `POST /api/v1/fx-conversions` 创建换汇/购汇交易。Body: `{ date:"YYYY-MM-DD", fromAccountId, toAccountId?, toCurrency?, fromAmount, toAmount, exchangeRate?, feeAmount?, note? }`。`fromAccountId` 必须是借记卡账户；`toAccountId` 可省略，省略时必须传 `toCurrency`，服务端会在换出账户同账簿、同所有人/分组、同机构下复用或自动创建该币种账户。服务端要求两个账户属于同一账簿、账户不同、币种不同、金额为正数；成功后生成两条 `source="fx_conversion"` 的单边 `TxRecord` 并用 `FxConversion` 绑定，返回 `{ ok:true, conversion, entries:{ fromEntry, toEntry } }`。`exchangeRate` 表示 `toCurrency / fromCurrency`，例如 `1000 CNY -> 21500 JPY` 的汇率为 `21.5`。`feeAmount` 仅用于记录手续费信息；实际现金扣减应包含在 `fromAmount` 中。
- 现金、借记卡或电子钱包账户转入信用卡账户时，存储和显示类型均为 `type = "transfer"`，分类为“信用卡还款”；客户端可用 `accountKind` + `toAccountKind` 校验和补充该分类，不得计入收入或支出。
- 信用卡与借记卡都支持 `expense | income | advance | transfer` 四种业务输入。`advance` 保存为内部 `transfer`，并写入 `source = "advance"`、往来对象快照和信用卡账期；`amount > 0` 表示资金账户流出并增加应收往来，`amount < 0` 表示往来对象返还、资金账户流入并减少应收往来。普通还款仍按上一条的“信用卡还款”转账规则处理。
- `/api/v1/record/ingest` 的普通 `transfer` 导入必须同时提供并匹配 `fromAccount` 和 `toAccount`。任一侧缺失或未匹配时，客户端应在预览阶段阻断，服务端也会拒绝整批写入；不得把转账对向账户按空值落库。
- `/api/v1/record/ingest` 的导入项可传 `businessType = "credit_card_repayment"`。此时 `type` 必须为 `transfer`，`fromAccount` 必须匹配借记卡/电子钱包账户，`toAccount` 必须匹配信用卡账户；服务端以转账记录落库并写入“信用卡还款”分类。
- `/api/v1/statement/import` 的转账行同样必须提供可解析的 `fromAccount` 和 `toAccount`。请求体可传 `createDebtAccounts` 和 `forceCreateOwnedMoneyAccounts`：前者允许账户文本为 `XXX的往来款` 时创建缺失的往来对象并创建或复用对应往来款账户；后者允许账户文本明确带出现有所有人且可识别为现金、借记卡、电子钱包、基金或理财账户时创建账户。两者未开启时，对应缺失账户仍应由客户端预览阻断。
- `/api/v1/record/ingest` 批量导入失败时返回 `{ ok:false, error, failedRow?, trace? }`。`failedRow` 包含 0 基 rowIndex、类型、账户、转出/转入、分类和错误原因，客户端应在预览界面直接显示到用户，而不是只提示整批回滚。
- `/api/v1/record/ingest/progress?traceId=...` 返回 `{ ok:true, progress }`，用于长时间批量导入的写库进度。`progress.phase` 包含 `preparing | writing | recalculating | done | failed`，`processed/total` 表示服务端写库进度。事务超时导致的行号表示执行到该行附近，不代表预览校验漏掉了该行脏数据。
- `/api/v1/record/ingest` 同一账簿同一时间只允许一批批量导入写库。已有导入未完成时，新的导入请求返回 409 和 `{ ok:false, error }`，客户端应提示用户等待当前导入完成，不能叠加第二批写入。
- `/api/v1/record/ingest` 写入交易成功后，账户余额重算失败不应把导入结果改成失败；接口会返回 `recalcFailedAccountCount` 供客户端提示后续刷新。
- `/api/v1/record/ingest` 和 `/api/v1/statement/import` 的导入项可传 `categoryUserEdited: true`，表示用户在普通 Excel 导入预览或邮箱/信用卡账单预览中手动改过分类。服务端只在该标记存在、且类型为收入/支出并能匹配到分类树节点时写入 `statement_recognition_rules(targetType="category")`，语义为“关键字 -> 分类树节点内容”；自动识别、AI 猜测、模板原始分类和未确认预览行不得设置该标记。导入项也可传 `institutionUserEdited: true`，表示用户手动填过收支机构；服务端只在该机构能匹配到机构表时保存并写入 `statement_recognition_rules(targetType="institution")`，匹配不到时留空，因为收支机构是可选项。
- `/api/v1/ai/chat` 只负责抽取事实字段和原始备注，不直接决定最终分类或收支机构；`/api/v1/ai/import` 会在入库前按 `statement_recognition_rules`、历史样本和当前账簿分类树补齐分类/机构，再写入数据库。客户端不应把 AI 返回的 category / institution 当作最终值。
- 批量导入前端区分普通账单和信用卡账单：普通账单逐行解析账户；信用卡账单先统一确定整份文件的信用卡账户，还款行再单独提供 `fromAccount`。
- `GET /api/v1/statement/recognition-rules` 返回当前账簿的表化识别样本 `{ ok:true, samples }`，供邮箱账单和 Excel 预览匹配“备注/收支机构/支付渠道 -> 分类或机构”，也供导入表头匹配“源表头 -> MMH 字段名”。通用关键词规则统一写入 `statement_recognition_rules`，支持 `targetType="category"`、`targetType="institution"` 和 `targetType="field"`；字段规则使用 `fieldName` 表示 `transactionDate | postedAt | amount | sourceAccount | creditAccount | institution | remark` 等内部字段。`targetType="category"` 的语义是“关键字 -> 分类树节点内容”，例如关键字“供电”命中后填入分类“电费”；`targetType="institution"` 的语义是“关键字 -> 机构表内容”，例如关键字“云闪付”命中后填入机构表里的“银联”。不能用“教育、药店、医疗、快递、会员”这类分类或抽象标签充当机构。用户保存单笔或批量分类修改时也直接写入 `statement_recognition_rules(targetType="category")`，不再维护第二张分类学习表。
- `GET /api/v1/statement/category-rules` 保留为分类学习样本兼容接口，但返回来源也是 `statement_recognition_rules(targetType="category")`。
- 账单导入项可用 `inflow` / `outflow` 表达账户侧方向。原支出的退款、退货、退回或冲正应提交为 `type="expense"`，并把金额放在 `inflow` 中，服务端保存为账户侧流入以抵减原支出分类，而不是保存为收入。
- `inflow` / `outflow` 是推荐的明确方向字段，不是导入必填字段。客户端预览只拿到单列 `amount` / `金额` 时，应按金额正负、收支大类和还款/退款关键词推断流向，不得仅因缺少 `inflow` / `outflow` 阻断导入。
- 导入账户名称只有“机构 + 账户类型”而没有后四位时，只在该机构下恰好存在一个启用的对应类型账户时自动匹配；存在多个候选时不自动选择。
- 交易接口保留 `accountName`、`toAccountName` 字段用于显示和旧客户端兼容，但服务端返回时应优先按 `accountId`、`toAccountId` 关联 `Account.name` 生成；筛选、统计、余额和移动同步都不能依赖 `TxRecord.accountName` / `toAccountName` 快照参与计算。
- `/api/v1/transactions` 与 `/api/v1/transactions/detail` 的交易项会返回 `accountKind` 和 `toAccountKind`，用于跨客户端判断转账、还款、以及特殊账户目标语义。
- `/api/v1/transactions/detail` 的交易项返回 `currency`，表示该流水原始币种。客户端明细金额应显示原币种；侧栏、净值和跨账户统计应使用账簿当前显示币种折算口径，不能把缺失汇率的外币金额按 1:1 混入。
- 交易项中的 `date` 是业务发生日期。支出记录可带 `postedAt` 表示实际入账日期，格式为 `YYYY-MM-DD`；未提供时服务端在新增支出时默认按 `date` 写入，收入、转账和投资记录通常为 `null`。
- 信用卡邮箱账单导入调用 `/api/v1/statement/import` 时，`mailSource` 可携带 `{ emailAccountId, uid, hash, subject, from, date }`。服务端会用 UID、邮件列表 hash 和解析后的稳定账单指纹阻止重复导入；稳定账单指纹优先使用机构、卡号后四位、银行账单周期，避免分类、备注、明细文本等解析规则变化造成同一账单被当作新账单。返回的 `lockedStatementBills` 可包含 `{ accountId, billAccountIds, statementMonth, amount, periodStart, periodEnd, dueDate }`，客户端应展示已锁定的账单金额、账期和到期还款日。
- 邮箱账单导入的邮件列表使用 `POST /api/v1/email/imap/list`。请求可提交已保存的 `accountId`，或提交临时 IMAP 配置；`sinceDate` 和 `endDate` 是 `YYYY-MM-DD` 日期范围，按用户视角包含首尾两天。`limit` 和 `scanLimit` 最大均为 50，客户端不应请求或展示超过 50 封；若范围内匹配邮件少于 50 封，应展示全部匹配邮件。

### Categories

- `/api/v1/category` 用于收支分类列表、新增、重命名和移动。
- 分类返回字段包含 `sortOrder`；同一类型、同一父分类下先展示用户分类并按 `sortOrder` 升序，再展示系统内置分类。`PUT /api/v1/category` 可传 `orderedIds` 调整用户分类顺序，系统内置分类不参与排序。
- 分类返回字段包含 `isSystem`。`isSystem=true` 的系统内置分类不能改名、移动或删除；客户端应隐藏或禁用这些操作，但仍可允许在其下新增用户子分类。同一父分类下，系统分类不参与用户排序并固定排在用户分类之后。
- 分类名称在同一账簿内必须全局唯一，不区分收入、支出、代付类型，也不区分父分类。
- 新增或修改为已有名称时，接口返回 `{ ok:false, error:"分类名称已存在" }`，状态码为 `409`。
- 修改系统内置分类时，接口返回 `{ ok:false, error:"系统内置类别，无法修改" }`，状态码为 `409`。
- 分类名称全局唯一后，客户端按名称匹配导入分类时不应再自行按同级或类型消歧。

范围：

- 收入、支出、代付、转账。
- 交易详情。
- 批量编辑。
- 删除和清理。

相关路径示例：

- `/api/v1/transactions`
- `/api/v1/transactions/detail`
  - `DELETE ?id=...` 的 `id` 是 `TxRecord.id`。如果该资金流水通过 `EntryBusinessLink` 关联了基金、保险、理财、存款、贵金属、股票或房产等独立业务交易，删除会通过统一删除服务同步软删关联业务交易和关联记录，并返回 `deletedEntryIds`、`removedEntryIds`、`accountIds` 供客户端局部刷新。
- `/api/v1/transactions/reorder` 用于同一账户明细、同一显示日期内调整记录顺序；成功返回 `orderedEntryIds` 和同日受影响记录的 `runningBalances`，客户端应以该顺序和余额作为服务端最终结果，并避免触发全局财务刷新。
- `/api/v1/entries/batch-edit`
- `/api/v1/entries/batch-update`
  - 批量更新支持 `categoryId`，客户端应提交真实分类 ID；传空字符串表示清空分类。层级分类中，二级、三级以及带子分类的真实分类节点都可以作为 `categoryId`。
  - 批量更新支持 `tagId`，客户端应提交当前账簿可读的真实标签 ID；传空字符串表示清除所选记录的全部标签。
  - 批量更新账户字段时，`account` 表示底层来源账户，`toAccount` 表示对向/目标账户；信用卡账单详情若要修改当前账单账户侧，应提交 `viewAccount`，服务端会按当前账单账户范围写入对应的 `accountId` 或 `toAccountId`。

### External Agent / DB Maintenance

范围：

- 外部 Agent 受控读取和维护数据库记录。
- 模型字段发现。
- 小范围补数据、核对、修正。

相关文档：

- `docs/agent-api.md`

相关路径示例：

- `/api/v1/db/models`
- `/api/v1/db/data`

注意：

- 这组接口不是普通移动端业务契约，优先使用账户、交易、基金等业务 API。
- 通用 DB API 必须认证，并屏蔽用户、密钥、邮箱、系统设置等敏感模型。
- 涉及交易、基金、余额的修改后，应调用对应业务接口或服务做重算。
- `/api/v1/entries/delete` 删除资金明细时支持 `checkOnly` 和 `linkedAction`：
  `checkOnly=true` 只返回是否有关联业务和 `impacts`，不执行删除，客户端应先用它预检；
  `deleteBusiness` 表示同时删除关联的保险/基金/理财/存款/贵金属业务明细；
  `keepBusiness` 表示只移除资金流水并保留业务明细。未传 `linkedAction` 且存在关联业务时，接口返回 `{ ok:false, needConfirm:true, impacts }`，客户端必须提示用户选择。

### Fund

范围：

- 基金名称。
- 基金净值。
- 基金交易明细。
- 基金持仓。
- 手续费率。
- 确认天数/到账天数。
- 持仓重算和净值刷新。
- 基金交易事实字段以 `FundTransaction` 为准；关联资金账户流水只表示现金流，二者通过 `FundTransactionCashFlow` 和 `EntryBusinessLink` 关联。`/api/v1/fund/nav` 的补净值和 `/api/v1/fund/entry` 的明细编辑可接收 `FundTransaction.id`，也兼容传入关联资金 `TxRecord.id` 后由服务端解析关联。

相关路径示例：

- `/api/v1/fund/name`
- `/api/v1/fund/nav`
- `/api/v1/fund/nav/history`
- `/api/v1/fund/nav/missing`
- `/api/v1/fund/entries`
- `/api/v1/fund/entry`
- `/api/v1/fund/position`
- `/api/v1/fund/fee-rate`
- `/api/v1/fund/confirm-days`
- `/api/v1/fund/profile`
- `/api/v1/fund/refresh`
- `/api/v1/fund/sync-position`
- `/api/v1/fund/import`
- `/api/v1/invest/monthly-floating-pnl`
- `/api/v1/precious-metals/dictionaries`
- `/api/v1/wealth-products`

#### 基金资料设置

- Method: `GET` / `PATCH` / `POST`
- Path: `/api/v1/fund/profile`
- Auth: required
- GET query: `fundCode` 或 `list=1`；单基金查询可传 `syncInstitution=0` 以只读取资料而不创建机构
- PATCH body: { fundCode, fundName?, fundCompany?, custodian?, manager?, navDateOffset?: 0 | 1, tradingCalendar? }；保存基金资料时会在当前账簿中确保基金公司机构存在
- POST body: { fundCode, syncInstitution?: boolean }；重新从外部基金资料源获取并保存基金公司侧资料。外部刷新可回填基金名称、基金公司、托管人和经理，但不修改 `navDateOffset`；只有基金资料保存/API PATCH 能显式修改净值日期偏移。T+N 和费率不由该接口修改。设置页获取资料时传 `syncInstitution=false`，只回填未手动修改的字段；用户点击保存后才创建未匹配的 `fund_company` 机构。外部数据源中的公司链接编号不作为基金公司代码使用。
- Success: GET 单基金返回 `{ ok: true, fundCode, profile }`；列表默认返回 `{ ok: true, rows }`，传 `includeProfiles=1` 时追加 `profiles`；PATCH/POST 返回 `{ ok: true, profile }`

说明：

- `FundProfile` 保存按基金代码共享的基金资料，包括净值日期偏移和净值交易日历；`navDateOffset` 只允许 `0` 或 `1`，`tradingCalendar` 可为 `cn_fund`、`hk_fund`、`jp_fund`、`us_fund`、`generic_weekday`。`navDateOffset` 是投资收益表、持仓最新净值刷新和 `/api/v1/invest/daily-pnl` 选择基金净值日的稳定设置：北京时间 19:00 后，`0` 使用本交易日净值，`1` 使用前一交易日净值；19:00 前在该偏移基础上再提前一个交易日。目标日休市时继续回退到上一交易日。`tradingCalendar` 是判断某只基金在哪些日期应该存在 NAV 的权威字段；名称关键字只用于初始化或字段缺失时兜底。
- 基金公司名称识别成功后，按当前账簿自动确保对应的 `fund_company` 机构存在；如果同名机构已存在则复用，不会把已有银行、代销机构等机构强制改类型。
- T+N 确认/到账规则仍通过 `/api/v1/fund/confirm-days` 保存当前持仓账户的生效规则；统一设置页面将它们放在基金资料区域。`DELETE /api/v1/fund/confirm-days?accountId=...&fundCode=...` 用于删除单条持仓账户+基金代码规则。
- 费率仍通过 `/api/v1/fund/fee-rate` 保存，属于代销机构/持仓账户侧设置。

#### 基金净值查询

- Method: `GET`
- Path: `/api/v1/fund/nav`
- Query: `code`, `date`, `accountId?`, `purpose?`, `applyDate?`
- The query uses the account default or institution-priority source first, then tries at most three configured sources; it does not poll every active source. A date-query historical fallback also uses this same three-request limit.
- When `purpose=buy` and `applyDate` is today or within the previous two trading days, a NAV from a different date is rejected with `code=EXACT_NAV_UNAVAILABLE`; clients should keep the buy NAV and units empty and retry through the startup pending-refresh task.

#### 缺失基金净值补齐

- Method: `POST`
- Path: `/api/v1/fund/nav/missing`
- Auth: required
- Body: `{ items: [{ fundCode, date, accountId? }] }` 或 `{ ranges: [{ fundCode, startDate, endDate }] }`
- Success: `{ ok: true, requested, rangeCount, fundCount, fetched, written, failed, ranges, resolvedItems, unresolvedItems, resolved, unresolved, skipped, skippedClosed }`

说明：

- 接口只补齐当前账簿已有投资交易或持仓中的基金代码，不能作为任意基金外部查询入口。
- 调用方可传逐日缺失项，服务端会按基金代码合并成日期范围，再批量写入 `FundNavCache`；投资收益表前端按基金+月份分批调用，避免年度视图一次请求拉取多年历史导致网关超时。补齐历史净值只写缓存，不修改 `FundProfile.navDateOffset`。
- 投资收益表用它补齐持仓基金交易日净值缺口；服务端优先根据 `FundProfile.tradingCalendar`，再用基金账户日历兜底，二次跳过非交易日。周末/非交易日仍允许沿用上一可用交易日净值，且不应提示缺净值。
- `resolvedItems/unresolvedItems` 用于前端判断本次补齐结果；投资收益表请求成功后应局部消隐当前提示，调用方不需要整页刷新来确认补齐结果。

#### 基金视图刷新

- Method: `POST`
- Path: `/api/v1/fund/refresh`
- Auth: required
- Body: `{ accountId: string, symbols?: string[] }`
- Success: `{ ok: true, entryFilled, entryNavFilled, entryFailed, entryDeferred, holdingNavChecked, holdingNavRefreshed, holdingNavFailed, nameFixed, message }`

说明：

- 该接口只刷新当前基金账户的未确认基金交易和当前持仓最新净值，不再按基金最早申请日批量拉取整段历史净值，也不改写 `FundProfile.navDateOffset`。当前持仓最新净值按基金资料的 `navDateOffset` 和 19:00 规则请求目标日期，而不是无条件请求外部来源的绝对最新日期。
- 处理未确认交易时，先使用 `FundNavCache` 中已有的精确确认日净值；缓存记录不受日期限制。
- 缓存没有精确净值时，只自动查询今天或往前三个交易日内的确认日；交易日历使用当前基金账户的 `tradingCalendar`。
- 更早且缓存仍缺失的确认日计入 `entryDeferred`，不在表头刷新时自动拉取，用户可在基金明细中单独手工补净值。投资收益表的历史净值补齐仍使用 `/api/v1/fund/nav/missing`。
- 成功处理后，服务端重算受影响持仓；Web 客户端应在请求成功后刷新当前基金视图及相关汇总。`symbols` 仅为兼容字段，不会扩大刷新范围。
#### 银行理财产品主数据

- Method: `GET`
- Path: `/api/v1/wealth-products`
- Query: `institutionId?: string`
- Success: `{ ok: true, products: [{ id, name, shortName, institutionId, institutionName, currency, annualRate, termDays, note }] }`

- Method: `POST`
- Path: `/api/v1/wealth-products`
- Body: `{ name, cashAccountId, wealthAccountId?, shortName?, currency?, annualRate?, termDays?, note? }`
- Success: `{ ok: true, product, wealthAccount }`

银行理财交易应保存 `wealthProductId` 作为产品身份，`fundName` 只作为兼容展示文本。买入时理财账户只能与资金来源同机构，或属于同一所有人名下的第三方支付/钱包机构；未传 `wealthAccountId` 时接口会按资金来源自动复用或创建同机构理财账户。同一理财账户下同一产品已有份额记录时，继续买入必须传 `fundUnits`。`/api/v1/transactions/detail` 在 `fundProductType/productType = "wealth"` 时使用拆表语义：资金流水只保存现金流和投资动作分类，业务字段写入 `WealthTransaction`，编辑时可传 `businessTransactionId` 明确指定关联的理财业务记录。

#### 理财持仓手动净值

- Method: `PUT`
- Path: `/api/v1/wealth-products/nav`
- Auth: required
- Context: server/book/user/role
- Body: `{ accountId, wealthProductId?, productName?, date, nav }`
- Success: `{ ok: true, data: { nav, date } }`
- Failure: `{ ok: false, code, error }`（缺少参数 `ACCOUNT_ID_REQUIRED` / `INVALID_DATE` / `INVALID_NAV` / `PRODUCT_IDENTIFIER_REQUIRED`；账户或产品不存在 `WEALTH_ACCOUNT_NOT_FOUND` / `WEALTH_PRODUCT_NOT_FOUND`）

说明：

- 用于用户在理财持仓界面手动追加产品当前净值（`nav` 为产品单位净值，`date` 为净值日期），写入 `WealthProduct.manualNav / manualNavDate`。
- 持仓表与投资汇总在读取时优先使用该净值计算市值（份额 × 净值）和浮动盈亏（市值 − 成本）；未录入手动净值时维持原口径（市值 = 剩余本金，浮动盈亏为 0）。
- `wealthProductId` 优先作为产品身份；缺失时按 `productName` 在理财账户所属机构下解析产品。


#### 贵金属字典

- Method: `GET`
- Path: `/api/v1/precious-metals/dictionaries`
- Auth: required
- Context: server/book/user/role

Success:

```json
{
  "ok": true,
  "data": {
    "types": [
      { "id": "metal-type-gold", "code": "gold", "name": "黄金", "shortName": "金" }
    ],
    "units": [
      { "id": "metal-unit-gram", "code": "gram", "name": "克", "symbol": "g", "decimals": 3 }
    ]
  }
}
```

Notes:

- 贵金属录入应选择字典里的品种和单位，不应让用户手填基金式代码。
- 交易明细可返回 `metalTypeId`、`metalTypeName`、`metalUnitId`、`metalUnitName`、`metalQuantity`、`metalUnitPrice`、`metalFee`，用于编辑回显和跨客户端显示。
- 贵金属交易不应把品种、数量、单价写入 `fundCode`、`fundUnits`、`fundNav` 等基金字段。

#### 基金批量导入

- Method: `POST`
- Path: `/api/v1/fund/import`
- Auth: required
- Context: server/book/user/role

Request body:

```json
{
  "mode": "preview",
  "context": {
    "fundAccountId": "fund-account-id",
    "fundAccount": "招商基金账户",
    "fundCode": "000001",
    "fundName": "华夏成长混合"
  },
  "overrides": [
    {
      "fundAccount": "招商基金账户",
      "fundCode": "000001",
      "confirmDays": 2,
      "arrivalDays": 3
    }
  ],
  "items": [
    {
      "date": "2026-06-08",
      "fundSubtype": "buy",
      "source": "regular_invest",
      "cashAccount": "招商银行2758",
      "fundAccount": "招商基金账户",
      "fundCode": "000001",
      "fundName": "",
      "amount": -100,
      "units": null,
      "nav": null,
      "fee": null,
      "feeRateInput": null,
      "confirmDate": null,
      "arrivalDate": null,
      "remark": "定投"
    }
  ]
}
```

规则：

- `mode="preview"` 只返回预览、补全值和校验结果，不写库。
- `mode="import"` 会按同样规则重新校验，通过后整批写入；任一条阻断错误都会整批回滚。
- `context` 是可选的当前基金视图上下文。当前基金账户有效且导入行未填 `fundAccount` 时，服务端可用该账户补全基金账户；当前基金代码有效且导入行未填 `fundCode` 时，可用该代码补全基金代码。
- `overrides` 是可选字段。键是 `基金账户 + 基金代码`，可覆盖确认天数与入账天数；`mode="import"` 时会把这次确认后的规则回写到确认天数库，供后续导入直接读取。
- `fee` 表示实际手续费金额；`feeRateInput` 或兼容字段 `feeRate` 表示手续费率百分比，例如 `1` 表示 1%。同一行同时传 `fee` 和费率时，服务端只使用 `fee`，避免双重扣减。
- `fundName` 只作为显示辅助。导入行未填名称或名称等于基金代码时，预览和最终导入都会按基金代码查询权威名称，再回退到最新净值缓存；只有仍查不到时才临时显示代码。
- `buy` / `buy_failed` / `refund` 等 buy 类动作会按绝对值处理金额。
- `dividend_reinvest` 只增加基金业务侧份额，不产生现金金额，不要求也不保存 `cashAccount` / `cashAccountId`；即使调用方传入资金账户，服务端也会忽略该字段，不创建资金侧 `TxRecord` 或 `FundTransactionCashFlow`。
- `refund` 是导入别名，服务端会兼容映射到现有退回记录子类型。
- `confirmDate` 表示净值日期，写入 `fundConfirmDate`。
- `arrivalDate` 表示入账日期，写入 `fundArrivalDate`。
- 基金收益计算不会把 `confirmDate` 当作新增份额的同日收益生效日；买入和红利再投资份额从净值日期后的下一个基金交易日开始参与净值差额收益。
- 基金买入和定投的现金侧发生日按申请日期 `date` 展示和排序；只有赎回、现金分红、买入退回等现金入账记录在现金/借记账户明细中按 `arrivalDate` 展示和排序。
- 买入退回记录会通过 `fundSourceEntryId` 显式关联到源买入记录；借记卡/现金账户明细展示这类退回入账时，按实际到账日期显示和排序。基金交易明细按源买入申请日期归集展示，退回到账日期保留在到账日期字段。
- 预览和导入都会按基金账户已有配置或本次 `overrides` 自动补全确认天数、净值日期、入账日期、手续费；缺净值时会按申请日期/时间推导净值日期并尝试获取精确净值。
- 预览响应中的 `calculatedFields` 标记由系统计算得到的数值字段，例如 `nav`、`feeRate`、`fee` 和 `units`；客户端应以斜体等样式区分这类值，确认导入时仍重新按服务端规则计算。
- `cashAccount` 与 `fundAccount` 都按账户匹配规则解析，基金账户必须能匹配到开放式基金账户；如果导入行提供了 `cashAccount`，资金账户也必须匹配到资金侧账户，否则作为阻断错误返回，不能导入成未关联的基金交易。
- 导入行未提供 `cashAccount` 且当前基金视图上下文能解析为同一个基金账户时，服务端会读取该基金账户最近 100 条未删除基金交易，按 `cashAccountId` 使用次数推断最常用资金账户；次数相同取最近出现的账户。无法推断或不在基金视图上下文中时，买入、赎回和现金分红行会作为缺少资金账户的阻断错误返回。成功导入时，服务端会用匹配或推断到的 `cashAccountId` 建立资金侧 `TxRecord`、`FundTransactionCashFlow` 和 `EntryBusinessLink`。

Preview success:

```json
{
  "ok": true,
  "items": [
    {
      "date": "2026-06-08",
      "fundSubtype": "buy",
      "amount": 100,
      "fee": 0.15,
      "feeRate": 0.15,
      "calculatedFields": ["fee", "feeRate"],
      "confirmDays": 1,
      "confirmDate": "2026-06-09",
      "issues": []
    }
  ]
}
```

#### 基金份额校准

- Method: `POST`
- Path: `/api/v1/fund/units-reconcile`
- Auth: required
- Context: server/book/user/role

Request body:

```json
{
  "accountId": "fund-account-id",
  "fundCode": "000001",
  "date": "2026-06-08",
  "actualUnits": 1234.56,
  "fundName": "华夏成长混合",
  "note": "月末核对"
}
```

规则：

- `actualUnits` 是用户看到的最终实际份额，不是本次要增减的份额。
- 服务端会先重算该基金当前持仓份额，再计算 `deltaUnits = actualUnits - currentUnits`；差额为 0 时不新增记录。
- 差额不为 0 时，服务端创建一条 `source="fund_units_reconcile"` 的无现金流基金业务交易，`fundSubtype` 按差额方向写 `buy` 或 `redeem`，`fundUnits` 写差额绝对值。
- 份额校准不创建 `TxRecord`、`FundTransactionCashFlow` 或现金账户余额变化，只影响基金业务份额和随后重算出的持仓。
- 当前份额读取、差额计算、校准记录及持仓更新在同一事务内完成；等待数据库后重新读取份额，不能沿用等待前的差额。原买入记录的确认/到账日期晚于校准日期不构成保存限制。
- 每次启动事务最多等待 10 秒，只有事务回调尚未开始且发生启动超时时才自动重试一次；进入回调后出现执行或提交错误不自动重放。持续繁忙返回 HTTP 503、`code="FUND_UNITS_RECONCILE_BUSY"` 和 `Retry-After: 2`，表示本次校准尚未保存；Web 保留输入供稍后重试。其他失败返回 HTTP 500、`code="FUND_UNITS_RECONCILE_FAILED"`，详细错误只写入服务端日志。

Success:

```json
{
  "ok": true,
  "data": {
    "entryId": "fund-transaction-id",
    "currentUnits": 1200,
    "actualUnits": 1234.56,
    "deltaUnits": 34.56,
    "noChange": false
  }
}
```

#### 月度基金浮盈

- Method: `GET`
- Path: `/api/v1/invest/monthly-floating-pnl`
- Auth: required
- Context: server/book/user/role

Query:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| month | string | no | 目标月份，格式 `YYYY-MM`；也可用 `year` + `monthNumber` |
| year | number | no | 目标年份，与 `monthNumber` 一起使用 |
| monthNumber | number | no | 目标月份，1-12，与 `year` 一起使用 |
| accounts | string | no | 投资账户 ID 列表，用英文逗号分隔 |

Success:

```json
{
  "ok": true,
  "data": {
    "month": "2026-06",
    "baselineDate": "2026-06-01",
    "endDate": "2026-06-30",
    "baselineFloatingPnL": 1200,
    "baselineFloatingPnLRate": 0.08,
    "endFloatingPnL": 1500,
    "endFloatingPnLRate": 0.09,
    "floatingPnLChange": 300,
    "floatingPnLRateChange": 0.01,
    "monthlyBuy": {
      "amount": 2000,
      "units": 1800.123456,
      "count": 2
    },
    "accounts": []
  }
}
```

Notes:

- 月度浮盈计算归属在 `src/lib/invest/monthlyFloatingPnl.ts`；API route 只负责参数解析、上下文获取和 JSON 输出，不维护计算公式。
- 接口从 `TxRecord` 重建月初和月末持仓，并使用 `FundNavCache` 中目标日期当天或之前最近一条净值估值，不依赖 `FundSnapshot`。
- `floatingPnLRate = floatingPnL / totalCost`；`floatingPnLRateChange = endFloatingPnLRate - baselineFloatingPnLRate`。
- `monthlyBuy` 统计确认日期落在目标月份内的基金申购交易，不包含红利再投资。
- 如果缺少净值，账户快照和持仓行会返回 `missingNavCodes`，客户端应提示先补净值再解释结果。

### Stock

范围：

- 股票账户、股票标的、股票交易、股票持仓、股票手续费规则。
- 股票归在 `Account.kind = "investment"` + `investProductType = "stock"` 下，但业务表、API、字段和 UI 语义都使用独立 `stock` 域。
- 股票资金流水只表示现金侧，股票身份、数量、价格和手续费保存在 `StockTransaction`；二者通过 `EntryBusinessLink.stockTransactionId` 关联，返回给客户端的 `linkId` 可直接用于 UI 高亮、删除预检和后续补链。
- 创建或更新股票账户时，`institutionId` 必须指向当前账簿内类型为证券/`brokerage` 的机构；缺失或选择银行、支付、保险等非证券机构时返回 `{ ok:false, error }`。校验通过后，服务端会确保同账簿、同所有人、同证券机构、同币种下存在一个现金/钱包类“证券资金账户”；不存在时自动创建，`POST /api/v1/accounts` 会在响应中返回 `brokerageCashAccount`。
- 股票交易的 `cashAccountId` 表示买入、卖出、分红、费用或税费调整使用的证券资金账户/券商可用资金账户；它可以和同一证券公司名下的基金交易共用同一个现金/钱包类账户。`cashAccountId` 可省略，服务端会按股票账户的所有人、证券机构和币种自动确保并使用同券商资金账户；只有股票账户缺少证券机构或找不到资金账户时才兼容退回股票账户自身现金。银行卡与证券资金账户之间的资金移动应作为普通转账/银证转账创建，不应伪装成股票买入或卖出。
- 股票不得复用 `fundCode`、`fundUnits`、`fundNav`、`fundFeeRate`、基金净值、确认天数或到账天数模块；股票导入和交易不得混同为基金 refund link。
- 投资收益表和 `/api/v1/invest/daily-pnl` 的股票收益按 `StockTransaction` 回放历史持仓，结合 `StockPriceCache` 收盘价和股票现金流计算；卖出、现金分红、费用和税费调整都通过现金流修正计入收益，`StockHolding` 仍只负责当前持仓盈亏报表。

相关路径：

- `GET /api/v1/stocks/securities?market=&q=` 返回 `{ ok:true, data:{ securities:[{ id, market, stockCode, stockName, currency, exchange }] } }`；`GET /api/v1/stocks/securities?market=CN&code=600519` 只查本地 `StockSecurity`，未命中时再从该账簿的 `StockHolding` / `StockTransaction` 找已保存的名称，不触发外部股票查询 API。`GET /api/v1/stocks/securities?market=CN&code=600519&lookup=1` 才会在本地全部未命中时按股票查询 API 获取名称并缓存；交易窗口输入股票代码默认走本地查询，只有首次买入保存时由 `POST /api/v1/stocks/transactions` 内部补全名称并缓存。导入或保存时 `stockName` 为空或等于 `stockCode` 都视为未提供名称，不能覆盖服务端补全出的真实名称。`market` 可省略，服务端按股票代码优先推断 A 股、港股或美股，导入和特殊场景仍可显式传入市场。
- `POST /api/v1/stocks/securities` 创建或返回股票标的。Body: `{ market?, stockCode, stockName?, currency?, exchange? }`；`market` 省略时按 `stockCode` 推断。
- `GET /api/v1/stocks/transactions?accountId=&securityId=&market=&stockCode=&limit=` 返回独立股票交易列表。交易项包含 `id`、`linkId`、`cashEntryId`、`stockAccountId`、`cashAccountId`、`securityId`、`market`、`stockCode`、`action`、`tradeDate`、`settleDate`、数量、价格、费用、`realizedProfit` 和 `externalLinkId`。
- `POST /api/v1/stocks/import` 执行上市证券 Excel 导入预览和确认导入。Body: `{ mode:"preview"|"import", context:{ stockAccountId?, stockAccountName? }, items:[{ stockAccount?, stockAccountId?, accountId?, tradeDate, settleDate?, action, market?, stockCode?, stockName?, quantity?, price?, grossAmount?, netAmount?, bankAccount?, fee?, commission?, stampTax?, transferFee?, exchangeFee?, regulatoryFee?, otherFee?, note?, calculatedFields? }] }`；`context.stockAccountId` 只是当前股票账户视图的默认股票账户，不是全局必填；导入行可用 `stockAccount` / `stockAccountId` / `accountId` 覆盖，未在股票账户视图导入且行内也没有股票账户时，预览返回行级 `STOCK_ACCOUNT_REQUIRED` 等阻断错误，模板必须包含股票账户列。`fee` 表示总费用合计，填写后按该值作为总费用，不再叠加佣金、印花税等拆分费用；未填写 `fee` 但填写拆分费用时，按用户填写的拆分费用求和，不补算缺失拆分项；所有费用字段都空时，买入/卖出按 `StockFeeRule` / `StockMarketFeeRule` 估算拆分费用。买入/卖出导入行必须有 `quantity` 和可解析的 `price`：`price` 可由导入表提供，也可在预览阶段按 `tradeDate` 先查 `StockPriceCache`、再查股票 API 补全；补全价格会在 `preview.calculatedFields` 中标记。`grossAmount` 由服务端按 `quantity × price` 计算并在 `preview.calculatedFields` 中标记；导入表中的 `grossAmount` 不作为买卖行成交金额来源。`netAmount` 为空时，预览/导入按成交金额和最终总费用补算：买入为成交金额 + 总费用，卖出为成交金额 - 总费用。`stockName` 仅作为兼容 API 输入，不出现在模板中；证券名称解析先查 `StockSecurity`、现有持仓和历史 `StockTransaction`，本地没有时再查股票 API 补全；`preview` 返回 `{ ok:true, items:[..., issues, totalFee, cashAmount, calculatedFields, securityId, cashAccountId, stockAccountId, duplicate] }`，其中 `calculatedFields` 标记由系统计算得到的数值字段，客户端应以斜体等样式区分；错误行保留在预览中并允许勾选、就地编辑和批量修正，但 `import` 必须阻断仍有未解决错误的选中行，并重新执行同一套服务端解析、账户匹配、费用估算和阻断校验后写入，返回 `{ ok:true, createdCount, skippedCount, ids, accountIds, items }`。普通股票动作用 `StockTransaction` + `EntryBusinessLink` 写业务和资金侧；买入、卖出、分红、费用/税费调整的 `bankAccount` 可显式选择任意现金、借记卡或钱包资金账户，服务端必须保留该选择，只有未传资金账户时才默认使用当前股票账户同券商下的证券资金账户或自动创建的默认资金账户。`bank_transfer` 使用同股票账户证券机构下的证券资金账户和导入行中的银行账户创建银证转账，正数为银行转入证券资金账户，负数为证券资金账户转回银行账户。`bankAccount` 在普通股票动作中表示资金侧账户，在银证转账中表示银行侧账户，模板显示为“银行账户”；银证转账行必须填写银行侧账户（所有人、机构、账户名称），也兼容具体账户 ID、别名或尾号；只写“借记卡”等账户类型不会匹配。上市证券导入模板不包含股票名称和成交号；服务端仅在调用方显式传入 `externalLinkId` 时做兼容去重。
- `POST /api/v1/stocks/transactions` 创建股票交易；动作为 `buy`、`sell`、`dividend`、`fee_adjustment` 或 `tax_adjustment` 时，服务端会在 `cashAccountId` 指向的现金、借记卡或钱包资金账户上创建或更新资金侧 `TxRecord`，用户显式传入的资金账户不受股票账户同券商/同机构限制；未传 `cashAccountId` 时才自动使用同券商默认资金账户，写入 `EntryBusinessLink`，重算 `StockHolding`，并返回 `{ ok:true, data:{ transaction, linkId, cashEntryId } }`。现金流水不生成“资金账户 ↔ 股票账户”的自转账；股票持仓变化只由 `StockTransaction` / `StockHolding` 表达。买卖交易以 `quantity` 和 `price` 为必填源字段，服务端按 `quantity × price` 写入 `grossAmount`；客户端不能直接提交 `grossAmount` 覆盖买卖成交金额。买卖交易可以省略 `commission`、`stampTax`、`transferFee`、`exchangeFee`、`regulatoryFee` 和 `otherFee`，服务端读取账户 `StockFeeRule` / 市场 `StockMarketFeeRule` 表中已保存的费率计算；账户规则未命中时再使用市场默认规则。交易保存本身不会刷新或改写费率表，只有 `GET /api/v1/stocks/fee-rules?estimate=1&refresh=1`（Web 交易窗口的“获取新费率”按钮）才刷新内置公开市场默认费率。
- `PATCH /api/v1/stocks/transactions?id=...` 更新股票交易。Body 与 POST 相同，省略字段保留原值；动作、账户、日期、数量、价格、金额变更后，服务端同步更新关联资金侧 `TxRecord` 和 `EntryBusinessLink`（动作改为无现金的送转/拆并股时软删旧现金流水与旧 link），重算 `StockHolding` 与账户余额，返回 `{ ok:true, data:{ transaction, linkId, cashEntryId, oldCashEntryId } }`。编辑 Web 明细行通过双击行或行内编辑按钮打开股票交易弹窗，保存走该接口。
- `POST /api/v1/stocks/transactions/batch-update` 批量修改股票交易的备注字段，Body: `{ updates: [{ id, note? }] }`，一次事务更新后统一重算受影响账户的持仓与余额，返回 `{ ok:true, data:{ updatedCount, accountIds } }`。数量/价格/金额/日期/动作等会影响资金流水与持仓重建的字段必须走单条 `PATCH`，不能循环调该接口。
- `DELETE /api/v1/stocks/transactions?id=...` 或 `DELETE /api/v1/stocks/transactions?linkId=...` 软删除股票交易、关联现金流水和业务 link，并重算持仓。
- `GET /api/v1/stocks/holdings?accountId=&includeZero=1` 返回某个股票账户的 `StockHolding`，包括数量、成本、最新价、市值、浮盈、历史收益和汇总值；传入 `tradeDate=YYYY-MM-DD` 时改为按该交易日回放 `StockTransaction`，只返回截至该日期仍有正数数量的股票，供股票卖出 SS 下拉使用。
- `GET /api/v1/reports/stock-holdings?accountId=` 返回跨股票账户的持仓盈亏报表；Web 报表页「股票持仓盈亏」使用同一口径。
- `POST /api/v1/stocks/holdings` 使用 `{ accountId, securityIds? }` 触发股票持仓重算。
- `POST /api/v1/stocks/prices/refresh` 使用 `{ accountId, securityIds? }` 获取当前股票持仓的最新收盘价，写入 `StockPriceCache` 后重算 `StockHolding`，返回 `{ refreshed, failed, prices, holdings, totalMarketValue, totalCost, floatingPnL }`；股票持仓表头的“获取收盘价”按钮调用该接口。
- `GET /api/v1/stocks/fee-rules` 查询账户/标的/日期下生效的股票账户覆盖规则；`GET /api/v1/stocks/fee-rules?accountId=...&list=1` 返回该股票账户最近规则列表，供股票持仓表头的“账户费率”设置入口展示。`GET /api/v1/stocks/fee-rules?accountId=...&estimate=1&direction=buy&tradeDate=YYYY-MM-DD&market=CN&stockCode=600519&grossAmount=1040` 返回买卖窗口使用的只读费用预估 `{ fees, totalFee, cashAmount }`，只读表中已保存的费率计算，不刷新或改写费率表；`refresh=1` 才会先刷新系统内置的 A 股公开市场默认费率，再按同一规则重算（Web 交易窗口“获取新费率”按钮使用）。`POST /api/v1/stocks/fee-rules` 新增佣金、印花税、过户费、经手费、监管费、平台费或其他费用规则，支持 `direction = buy | sell | both`、`rate`、`amount` 和 `minAmount`。账户规则匹配优先级为单一股票/标的、市场+代码、市场（例如 `CN_SH`、`CN_SZ`）和账户通用规则；市场公开默认规则存储在 `StockMarketFeeRule`，证券公司公开名录和别名存储在 `StockBrokerageCatalog`。

股票动作：

- `buy`：买入，通常产生现金流出。
- `sell`：卖出，通常产生现金流入并由 `recalcStockPositions` 计算已实现收益。
- `dividend`：现金股息，产生现金流入并计入历史收益；`grossAmount` 为分红金额，`netAmount` 可选表示扣税/费用后的实际到账金额。
- Web 股票交易窗口的“送股/转增”提交为 `bonus_share`，只填写增加的股数，不创建资金侧流水；股票分红窗口必须先按交易日期通过持仓 SS 选择股票。
- `bonus_share` / `split_share` / `merge_share`：股数变动，不创建资金侧流水；Web 交易弹窗应合并为一个“股本变动”入口，再在表单内选择具体类型。
- `fee_adjustment` / `tax_adjustment`：费用或税费调整，通常产生现金流出；用于导入/账户调整路径，不作为普通股票交易弹窗动作展示。

### Property

范围：

- 房产账户、房产资产、房产交易和手动估值。
- 房产归在 `Account.kind = "investment"` + `investProductType = "property"` 下，但业务表、API、字段和 UI 语义都使用独立 `property` 域。
- 房产没有份额、净值、确认日或到账日。房产市值来自 `PropertyAsset.marketValue` 和 `PropertyValuation`，累计成本来自购入/装修/税费/手续费，房贷余额仍来自单独负债账户。
- 投资收益表和 `/api/v1/invest/daily-pnl` 的固定资产收益只读取 `PropertyTransaction.action = sale` 的 `realizedProfit`；购入、装修投入和手动估值不产生收益，关联现金侧 `TxRecord` 不重复统计。

相关路径：

- `GET /api/v1/properties?accountId=` 返回 `{ ok:true, data:{ assets, transactions } }`。`assets` 包含 `id`、`accountId`、`mortgageLoanAccountId`、`name`、`propertyType`、`address`、`currency`、`purchaseDate`、`purchasePrice`、`cost`、`marketValue`、`latestValuationDate`、`status` 和 `note`；`transactions` 包含 `id`、`linkId/cashEntryId`、`accountId`、`cashAccountId`、`propertyAssetId`、`action`、`tradeDate`、`settlementDate`、`amount`、`fee`、`tax`、`realizedProfit` 和 `note`。
- `POST /api/v1/properties` 创建房产交易。Body: `{ accountId, cashAccountId?, propertyAssetId?, action, name?, propertyType?, address?, tradeDate, settlementDate?, amount, fee?, tax?, marketValue?, note? }`；`action` 为 `purchase`、`improvement` 或 `sale`。购入会创建 `PropertyAsset` 和初始 `PropertyValuation`；装修增加累计成本；出售把资产标记为 `sold` 并按净回收金额计算 `realizedProfit`。传入 `cashAccountId` 时同步创建/更新现金侧 `TxRecord` 和 `EntryBusinessLink.propertyTransactionId`。
- `POST /api/v1/properties/valuations` 手动更新房产估值。Body: `{ propertyAssetId, valuationDate, marketValue, note? }`；只写 `PropertyValuation` 并更新 `PropertyAsset.marketValue` / `latestValuationDate`，不创建收入、支出、转账或投资现金流水。

房产动作：

- `purchase`：购入房产，通常产生现金流出，成本 = 金额 + 手续费 + 税费。
- `improvement`：装修或资本化投入，通常产生现金流出并增加累计成本。
- `sale`：出售房产，通常产生现金流入，已实现收益 = 出售净回收金额 - 累计成本。

### Insurance

范围：

- 保险产品列表、创建和更新。
- 按保险产品名称查询公开参考资料。
- 保险投保、赎回记录仍通过交易明细接口保存，并关联 `insuranceProductId`。
- 通过交易明细接口选择 `insuranceProductMasterId` 创建新保单时，可传 `policyNo`；`policyNo` 和 `effectiveDate` 属于实际保单/持仓，不属于保险产品主数据。保单编辑接口也应回写这两个字段。
- 保险产品主数据不作为系统设置入口展示，`/settings/insurance-products` 直达页也不作为维护入口；Web 在保险新增/编辑和保险持仓业务流程内维护产品库，保险持仓页只显示有交易记录的持仓。

相关路径示例：

- `/api/v1/insurance-products`
- `/api/v1/insurance-products/lookup`

#### 保险产品资料查询

- Method: `GET`
- Path: `/api/v1/insurance-products/lookup`
- Auth: required
- Context: server/book/user/role

Query:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| name | string | yes | 保险产品名称，建议使用保单或条款上的正式名称 |
| institutionName | string | no | 承保机构名称，用于缩小官方产品库和搜索范围 |

Success:

```json
{
  "ok": true,
  "data": {
    "query": "产品名称",
    "institutionName": "保险公司名称",
    "candidates": [
      {
        "name": "产品正式名称",
        "institutionName": "保险公司名称",
        "productType": "critical_illness",
        "status": "在售",
        "saleDate": "2026-06-29",
        "termsNo": "条款编号",
        "source": "中国保险行业协会产品信息库",
        "sourceType": "official",
        "url": "https://tiaokuan.iachina.cn/",
        "confidence": "high",
        "reason": "来自中国保险行业协会公开产品库。"
      }
    ],
    "officialSources": [],
    "officialProducts": [],
    "webResults": [],
    "crawledPages": [],
    "suggestion": {
      "productType": "critical_illness",
      "institutionName": "保险公司名称",
      "confidence": "medium",
      "reason": "根据标题/摘要轻量推断"
    },
    "searchedAt": "2026-06-29T00:00:00.000Z"
  }
}
```

Error:

```json
{
  "ok": false,
  "error": "错误说明"
}
```

Notes:

- 外部资料只作为录入辅助和官方核对入口，不是数据库事实来源。
- 客户端应优先展示 `candidates` 作为可选择产品列表；不要把 `webResults` 或 `crawledPages` 原始摘要直接铺到表单里。
- `officialProducts`、`webResults`、`crawledPages` 只作为参考/调试材料，展示给用户时必须先整理成结构化候选项。
- 查询会先尝试公开行业产品库接口；如果不可用、限频或缺少必要条件，再爬取公开搜索结果页面并抽取产品名称、承保机构、条款号、状态、日期等结构化字段。
- 爬虫只访问公开页面，不绕过验证码、登录、robots 防护或非公开数据控制。
- 客户端不能把搜索摘要当作精算、保障责任、费率或销售资格依据。

### Scheduled Tasks

范围：

- 定期计划任务。
- 当前支持基金定投、还房贷、转账、保险缴费、固定收入、固定支出六类任务。
- 任务共用计划字段：资金账户、任务类型、周期、已执行次数、开始日期、停止日期。`nextRunDate` 是服务端内部执行游标，可用于到期判断和只读展示，但客户端不能把它作为编辑字段提交。
- `planName` 是用户可编辑的计划展示名称；创建时可省略，服务端默认使用任务内容，客户端展示时应优先使用 `planName`，空值再回退到 `taskTitle`/目标内容。
- 任务内容按类型保存不同目标：基金代码/基金账户、贷款账户、转入账户、保险产品，或普通收入/支出的资金账户、分类和备注。
- 一次性计划用 `totalRuns = 1` 表达。周频、双周频、月频和年频支持可选 `secondaryExecutionDay`：周频/双周频是第二个星期几（1-7，周一到周日），月频是第二个执行日（1-31），年频是第二个 `MMDD` 编码（101-1231）。两个锚点按所在周期内的日期顺序交替执行；留空时保持原有单执行日行为。
- 贷款还款计划金额由还款表生成，PUT 更新时不允许直接修改金额；自动扣款贷款计划仍可修改 `cashAccountId`、`nextRunDate` 和 `planName`。提交不一致金额时返回 HTTP 403 `{ ok: false, code: "LOAN_REPAYMENT_AMOUNT_LOCKED", error }`。
- 贷款账单与还款是两个状态：`loanPlanRole = bill` 生成的 `loan_bill` 只表示当期应还；正常还款转入通过 `TxRecord.regularInvestPlanId + installmentNo` 关联计划期次。`GET /api/v1/debt/repayable-loan-accounts` 返回当期剩余 `currentPrincipal`、`currentInterest` 和 `currentPayment`。客户端只能在该期关联转入累计达到应还本金与利息合计后显示“本期已经还清”，部分还款显示剩余应还；自动扣款计划生成的 `scheduled_task` 转入才可直接计作还款。
- 贷款计划 memo 使用 `firstBillDate` 和 `firstRepaymentDate` 保存首期账单日与首期最迟还款日；自动扣款计划的 `firstRepaymentDate` 表示首期扣款日。原始贷款 `TxRecord.regularInvestPlanId` 必须关联主账单/还款计划；贷款编辑可以同步更新贷款账户名称、原始本金、期数、利率和日期规则，但不得改写已发生的真实还款交易。
- `POST /api/v1/loan-rate-adjustments` 更新单个贷款账户的统一利率调整表。请求体可提交 `adjustments: [{ effectiveDate, annualRate }]` 覆盖整表，或提交单条 `effectiveDate` + `annualRate`；`annualRate` 可为 `0`，但不能为负数。消费贷款只接受“生效日期 + 年利率”语义，`mortgageLprDiscount` 和 `loanStartDate` 只用于房贷/住房贷款 LPR 生成。保存利率表只同步利率记录和计划备注，不直接重新均摊月供；月供在对应重定价还款期由执行器或明确的还款表重算流程更新，返回 `{ ok: true, data: { adjustments, nextAmount } }`。
- `POST /api/v1/loan-repayment/recalculate` 用于提前还款或贷款资料变更后重算后续计划。若 `startDate` 命中提前还款记录且策略为“月供不变，缩短期限”，服务端沿用该提前还款所在还款期之前的实际/计划月供金额，只调整该时点的剩余总期数；历史重算时不能把未来提前还款后的缩期结果倒灌进来。“期限不变，减少月供”才按剩余本金和原剩余期数重算月供。
- 执行时调用现有交易、基金、保险业务语义，不新增独立交易类型。
- 每日自动执行扫描所有执行中计划，未到执行日的计划直接跳过。

相关路径示例：

- `/api/v1/regular-invest`
- `/api/v1/regular-invest/records`
- `/api/v1/regular-invest/execute`
- `/api/v1/regular-invest/batch-execute`
- `/api/v1/regular-invest/auto-execute`

### Settings

范围：

- 用户设置。
- App 偏好。
- 颜色规则。
- 邮件/Resend 设置。
- 基金查询 API。
- 系统更新。

相关路径示例：

- `/api/v1/settings/users`
- `/api/v1/settings/catalog`：GET 返回 Web 和 Android 共用的设置目录；可用 `?surface=web` 或 `?surface=android` 过滤客户端可用项。返回 `{ ok: true, data }`，目录源头为 `shared/settings/catalog.json`。
- `/api/v1/settings/app-preferences`：`sidebarHideInitialData` 是兼容保留字段名，当前产品语义为“隐藏使用向导”；为 `true` 时客户端应隐藏“使用向导”入口，并停用首次使用向导的自动和手动打开。`sidebarShowFixedAssets` 控制左侧侧边栏是否显示固定资产汇总入口，默认 `true`。`detailDateBackground` 控制明细表是否按日期使用双色背景并在同日期内交替深浅，默认 `false`。`rowHeightMode` 控制明细表格的行高，取值 `large`(41px)、`medium`(38px，默认)、`small`(35px)，单元格正文字号随之联动为 14px / 13px / 12px。`dateDisplayFormat` 支持 `yyyy-mm-dd`、`yyyy/mm/dd`、`mm/dd/yyyy`、`dd/mm/yyyy`，仅影响界面日期显示，不改变数据库、导入或 API 日期值。
- `/api/v1/settings/color-scheme`
- `/api/v1/settings/email`
- `/api/v1/settings/email-import`：GET 返回当前账簿邮箱账单导入的邮件筛选关键词；从未设置时默认 `账单`，PUT 提交 `{ keyword }` 后保存当前账簿配置，空值表示不按关键词筛选。
- `/api/v1/settings/email-accounts`
- `/api/v1/settings/resend`
- `/api/v1/settings/fund-query-api`：GET/POST/PUT/DELETE 管理基金查询来源，PATCH 批量保存拖拽后的优先级；基金净值查询会优先使用账户默认 API，其次按机构场景（如支付宝基金账户优先支付宝来源），最后按全局优先级尝试。
- `/api/v1/settings/backup`：导出/恢复当前账簿加密恢复包，也提供普通表格导出。备份导出使用 `POST /api/v1/settings/backup?mode=export`，JSON body 提交 `userPassword` 和可选 `backupPassphrase`；服务端先用 `userPassword` 验证当前登录用户，再用 `backupPassphrase` 加密 `.mmh-backup` 包，未提供时使用 `userPassword` 作为备份文件加密口令。恢复时 multipart body 提交扩展名为 `.mmh-backup` 的 `file`、`userPassword` 和可选 `backupPassphrase`；服务端先验证当前用户密码，然后返回 `{ ok: true, restoreId, task }` 并在后台解密、清空和写回；调用方应轮询 `GET /api/v1/settings/backup?mode=restore-status&id=<restoreId>`，直到 `task.status` 为 `success` 或 `error`。导出和恢复都不要求重复提交用户名。表格导出使用 `POST /api/v1/settings/backup?mode=table-export`，返回 `.xlsx` 文件，仅用于查看、核对和处理数据，不能用于恢复账簿，且不包含密码、API Key、邮箱密码等敏感恢复配置；其中交易和定投计划的账户名称列按 `accountId` / `toAccountId` / `cashAccountId` 从 Account 表生成，不依赖流水表里的旧名称快照。当前恢复上传上限为 128MB，超过限制应返回 `{ ok: false, error }` 而不是 HTTP 500。PostgreSQL JSON 恢复包会包含账簿基础资料（含基础币种）、全部家庭业务表、交易来源、账户使用字段、定投次执行日、基金快照，以及系统备份中的全局和当前账簿基金查询接口、基金净值缓存、证券公司目录、命令别名、AI 提取日志和命令测试结果；密码重置令牌和撤销历史属于安全/临时状态，不随备份恢复。SQLite 文件数据库仍使用加密整库快照。恢复包还包含系统设置、访问 Key、AI API Key、邀请码、加密主密钥、旧版备份包加密密钥（如存在）、邮箱账户和接口配置等恢复状态所需数据。备份文件本身不是明文，应妥善保存。
- 备份角色边界：`admin` / `isSystem` 可以请求 `backupScope=system`；`user` 和 `viewer` 只能请求 `backupScope=household`。`viewer` 可以导出当前账簿备份和 `.xlsx` 表格，但不能恢复或执行任何保存、编辑、删除、导入等写入操作。SQLite 的系统备份使用加密整库快照，SQLite 的账簿备份使用与 PostgreSQL 相同的加密逻辑 JSON 包，以便隔离单个账簿。
- `/api/v1/settings/system-update`：GET 返回部署方式、当前包版本 `localVersion`、本版说明 `localReleaseNotes`、远端版本/镜像信息和更新状态；飞牛版返回版本和说明，但更新动作由飞牛应用中心管理。

用户设置规则：

- `/api/v1/settings/users` 返回和更新 `sessionDays`，含义是该用户登录态保留几天后需要重新登录，不是用户角色或权限有效期。
- `/api/v1/households` 的登录上下文返回 `role`、`isReadOnly`、`canWrite` 和 `canBackupSystem`；客户端可以据此显示只读状态，但写入权限仍必须由服务端校验。

### Mobile Sync

范围：

- 移动端快速同步。
- 移动端概览、账户、交易、基金的聚合数据。

相关路径示例：

- `/api/v1/mobile/sync`

移动端聚合接口可以减少请求次数，但不应复制 Web 的业务计算逻辑。聚合数据应来自同一套服务模块或统一查询口径。

贷款初始记录有两种资金语义：`source = debt_borrow_in` 表示贷款资金实际进入 `toAccountId`；`source = debt_financed_purchase` 表示车贷等消费融资，只在 `accountId` 对应的贷款账户建立负债，`toAccountId` 为 `null`。后者选择的还款账户属于还款计划，不代表收到贷款资金。客户端不得把消费融资本金显示为资金账户收入。机构贷款（房贷、消费贷）一律按消费融资处理：贷款窗口的「放款/借入」不提供资金账户字段，贷款资金不进入资金账户；账户字段是「还款账户」，仅作为还款计划的扣款账户。

车贷等 `debt_financed_purchase` 保存时只创建贷款负债记录和 `loan_repayment` 计划任务，不批量生成还款交易。移动端同步到的还款 `TxRecord` 应表示计划任务已到期并实际生成的记录；未到期或未执行的还款安排应从计划任务数据展示，不应伪装成交易流水。

交易同步项包含 `accountKind`、`toAccountKind`、`categoryId` 和 `categoryName`。信用卡还款应显示为“类型：转账、分类：信用卡还款”；移动端使用账户类型校验该语义，不要依赖账户名称或备注文本猜测。

投资交易保持 `type = "investment"`，并使用基金投资、理财投资、存款投资、贵金属投资、股票投资或其他投资分类。客户端应优先显示保存的 `categoryId` / `categoryName`，买入、赎回、定投、分红和股票买卖仍是投资动作，不是收入或支出类型。`source = "insurance"` 的记录不归入投资分类：保费显示为保险支出，理赔、退保和满期领取显示为保险回款。

移动同步返回 `stockHoldings`、`stockTransactions` 和 `deletedStockTransactionIds`。股票同步项来自独立 stock 表，客户端不得从 `fundCode`、`fundUnits`、`fundNav` 或基金净值缓存推断股票持仓；`stockTransactions[].linkId` 是 `EntryBusinessLink` 的稳定关联 ID。

移动同步返回 `propertyAssets`、`propertyTransactions`、`deletedPropertyAssetIds` 和 `deletedPropertyTransactionIds`。房产同步项来自独立 property 表，客户端不得从基金份额、净值或 `TxRecord` 余额推断房产市值；`propertyTransactions[].linkId` 是 `EntryBusinessLink` 的稳定关联 ID。

移动同步的 `regularInvestPlans` 包含 `planName`、`taskType`、`taskTitle`、`taskCategoryId`、`taskCategoryName` 和 `taskNote`。`planName` 是用户可编辑展示名，客户端展示时优先使用它，空值再回退到 `taskTitle`/目标内容。只有 `taskType = "fund_regular_invest"` 的计划参与基金净值刷新；固定收入和固定支出计划按普通 `TxRecord` 语义执行，客户端不得把它们当作基金代码查询净值。

账户同步项包含 `creditBillMode`，值为 `separate` 或 `consolidated`，也包含用户自由备注 `note`。合并账单按同一账簿、同一机构下标记为 `consolidated` 的有效信用卡归组；交易的 `accountId` / `toAccountId` 仍指向具体信用卡，不改写为代表账户。

账户同步项的 `balance` 与 Web 一致，表示截至当前日期的展示余额；移动端不得把未来日期的计划还款、分期、保费或未来流水自行累加到账户余额。

### 撤销最近明细操作

- `GET /api/v1/undo` 返回当前用户最近一条可撤销的资金明细编辑/删除操作、`canUndo`、`undoCount` 和 `historyLimit`；当前保留最近 5 个操作。
- `POST /api/v1/undo` 将最近一条可撤销的单条编辑、批量编辑、单条删除或批量删除作为一个整体恢复；连续调用可继续撤销上一条，最多回退当前保留的 5 个操作。
- 撤销恢复交易字段与标签，并触发账户余额、基金/贵金属持仓和信用卡账单缓存刷新。
- 贷款项目整体删除涉及账户、计划和利率硬删除，当前不进入普通明细撤销。

信用卡分期生成的交易同步项还包含：

- `creditCardInstallmentPlanId`: 分期计划稳定 ID。
- `installmentNo` / `installmentTotal`: 当前期次与总期数；冲抵行的 `installmentNo` 为 `null`。
- `installmentPrincipal` / `installmentInterest`: 本行本金与手续费/利息。
- `installmentRole`: `adjustment` 表示原账期本金冲抵，`payment` 表示某一期本金，`fee` 表示同一期手续费/利息。
- `installmentSourceType`: `transaction` 表示消费时创建的消费分期，`statement` 表示已出账后创建的账单分期。
- `installmentSourceStatementMonth`: 账单分期的来源账单月份（`YYYY-MM`）；消费分期为 `null`。

消费分期支持仅对原支出的部分金额分期；账单分期支持对已出账且未结清账单的部分金额分期。客户端不得把原消费、冲抵和全部分期再次相加；账单口径是“保留原消费、在来源账单冲抵分期本金、从首期账单开始逐期加入本金与费用”。冲抵行是信用卡账户流入/支出抵减，保存为 `type=expense` 且 `amount` 为正数；账单摘要的流出/流入按信用卡视角的金额正负统计，不按 `type` 大类统计，因此该冲抵行计入流入。每期扣款日期按首期入账日期逐月推进，例如首期入账日期为 `11-27` 时第二期日期为 `12-27`；账单分期窗口中首期入账日期默认等于分期日期，但可单独指定。每期本金和手续费/利息生成同日两条流水（无手续费/利息时不生成零金额手续费流水）。首期本金/手续费所属账期按首期入账日期和账单日计算，不强制归到来源账单的下一期。费率类型必须区分 `annual_interest`（年利率）与 `period_fee`（每期手续费率）。

### 刷新信用卡账单汇总

- Method: `GET`
- Path: `/api/v1/bill/summary`
- Auth: required
- Query: `accountId`（信用卡账户 ID）、可选的 `billMonth`、`hideZeroBills`、`hideSettledBills`、`billMonthsLimit`、`billDateFrom` 和 `billDateTo`。
- 返回当前筛选条件下重新计算的 `rows` 和 `creditBillBalanceValue`；该接口只返回账单汇总，不返回下方交易明细，用于账单金额覆盖后的局部刷新。

### 创建账单分期

- Method: `POST`
- Path: `/api/v1/bill/installment`
- Auth: required
- Body: `accountId`, `amount`, `date`（`YYYY-MM-DD`，分期确定/冲抵日期，系统按该日期和账单日自动归属来源账单月份）, `firstPaymentDate`（可选，`YYYY-MM-DD`，首期入账日期，默认等于 `date`）, `totalRuns`, `rateType`, `rate`；`statementMonth` 仅作为兼容校验字段可选传入，必须与日期推导结果一致。
- 仅允许日期归属到已出账的信用卡账单；分期金额默认可参考未还金额但不限制输入上限，也不以系统计算的未还金额作为创建门槛；同一合并/独立账单月份只能有一个有效账单分期计划。
- 返回 `planId`, `sourceType`, `sourceStatementMonth`, `installmentPrincipal`, `firstStatementMonth`, `totalRuns`。

## 接口详情模板

后续补充具体接口时使用以下模板：

````md
### 接口名称

- Method: `GET`
- Path: `/api/v1/example`
- Auth: required
- Context: server/book/user/role

Query:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| id | string | yes | Entity ID |

Body:

```json
{}
```

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "error": "错误说明"
}
```

Notes:

- 说明排序、日期、金额、刷新影响等特殊规则。
````
- Account kind contract: `settlement` represents counterparty/person/company settlement accounts (往来款); `loan` represents institution-backed loans. Both are exposed through the existing debt/settlement workspace and sidebar entry.
