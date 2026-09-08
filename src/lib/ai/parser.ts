// AI response parsing: extract items from LLM output, text detection, and fund trade parsing

export interface ParsedItem {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  /** Confirmed actual posting date; defaults to date during import when absent. */
  postedAt?: string;
  amount: number;
  accountId?: string;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  categoryId?: string;
  category?: string;
  institutionId?: string;
  institution?: string;
  remark?: string;
  counterparty?: string;
}

function isExpenseRefundLike(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (/信用卡还款|还款入账|repayment|payment/i.test(normalized)) return false;
  return /退款|退货|退回|消费撤销|交易撤销|冲正|refund|return|reversal/i.test(normalized);
}

// ── Date utilities (used by normalizeDate / parseItems) ──

export function formatYmd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeekMonday(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

function addDaysLocal(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function hasRelativeDateToken(text: string) {
  const t = text.trim();
  if (!t) return false;
  return /(今天|昨天|前天|上周|本周|这周|上星期|本星期|这星期|周[一二三四五六日天1-7]|星期\s*[一二三四五六日天1-7])/.test(t);
}

function normalizeMonthDayDate(month: number, day: number, now: Date) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = now.getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseRelativeDateFromText(text: string, now: Date) {
  const t = text.trim();
  if (!t) return null;

  if (/(^|[^一-龥])(今天)([^一-龥]|$)/.test(t)) return formatYmd(now);
  if (/(昨天|昨日)/.test(t)) return formatYmd(addDaysLocal(now, -1));
  if (/前天/.test(t)) return formatYmd(addDaysLocal(now, -2));

  const w = t.match(/(上周|本周|这周|上星期|本星期|这星期)?\s*(周|星期)\s*([一二三四五六日天1-7])/);
  if (w) {
    const prefix = w[1] ?? "";
    const weekdayChar = w[3];
    const weekdayIndex =
      weekdayChar === "一" ? 0
      : weekdayChar === "二" ? 1
      : weekdayChar === "三" ? 2
      : weekdayChar === "四" ? 3
      : weekdayChar === "五" ? 4
      : weekdayChar === "六" ? 5
      : weekdayChar === "7" ? 6
      : weekdayChar === "1" ? 0
      : weekdayChar === "2" ? 1
      : weekdayChar === "3" ? 2
      : weekdayChar === "4" ? 3
      : weekdayChar === "5" ? 4
      : weekdayChar === "6" ? 5
      : 6;

    const base = startOfWeekMonday(now);
    if (prefix.startsWith("上")) return formatYmd(addDaysLocal(base, -7 + weekdayIndex));
    if (prefix.startsWith("本") || prefix.startsWith("这")) return formatYmd(addDaysLocal(base, weekdayIndex));

    const candidate = addDaysLocal(base, weekdayIndex);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    if (candidate.getTime() > todayStart.getTime()) return formatYmd(addDaysLocal(candidate, -7));
    return formatYmd(candidate);
  }

  return null;
}

export function parseTransactionSuccessReminder(text: string, now: Date): { items: ParsedItem[]; directImport: boolean } | null {
  const raw = String(text ?? "").replace(/\r/g, "\n");
  if (!/交易成功提醒|交易时间|交易金额|交易商户/.test(raw)) return null;

  const reminderPattern = /交易(?:成功)?提醒/g;
  const blockStarts: number[] = [];
  for (let match = reminderPattern.exec(raw); match; match = reminderPattern.exec(raw)) {
    blockStarts.push(match.index);
    if (match.index === reminderPattern.lastIndex) reminderPattern.lastIndex += 1;
  }
  const reminderBlocks = blockStarts.length > 1
    ? blockStarts.map((start, index) => raw.slice(start, blockStarts[index + 1] ?? raw.length).trim()).filter(Boolean)
    : [raw.trim()].filter(Boolean);

  const items: ParsedItem[] = [];
  for (const block of reminderBlocks) {
    const item = (() => {
      const timeLine = block.match(/交易时间\s*[:：]\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const tail = timeLine.match(/尾号\s*([0-9]{4})(?=.*信用卡)|信用卡.*?尾号\s*([0-9]{4})/)?.slice(1).find(Boolean) ?? "";
      const md = timeLine.match(/(\d{1,2})月(\d{1,2})日/);
      const amountText = block.match(/交易金额\s*[:：]\s*([+-]?\d+(?:,\d{3})*(?:\.\d{1,2})?)/)?.[1] ?? "";
      const amount = Number(amountText.replace(/,/g, ""));
      const merchant = block.match(/(?:交易商户|交易说明|商户名称|商户)\s*[:：]\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const typeText = block.match(/交易类型\s*[:：]\s*([^\n]+)/)?.[1]?.trim() ?? "";
      if (!md || !Number.isFinite(amount) || amount === 0) return null;

      const combinedText = `${typeText} ${merchant}`;
      const isExpenseRefund = isExpenseRefundLike(combinedText);
      const isIncome = !isExpenseRefund && /返还|收入|入账/.test(typeText) && !/消费/.test(typeText);
      const account = tail ? `尾号${tail}信用卡` : undefined;
      const institution = (
        merchant.match(/^(支付宝|微信(?:支付)?|财付通|云闪付|银联)\s*(?:--?|：|:)/i)?.[1]
        ?? merchant
      ) || undefined;
      const date = normalizeMonthDayDate(Number(md[1]), Number(md[2]), now);
      if (!date) return null;

      return {
        rawText: block.slice(0, 200),
        type: isIncome ? "income" : "expense",
        date,
        amount: isExpenseRefund ? -Math.abs(amount) : Math.abs(amount),
        account,
        institution,
        remark: merchant || typeText || undefined,
        counterparty: institution,
      } satisfies ParsedItem;
    })();
    if (item) items.push(item);
  }

  if (!items.length) return null;
  return { items, directImport: true };
}

export function normalizeDate(dateInput: unknown, rawText: string, now: Date) {
  const rel = parseRelativeDateFromText(rawText, now);
  if (rel && hasRelativeDateToken(rawText)) return rel;
  const dateStr = typeof dateInput === "string" ? dateInput.trim() : "";
  if (dateStr) {
    const d = new Date(dateStr.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, ""));
    if (!Number.isNaN(d.getTime())) return formatYmd(d);
  }
  return rel ?? formatYmd(now);
}

// ── LLM response extraction ──

export function extractItemsFromText(text: string): ParsedItem[] | null {
  const patterns = [
    /```json\s*([\s\S]*?)\s*```/i,
    /```\s*([\s\S]*?)\s*```/,
    /\{[\s\S]*"items"[\s\S]*\}/,
    /\[[\s\S]*\{[\s\S]*rawText[\s\S]*\]/,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const str = m[1] ?? m[0];
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return parsed;
        if (parsed?.items && Array.isArray(parsed.items)) return parsed.items;
      } catch {
        continue;
      }
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed?.items && Array.isArray(parsed.items)) return parsed.items;
  } catch {
    return null;
  }

  return null;
}

export function parseAmountLoose(value: unknown, fallbackText: string) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value);
  if (typeof value === "string") {
    const m = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (m) return Math.abs(Number(m[0]));
  }
  const matches = fallbackText.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (matches.length) return Math.abs(Number(matches[matches.length - 1]));
  return 0;
}

