# MoneyMoneyHome

<p align="center">
  <a href="#中文">中文</a>
  ·
  <a href="#english">English</a>
  ·
  <a href="#日本語">日本語</a>
</p>

## 中文

### 产品定位

MoneyMoneyHome（MMH）是一个面向家庭和个人的本地优先智能财务系统。它把日常记账、账户资产、信用卡账单、基金投资、上市证券、固定资产、保险保单、房贷还款、往来款、计划任务、邮箱账单识别和多端 API 接入放进同一套可长期维护的家庭财务工作台。

MMH 不是把家庭账本交给外部平台托管的 SaaS。它更适合部署在自己的 NAS、家庭服务器或本地 Docker 环境中，让敏感财务数据留在自己掌握的地方。

你可以通过账单导入、计划任务、余额校准等功能，轻松实现账户记录与实际余额对齐，享用轻松对账的快乐。

### 你可以用它做什么

- **把家庭财务放回自己手里**：部署在自己的 NAS、家庭服务器或 Docker 环境中，日常数据保存在自己的环境里。
- **看清完整资产和负债**：把现金、银行卡、信用卡、基金、理财、上市证券、固定资产、保险、房贷和往来款放到同一套账里看。
- **更轻松地对账**：通过账单导入、明细核对、余额校准和报表查看，把账户记录与实际余额对齐。
- **减少重复录入**：用计划任务处理定投、转账、还贷款、保险缴费等周期事项。
- **维护复杂资产变化**：跟踪基金确认/到账、股票买卖和分红、固定资产投入和估值、保险缴费和现金价值。
- **从账单变成标准记录**：从邮箱、文本、PDF 或截图中识别账单，预览编辑后批量导入。
- **在不同设备上使用同一本账**：Web 适合细致整理和核对，移动端适合日常查看和快速录入，开放 API 方便接入其他客户端。

### 它解决什么问题

家庭财务数据通常分散在银行卡、信用卡、基金平台、贷款合同、保险合同、邮箱账单和手工表格里。时间久了，最麻烦的并不是记一笔账，而是保持统一口径：

- 多账户、多家庭成员、多机构之间缺少统一资产视图。
- 信用卡账单、基金定投、股票交易、固定资产投入、房贷、保险缴费和往来款很难长期追踪。
- 普通记账工具可以录入流水，但很难稳定维护持仓、账单期、净值、还款计划和保单计划。
- 外部云平台虽然方便，但家庭财务数据不一定适合托管出去。

MMH 的目标是建立一个可以长期维护的家庭财务底座：高频录入要快，复杂资产要算得清楚，同一笔数据在不同页面和客户端看到的含义一致。

### 功能模块

| 模块 | 说明 |
| --- | --- |
| 概览 | 汇总日常账户、信用卡、投资、上市证券、固定资产、保险、往来款和关键指标。 |
| 账户 | 管理现金、借记卡、电子钱包、存款、投资账户和账户归属。 |
| 信用卡 | 维护信用卡账户、账单周期、交易明细、入账日期和还款记录。 |
| 投资基金 | 管理基金交易、净值缓存、持仓、份额、成本、收益和确认/到账规则。 |
| 上市证券 | 管理股票账户、证券资金账户、买卖交易、分红、费用、收盘价和持仓盈亏。 |
| 固定资产 | 管理房产等固定资产、装修投入、资产估值、关联流水和资产明细。 |
| 保险 | 维护保险产品、保单、投保记录、缴费计划、现金价值和保险概览。 |
| 往来款 | 跟踪代付、借入、借出、还款和与往来对象相关的余额结果。 |
| 计划任务 | 管理定投、还款、转账、缴费等周期任务，减少重复录入。 |
| AI 导入 | 从邮箱、文本、PDF 或截图中识别账单，预览后批量写入标准记录。 |
| 系统设置 | 管理账簿、用户、账户、机构、往来对象、分类、标签、邮箱、AI 模型、显示和系统更新。 |

