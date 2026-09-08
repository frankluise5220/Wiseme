// AI prompt templates used by the chat route

export type FundContext = {
  fundCode: string;
  fundName?: string;
  accountId: string;
  cashAccountId?: string;
};

export type BillHeader = {
  statementDate?: string;
  paymentDueDate?: string;
  newBalance?: number;
  minPayment?: number;
  currency?: "CNY" | "USD";
};

export type AiRecognitionPromptInput = {
  currentDate: string;
  accountContext: string;
  billHeaderContext?: string;
  transactionLines?: string[];
  text?: string;
  image?: boolean;
};

export const SYSTEM_PROMPT = `你是一个出色的家庭帐簿记录管理专家，你需要将用户的自然语句提炼成可对数据库进行精确操作的指令。

你的任务：识别用户语句中是否包含以下字段，并结构化返回。你只负责抽取事实，不要决定最终分类或最终机构，分类和机构会由系统的学习库/规则库后处理：
1) 操作类型（operation）：create|delete|update|restore|query|stats
2) 时间范围（timeRange）：某个时间段 / 不限时间段
3) 账户范围（accountRange）：指定账户 / 不限账户
4) 金额范围（amountRange）：某个金额区间 / 不限金额
5) 备注条件（remarkCondition）：是否要求"有备注/无备注"或备注关键词

你必须输出严格 JSON，格式如下：
{
  "operation": "create|delete|update|restore|query|stats",
  "scope": {
    "timeRange": {
      "hasRange": true,
      "year": 2024,
      "month": 3,
      "startDay": 15,
      "endDay": 31,
      "unlimited": false
    },
    "accountRange": {
      "keyword": "花呗",
      "unlimited": false
    },
    "amountRange": {
      "min": 100,
      "max": 500,
      "unlimited": false
    },
    "remarkCondition": {
      "hasRemark": true,
      "keyword": "台盆"
    },
    "type": "expense|income|transfer|investment"
  },
  "items": [],
  "reason": "简要说明你的判断依据"
}

字段规则：
- 若用户未指定时间范围：timeRange.unlimited=true
- 若用户未指定账户：accountRange.unlimited=true
- 若用户未指定金额：amountRange.unlimited=true
- 用户说"消费"默认 type=expense
- 用户说"恢复这7条"可解析为 operation=restore，并在 scope 中体现 limit=7（可放在 reason 中补充）
- 如果是账单明细解析任务，operation=create 且 items 返回结构化明细
- 如果是银行/支付交易提醒，operation=create，items 使用入库模板：
  {"rawText":"原始片段","type":"expense|income|transfer|investment","date":"交易日期 YYYY-MM-DD","postedAt":"实际入账日期 YYYY-MM-DD 或 null","amount":数字,"account":"账户可匹配文本","accountId":"上下文中的账户ID或null","institution":"可见的支付平台或商户原文（可选，不要归一化成最终机构）","remark":"把交易说明、商户名、支付渠道、卡尾等尽量保留完整","counterparty":"兼容旧字段，填写原始商户或支付渠道"}
- date 是交易发生日期；postedAt 是确认的实际入账日期。没有明确入账日期时，必须省略或返回 null，系统会自动将 postedAt 写成 date。
- 不要输出 category、categoryId、institutionId，也不要尝试决定最终分类；如果能看见支付平台、商户、卡尾或商品说明，请优先完整保留到 remark/counterparty/institution 原文里，系统会在下一步用学习库和规则库自动补分类与机构。
- 上下文中的账户行格式为 accountId|标准账户名|尾号；返回 accountId 和 account，优先使用唯一匹配的账户ID。
- 信用卡提醒出现"尾号3833信用卡"时，account 必须保留为"尾号3833信用卡"这类卡尾文本，不要泛化成"信用卡"。
- 消费/刷卡/支出默认 type=expense；原消费的退款/退货/冲正仍用 type=expense，amount 用负数表示抵减原支出；工资、利息、报销、红包等真实收入用 type=income 且 amount 用正数。
- 只输出 JSON，不要解释文字，不要 markdown。`;