export function isReadyForImport(item: ParsedItem) {
  if (!(Math.abs(item.amount) > 0)) return false;
  if (item.type === "transfer") return !!(item.fromAccount?.trim() && item.toAccount?.trim());
  return true;
}

export function isBillStatement(text: string) {
  const t = text ?? "";
  if (/(基金交易记录|基金定期定额|申购|赎回|交易日期.*交易时间)/i.test(t)) return false;
  return /(账单日|最后还款日|本期应还|最低还款|信用额度|Statement\s*Date|Payment\s*Due\s*Date|New\s*Balance|Min\.Payment)/i.test(t);
}

export function extractBankKeywordFromBill(text: string) {
  if (/民生/.test(text)) return "民生银行";
  if (/平安/.test(text)) return "平安银行";
  if (/招商|招行/.test(text)) return "招商银行";
  if (/交通|交行/.test(text)) return "交通银行";
  if (/中信/.test(text)) return "中信银行";
  if (/光大/.test(text)) return "光大银行";
  if (/华夏/.test(text)) return "华夏银行";
  if (/浦发/.test(text)) return "浦发银行";
  if (/兴业/.test(text)) return "兴业银行";
  if (/广发/.test(text)) return "广发银行";
  if (/邮储/.test(text)) return "邮储银行";
  if (/工商|工行/.test(text)) return "工商银行";
  if (/农业|农行/.test(text)) return "农业银行";
  if (/建设|建行/.test(text)) return "建设银行";
  if (/中国银行|中行/.test(text)) return "中国银行";
  return "";
}