### 安全模型

MMH 面向自托管环境，但远程访问时仍需要明确的安全边界：

- 推荐通过 HTTPS 反向代理访问。
- 可使用 `MMH_ALLOWED_HOSTS` 限定允许访问的域名或 IP。
- 登录会话 Cookie 使用 `HttpOnly`、`SameSite=Lax`，生产环境默认 `Secure`。
- 数据库端口应只暴露给应用容器或本机网络。
- Prisma Studio 不作为正式功能暴露，因为它绕过应用权限和账簿隔离。
- 业务 API 应通过当前 session 解析账簿、用户和角色上下文，避免跨账簿访问。

更多说明见 [Security Hardening](docs/security-hardening.md)。

### 部署与更新

MMH 的 NAS 版本以 Docker 预构建镜像为主。日常更新流程应保持简单，并避免在低功耗 NAS 上反复构建应用：

完整说明见 [NAS / 飞牛 fnOS / 群晖 DSM 安装与更新](deploy/nas-install-manual.md)。

## English

### Product Positioning

MoneyMoneyHome (MMH) is a local-first intelligent finance system for households and individuals. It brings daily bookkeeping, account assets, credit card bills, fund investments, listed securities, fixed assets, insurance policies, mortgage repayment, settlements, scheduled tasks, email bill recognition, and multi-client APIs into one durable household finance workspace.

MMH is not a SaaS product that asks you to hand your family ledger to an external platform. It is designed for your own NAS, home server, or local Docker environment, so sensitive financial data can stay under your control.

You can use statement import, detail review, balance reconciliation, and reports to align account records with actual balances, making reconciliation feel lighter and calmer.

### What You Can Do

- **Keep household finance under your control**: Run MMH on your own NAS, home server, or Docker environment while keeping daily data in your own environment.
- **See assets and liabilities together**: View cash, bank cards, credit cards, funds, wealth products, listed securities, fixed assets, insurance, mortgages, and settlements in one ledger.
- **Reconcile with less friction**: Use statement import, detail review, balance reconciliation, and reports to align account records with actual balances.
- **Reduce repeated entry**: Use scheduled tasks for recurring investments, transfers, loan repayment, insurance premium payments, and other periodic work.
- **Maintain complex asset changes**: Track fund confirmation/arrival, stock trades and dividends, fixed asset investments and valuations, insurance premiums, and cash value.
- **Turn bills into standard records**: Recognize bills from email, text, PDF, or screenshots, then review, edit, and batch import them.
- **Use the same ledger across devices**: Web is for detailed review and reconciliation, mobile is for daily viewing and quick entry, and open APIs support other clients.

### What It Solves

Household finance data is often scattered across bank cards, credit cards, fund platforms, loan contracts, insurance contracts, email statements, and manual spreadsheets. Over time, the hard part is not simply recording one transaction. The hard part is keeping everything consistent:

- Multiple accounts, family members, and institutions need one coherent asset view.
- Credit card statements, recurring fund investments, stock trades, fixed asset investments, mortgages, insurance payments, and settlements are difficult to track over the long term.
- Common bookkeeping tools can record cash flow, but they often cannot maintain holdings, statement periods, NAV data, repayment schedules, and policy plans consistently.
- Cloud services are convenient, but sensitive household finance data may not be suitable for external hosting.

MMH aims to become a long-term household finance foundation: frequent entry should be fast, complex assets should be calculated clearly, and the same data should carry the same meaning across pages and clients.

### Feature Modules