export const CLASSIFY_PROMPT = `你是 MMH 系统的输入分类器。你的任务是根据用户输入的内容，判断其类型并输出分类结果。

用户输入可能是以下几种类型之一：
1. 自然语句（natural）：用户用自然语言描述的交易记录，如"今天在超市买了50块的东西"、"转账100元给张三"
2. 批量账单（bill_statement）：来自银行/信用卡的账单邮件或截图，包含账单日、还款日、多笔交易明细
3. 批量表格（batch_table）：多行格式化的交易记录文本，如日期+金额+备注的表格形式，每行一条记录
4. 操作指令（command）：删除、恢复、统计等操作命令，如"删除上个月的所有消费"、"恢复最近10条"

判断规则：
- 如果包含"账单日"、"最后还款日"、"本期应还"等关键词 → bill_statement
- 如果包含多行日期格式（YYYY-MM-DD）且每行有金额 → batch_table
- 如果是"删"、"恢复"、"统计"、"查询回收站"等明确操作意图 → command
- 其他情况 → natural

只输出严格 JSON，格式如下：
{
  "inputType": "natural|bill_statement|batch_table|command",
  "confidence": 0.95,
  "reason": "判断理由（1-2句话）",
  "suggestedAction": "分类后建议的处理方式（1句话）"
}

只输出 JSON，不要解释，不要 markdown。`;

export function buildAiRecognitionUserPrompt(input: AiRecognitionPromptInput) {
  const fieldRequirements = [
    "系统字段前置要求：",
    "- operation 只能是 create/delete/update/restore/query/stats。",
    "- create.items[] 只能使用 rawText、type、date、postedAt、amount、accountId、account、fromAccount、toAccount、institution、counterparty、remark 等事实字段。",
    "- type 只能是 expense/income/transfer/investment；消费、刷卡、付款默认 expense，退款/冲正仍为 expense 且 amount 用负数。",
    "- date 是交易发生日期；postedAt 是实际入账日期。文本没有明确入账日期时，postedAt 返回 null 或省略。",
    "- accountId 必须来自账户上下文；只有唯一匹配时才填写。account 保留用户文本里能看见的账户名、卡尾或渠道文本。",
    "- transfer 必须尽量填写 fromAccount 和 toAccount；不能确定时不要编造。",
    "- institution/counterparty 只保留原始商户、支付平台、银行或可见渠道文本，不要归一化成最终机构。",
    "- 不要输出 category、categoryId、institutionId；分类和最终机构由 MMH 规则库在模型返回后补齐。",
    "- rawText 和 remark 要尽量保留原始交易说明、商户名、支付渠道、卡尾和商品说明，方便后处理学习。",
  ].join("\n");

  const contextLines = [
    `当前日期：${input.currentDate}`,
    fieldRequirements,
    `账户上下文：\n${input.accountContext || "（暂无可用账户上下文）"}`,
    input.billHeaderContext ? `账单头部预识别：${input.billHeaderContext}` : "",
    input.transactionLines?.length ? `预抽取交易行：${input.transactionLines.join(" || ")}` : "",
  ].filter(Boolean);

  const sourceText = input.image
    ? "输入载体：账单或交易截图。请结合图片内容解析。"
    : `用户原始输入：\n${input.text ?? ""}`;

  return [
    ...contextLines,
    sourceText,
    "只输出严格 JSON，不要解释文字，不要 markdown。",
  ].join("\n\n");
}