export function looksLikeBatchLedgerText(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (/交易日期.*交易时间.*支出.*余额.*交易类型/i.test(t)) return false;
  const matches = t.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (matches.length < 3) return false;
  return true;
}

export function isCMBFundRecord(text: string) {
  const t = text ?? "";
  if (!/交易日期.*交易时间.*支出.*余额.*交易类型/i.test(t)) return false;
  if (/账单日|最后还款日|本期应还|信用额度/i.test(t)) return false;
  return true;
}

export function looksLikeFundTrade(text: string) {
  const t = text.trim();
  if (!t || t.length > 200) return false;
  return /(买入|卖出|赎回|申购|红利转投|红利再投|现金红利|转出|转入)/.test(t) &&
    /\d{6}/.test(t);
}

export function parseCMBFundRecord(text: string, now: Date): { items: ParsedItem[]; directImport: boolean } {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const rows: ParsedItem[] = [];
  for (const line of lines) {
    const parts = line.split(/\|/).map(p => p.trim().replace(/"/g, ""));
    if (parts.length < 6) continue;
    const dateStr = parts[0].replace(/\D/g, "");
    if (!/^\d{8}$/.test(dateStr)) continue;
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const expense = parseFloat(parts[3]) || 0;
    if (expense <= 0) continue;
    const fundCode = (parts[parts.length - 1] || "").replace(/\D/g, "").slice(-6);
    const remark = parts[parts.length - 1]?.trim() || "";
    const isRedeem = /赎回/.test(remark);
    const rawText = `${isRedeem ? "赎回" : "买入"} ${fundCode} ${expense}元`;
    rows.push({
      rawText: rawText.slice(0, 200),
      type: "investment",
      date,
      amount: expense,
      remark: remark && /\d{6}/.test(remark) ? remark : `${fundCode} ${isRedeem ? "赎回" : "申购"}`,
      account: "招商银行",
      counterparty: /\d{6}/.test(fundCode) ? `基金${fundCode}` : undefined,
      ...(fundCode ? { category: `基金·${fundCode}` } : {}),
    });
  }
  return { items: rows, directImport: rows.length > 0 };
}

export function parseItems(raw: string, now: Date, userTextForContext: string): { items: ParsedItem[]; directImport: boolean } {
  const items = extractItemsFromText(raw);
  if (!items || items.length === 0) {
    const ctx = (userTextForContext || raw).trim();
    const fallback: ParsedItem = {
      rawText: ctx.slice(0, 200),
      type: "expense",
      amount: parseAmountLoose(undefined, ctx),
      date: normalizeDate(undefined, ctx, now),
    };
    return { items: [fallback], directImport: isReadyForImport(fallback) };
  }
  const parsedItems = items.map((item) => {
    const rawText = (item.rawText ?? "").trim() || userTextForContext.slice(0, 200) || raw.slice(0, 200);
    const ctxText = `${userTextForContext}\n${rawText}`.trim();
    const typeFromModel = (item.type as ParsedItem["type"]) || "expense";
    const date = normalizeDate(item.date, ctxText, now);
    const itemDirectionText = `${rawText} ${item.remark ?? ""} ${item.category ?? ""} ${item.counterparty ?? ""}`;
    const isExpenseRefund = isExpenseRefundLike(itemDirectionText);
    const type = isExpenseRefund && typeFromModel !== "transfer" && typeFromModel !== "investment"
      ? "expense"
      : typeFromModel;
    const amount = isExpenseRefund && type === "expense"
      ? -parseAmountLoose(item.amount, ctxText)
      : parseAmountLoose(item.amount, ctxText);
    return {
      rawText,
      type,
      date,
      postedAt: typeof item.postedAt === "string" && item.postedAt.trim() ? item.postedAt.trim() : undefined,
      amount,
      accountId: typeof item.accountId === "string" && item.accountId.trim() ? item.accountId.trim() : undefined,
      account: item.account?.trim() ? item.account : undefined,
      fromAccount: item.fromAccount,
      toAccount: item.toAccount,
      categoryId: typeof item.categoryId === "string" && item.categoryId.trim() ? item.categoryId.trim() : undefined,
      category: item.category,
      institutionId: typeof item.institutionId === "string" && item.institutionId.trim() ? item.institutionId.trim() : undefined,
      institution: item.institution,
      remark: item.remark,
      counterparty: item.counterparty,
    };
  });
  const allValid = parsedItems.every(isReadyForImport);
  return { items: parsedItems, directImport: allValid };
}

/** Parse a fund trade expressed in natural language, returning items ready for import */
export function parseFundTradeFromText(
  text: string,
  now: Date,
  fundContext?: { fundCode: string; fundName?: string; accountId: string; cashAccountId?: string } | null,
): { items: ParsedItem[]; directImport: boolean } | null {
  if (!fundContext) {
    // Without fund context: extract fund code from text for basic fund trades
    const fundCodeFromText = text.match(/\b(\d{6})\b/)?.[1];
    if (fundCodeFromText && /\b(买入|卖出|赎回|申购)\b/.test(text)) {
      const isRedeem = /赎回|卖出/.test(text);
      const amtMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块|万)/);
      const amount = amtMatch ? parseFloat(amtMatch[1]) : 0;
      const date = normalizeDate(undefined, text, now);
      return {
        items: [{
          rawText: text.slice(0, 200),
          type: "investment",
          date,
          amount: amount || 0,
          remark: `${isRedeem ? "赎回" : "申购"} ${fundCodeFromText}`,
          category: `基金·${fundCodeFromText}`,
          counterparty: `基金${fundCodeFromText}`,
        }],
        directImport: amount > 0,
      };
    }
    return null;
  }

  const isRedeem = /赎回|卖出/.test(text);
  const isDividendReinvest = /红利转投|红利再投/.test(text);
  const isDividendCash = /现金红利/.test(text);
  const subtype = isRedeem ? "redeem" : isDividendReinvest ? "dividend_reinvest" : isDividendCash ? "dividend_cash" : "buy";

  const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块|万)/);
  const sharesMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:份)/);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : sharesMatch ? parseFloat(sharesMatch[1]) : 0;

  const date = normalizeDate(undefined, text, now);
  const typeLabel = subtype === "redeem" ? "赎回" : subtype === "dividend_cash" ? "现金红利" : subtype === "dividend_reinvest" ? "红利转投" : "申购";

  return {
    items: [{
      rawText: text.slice(0, 200),
      type: "investment",
      date,
      amount: amount || 0,
      remark: `${typeLabel} ${fundContext.fundCode}`,
      category: `基金·${fundContext.fundCode}`,
      counterparty: `基金${fundContext.fundCode}`,
    }],
    directImport: amount > 0,
  };
}
