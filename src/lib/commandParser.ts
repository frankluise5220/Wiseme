import { joinBaseUrl } from "@/lib/http";
import type { AiApiMode } from "@/lib/ai/config";
import { buildResponsesRequestBody, extractResponsesText } from "@/lib/ai/responses";

export const CMD_ANALYZER_PROMPT = `你是一个专业的家庭理财记账专家。分析用户的自然语言，转化成对应的操作指令。

请从用户输入中提取下列信息，以JSON返回：

1. 操作类型（action）：增加、编辑、删除、统计、未知
2. 如果是编辑/删除，提取限制范围：
   - 开始时间（startDate）、结束时间（endDate）
   - 交易类型（transType）：买入、赎回、现金红利、红利再投、支出、收入、转账
   - 账户名称（accountName）
   - 金额条件（amountCond）
3. 如果是编辑，提取：
   - 要修改的项目（editField）：资金账户、基金账户、金额、日期、备注
   - 修改方式（editOp）：替换、乘、加
   - 目标值（editValue）

示例：
"把5月份的买入金额都改成2000"
→ {"action":"编辑","startDate":"2026-05-01","endDate":"2026-05-31","transType":"买入","editField":"金额","editOp":"替换","editValue":"2000"}

"资金账户改成招商银行借记卡"
→ {"action":"编辑","editField":"资金账户","editOp":"替换","editValue":"招商银行借记卡"}

"统计上个月买入总金额"
→ {"action":"统计","startDate":"2026-05-01","endDate":"2026-05-31","transType":"买入"}

"把2024年买入都删了"
→ {"action":"删除","startDate":"2024-01-01","endDate":"2024-12-31"}`;

export const FIELD_MAP_CN: Record<string, string> = {
  "金额": "amount", "资金": "amount",
  "资金账户": "cashAccount", "扣款卡": "cashAccount",
  "消费账户": "account", "主账户": "account",
  "日期": "date", "时间": "date",
  "备注": "note", "说明": "note",
};
export const OP_MAP_CN: Record<string, string> = {
  "替换": "replace", "改为": "replace", "改成": "replace", "换成": "replace",
  "乘": "multiply", "乘以": "multiply", "加倍": "multiply", "翻倍": "multiply",
  "加": "add", "增加": "add",
};
export function cnField(f: string | undefined) { return f ? (FIELD_MAP_CN[f] ?? "amount") : "amount"; }
export function cnOp(o: string | undefined) { return o ? (OP_MAP_CN[o] ?? "replace") : "replace"; }

export type AnalyzedCommand = {
  action?: string;
  startDate?: string; endDate?: string;
  transType?: string; accountName?: string; amountCond?: string;
  editField?: string; editOp?: string; editValue?: string;
  // Legacy flat format support
  field?: string; operation?: string; value?: string;
  time?: string | null;
};

export function buildAnalyzerPrompt(opts: {
  text: string;
  fundContext?: { fundCode: string; fundName?: string; accountId: string } | null;
  today: string; rolePrompt?: string;
}) {
  const parts = buildAnalyzerPromptParts(opts);
  return `${parts.systemPrompt}\n\n${parts.userMessage}`;
}

export function buildAnalyzerPromptParts(opts: {
  text: string;
  fundContext?: { fundCode: string; fundName?: string; accountId: string } | null;
  today: string; rolePrompt?: string;
}) {
  const ctx: string[] = [];
  ctx.push(`当前日期：${opts.today}`);
  if (opts.fundContext) {
    ctx.push(`当前页面基金：${opts.fundContext.fundCode}${opts.fundContext.fundName ? ` ${opts.fundContext.fundName}` : ""}`);
  }
  const systemPrompt = opts.rolePrompt?.trim() || CMD_ANALYZER_PROMPT;
  return {
    systemPrompt,
    userMessage: `${ctx.join("；")}\n\n用户输入：${opts.text}`,
  };
}

