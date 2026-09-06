# 检查和修复投资交易账户设置错误

## 问题描述

根据 DESIGN.md 规范，投资交易的账户结构应该是：
- `accountId` = 资金来源账户（现金账户）
- `toAccountId` = 基金账户（投资账户）
- `amount` 为负数表示买入（资金从左流向右）

历史数据中可能存在错误：`accountId` 设置为基金账户（应该设置为资金账户）。

## 基金身份字段

- 份额校准事务回归：运行 `node scripts/verify-fund-units-reconcile.cjs`。脚本只使用临时 SQLite 数据库和独立生成的客户端，验证到账前校准、短暂占用、启动超时重试、持续繁忙、并发重复请求、写入回滚及弹窗输入保留。
- SQLite 运行时通过 `src/lib/db/sqlite-adapter.ts` 补齐启动超时后的实际回滚；更新 Prisma 时需运行上述回归，确认延迟启动的事务不会残留 `BEGIN` 或阻塞后续保存。

- `fundCode` 是基金记录的身份字段，也是持仓重算、匹配、分组和去重的计算键。
- `fundName` 只用于显示、补全和导入辅助，不参与持仓、成本、份额、收益计算。
- 基金导入时，空 `fundName` 或等于 `fundCode` 的名称都应视为缺失显示名；预览和写入前应按代码补全真实基金名称，不能把基金代码长期保存成基金名称。
- 同一个基金改名、名称缺失或名称被导入备注污染时，不应影响持仓计算结果。
- 基金资料的 `tradingCalendar` 是净值交易日历，用于判断某只基金在哪些日期应该存在 NAV，例如港股、日本、美国市场基金。基金账户的 `tradingCalendar` 仍是确认日期、到账日期、T+N 推导的账户级规则；资料缺失时也可作为净值判断兜底。核对净值日期/入账日期时，不能只看确认天数和到账天数，还要同时确认基金资料和账户分别使用的是哪一种交易日历。
- 基金 Excel 导入预览会优先用申请日期/时间推导净值日期：申请时间在 15:00 及以后时，净值日期按下一个基金交易日；15:00 以前按申请日。缺净值时应先按该净值日期查缓存/外部精确净值，查到后再计算份额。
- 基金视图表头“获取净值”不负责补齐历史确认数据：先使用缓存中已有的精确确认日净值，缓存缺失时只自动查询今天及往前三个交易日；更早且未缓存的确认日交由用户在基金明细中手工补齐。投资收益表需要历史净值时，继续使用专用的历史净值补齐流程。
- 基金确认天数没有单独配置时默认按 T+0；只有用户明确保存其他天数时才按对应天数确认。T+N 自动推导必须按交易日计算，不能用自然日直接加天数，否则周末和节假日会让确认日偏早。
- 基金记录里的 `confirmDate` / `fundConfirmDate` 是净值日期，不等同于新增份额开始计算收益的日期。买入和红利再投资份额要等净值日期后的下一个基金交易日才进入收益计算；当天刚增加的份额不能参与当天净值变化。
- 基金红利再投只增加基金业务侧份额，不产生金额、不关联资金账户、不创建资金侧 `TxRecord` 或 `FundTransactionCashFlow`；落库时 `FundTransaction.grossAmount = 0`、`cashAccountId = null`、`cashEntryId = null`，持仓成本增加为 0。
- 基金交易 Excel 如果填写了资金账户，导入预览必须把该值匹配成资金侧 `Account.id`；匹配不到应阻断导入。导入成功后，应能在资金侧看到对应 `TxRecord`，在 `FundTransactionCashFlow` 中看到现金流，并通过 `EntryBusinessLink` 关联到基金业务交易。
- 基金交易 Excel 从具体基金账户视图发起时，导入行缺基金账户可用当前基金账户补全；买入、赎回和现金分红行缺资金账户时，只能从该基金账户最近 100 条未删除基金交易里按最高使用频率推断资金侧账户。没有当前基金账户上下文或推断不到资金账户时，应在预览中阻断，不能写成无现金侧关联的基金交易。
- 基金份额校准的输入是最终实际份额；落库时只新增达到该最终份额所需的差额份额，写成 `source="fund_units_reconcile"` 的无现金流基金业务交易，不生成或修改资金侧流水。

## 股票身份和持仓字段