| Module | Description |
| --- | --- |
| Overview | Summarizes daily accounts, credit cards, investments, listed securities, fixed assets, insurance, settlements, and key indicators. |
| Accounts | Manages cash, debit cards, e-wallets, deposits, investment accounts, and ownership. |
| Credit Cards | Maintains credit card accounts, statement cycles, transaction details, posting dates, and repayments. |
| Fund Investments | Manages fund transactions, NAV cache, holdings, units, cost, returns, and confirmation/arrival rules. |
| Listed Securities | Manages stock accounts, brokerage cash accounts, trades, dividends, fees, close prices, and holding profit/loss. |
| Fixed Assets | Manages properties and other fixed assets, renovation investments, valuations, linked entries, and asset details. |
| Insurance | Maintains insurance products, policies, purchase records, payment plans, cash value, and insurance summaries. |
| Settlements | Tracks advance payments, borrowing, lending, repayment, and balances related to counterparties. |
| Scheduled Tasks | Manages recurring investments, repayments, transfers, and payments to reduce repeated entry. |
| AI Import | Recognizes bills from email, text, PDF, or screenshots, then imports reviewed records in batches. |
| System Settings | Manages ledgers, users, accounts, institutions, counterparties, categories, tags, email accounts, AI models, display, and updates. |

### Security Model

MMH is built for self-hosted environments, but remote access still needs clear security boundaries:

- HTTPS reverse proxy access is recommended.
- `MMH_ALLOWED_HOSTS` can restrict allowed domains or IP addresses.
- Login session cookies use `HttpOnly` and `SameSite=Lax`, with `Secure` enabled by default in production.
- Database ports should only be exposed to the app container or local network.
- Prisma Studio is not exposed as a production feature because it bypasses application permissions and ledger isolation.
- Business APIs should resolve ledger, user, and role context from the current session to avoid cross-ledger access.

See [Security Hardening](docs/security-hardening.md) for details.

### Deployment And Updates

The NAS version of MMH is designed to use prebuilt Docker images. Routine updates should stay simple and avoid repeated application builds on low-power NAS hardware:

See [NAS / fnOS / Synology DSM Install And Update](deploy/nas-install-manual.md) for the full guide.

## 日本語

### 製品の位置づけ

MoneyMoneyHome（MMH）は、家庭と個人のためのローカルファーストなスマート財務システムです。日々の記帳、口座資産、クレジットカード明細、投資信託、上場証券、固定資産、保険契約、住宅ローン返済、立替・貸借、予定タスク、メール明細認識、複数クライアント向け API を、長く使える家庭向け財務ワークスペースにまとめます。

MMH は、家庭の帳簿を外部プラットフォームに預ける SaaS ではありません。自分の NAS、家庭サーバー、またはローカル Docker 環境で動かし、重要な財務データを自分の管理下に置くことを前提にしています。

明細取込、明細確認、残高調整、レポートを使って、口座記録と実際の残高をそろえられます。照合の負担を軽くし、数字が合う安心感を得られます。

### できること

- **家庭の財務を自分で管理する**：自分の NAS、家庭サーバー、Docker 環境で運用し、日々のデータを自分の環境に保存できます。
- **資産と負債をまとめて見る**：現金、銀行カード、クレジットカード、投資信託、理財商品、上場証券、固定資産、保険、住宅ローン、立替・貸借を一つの帳簿で確認できます。
- **残高照合を軽くする**：明細取込、明細確認、残高調整、レポートを使い、口座記録と実際の残高をそろえられます。
- **繰り返し入力を減らす**：積立、振替、ローン返済、保険料支払いなどの周期的な作業を予定タスクで扱えます。
- **複雑な資産変化を追跡する**：投資信託の約定/入金、株式の売買と配当、固定資産への支出と評価、保険料と解約返戻金を管理できます。
- **明細を標準記録に変える**：メール、テキスト、PDF、スクリーンショットから明細を認識し、確認・編集してまとめて取り込めます。
- **同じ帳簿を複数デバイスで使う**：Web は細かい整理と照合に、モバイルは日常確認と素早い入力に、公開 API は他のクライアント接続に使えます。

### 解決する課題