export async function callAiForCommand(opts: {
  text: string;
  fundContext?: { fundCode: string; fundName?: string; accountId: string } | null;
  today: string;
  modelName: string; baseUrl: string; apiKey: string; isOllama: boolean;
  apiMode?: AiApiMode;
  rolePrompt?: string;
}): Promise<AnalyzedCommand | null> {
  const { systemPrompt, userMessage } = buildAnalyzerPromptParts(opts);
  const { isOllama, modelName, baseUrl: base, apiKey } = opts;
  const apiMode = opts.apiMode ?? "chat";
  const cleanUrl = base.replace(/\/$/, "");

  try {
    const body = isOllama
      ? {
          model: modelName,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }
      : apiMode === "responses"
        ? buildResponsesRequestBody({
            modelName,
            instructions: systemPrompt,
            userMessage,
            temperature: 0,
            maxOutputTokens: 500,
          })
        : {
            model: modelName,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            max_tokens: 500,
            temperature: 0,
          };
    const url = isOllama
      ? joinBaseUrl(cleanUrl, "/api/chat")
      : joinBaseUrl(cleanUrl, apiMode === "responses" ? "/v1/responses" : "/v1/chat/completions");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!isOllama && apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as any;
    const raw = (
      isOllama
        ? data?.message?.content ?? data?.response ?? ""
        : apiMode === "responses"
          ? extractResponsesText(data)
          : data?.choices?.[0]?.message?.content ?? ""
    ).trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as any;
    if (parsed.field) return parsed as AnalyzedCommand;
    if (parsed.action) return parsed as AnalyzedCommand;
    return null;
  } catch {
    return null;
  }
}

export function normalizeOperationText(text: string) {
  let t = text.trim();
  t = t.replace(/[，,。；;\s]*(?:请)?确认(?:执行|修改|更新)?\s*$/g, "");
  t = t.replace(/[，,。；;\s]*(?:继续|立即)?执行\s*$/g, "");
  t = t.replace(/删掉|去掉|不要了|移除/g, "删除");
  t = t.replace(/还原/g, "恢复");
  t = t.replace(/看看|查下|看一下/g, "查询");
  t = t.replace(/算一下|统计一下|统计下|汇总/g, "统计");
  return t;
}

export type ParsedDateRange = { year: number; startMonth?: number; startDay?: number; endMonth?: number; endDay?: number; before?: boolean };

export type ParsedUpdateCommand = {
  remarkKeyword: string;
  newAccountName: string;
  newType?: string;
  timeRange?: ParsedDateRange;
  updateTarget?: "cashAccount" | "toAccount" | "account";
  fundSubtype?: string;
  oldAccountName?: string;
  replaceAccountEverywhere?: boolean;
};

export function parseDateRange(text: string): ParsedDateRange | null {
  const fullRange = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[号日](?:开始)?\s*(?:到|至|-|~)\s*(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]?/);
  if (fullRange) {
    return { year: Number(fullRange[1]), startMonth: Number(fullRange[2]), startDay: Number(fullRange[3]), endMonth: Number(fullRange[4]), endDay: Number(fullRange[5]) };
  }
  const twoYearRange = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[号日](?:开始)?\s*(?:到|至|-|~)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]?/);
  if (twoYearRange && Number(twoYearRange[4]) === Number(twoYearRange[1])) {
    return { year: Number(twoYearRange[1]), startMonth: Number(twoYearRange[2]), startDay: Number(twoYearRange[3]), endMonth: Number(twoYearRange[5]), endDay: Number(twoYearRange[6]) };
  }
  const beforeMonth = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?:份)?\s*(?:前|以前|之前)/);
  if (beforeMonth) {
    return { year: Number(beforeMonth[1]), startMonth: Number(beforeMonth[2]), before: true };
  }
  const withYear = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?:(\d{1,2})\s*[号日])?/);
  if (withYear) {
    return { year: Number(withYear[1]), startMonth: Number(withYear[2]), startDay: withYear[3] ? Number(withYear[3]) : undefined };
  }
  const yy = new Date().getFullYear();
  const monthOnly = text.match(/^(\d{1,2})\s*月(?:份)?$/);
  if (monthOnly) {
    const m = Number(monthOnly[1]);
    if (m >= 1 && m <= 12) return { year: yy, startMonth: m };
  }
  const relMonth = text.match(/(上+)个?\s*月/);
  if (relMonth) {
    const back = relMonth[1].length;
    const now = new Date();
    let m = now.getMonth() + 1 - back;
    let y = now.getFullYear();
    while (m <= 0) { m += 12; y--; }
    return { year: y, startMonth: m };
  }
  if (/这个月|本月/.test(text)) {
    const now = new Date();
    return { year: now.getFullYear(), startMonth: now.getMonth() + 1 };
  }
  const yearOnly = text.match(/^(?:(\d{4})\s*年|今年)$/);
  if (yearOnly) return { year: yearOnly[1] ? Number(yearOnly[1]) : yy };
  return null;
}