- 股票账户使用 `Account.kind = "investment"` + `investProductType = "stock"`；同一账簿可有多个股票账户，账户 ID 是账户身份来源。
- 创建或更新股票账户时，如果有证券机构，应自动确保同账簿、同所有人、同证券机构、同币种下存在一个现金/钱包类“证券资金账户”；核对时不要把银证转账目标设成股票账户或基金账户。
- 股票标的身份使用 `StockSecurity.id` / `securityId`，展示和导入辅助字段是 `market`、`stockCode`、`stockName`；不要把股票代码写入或核对到 `fundCode`。
- 股票导入时，空 `stockName` 或等于 `stockCode` 的名称都应视为缺失显示名；服务端应先使用本地已有名称，首次买入且本地缺失时再按股票代码补全并缓存，不能让代码覆盖真实名称。
- 股票交易事实字段以 `StockTransaction` 为准，现金流水只在需要时创建普通 `TxRecord`，二者通过 `EntryBusinessLink.stockTransactionId` 和返回的 `linkId` 关联。
- 股票买入、卖出、分红和税费调整使用 `cashAccountId` 指向的证券资金账户/券商可用资金账户；同一证券公司名下的股票和基金可以共用同一个现金/钱包类资金账户。检查余额时应把证券资金账户现金和 `StockHolding` 市值区分开。银证转账是银行/现金账户与证券资金账户之间的普通转账，不写入 `StockTransaction`。
- 股票持仓以 `StockHolding` 为准，数量、成本、最新价、市值、浮盈和历史收益都由 `src/lib/stock/recalcPosition.ts` 重算；最新收盘价写入 `StockPriceCache`，刷新后必须再次重算 `StockHolding`。不要从 `FundHolding` 或基金净值缓存推断股票值。
- 股票账户页应把 `StockHolding.quantity > 0` 的行显示在“持仓”，把零份额清仓行显示在“清仓”；清仓行保留历史收益并可点击查看对应 `StockTransaction` 明细，但不计入当前市值和当前成本。
- 报表页「股票持仓盈亏」必须与股票账户持仓表使用同一套 `StockHolding` 数字：市值、成本、浮动盈亏、已实现收益。核对时先看股票账户页，再看 `/reports?report=stock-holdings`，两边同一只股票的金额不能各算各的。
- 股票手续费规则先看账户级 `StockFeeRule`，未命中时使用市场默认 `StockMarketFeeRule`；证券公司公开名录和别名存入 `StockBrokerageCatalog`。这些规则支持佣金、印花税、过户费、经手费、监管费、平台费、最低收费和买卖方向；不要复用 `fundFeeRate`。
- 股票买入/卖出窗口只直接展示费用合计、成交金额和预计应付/到账，佣金、印花税、过户费、经手费、证管费、其他费用只在费用合计 hover 明细中展示；这些值只是同一套 `src/lib/stock/feeRule.ts` 计算结果的只读预估。保存交易时服务端再次按该规则计算并写入 `StockTransaction`，买入现金侧 `TxRecord` 金额应等于成交金额 + 费用合计，卖出现金侧 `TxRecord` 金额应等于成交金额 - 费用合计。
- 券商导入或成交单去重使用 `externalLinkId` / `brokerTradeId`；它们不是基金买入退回 link，也不是 `fundSourceEntryId`。

## 理财收益统计字段

- 理财赎回的到账金额是本金 + 收益，只影响资金账户现金流水；报表统计和投资收益表只能计入经济收益或亏损。
- 理财收益优先读取 `WealthTransaction.realizedProfit`；没有该字段时，用 `interest - fee`，或在同时有赎回本金 `grossAmount` 和到账额 `arrivalAmount` 时用 `arrivalAmount - grossAmount`。
- 如果理财赎回只有到账额，缺少本金、份额、净值、利息和手续费，收益应按 0 处理，不能把整笔到账额归入“理财收益”或“投资收入”。
- 核对异常月份时，先查该月 `WealthTransaction` 的 `grossAmount`、`arrivalAmount`、`interest`、`fee`、`realizedProfit` 和 `cashEntryId`；`cashEntryId` 对应的 `TxRecord.amount` 是现金流金额，不等同于收益。

## 房产资产字段

- 房产账户使用 `Account.kind = "investment"` + `investProductType = "property"`；同一账簿可有多个房产账户，账户 ID 是归属来源。
- 房产资产以 `PropertyAsset` 为准，字段包括名称、地址、币种、购入日期、购入价、累计成本、当前市值、最近估值日期和状态；不要把房产身份或市值写入基金字段。
- 房产购入、装修投入和出售以 `PropertyTransaction` 为业务事实，现金侧只在传入资金账户时创建 `TxRecord`，并通过 `EntryBusinessLink.propertyTransactionId` 关联。
- 成本口径为交易金额 + 手续费 + 税费；装修投入增加累计成本。手动估值只写 `PropertyValuation` 并更新市值，不产生收入/支出/转账现金流水。
- 房贷或按揭仍应作为贷款/负债账户核对；房产持仓市值和贷款余额不能混在同一房产资产表里计算。