家庭の財務データは、銀行カード、クレジットカード、投資信託プラットフォーム、ローン契約、保険契約、メール明細、手作業の表に分散しがちです。時間がたつほど難しくなるのは、単に一件の取引を記録することではなく、全体の口径をそろえることです。

- 複数の口座、家族メンバー、金融機関をまたいだ統一的な資産ビューが必要です。
- クレジットカード明細、積立投資、株式取引、固定資産への支出、住宅ローン、保険料支払い、立替・貸借は長期的に追跡しにくいものです。
- 一般的な家計簿ツールは入出金を記録できますが、保有、明細期間、基準価額、返済計画、保険計画まで一貫して管理するのは難しい場合があります。
- クラウドサービスは便利ですが、家庭の重要な財務データを外部に預けることが常に適切とは限りません。

MMH の目標は、長く維持できる家庭財務の土台を作ることです。よく使う入力は速く、複雑な資産は明確に計算され、同じデータはどの画面やクライアントでも同じ意味を持つべきです。

### 機能モジュール

| モジュール | 説明 |
| --- | --- |
| 概要 | 日常口座、クレジットカード、投資、上場証券、固定資産、保険、立替・貸借、主要指標を集計します。 |
| 口座 | 現金、デビットカード、電子ウォレット、預金、投資口座、所有者を管理します。 |
| クレジットカード | カード口座、明細周期、取引明細、入金日、返済記録を管理します。 |
| 投資信託 | 取引、基準価額キャッシュ、保有、口数、コスト、損益、約定/入金ルールを管理します。 |
| 上場証券 | 株式口座、証券資金口座、売買、配当、費用、終値、保有損益を管理します。 |
| 固定資産 | 不動産などの固定資産、改修投資、資産評価、関連記録、資産明細を管理します。 |
| 保険 | 保険商品、契約、加入記録、支払計画、解約返戻金、保険サマリーを管理します。 |
| 立替・貸借 | 立替払い、借入、貸付、返済、取引先に関係する残高を追跡します。 |
| 予定タスク | 積立、返済、振替、支払いなどの定期処理を管理し、繰り返し入力を減らします。 |
| AI 取込 | メール、テキスト、PDF、スクリーンショットから明細を認識し、確認後にまとめて取り込みます。 |
| システム設定 | 帳簿、ユーザー、口座、金融機関、取引先、カテゴリ、タグ、メールアカウント、AI モデル、表示、更新を管理します。 |

### セキュリティモデル

MMH は自ホスト環境向けですが、リモートアクセスには明確な安全境界が必要です。

- HTTPS リバースプロキシ経由のアクセスを推奨します。
- `MMH_ALLOWED_HOSTS` で許可するドメインまたは IP を制限できます。
- ログインセッション Cookie は `HttpOnly`、`SameSite=Lax` を使い、本番環境では既定で `Secure` になります。
- データベースポートはアプリコンテナまたはローカルネットワークにだけ公開するべきです。
- Prisma Studio はアプリ権限と帳簿分離を迂回するため、本番機能として公開しません。
- 業務 API は現在の session から帳簿、ユーザー、ロールの文脈を解決し、帳簿をまたぐアクセスを防ぐべきです。

詳細は [Security Hardening](docs/security-hardening.md) を参照してください。

### デプロイと更新

MMH の NAS 版は、事前ビルド済み Docker イメージを使う方針です。日常更新は簡単に保ち、低消費電力 NAS 上でアプリを繰り返しビルドしないようにします。

詳しくは [NAS / fnOS / Synology DSM インストールと更新](deploy/nas-install-manual.md) を参照してください。

## Developer Docs

- [Development Docs](docs/development-docs.md)
- [Client API](docs/client-api.md)
- [Agent API](docs/agent-api.md)
- [Android Release](docs/android-release.md)
- [Edit Window Checklist](docs/edit-window-checklist.md)
- [Investment Data Check](docs/check-investment-data.md)