export async function parseUpdateCommand(text: string): Promise<ParsedUpdateCommand | null> {
  const t = normalizeOperationText(text);
  if (!t) return null;

  const sqlStyleMatch = t.match(/^replace\s+(.+?)\s+with\s+(.+?)\s+for\s+(.+?)$/i);
  if (sqlStyleMatch) {
    return { remarkKeyword: sqlStyleMatch[3].trim(), newAccountName: sqlStyleMatch[2].trim() };
  }
  const naturalMatch = t.match(/把所有备注包含(.+?)的记录.*改成(.+?)(?:$|，|。|的话)/);
  if (naturalMatch) {
    return { remarkKeyword: naturalMatch[1].trim(), newAccountName: naturalMatch[2].trim() };
  }
  const simpleMatch = t.match(/备注包含(.+?).*改成(.+?)(?:$|，|。)/);
  if (simpleMatch) {
    return { remarkKeyword: simpleMatch[1].trim(), newAccountName: simpleMatch[2].trim() };
  }

  const accountReplaceMatch = t.match(/(?:把|将)(.+?)(?:的)?记录的?(.+?)(?:都|全|全部)?(?:改|换|替换|设置?|变)(?:成|为|到)(.+?)(?:吧|，|。|$)/);
  if (accountReplaceMatch) {
    const rangeText = accountReplaceMatch[1].trim();
    const oldAccountName = accountReplaceMatch[2].trim();
    const newAccountName = accountReplaceMatch[3].trim();
    const dateRange = parseDateRange(rangeText);
    if (dateRange && oldAccountName && newAccountName && /(?:卡|账户|银行|\d{3,})/.test(oldAccountName)) {
      return {
        remarkKeyword: "",
        newAccountName,
        timeRange: dateRange,
        oldAccountName,
        replaceAccountEverywhere: true,
      };
    }
  }

  const { listAliases } = await import("@/lib/commandAlias");
  const subtypeAliases = (await listAliases("fundSubtype")).filter(a => a.key);
  const targetAliases = (await listAliases("updateTarget")).filter(a => a.key);
  const subtypeKeys = subtypeAliases.map(a => a.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const targetKeys = targetAliases.map(a => a.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const updateWithRange = t.match(
    new RegExp(`(?:把|将)?(.+?)的\\s*(${subtypeKeys})?\\s*记录的?\\s*(${targetKeys})\\s*(?:都|全|全部|也)?\\s*(?:改|换|设置?|变)\\s*(?:成|为|到)\\s*(.+?)(?:吧|，|。|$)`),
  );
  if (updateWithRange) {
    const rangeText = updateWithRange[1].trim();
    const subtypeRaw = updateWithRange[2]?.trim();
    const targetField = updateWithRange[3].trim();
    const newValue = updateWithRange[4].trim();
    const dateRange = parseDateRange(rangeText);
    const fundSubtype = subtypeRaw ? (subtypeAliases.find(a => a.key === subtypeRaw)?.value ?? subtypeRaw) : undefined;
    const targetCanonical = targetAliases.find(a => a.key === targetField)?.value ?? "account";
    return {
      remarkKeyword: "",
      newAccountName: newValue,
      timeRange: dateRange || undefined,
      updateTarget: targetCanonical as "cashAccount" | "toAccount" | "account",
      fundSubtype,
    };
  }

  const explicitMatch = t.match(/(?:把|把.+的)?记录.*账户.*改成(.+?)(?:吧|，|$)/);
  const expenseMatch = t.match(/支出改(投资|收入|转账)/);
  if (explicitMatch || expenseMatch) {
    return {
      remarkKeyword: "",
      newAccountName: explicitMatch ? explicitMatch[1].trim() : "",
      newType: expenseMatch ? expenseMatch[1].trim() : undefined,
    };
  }
  return null;
}