## 最新净值刷新

- 基金买入申请日为当天或前两个交易日内时，如果确认日尚未获取到精确净值，买入记录的净值和份额必须保持为空，不能用较早净值代替；应用下一次启动时由启动检查再次补填精确净值并计算份额。

- 启动后的轻量后台检查和基金页手动“获取净值”都应刷新当前持仓基金的最新净值。
- 当前持仓以 `FundHolding` 中 `units > 0` 或 `pendingCost > 0` 的基金/货币基金账户行判断，不依赖该基金是否存在定投计划。
- 待确认买入记录的确认日净值补填仍按交易确认日期处理；持仓最新净值刷新只负责更新最新可用交易日净值缓存和显示名称，不能改写已有真实基金资料的 `FundProfile.navDateOffset` 或 `FundProfile.tradingCalendar`。
- 持仓最新净值刷新和持仓市值展示必须按 `FundProfile.navDateOffset` 选择目标净值日：北京时间 19:00 后，`0` 查询/显示本交易日，`1` 查询/显示前一交易日；19:00 前在该偏移基础上再提前一个交易日。目标日如果是周末或对应基金市场休市日，应继续回退到上一交易日。
- 投资收益表的每日市值收益必须先按每只基金的 `FundProfile.navDateOffset` 选择净值日：`0` 用统计日净值减上一净值，`1` 用统计日前一交易日净值减再上一净值；如果统计日是今天且北京时间未到 19:00，则在该偏移基础上再提前一个交易日。缺失时提示用户批量获取；获取会按基金合并日期范围写入 `FundNavCache`，但不得自动修改偏移值。周末/非交易日市值可沿用上一可用交易日净值。
- `FundProfile.navDateOffset` 新建基金资料时默认 `0`；只有基金资料保存/API PATCH 能显式改为 `0` 或 `1`。外部资料刷新、最新净值刷新和缺失净值补齐不得按基金名称或最新净值可用情况推导或覆盖该值。
- `FundProfile.tradingCalendar` 首次默认赋值按基金/指数名称关键字推断：恒生、香港、港股、H 股、Hang Seng、Hong Kong 使用 `hk_fund`；日本、日经、东证、Nikkei、TOPIX、Japan 使用 `jp_fund`；QDII、标普、纳斯达克、纳指、道琼斯、美国、全球等使用 `us_fund`；其他默认 `cn_fund`。如果用户保存过净值交易日历，外部资料刷新不得覆盖该值。
- 投资页收益日历的单日数字按前一日已收益生效份额乘以当日净值变化计算，例如 2 号 2000 份、净值 2，3 号净值 2.01 且当天新增确认 20 份，则 3 号收益为 `2000*2.01 - 2000*2`；所有份额必须经历一次净值变化后才计算收益。数据优先读取独立业务表 `FundTransaction` 和 `FundTransactionCashFlow`，只有没有独立业务记录的历史数据才回退读取带基金字段的旧 `TxRecord`。不要用当前 `FundHolding.units` 乘历史净值倒推，因为买入、赎回、买入退回和手续费会让历史份额与当前份额不同。
- 投资收益表的“缺净值”提示按基金净值公布模型判断，避免把“还没公布”误报成“缺失”：
  - 港股、日本、美国等海外类基金优先按 `FundProfile.tradingCalendar` 判断交易日，且只提示“净值公布历史中段”的缺口（基金已存在该日期之后的净值）；最近交易日净值尚未公布或对应市场休市日不提示。
  - 货币基金（名称含“货币”）不做缺净值提示：其单位净值恒为 1，缓存里存的是万份收益，缺失万份收益不影响市值。
  - 资料缺失时才退回账户交易日历判断；已发生交易日缺当日净值才提示。