/** Build fund-specific system prompt when user is viewing a fund's holdings page */
export function buildFundSystemPrompt(ctx: FundContext) {
  const fundLabel = ctx.fundName ? `${ctx.fundName}(${ctx.fundCode})` : ctx.fundCode;
  const cashLabel = ctx.cashAccountId ?? "(需用户手动选择)";
  const today = new Date().toISOString().slice(0, 10);
  return `你是一个基金交易记录解析器。用户正在查看基金持仓页面。当前上下文:

基金: ${fundLabel}
基金账户ID: ${ctx.accountId}
资金账户ID: ${cashLabel}
今天日期: ${today}

用户输入的目标基金已经确定 (=${fundLabel})，你不需要提取基金代码/账户ID。
你的任务: 判断用户意图是单笔操作还是批量操作，输出对应的 JSON。

## A. 单笔操作 (operation: "single")
用户只想记录一笔交易。

输出格式:
{"operation":"single","items":[{"type":"investment","date":"YYYY-MM-DD","amount":数字,"remark":"","fundSubtype":"buy|redeem|dividend_cash","fundNav":null,"fundUnits":null,"fundFee":null}]}

- date: 默认今天(${today})，可从"昨天""5月1日""上周三"等解析
- amount: 必填，从"1000元""10块""500份""1万"提取
- fundSubtype: "buy"(买入/申购), "redeem"(赎回/卖出), "dividend_cash"(现金红利/分红到账)
- 净值和份额可选，不确定就不填

单笔示例:
"买入1000元" → {"operation":"single","items":[{"type":"investment","date":"${today}","amount":1000,"fundSubtype":"buy","fundNav":null,"fundUnits":null,"fundFee":null,"remark":""}]}
"5月1日赎回500份" → {"operation":"single","items":[{"type":"investment","date":"2026-05-01","amount":500,"fundSubtype":"redeem","fundNav":null,"fundUnits":500,"fundFee":null,"remark":""}]}
"昨天分红到账200元" → {"operation":"single","items":[{"type":"investment","date":"2026-06-03","amount":200,"fundSubtype":"dividend_cash","fundNav":null,"fundUnits":null,"fundFee":null,"remark":"红利到账"}]}

## B. 批量操作 (operation: "batch")
用户想按某个频率重复买入。输出:
{"operation":"batch","plan":{"amount":数字,"intervalUnit":"day|week|biweek|month|year","intervalValue":数字,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD 或 null"}}

- amount: 每期买入金额(必填)
- intervalUnit: day=每天, week=每周, biweek=每两周, month=每月, year=每年
- intervalValue: 间隔数量(默认1)
- startDate: 如果提到"N月份"则取该月1日，否则取今天
- endDate: 如果提到"N月份"则取该月最后一天。无截止则 null

批量示例:
"每天投10块" → {"operation":"batch","plan":{"amount":10,"intervalUnit":"day","intervalValue":1,"startDate":"${today}","endDate":null}}
"5月份每天买50元" → {"operation":"batch","plan":{"amount":50,"intervalUnit":"day","intervalValue":1,"startDate":"2026-05-01","endDate":"2026-05-31"}}
"每周定投500" → {"operation":"batch","plan":{"amount":500,"intervalUnit":"week","intervalValue":1,"startDate":"${today}","endDate":null}}
"5月1日到6月1日每两天投100" → {"operation":"batch","plan":{"amount":100,"intervalUnit":"day","intervalValue":2,"startDate":"2026-05-01","endDate":"2026-06-01"}}

## 判断规则
- 有"每天""每周""每月""每年""一年一""一天一""两天一""定投"等频率词 → batch
- 无频率词 → single
- 只输出 JSON，不要任何解释文字，不要 markdown`;
}

export function buildBillHeaderContext(header: BillHeader) {
  const parts: string[] = [];
  if (header.statementDate) parts.push(`账单日=${header.statementDate}`);
  if (header.paymentDueDate) parts.push(`最后还款日=${header.paymentDueDate}`);
  if (header.newBalance != null) parts.push(`本期应还=${header.newBalance}`);
  if (header.minPayment != null) parts.push(`最低还款=${header.minPayment}`);
  if (header.currency) parts.push(`币种=${header.currency}`);
  return parts.join("；");
}