- 投资收益表的快照估值覆盖 `fund`、无类型和 `money` 类型的投资账户：货币基金市值 = 份额 × 1（单位净值恒 1），当日收益按缓存中的万份收益 × 份额 ÷ 10000 计入；货币账户里普通债券/股票型基金按正常净值估值。
- 投资收益表的股票列覆盖 `stock` 类型投资账户：按 `StockTransaction` 回放历史持仓，使用 `StockPriceCache` 中统计日及之前最后收盘价估值，并把买入、卖出、分红、费用/税费调整作为现金流修正股票收益；没有可用收盘价时以回放成本兜底，不能因此漏掉已卖出收益或现金分红。
- 投资收益表的固定资产列覆盖 `property` 类型投资账户：只统计 `PropertyTransaction.action = sale` 的 `realizedProfit`，归属日期优先使用 `settlementDate`，否则使用 `tradeDate`；购入、装修投入和手动估值不进入收益，关联现金侧 `TxRecord` 不再重复归到基金收益。
- 理财现金流水（`wealthTransaction.cashEntryId` 关联的 `TxRecord`）的已实现收益归入“理财收益”列，不再因 `fundProductType` 为空而误归到“基金”列。

## 买入退回与确认份额

- 持仓表显示的未确认金额按待确认买入记录的 `买入金额 - 关联退回金额` 汇总，不扣申购手续费；这是显示口径，不要求改写 `FundHolding.pendingCost` 缓存。
- 买入确认份额统一按 `买入金额 - 关联退回金额 - 申购手续费` 后再除以净值计算；买入记录的 `fundUnits` 存储扣费后的确认份额。
- 持仓成本价使用扣除关联退回、但不扣申购手续费的买入金额（买入金额 - 关联退回金额）作为成本基础；申购手续费属于用户投入成本，但不形成份额。赎回收益使用净到账金额，若没有单独保存到账金额，`TxRecord.amount` 已经是现金侧净到账，重算时不能再扣一次赎回费。
- 退回记录只表示资金回流和与买入记录的关联，不应在展示、持仓重算、净值补全、导入或批量编辑中再次扣减份额。
- 基金明细统一使用“金额”列表达交易金额：买入主记录（包括买入失败）显示原买入金额正数，关联买入退回记录显示负数，二者可直接相加对冲；状态只显示“买入失败”“买入退回”或“部分确认”等简洁状态。确认净额只用于编辑窗口的派生确认金额、份额和持仓计算。退回行只是资金回流和关联关系记录，不能改成普通买入，否则会影响成本和未确认金额。
- 买入/退款/赎回的确认日和到账日都要按交易日推进：确认日以申请日 + confirmDays 计算，到账日以申请日 + arrivalDays 计算，周末和基金节假日都要跳过。编辑到账日时只回写 arrivalDays，不要反向改确认日。
- 核对问题记录时，先看退回记录是否通过 `fundSourceEntryId` 关联到源买入记录；没有显式关联的旧数据才允许按日期规则做兼容匹配。

## 如何检查

### 方法1：使用 Prisma Studio（推荐）

Prisma Studio 已启动在：http://localhost:51212

1. 打开 TxRecord 表
2. 添加筛选条件：
   - `type` = `investment`
   - `deletedAt` = `null`
3. 查看每条记录的 `accountId` 和 `account` 关联
4. 如果 `account.kind` = `investment`，则该记录存在错误

### 方法2：使用 SQL 查询

在数据库工具中运行 `scripts/archive/check-investment-account.sql`：

```sql
SELECT
  tx.id,
  tx.date,
  tx.type,
  tx.accountId,
  tx.accountName,
  tx.toAccountId,
  tx.toAccountName,
  tx.amount,
  tx.fundCode,
  acc.kind as account_kind,
  CASE
    WHEN acc.kind = 'investment' THEN 'ERROR: accountId should be cash account'
    ELSE 'OK'
  END as validation_result
FROM TxRecord tx
LEFT JOIN Account acc ON tx.accountId = acc.id
WHERE
  tx.type = 'investment'
  AND tx.deletedAt IS NULL
  AND acc.kind = 'investment'
ORDER BY tx.date DESC;
```

## 如何修复

对于发现的错误记录，需要交换 `accountId` 和 `toAccountId`：

### Prisma Studio 手动修复

1. 在 TxRecord 表中找到错误记录
2. 点击编辑
3. 将 `accountId` 改为原来的 `toAccountId` 值
4. 将 `toAccountId` 改为原来的 `accountId` 值
5. 保存；`accountName` 和 `toAccountName` 是旧兼容字段，显示和导出应优先从账户 ID 关联的 Account 表生成

### 批量修复脚本（谨慎使用）

如果数据量较大，可以编写批量修复脚本，但建议先备份数据。

## 验证修复结果

修复后，重新运行检查步骤，确认：
- 所有 investment 类型记录的 `account.kind` ≠ `investment`
- `accountId` 指向的是现金/银行账户
- `toAccountId` 指向的是投资账户
