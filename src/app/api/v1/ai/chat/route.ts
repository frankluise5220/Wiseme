import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { Prisma, TransactionType } from "@prisma/client";
import { corsHeaders, joinBaseUrl } from "@/lib/http";
import { getHouseholdScope, type HouseholdContext } from "@/lib/server/household-scope";
import { callAiForCommand, parseUpdateCommand, normalizeOperationText, type AnalyzedCommand, type ParsedDateRange, type ParsedUpdateCommand } from "@/lib/commandParser";
import { SYSTEM_PROMPT, buildFundSystemPrompt, buildBillHeaderContext } from "@/lib/ai/prompts";
import type { BillHeader } from "@/lib/ai/prompts";
import { modelSupportsVision, buildAccountContextText, classifyInput } from "@/lib/ai/client";
import { normalizeAiApiMode } from "@/lib/ai/config";
import { buildResponsesRequestBody, extractResponsesText, type ChatContentPart } from "@/lib/ai/responses";
import { isSpendableAccount } from "@/lib/account-kind-utils";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE } from "@/lib/balance-reconcile";
import {
  type ParsedItem,
  formatYmd,
  isReadyForImport,
  parseItems,
  isBillStatement,
  extractBankKeywordFromBill,
  looksLikeBatchLedgerText,
  isCMBFundRecord,
  looksLikeFundTrade,
  parseCMBFundRecord,
  parseFundTradeFromText,
  parseTransactionSuccessReminder,
} from "@/lib/ai/parser";
import { enrichAiParsedItems } from "@/lib/statement/ai-import-enrichment";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { softDeleteEntriesByIds } from "@/lib/server/entry-delete";

export const runtime = "nodejs";


export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

async function logDistill(payload: {
  source: string;
  rawInput: string;
  preprocessed?: string;
  promptSent?: string;
  llmResponse?: string;
  parsedItems?: unknown;
  operationType?: string;
  finalResult?: unknown;
  trace?: string[];
  modelName?: string;
  latencyMs?: number;
  success: boolean;
  errorMsg?: string;
}) {
  try {
    await prisma.distillLog.create({
      data: {
        source: payload.source,
        rawInput: payload.rawInput.slice(0, 20000),
        preprocessed: payload.preprocessed?.slice(0, 20000),
        promptSent: payload.promptSent?.slice(0, 20000),
        llmResponse: payload.llmResponse?.slice(0, 20000),
        parsedItems: payload.parsedItems ? JSON.stringify(payload.parsedItems).slice(0, 20000) : undefined,
        operationType: payload.operationType,
        finalResult: payload.finalResult ? JSON.stringify(payload.finalResult).slice(0, 20000) : undefined,
        trace: payload.trace?.join("\n")?.slice(0, 5000),
        modelName: payload.modelName,
        latencyMs: payload.latencyMs,
        success: payload.success,
        errorMsg: payload.errorMsg?.slice(0, 2000),
      },
    });
  } catch {
    // Distill log write failures must not block the main flow
  }
}



type CommandScope = {
  operation: "create" | "update" | "delete" | "restore" | "query";
  timeRange: {
    hasRange: boolean;
    year?: number;
    month?: number;
    startDay?: number;
    endDay?: number;
  };
  amountRange: {
    min?: number;
    max?: number;
  };
  accountRange: {
    keyword?: string;
  };
  remarkCondition: {
    hasRemark?: boolean;
    keyword?: string;
  };
  type?: "expense" | "income" | "transfer" | "investment";
};

function buildScopeSummary(scope: CommandScope) {
  return {
    operation: scope.operation,
    timeRange: scope.timeRange,
    amountRange: scope.amountRange,
    accountRange: scope.accountRange,
    remarkCondition: scope.remarkCondition,
    type: scope.type,
  };
}



function normalizeDateToken(raw: string) {
  const s = raw.trim().replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, "");
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function extractAmountNear(text: string, labels: string[]) {
  const escaped = labels.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const reg = new RegExp(`(?:${escaped})[^\\n\\r]{0,30}?(?:RMB|人民币|USD|美元)?\\s*([+-]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})|[+-]?\\d+(?:\\.\\d{1,2})?)`, "i");
  const m = text.match(reg);
  if (!m) return undefined;
  const n = Number(String(m[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : undefined;
}

function parseBillHeader(text: string): BillHeader {
  const t = text.replace(/\u00A0/g, " ");
  const statementRaw = t.match(/(?:本期账单日|账单日|Statement\s*Date|Bill\s*Date)\s*[:：]?\s*(\d{4}[\/.年-]\d{1,2}[\/.月-]\d{1,2}日?)/i)?.[1];
  const dueRaw = t.match(/(?:本期最后还款日|最后还款日|Payment\s*Due\s*Date|Due\s*Date)\s*[:：]?\s*(\d{4}[\/.年-]\d{1,2}[\/.月-]\d{1,2}日?)/i)?.[1];
  const newBalance = extractAmountNear(t, ["本期应还款金额", "应还款金额", "New Balance", "Total Due"]);
  const minPayment = extractAmountNear(t, ["本期最低还款金额", "最低还款金额", "Min.Payment", "Min Payment", "Minimum Due"]);
  const hasCny = /RMB|人民币/i.test(t);
  const hasUsd = /USD|美元/i.test(t);
  const currency: "CNY" | "USD" | undefined = hasCny ? "CNY" : hasUsd ? "USD" : undefined;
  return {
    statementDate: statementRaw ? normalizeDateToken(statementRaw) : undefined,
    paymentDueDate: dueRaw ? normalizeDateToken(dueRaw) : undefined,
    newBalance,
    minPayment,
    currency,
  };
}

function preprocessBillText(raw: string) {
  const src = raw.replace(/\r/g, "");
  const cleaned = src
    .replace(/精彩推荐[\s\S]*?(?=本期账单交易明细|交易日\s*SOLD|$)/g, " ")
    .replace(/查看更多精彩活动[\s\S]*?(?=本期账单交易明细|交易日\s*SOLD|$)/g, " ")
    .replace(/账单也能分期还[\s\S]*?(?=本期账单交易明细|交易日\s*SOLD|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const header = parseBillHeader(src);

  const txMatches = [...src.matchAll(/(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.{2,80}?)\s+(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2}))\s+(\d{4})(?=\s|$)/g)];
  const txLines = txMatches.slice(0, 20).map((m) => {
    const sold = m[1];
    const posted = m[2];
    const desc = m[3].trim();
    const amt = String(m[4]).replace(/,/g, "");
    const card4 = m[5];
    const y = header.statementDate ? Number(header.statementDate.slice(0, 4)) : new Date().getFullYear();
    const soldIso = `${y}-${sold.slice(0,2)}-${sold.slice(3,5)}`;
    const postedIso = `${y}-${posted.slice(0,2)}-${posted.slice(3,5)}`;
    return `${soldIso}|${postedIso}|${desc}|${amt}|${card4}`;
  });

  return { cleaned, header, txLines };
}

function parseBillTxLines(txLines: string[], header: BillHeader, issuerKeyword: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const line of txLines) {
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [soldIso, _, desc, amt, card4] = parts;
    const amount = parseFloat(amt);
    if (!Number.isFinite(amount)) continue;

    const isRepayment = amount < 0 || /还款|入账/.test(desc);
    const absAmt = Math.abs(amount);

    const counterparty = /支付宝/.test(desc) ? "支付宝" : /微信/.test(desc) ? "微信" : /银联/.test(desc) ? "银联" : undefined;
    const account = issuerKeyword ? `${issuerKeyword}信用卡` : undefined;

    items.push({
      rawText: line,
      type: isRepayment ? "transfer" : "expense",
      date: soldIso,
      amount: absAmt,
      account,
      remark: desc.trim(),
      counterparty,
      fromAccount: isRepayment ? "外部还款" : undefined,
    });
  }
  return items;
}

function extractCreditCardTailForPreview(text: string | undefined) {
  const clean = String(text ?? "").trim();
  if (!clean) return "";
  const direct = clean.match(/尾号\s*([0-9]{4})(?=.*信用卡)|信用卡.*?尾号\s*([0-9]{4})/);
  if (direct?.[1] || direct?.[2]) return direct[1] ?? direct[2] ?? "";
  const compact = clean.match(/\b([0-9]{4})\b(?=.*信用卡)|信用卡.*?\b([0-9]{4})\b/);
  return compact?.[1] ?? compact?.[2] ?? "";
}

function accountPreviewName(account: {
  name: string;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
}) {
  const inst = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || "";
  const tail = String(account.numberMasked ?? "").trim();
  return [inst, account.name, tail].filter(Boolean).join("·");
}

async function enrichPreviewAccountNames(items: ParsedItem[], hidFilter: Record<string, string>, requestAccountId?: string) {
  const needsCreditTail = items.some((item) =>
    extractCreditCardTailForPreview(`${item.account ?? ""} ${item.rawText ?? ""} ${item.remark ?? ""}`),
  );
  if (!needsCreditTail) return items;

  const accounts = await prisma.account.findMany({
    where: { ...hidFilter, kind: "bank_credit" },
    include: { Institution: { select: { name: true, shortName: true } } },
  });
  const requestAccount = requestAccountId ? accounts.find((account) => account.id === requestAccountId) ?? null : null;

  return items.map((item) => {
    const tail = extractCreditCardTailForPreview(`${item.account ?? ""} ${item.rawText ?? ""} ${item.remark ?? ""}`);
    if (!tail) return item;
    const matchesTail = (account: (typeof accounts)[number]) => {
      const masked = String(account.numberMasked ?? "").replace(/\D/g, "");
      const nameDigits = String(account.name ?? "").replace(/\D/g, "");
      return masked.endsWith(tail) || nameDigits.endsWith(tail);
    };
    const matched =
      requestAccount && matchesTail(requestAccount)
        ? requestAccount
        : accounts.find(matchesTail) ?? null;
    if (!matched) return item;
    return {
      ...item,
      _meta: {
        ...(item as any)._meta,
        accountDisplayName: accountPreviewName(matched),
      },
    } as ParsedItem;
  });
}

function parseBatchEditCommand(text: string) {
  const t = text.trim();
  if (!/^修改/.test(t)) return null;

  const year = new Date().getFullYear();
  let yearMatch = t.match(/(\d{4})年/);
  const targetYear = yearMatch ? Number(yearMatch[1]) : year;

  let targetMonth: number | undefined = undefined;
  const monthMatch = t.match(/(\d{1,2})月/);
  if (monthMatch) targetMonth = Number(monthMatch[1]);

  let targetDay: number | undefined = undefined;
  const dayMatch = t.match(/(\d{1,2})号/);
  if (dayMatch) targetDay = Number(dayMatch[1]);

  let accountKeyword: string | undefined = undefined;
  if (/招行|招商/.test(t)) accountKeyword = "招商";
  else if (/花呗/.test(t)) accountKeyword = "花呗";
  else if (/微信/.test(t)) accountKeyword = "微信";
  else if (/支付宝/.test(t)) accountKeyword = "支付宝";
  else {
    const m = t.match(/(?:所有|的)(.+?)(?:交易|记录)/);
    if (m?.[1]) accountKeyword = m[1].trim();
  }

  return {
    year: targetYear,
    month: targetMonth,
    day: targetDay,
    accountKeyword: accountKeyword || undefined,
  };
}

async function executeBatchEditPlan(plan: { year: number; month?: number; day?: number; accountKeyword?: string }, hidFilter: Record<string, string>, householdId: string | null) {
  const where: Record<string, unknown> = { deletedAt: null, ...hidFilter };

  if (plan.day) {
    const start = new Date(Date.UTC(plan.year, (plan.month ?? 1) - 1, plan.day, 0, 0, 0));
    const end = new Date(Date.UTC(plan.year, (plan.month ?? 1) - 1, plan.day + 1, 0, 0, 0));
    where.transaction = { date: { gte: start as Date, lt: end as Date }, deletedAt: null };
  } else if (plan.month) {
    const start = new Date(Date.UTC(plan.year, plan.month - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(plan.year, plan.month, 1, 0, 0, 0));
    where.transaction = { date: { gte: start as Date, lt: end as Date }, deletedAt: null };
  } else {
    where.transaction = { deletedAt: null };
  }

  if (plan.accountKeyword) {
    const accounts = await prisma.account.findMany({
      where: { isActive: true, ...hidFilter },
      include: { Institution: true },
      take: 300,
    });
    const matchedAccountIds = accounts
      .filter((account) => accountMatches(account, plan.accountKeyword ?? ""))
      .map((account) => account.id);
    where.OR = matchedAccountIds.length > 0
      ? [{ accountId: { in: matchedAccountIds } }, { toAccountId: { in: matchedAccountIds } }]
      : [{ id: "__no_matching_account__" }];
  }

  const entries = await prisma.txRecord.findMany({
    where,
    include: { account: { select: { name: true } } },
    take: 100,
    orderBy: [{ date: "desc" }],
  });

  const targets = entries.map(e => ({
    id: e.id,
    transactionId: e.id,
    date: e.date.toISOString().slice(0, 10),
    accountName: e.account?.name ?? e.accountName,
    amount: Number(e.amount),
    remark: e.note ?? "",
    type: e.type ?? "expense",
  }));

  return {
    ok: true,
    count: entries.length,
    targets,
    requiresConfirm: true,
  };
}

function dateRangeToWhere(range?: ParsedDateRange) {
  if (!range?.year) return undefined;
  const startMonth = range.startMonth ?? 1;
  const startDay = range.startDay ?? 1;
  if (range.before && range.startMonth) {
    return { lt: new Date(Date.UTC(range.year, range.startMonth - 1, 1, 0, 0, 0)) };
  }
  const start = new Date(Date.UTC(range.year, startMonth - 1, startDay, 0, 0, 0));
  const endMonth = range.endMonth ?? range.startMonth;
  const endDay = range.endDay ?? range.startDay;
  const end = endMonth
    ? endDay
      ? new Date(Date.UTC(range.year, endMonth - 1, endDay + 1, 0, 0, 0))
      : new Date(Date.UTC(range.year, endMonth, 1, 0, 0, 0))
    : new Date(Date.UTC(range.year + 1, 0, 1, 0, 0, 0));
  return { gte: start, lt: end };
}

function accountQueryParts(query: string) {
  return query
    .replace(/[·・.\s_-]/g, "")
    .match(/\d+|[A-Za-z]+|[\u4e00-\u9fa5]+/g) ?? [];
}

function accountMatches(account: { name: string; Institution?: { name: string } | null }, query: string) {
  const normalizedQuery = query.replace(/[·・.\s_-]/g, "");
  const label = `${account.Institution?.name ?? ""}${account.name}`.replace(/[·・.\s_-]/g, "");
  if (account.name.replace(/[·・.\s_-]/g, "").includes(normalizedQuery) || label.includes(normalizedQuery)) return true;
  const parts = accountQueryParts(query);
  return parts.length > 0 && parts.every((part) => label.includes(part));
}

function parsedDateRangeFromIso(startDate?: string, endDate?: string): ParsedDateRange | undefined {
  const start = startDate?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!start) return undefined;
  const range: ParsedDateRange = { year: Number(start[1]), startMonth: Number(start[2]), startDay: Number(start[3]) };
  const end = endDate?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (end && Number(end[1]) === range.year) {
    range.endMonth = Number(end[2]);
    range.endDay = Number(end[3]);
  }
  return range;
}

function analyzedToUpdateCommand(command: AnalyzedCommand | null): ParsedUpdateCommand | null {
  if (!command || !/编辑|修改|update/i.test(command.action ?? "")) return null;
  const editField = command.editField ?? command.field;
  const editValue = command.editValue ?? command.value;
  if (!editValue) return null;
  const canonicalField = editField ? cnFieldFallback(editField) : "";
  const isAccountField = /账户|资金|cashAccount|account/i.test(editField ?? "") || ["cashAccount", "toAccount", "account"].includes(canonicalField);
  const updateTarget = isAccountField ? ({ cashAccount: "cashAccount", toAccount: "toAccount", account: "account" }[canonicalField] as ParsedUpdateCommand["updateTarget"] | undefined) : undefined;
  return {
    remarkKeyword: "",
    newAccountName: isAccountField ? editValue : "",
    newType: /类型|type/i.test(editField ?? "") ? editValue : undefined,
    timeRange: parsedDateRangeFromIso(command.startDate, command.endDate),
    updateTarget,
    oldAccountName: command.accountName,
    replaceAccountEverywhere: Boolean(isAccountField && command.accountName),
  };
}

function cnFieldFallback(field: string) {
  if (/资金账户|扣款卡/.test(field)) return "cashAccount";
  if (/对方账户|转入账户|收款账户/.test(field)) return "toAccount";
  if (/账户|消费账户|主账户/.test(field)) return "account";
  if (/类型/.test(field)) return "type";
  return field;
}

function describeDateRange(range?: ParsedDateRange) {
  if (!range?.year) return "不限时间";
  if (range.before && range.startMonth) return `${range.year}年${range.startMonth}月前`;
  if (range.startMonth && range.startDay && range.endMonth && range.endDay) return `${range.year}-${String(range.startMonth).padStart(2, "0")}-${String(range.startDay).padStart(2, "0")} 至 ${String(range.endMonth).padStart(2, "0")}-${String(range.endDay).padStart(2, "0")}`;
  if (range.startMonth) return `${range.year}年${range.startMonth}月`;
  return `${range.year}年`;
}

function buildUpdatePreview(plan: ParsedUpdateCommand, count: number, accountName?: string) {
  const isAccountReplace = Boolean(plan.replaceAccountEverywhere && plan.oldAccountName);
  return {
    operationType: "批量修改",
    action: isAccountReplace ? "账户替换" : "字段修改",
    targetField: isAccountReplace ? "账户（发出方/接收方）" : plan.updateTarget === "toAccount" ? "对方账户" : plan.updateTarget === "cashAccount" ? "资金账户" : plan.newType ? "记录类型" : "账户",
    oldValue: plan.oldAccountName ?? (plan.remarkKeyword ? `备注包含：${plan.remarkKeyword}` : accountName || "当前筛选范围"),
    newValue: plan.newType ?? plan.newAccountName,
    scopeFields: [
      { label: "时间范围", value: describeDateRange(plan.timeRange) },
      { label: "原账户/范围", value: (plan.oldAccountName ?? accountName) || "不限账户" },
      { label: "备注条件", value: plan.remarkKeyword || "不限备注" },
      { label: "命中记录", value: `${count} 条` },
    ],
  };
}

async function executeUpdatePlan(plan: ParsedUpdateCommand, apply: boolean, accountName?: string, hidFilter: Record<string, string> = {}, householdId: string | null = null) {
  const accounts = await prisma.account.findMany({
    where: { isActive: true, ...hidFilter },
    include: { Institution: true },
    take: 300,
  });

  const findSingleAccount = (query: string, label: string) => {
    const matches = accounts.filter((account) => accountMatches(account, query));
    if (matches.length === 0) return { error: `未找到${label}：${query}` };
    if (matches.length > 1) return { error: `${label}“${query}”匹配到多个账户：${matches.slice(0, 5).map((a) => `${a.Institution?.name ? `${a.Institution.name}·` : ""}${a.name}`).join("、")}` };
    return { account: matches[0] };
  };

  const dateWhere = dateRangeToWhere(plan.timeRange);

  if (plan.replaceAccountEverywhere && plan.oldAccountName && plan.newAccountName) {
    const oldResult = findSingleAccount(plan.oldAccountName, "原账户");
    if (oldResult.error || !oldResult.account) return { ok: false, error: oldResult.error ?? "原账户匹配失败" };
    const newResult = findSingleAccount(plan.newAccountName, "新账户");
    if (newResult.error || !newResult.account) return { ok: false, error: newResult.error ?? "新账户匹配失败" };
    const oldAccount = oldResult.account;
    const newAccount = newResult.account;
    const where = {
      deletedAt: null,
      ...hidFilter,
      ...(dateWhere ? { date: dateWhere } : {}),
      OR: [{ accountId: oldAccount.id }, { toAccountId: oldAccount.id }],
    };
    const entries = await prisma.txRecord.findMany({
      where,
      include: { account: { select: { name: true } } },
      orderBy: { date: "asc" },
      take: 500,
    });

    if (!apply) {
      return {
        ok: true,
        requiresConfirm: true,
        count: entries.length,
        accountName: newAccount.name,
        targets: entries.slice(0, 10).map((e) => ({
          transactionId: e.id,
          date: e.date.toISOString().slice(0, 10),
          accountName: e.accountId === oldAccount.id ? `${oldAccount.name} → ${newAccount.name}` : `${e.account?.name ?? e.accountName} / ${oldAccount.name} → ${newAccount.name}`,
          amount: Number(e.amount),
          remark: e.note ?? "",
          type: e.type ?? "expense",
        })),
      };
    }

    if (householdId) {
      const mismatchCount = entries.filter((e) => e.householdId !== householdId).length;
      if (mismatchCount > 0) return { ok: false, error: `有 ${mismatchCount} 条记录不属于当前账簿，无法修改` };
    }

    const sourceIds = entries.filter((e) => e.accountId === oldAccount.id).map((e) => e.id);
    const targetIds = entries.filter((e) => e.toAccountId === oldAccount.id).map((e) => e.id);
    const [sourceResult, targetResult] = await prisma.$transaction([
      prisma.txRecord.updateMany({
        where: { id: { in: sourceIds }, deletedAt: null, ...hidFilter },
        data: { accountId: newAccount.id, accountName: newAccount.name },
      }),
      prisma.txRecord.updateMany({
        where: { id: { in: targetIds }, deletedAt: null, ...hidFilter },
        data: { toAccountId: newAccount.id, toAccountName: newAccount.name },
      }),
    ]);
    await Promise.all([oldAccount.id, newAccount.id].map((id) => recalcAndSaveAccountBalance(id)));
    // Client-side handles page refresh
    return {
      ok: true,
      updatedCount: sourceResult.count + targetResult.count,
      accountName: newAccount.name,
      requiresConfirm: false,
    };
  }

  let accountId: string | undefined = undefined;
  let accountFullName = "";
  if (plan.newAccountName) {
    const accountResult = findSingleAccount(plan.newAccountName, "账户");
    if (accountResult.error || !accountResult.account) return { ok: false, error: accountResult.error ?? `未找到账户：${plan.newAccountName}` };
    accountId = accountResult.account.id;
    accountFullName = accountResult.account.name;
  }
  let filterAccountId: string | undefined = undefined;
  let filterAccountName = accountName ?? "";
  if (accountName) {
    const accountResult = findSingleAccount(accountName, "筛选账户");
    if (accountResult.error || !accountResult.account) return { ok: false, error: accountResult.error ?? `未找到账户：${accountName}` };
    filterAccountId = accountResult.account.id;
    filterAccountName = accountResult.account.name;
  }

  const where: Record<string, unknown> = { deletedAt: null, ...hidFilter };
  if (plan.remarkKeyword) where.note = { contains: plan.remarkKeyword };
  if (filterAccountId) where.OR = [{ accountId: filterAccountId }, { toAccountId: filterAccountId }];
  if (dateWhere) where.date = dateWhere;
  if (plan.fundSubtype) where.fundSubtype = plan.fundSubtype;

  const entries = await prisma.txRecord.findMany({
    where,
    include: { account: { select: { name: true } } },
    orderBy: { date: "asc" },
    take: 500,
  });

  if (!apply) {
    return {
      ok: true,
      requiresConfirm: true,
      count: entries.length,
      accountName: accountFullName || filterAccountName,
      targets: entries.slice(0, 10).map(e => ({
        transactionId: e.id,
        date: e.date.toISOString().slice(0, 10),
        accountName: e.account?.name ?? e.accountName,
        amount: Number(e.amount),
        remark: e.note ?? "",
        type: e.type ?? "expense",
      })),
    };
  }

  const data: Record<string, unknown> = {};
  if (accountId) {
    if (plan.updateTarget === "toAccount" || plan.updateTarget === "cashAccount") {
      data.toAccountId = accountId;
      data.toAccountName = accountFullName;
    } else {
      data.accountId = accountId;
      data.accountName = accountFullName;
    }
  }
  if (plan.newType) data.type = plan.newType;

  if (householdId) {
    const mismatchCount = entries.filter(e => e.householdId !== householdId).length;
    if (mismatchCount > 0) return { ok: false, error: `有 ${mismatchCount} 条记录不属于当前账簿，无法修改` };
  }

  const affectedAccountIds = new Set<string>();
  entries.forEach((entry) => {
    if (entry.accountId) affectedAccountIds.add(entry.accountId);
    if (entry.toAccountId) affectedAccountIds.add(entry.toAccountId);
  });
  if (accountId) affectedAccountIds.add(accountId);
  const result = await prisma.txRecord.updateMany({
    where: { id: { in: entries.map(e => e.id) }, deletedAt: null, ...hidFilter },
    data,
  });
  await Promise.all([...affectedAccountIds].map((id) => recalcAndSaveAccountBalance(id)));
  // Client-side handles page refresh

  return {
    ok: true,
    updatedCount: result.count,
    accountName: accountFullName,
    requiresConfirm: false,
  };
}

type DeleteAmountRange = {
  min?: number;
  max?: number;
  includeMin?: boolean;
  includeMax?: boolean;
};

type DeletePlan = {
  year?: number;
  month?: number;
  hasMonth: boolean;
  startDay: number;
  endDay: number;
  accountQuery?: string;
  allAccounts?: boolean;
  type?: "expense" | "income" | "transfer";
  amountRange?: DeleteAmountRange;
  remarkCondition?: { hasRemark?: boolean; keyword?: string };
};

const DELETE_PREVIEW_LIMIT = 5000;

function parseCommandAmount(raw: string) {
  const normalized = raw.replace(/,/g, "").trim();
  const m = normalized.match(/([+-]?\d+(?:\.\d+)?)(?:\s*万)?/);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  return /万/.test(normalized) ? value * 10000 : value;
}

function parseAmountRange(text: string): DeleteAmountRange | undefined {
  const between = text.match(/金额?\s*(?:在|介于)?\s*([+-]?\d+(?:\.\d+)?\s*万?)\s*(?:到|至|-|~)\s*([+-]?\d+(?:\.\d+)?\s*万?)/);
  if (between) {
    const a = parseCommandAmount(between[1]);
    const b = parseCommandAmount(between[2]);
    if (a != null && b != null) return { min: Math.min(Math.abs(a), Math.abs(b)), max: Math.max(Math.abs(a), Math.abs(b)), includeMin: true, includeMax: true };
  }

  const lt = text.match(/(?:金额|钱|数额)?\s*(小于|低于|少于|不足|不超过|不大于|<=|<)\s*([+-]?\d+(?:\.\d+)?\s*万?)/);
  const gt = text.match(/(?:金额|钱|数额)?\s*(大于|高于|超过|不少于|不低于|>=|>)\s*([+-]?\d+(?:\.\d+)?\s*万?)/);
  const range: DeleteAmountRange = {};
  if (lt) {
    const value = parseCommandAmount(lt[2]);
    if (value != null) {
      range.max = Math.abs(value);
      range.includeMax = /不超过|不大于|<=/.test(lt[1]);
    }
  }
  if (gt) {
    const value = parseCommandAmount(gt[2]);
    if (value != null) {
      range.min = Math.abs(value);
      range.includeMin = /不少于|不低于|>=/.test(gt[1]);
    }
  }
  return range.min != null || range.max != null ? range : undefined;
}

function amountRangeToWhere(range: DeleteAmountRange): Prisma.TxRecordWhereInput {
  const min = range.min != null ? Math.abs(range.min) : undefined;
  const max = range.max != null ? Math.abs(range.max) : undefined;
  if (min != null && max != null) {
    const positive: Prisma.DecimalFilter<"TxRecord"> = {};
    const negative: Prisma.DecimalFilter<"TxRecord"> = {};
    if (range.includeMin) {
      positive.gte = min;
      negative.lte = -min;
    } else {
      positive.gt = min;
      negative.lt = -min;
    }
    if (range.includeMax) {
      positive.lte = max;
      negative.gte = -max;
    } else {
      positive.lt = max;
      negative.gt = -max;
    }
    const absRange: Prisma.TxRecordWhereInput = { OR: [{ amount: positive }, { amount: negative }] };
    return min === 0 ? { AND: [absRange, { NOT: { amount: 0 } }] } : absRange;
  }
  if (max != null) {
    const belowMax: Prisma.TxRecordWhereInput = {
      amount: range.includeMax
        ? { gte: -max, lte: max }
        : { gt: -max, lt: max },
    };
    return {
      AND: [belowMax, { NOT: { amount: 0 } }],
    };
  }
  if (min != null) {
    return {
      OR: [
        { amount: range.includeMin ? { gte: min } : { gt: min } },
        { amount: range.includeMin ? { lte: -min } : { lt: -min } },
      ],
    };
  }
  return {};
}

function describeAmountRange(range?: DeleteAmountRange) {
  if (!range) return "不限金额";
  const minText = range.min != null ? `${range.includeMin ? "大于等于" : "大于"} ${range.min}` : "";
  const maxText = range.max != null ? `${range.includeMax ? "小于等于" : "小于"} ${range.max}` : "";
  return [minText, maxText].filter(Boolean).join(" 且 ") || "不限金额";
}

function stripAmountCondition(text: string) {
  return text
    .replace(/金额?\s*(?:在|介于)?\s*[+-]?\d+(?:\.\d+)?\s*万?\s*(?:到|至|-|~)\s*[+-]?\d+(?:\.\d+)?\s*万?/g, "")
    .replace(/(?:金额|钱|数额)?\s*(?:小于|低于|少于|不足|不超过|不大于|<=|<|大于|高于|超过|不少于|不低于|>=|>)\s*[+-]?\d+(?:\.\d+)?\s*万?/g, "");
}

function parseDeleteCommand(text: string): DeletePlan | null {
  const t = normalizeOperationText(text);
  if (!t) return null;
  if (!/^删除/.test(t)) return null;
  const amountRange = parseAmountRange(t);
  const allAccounts = /(?:全部|所有|全)[^，。；;]{0,4}账户/.test(t);

  const ym = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  const hasMonth = !!ym;
  const year = hasMonth ? Number(ym![1]) : undefined;
  const month = hasMonth ? Number(ym![2]) : undefined;
  if (hasMonth && (!Number.isFinite(year) || !Number.isFinite(month) || (month as number) < 1 || (month as number) > 12)) return null;

  const explicitType = /收入/.test(t) ? "income" : /转账/.test(t) ? "transfer" : /支出|消费/.test(t) ? "expense" : undefined;

  let startDay = 1;
  let endDay = 31;

  if (hasMonth) {
    const daysInMonth = new Date(year as number, month as number, 0).getDate();
    startDay = 1;
    endDay = daysInMonth;

    const rangeMatch = t.match(/(\d{1,2})\s*(?:号|日)?\s*(?:到|至|\-|~)\s*(\d{1,2})\s*(?:号|日)?/);
    const afterMatch = t.match(/(\d{1,2})\s*(?:号|日)?\s*(?:以后|之后|后)/);
    const beforeMatch = t.match(/(\d{1,2})\s*(?:号|日)?\s*(?:以前|之前|前)/);

    if (rangeMatch) {
      startDay = Number(rangeMatch[1]);
      endDay = Number(rangeMatch[2]);
    } else if (afterMatch) {
      startDay = Number(afterMatch[1]);
      endDay = daysInMonth;
    } else if (beforeMatch) {
      startDay = 1;
      endDay = Number(beforeMatch[1]);
    }

    startDay = Math.max(1, Math.min(daysInMonth, startDay));
    endDay = Math.max(1, Math.min(daysInMonth, endDay));
    if (startDay > endDay) {
      const tmp = startDay;
      startDay = endDay;
      endDay = tmp;
    }
  }

  const textWithoutAmount = stripAmountCondition(t);
  let accountQuery: string | undefined;
  if (/招行信用卡|招商信用卡|信用卡/.test(textWithoutAmount) && /招行|招商/.test(textWithoutAmount)) accountQuery = "招商信用卡";
  else if (/花呗/.test(textWithoutAmount)) accountQuery = "花呗";
  else if (/微信/.test(textWithoutAmount)) accountQuery = "微信";
  else if (/支付宝/.test(textWithoutAmount)) accountQuery = "支付宝";
  else if (/招行|招商/.test(textWithoutAmount)) accountQuery = "招商";

  if (!accountQuery) {
    const m = textWithoutAmount.match(/(?:所有|全部)?(?:的)?(.+?)(?:消费|交易|记录|明细)/);
    const candidate = m?.[1]?.replace(/^删除/, "").replace(/[的\s]/g, "").trim();
    if (candidate && !/^(所有|全部)$/.test(candidate)) accountQuery = candidate;
  }
  if (!accountQuery && !amountRange) return null;

  return {
    year: year as number | undefined,
    month: month as number | undefined,
    hasMonth,
    startDay,
    endDay,
    accountQuery,
    allAccounts,
    type: explicitType,
    amountRange,
  };
}

async function executeDeletePlan(
  plan: DeletePlan,
  apply: boolean,
  ctx: HouseholdContext,
  viewAccount?: { accountId?: string; accountName?: string },
) {
  const { hidFilter } = ctx;
  const start = plan.hasMonth ? new Date(Date.UTC(plan.year as number, (plan.month as number) - 1, plan.startDay, 0, 0, 0)) : null;
  const end = plan.hasMonth ? new Date(Date.UTC(plan.year as number, (plan.month as number) - 1, plan.endDay + 1, 0, 0, 0)) : null;
  let accountName = "全部账户";
  let accountId: string | undefined;
  const hasExplicitAccountQuery = Boolean(plan.accountQuery?.trim());

  if (!hasExplicitAccountQuery && !plan.allAccounts && viewAccount?.accountId) {
    const currentAccount = await prisma.account.findFirst({
      where: { id: viewAccount.accountId, ...hidFilter },
      select: { id: true, name: true },
    });
    if (currentAccount) {
      accountId = currentAccount.id;
      accountName = currentAccount.name;
    }
  } else if (!hasExplicitAccountQuery && !plan.allAccounts && viewAccount?.accountName) {
    accountName = viewAccount.accountName;
  }

  if (hasExplicitAccountQuery) {
    const explicitAccountQuery = plan.accountQuery?.trim() ?? "";
    const accounts = await prisma.account.findMany({
      where: { isActive: true, ...hidFilter },
      include: { Institution: true },
      orderBy: { name: "asc" },
      take: 300,
    });

    const q = explicitAccountQuery;
    const candidates = accounts.filter((a) => {
      const inst = (a.Institution?.name ?? "").trim();
      const label = inst ? `${inst}·${a.name}` : a.name;
      return a.name.includes(q) || inst.includes(q) || label.includes(q) || q.includes(a.name);
    });

    const picked = candidates.find((a) => a.name === q) ?? candidates[0] ?? null;
    if (!picked) {
      return { ok: false as const, error: `未找到账户：${plan.accountQuery}` };
    }
    accountId = picked.id;
    accountName = picked.name;
  } else if (!accountId && accountName !== "全部账户") {
    const matched = await prisma.account.findFirst({
      where: { name: accountName, isActive: true, ...hidFilter },
      select: { id: true, name: true },
    });
    if (matched) {
      accountId = matched.id;
      accountName = matched.name;
    }
  }

  const txType = plan.type === "expense"
    ? TransactionType.expense
    : plan.type === "income"
      ? TransactionType.income
      : plan.type === "transfer"
        ? TransactionType.transfer
        : undefined;

  const andFilters: Prisma.TxRecordWhereInput[] = [
    { NOT: { source: { in: [BALANCE_RECONCILE_SOURCE, BALANCE_INITIALIZATION_SOURCE] } } },
  ];
  if (accountId) {
    andFilters.push({ OR: [{ accountId }, { toAccountId: accountId }] });
  } else if (accountName !== "全部账户") {
    return { ok: false as const, error: `未找到账户：${accountName}` };
  }
  if (plan.amountRange) andFilters.push(amountRangeToWhere(plan.amountRange));
  if (plan.remarkCondition?.keyword) andFilters.push({ note: { contains: plan.remarkCondition.keyword } });

  const txIds = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...(txType ? { type: txType } : {}),
      ...(start && end ? { date: { gte: start, lt: end } } : {}),
      AND: andFilters,
      ...hidFilter,
    },
    select: { id: true },
    take: DELETE_PREVIEW_LIMIT + 1,
  });

  const ids = txIds.map((r) => r.id);
  if (ids.length > DELETE_PREVIEW_LIMIT) {
    return { ok: false as const, error: `命中超过 ${DELETE_PREVIEW_LIMIT} 条记录，请增加时间、账户、类型或金额范围后再删除` };
  }
  if (ids.length === 0) {
    return { ok: true as const, deletedCount: 0, accountName, targets: [] as Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string; type?: string }> };
  }

  const preview = await prisma.txRecord.findMany({
    where: { id: { in: ids } },
    select: { id: true, date: true, accountName: true, amount: true, note: true, type: true, account: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { dayOrder: "desc" }, { createdAt: "desc" }],
  });

  const targets = preview.map((tx) => {
    return {
      transactionId: tx.id,
      date: tx.date.toISOString().slice(0, 10),
      accountName: tx.account?.name ?? tx.accountName,
      amount: Number(tx.amount),
      remark: tx.note ?? "",
      type: tx.type,
    };
  });

  if (!apply) {
    return { ok: true as const, deletedCount: ids.length, accountName, requiresConfirm: true as const, targets };
  }

  const res = await softDeleteEntriesByIds(ctx, ids, `AI 删除 ${ids.length} 条明细`);
  return { ok: true as const, deletedCount: res.deletedCount, accountName, requiresConfirm: false as const, targets };
}

function parseRestoreCommand(text: string) {
  const t = text.trim();
  if (!t) return null;
  if (!/^恢复/.test(t) && !/^还原/.test(t)) return null;
  const m = t.match(/(\d+)\s*条/);
  const take = Math.max(1, Math.min(100, m ? Number(m[1]) : 1));
  return { take };
}

async function executeRestorePlan(plan: { take: number }, apply: boolean, hidFilter: Record<string, string> = {}, householdId: string | null = null) {
  const rows = await prisma.txRecord.findMany({
    where: { deletedAt: { not: null }, ...hidFilter },
    include: { account: { select: { name: true } } },
    orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
    take: plan.take,
  });
  if (!rows.length) return { ok: true as const, restoredCount: 0, requiresConfirm: false as const, targets: [] as Array<{ date: string; accountName: string; amount: number; remark: string }> };

  const targets = rows.slice(0, 5).map((tx) => {
    return {
      date: tx.date.toISOString().slice(0, 10),
      accountName: tx.account?.name ?? tx.accountName,
      amount: Number(tx.amount),
      remark: tx.note ?? "",
    };
  });

  if (!apply) {
    return { ok: true as const, restoredCount: rows.length, requiresConfirm: true as const, targets };
  }

  const ids = rows.map((r) => r.id);
  const res = await prisma.txRecord.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: null },
  });
  return { ok: true as const, restoredCount: res.count, requiresConfirm: false as const, targets };
}

function parseQueryCommand(text: string) {
  const t = normalizeOperationText(text);
  if (!t) return null;
  if (!/(显示|查看|看看|列出|展示|查下|查询)/.test(t)) return null;
  if (!/回收站|移入回收站|删除记录|已删除/.test(t)) return null;

  const m = t.match(/(\d+)\s*条/);
  const take = Math.max(1, Math.min(100, m ? Number(m[1]) : 10));
  return { mode: "recycle_recent" as const, take };
}

function parseStatsCommand(text: string) {
  const t = normalizeOperationText(text);
  if (!t) return null;
  if (!/(统计|算一下|统计一下|汇总)/.test(t)) return null;
  const metric = /(多少钱|金额|总额|合计)/.test(t) ? "sum" : "count";
  const type = /收入/.test(t) ? TransactionType.income : /转账/.test(t) ? TransactionType.transfer : TransactionType.expense;

  let year: number | undefined = undefined;
  const yearMatch = t.match(/(\d{4})年/);
  if (yearMatch) year = Number(yearMatch[1]);

  let month: number | undefined = undefined;
  const monthMatch = t.match(/(\d{1,2})月/);
  if (monthMatch) month = Number(monthMatch[1]);

  let accountKeyword: string | undefined = undefined;
  const bankKey = extractBankKeywordFromBill(t);
  if (bankKey) accountKeyword = bankKey;

  return { metric: metric as "count" | "sum", type, year, month, accountKeyword };
}

async function executeStatsPlan(plan: { metric: "count" | "sum"; type: TransactionType; year?: number; month?: number; accountKeyword?: string }, hidFilter: Record<string, string> = {}) {
  const where: any = {
    ...hidFilter,
    transaction: {
      deletedAt: null,
      type: plan.type,
    },
  };

  if (plan.year) {
    const start = new Date(plan.year, (plan.month ?? 1) - 1, 1);
    const end = plan.month
      ? new Date(plan.year, plan.month, 1)
      : new Date(plan.year + 1, 0, 1);
    where.transaction.date = { gte: start, lt: end };
  }

  if (plan.accountKeyword) {
    where.OR = [
      { account: { name: { contains: plan.accountKeyword }, ...hidFilter } },
      { account: { Institution: { name: { contains: plan.accountKeyword } }, ...hidFilter } },
    ];
  }

  const rows = await prisma.txRecord.findMany({
    where,
    select: { amount: true },
    take: 50000,
  });
  const count = rows.length;
  const sum = rows.reduce((acc, r) => acc + Math.abs(Number(r.amount ?? 0)), 0);
  return { count, sum };
}

async function executeQueryPlan(plan: { mode: "recycle_recent"; take: number }, hidFilter: Record<string, string> = {}) {
  const rows = await prisma.txRecord.findMany({
    where: { deletedAt: { not: null }, ...hidFilter },
    include: { account: { select: { name: true } } },
    orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
    take: plan.take,
  });

  const records = rows.map((tx) => {
    return {
      id: tx.id,
      date: tx.date.toISOString().slice(0, 10),
      deletedAt: tx.deletedAt?.toISOString() ?? null,
      type: tx.type,
      amount: Number(tx.amount),
      accountName: tx.account?.name ?? tx.accountName,
      remark: tx.note ?? "",
    };
  });

  return { ok: true as const, records };
}

export async function POST(req: Request) {
  const ctx = await getHouseholdScope();
  if (!ctx.user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  const { hidFilter, householdId } = ctx;
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = z
    .object({
      text: z.string().optional(),
      imageDataUrl: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      modelName: z.string().optional(),
      apiMode: z.enum(["chat", "responses"]).optional(),
      accountId: z.string().optional(),
      accountName: z.string().optional(),
      fundContext: z.object({
        fundCode: z.string(),
        fundName: z.string().optional(),
        accountId: z.string(),
        cashAccountId: z.string().optional(),
      }).optional(),
    })
    .safeParse(body);

  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "参数格式不正确" }, { status: 400, headers: corsHeaders() });
  }

  const { text, imageDataUrl, fundContext } = parse.data;
  const baseUrl = (parse.data.baseUrl ?? "").trim();
  const apiKey = (parse.data.apiKey ?? "").trim();
  const modelName = (parse.data.modelName ?? "").trim();
  const accountId = (parse.data.accountId ?? "").trim();
  const accountName = (parse.data.accountName ?? "").trim();
  const currentAccount = accountId
    ? await prisma.account.findFirst({
        where: { id: accountId, ...hidFilter, isActive: true, isPlaceholder: { not: true } },
        select: { id: true, name: true, kind: true },
      })
    : null;
  const defaultSpendableAccount = isSpendableAccount(currentAccount)
    ? currentAccount
    : await prisma.account.findFirst({
        where: {
          ...hidFilter,
          isActive: true,
          isPlaceholder: { not: true },
          OR: [{ kind: "cash" }, { kind: "bank_debit" }, { kind: "ewallet" }, { kind: "bank_credit" }],
        },
        select: { id: true, name: true, kind: true },
        orderBy: { name: "asc" },
      });

  if (!text && !imageDataUrl) {
    return NextResponse.json({ ok: false, code: "MISSING_INPUT", error: "缺少 text 或 imageDataUrl" }, { status: 400, headers: corsHeaders() });
  }

  if (!baseUrl || !modelName) {
    return NextResponse.json({ ok: false, code: "MISSING_MODEL_CONFIG", error: "缺少模型配置（baseUrl/modelName）" }, { status: 400, headers: corsHeaders() });
  }

  const cleanUrl = baseUrl.replace(/\/$/, "");
  const isOllama = /:11434(\/|$)/.test(cleanUrl);
  const apiMode = isOllama ? "chat" : normalizeAiApiMode(parse.data.apiMode);

  if (text) {
    const startMs = Date.now();
    const normalizedCommand = await callAiForCommand({
      text,
      fundContext: fundContext ?? null,
      today: formatYmd(new Date()),
      modelName,
      baseUrl,
      apiKey,
      isOllama,
      apiMode,
    });

    const restorePlan = parseRestoreCommand(text);
    if (restorePlan) {
      try {
        const applyNow = /确认|继续|执行|立即/.test(text);
        const r = await executeRestorePlan(restorePlan, applyNow, hidFilter, householdId);
        if (applyNow) {
          return NextResponse.json({
            ok: true,
            operation: "restore",
            restoredCount: r.restoredCount,
            targets: r.targets ?? [],
            trace: [`已确认执行恢复：恢复 ${r.restoredCount} 条记录。`],
          }, { headers: corsHeaders() });
        }
        return NextResponse.json({
          ok: true,
          operation: "restore",
          stage: "confirm",
          restoredCount: r.restoredCount,
          targets: r.targets ?? [],
          trace: [`识别为恢复指令：恢复最近 ${restorePlan.take} 条`, `命中 ${r.restoredCount} 条记录`],
        }, { headers: corsHeaders() });
      } catch { /* continue */ }
    }

    const updatePlan = analyzedToUpdateCommand(normalizedCommand) ?? await parseUpdateCommand(text);
    if (updatePlan) {
      try {
        const applyNow = /确认|继续|执行|立即/.test(text);
        const result = await executeUpdatePlan(updatePlan, applyNow, accountName, hidFilter, householdId);
        if (!result.ok) return NextResponse.json({ ok: false, code: "UPDATE_PLAN_FAILED", error: (result as { error: string }).error }, { status: 422, headers: corsHeaders() });
        if (applyNow) {
          return NextResponse.json({
            ok: true,
            operation: "update",
            updatedCount: (result as { updatedCount: number }).updatedCount,
            accountName: (result as { accountName: string }).accountName,
            trace: [`已确认执行更新：修改 ${(result as { updatedCount: number }).updatedCount} 条记录。`],
          }, { headers: corsHeaders() });
        }
        return NextResponse.json({
          ok: true,
          operation: "update",
          stage: "confirm",
          count: (result as { count: number }).count,
          accountName: (result as { accountName: string }).accountName,
          remarkKeyword: updatePlan.remarkKeyword,
          newType: updatePlan.newType,
          targets: (result as { targets: Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string; type?: string }> }).targets,
          preview: buildUpdatePreview(updatePlan, (result as { count: number }).count, accountName),
          normalizedCommand,
          trace: [
            updatePlan.replaceAccountEverywhere && updatePlan.oldAccountName
              ? `识别为账户替换：${updatePlan.oldAccountName} → ${updatePlan.newAccountName}`
              : `识别为更新指令：${updatePlan.remarkKeyword ? `备注包含"${updatePlan.remarkKeyword}"的` : "当前账户"}记录${updatePlan.newAccountName ? `改为"${updatePlan.newAccountName}"` : ""}${updatePlan.newType ? `，类型改为"${updatePlan.newType}"` : ""}`,
            `命中 ${(result as { count: number }).count} 条记录，需要确认后执行。`,
          ],
        }, { headers: corsHeaders() });
      } catch {
        // Database unavailable, fall through to the next step
      }
    }

    const batchEditPlan = parseBatchEditCommand(text);
    if (batchEditPlan) {
      try {
        const planToExecute = {
          ...batchEditPlan,
          accountKeyword: batchEditPlan.accountKeyword || accountName || undefined,
        };
        const result = await executeBatchEditPlan(planToExecute, hidFilter, householdId);
        return NextResponse.json(
          {
            ok: true,
            operation: "batchEdit",
            stage: "confirm",
            count: result.count,
            targets: result.targets,
            trace: [
              `识别为批量编辑指令：${batchEditPlan.day ? `${batchEditPlan.day}号` : batchEditPlan.month ? `${batchEditPlan.month}月` : "全部"}${batchEditPlan.accountKeyword ? ` ${batchEditPlan.accountKeyword}` : ""}交易`,
              `命中 ${result.count} 条记录`,
            ],
          },
          { headers: corsHeaders() },
        );
      } catch {
        // Database unavailable, fall through to the next step
      }
    }

    const plan = parseDeleteCommand(text);
    if (plan) {
      try {
        const applyNow = /确认|继续|执行|立即/.test(text);
        const result = await executeDeletePlan(plan, applyNow, ctx, { accountId, accountName });
        if (!result.ok) return NextResponse.json({ ok: false, code: "DELETE_PLAN_FAILED", error: result.error }, { status: 422, headers: corsHeaders() });
        if (applyNow) {
          return NextResponse.json({
            ok: true,
            operation: "delete",
            deletedCount: result.deletedCount,
            accountName: result.accountName,
            targets: result.targets,
            trace: [
              `已确认执行删除：${result.accountName} ${describeAmountRange(plan.amountRange)}`,
              `已删除 ${result.deletedCount} 条记录`,
            ],
          }, { headers: corsHeaders() });
        }
        const scopeText = plan.hasMonth
          ? `${plan.year}-${String(plan.month).padStart(2, "0")}-${String(plan.startDay).padStart(2, "0")} 到 ${String(plan.endDay).padStart(2, "0")}`
          : `全部时间`;
        return NextResponse.json({
          ok: true,
          operation: "delete",
          stage: "confirm",
          deletedCount: result.deletedCount,
          accountName: result.accountName,
          yearMonth: plan.hasMonth ? `${plan.year}-${String(plan.month).padStart(2, "0")}` : undefined,
          targets: result.targets,
          trace: [
            `识别为删除指令：${scopeText} ${result.accountName} ${plan.type ?? "全部类型"} ${describeAmountRange(plan.amountRange)}`,
            `命中 ${result.deletedCount} 条记录`,
          ],
        }, { headers: corsHeaders() });
      } catch {
        // Database unavailable, fall through to the next step
      }
    }

    const statsPlan = parseStatsCommand(text);
    if (statsPlan) {
      try {
        const s = await executeStatsPlan(statsPlan, hidFilter);
        return NextResponse.json(
          {
            ok: true,
            operation: "stats",
            metric: statsPlan.metric,
            type: statsPlan.type,
            count: s.count,
            sum: s.sum,
            trace: [
              `识别为统计指令：${statsPlan.metric === "sum" ? "金额汇总" : "数量统计"}`,
              `统计结果：count=${s.count}, sum=${s.sum.toFixed(2)}`,
            ],
          },
          { headers: corsHeaders() },
        );
      } catch {
        // Database unavailable, fall through to the next step
      }
    }

    const queryPlan = parseQueryCommand(text);
    if (queryPlan) {
      try {
        const q = await executeQueryPlan(queryPlan, hidFilter);
        return NextResponse.json(
          {
            ok: true,
            operation: "query",
            queryType: "recycle_recent",
            records: q.records,
            trace: [`识别为查询指令：最近回收站记录`, `返回 ${q.records.length} 条记录`],
          },
          { headers: corsHeaders() },
        );
      } catch {
        // Database unavailable, fall through to the next step
      }
    }
  }

  if (imageDataUrl && !modelSupportsVision(modelName)) {
    return NextResponse.json(
      { ok: false, code: "VISION_NOT_SUPPORTED", error: `当前模型 "${modelName}" 不支持图片识别，请切换到支持图片的模型（如 GPT-4o、Claude-3.5、Qwen-VL 等），或将截图另存为文本后粘贴上传。` },
      { status: 422, headers: corsHeaders() },
    );
  }

  if (text && !imageDataUrl) {
    const successReminder = parseTransactionSuccessReminder(text, new Date());
    if (successReminder && successReminder.items.length > 0) {
      const previewItems = await enrichPreviewAccountNames(await enrichItems(successReminder.items), hidFilter, accountId);
      const result = {
        ok: true,
        items: previewItems,
        directImport: successReminder.directImport,
        trace: [
          `交易成功提醒规则直出 ${successReminder.items.length} 条记录（无需模型）`,
          `directImport=${successReminder.directImport ? "true" : "false"}`,
        ],
      };
      void logDistill({
        source: "chat",
        rawInput: text,
        parsedItems: previewItems,
        operationType: "transaction_success_reminder_direct",
        finalResult: result,
        trace: result.trace,
        success: true,
      });
      return NextResponse.json(result, { headers: corsHeaders() });
    }

    const billPre = preprocessBillText(text);
    if (billPre.txLines.length > 0 && billPre.header.statementDate) {
      const issuer = extractBankKeywordFromBill(text);
      const billItems = parseBillTxLines(billPre.txLines, billPre.header, issuer);
      if (billItems.length) {
        const enrichedItems = await enrichItems(billItems);
        const result = {
          ok: true,
          items: enrichedItems,
          directImport: false,
          billHeader: billPre.header.statementDate ? {
            statementDate: billPre.header.statementDate,
            paymentDueDate: billPre.header.paymentDueDate,
            newBalance: billPre.header.newBalance,
            minPayment: billPre.header.minPayment,
            currency: billPre.header.currency,
            issuer,
          } : undefined,
          trace: [
            `信用卡账单规则直出 ${billItems.length} 条记录（无需模型）`,
            `账单类文本：需人工确认后再导入`,
            `账单头部预识别：${buildBillHeaderContext(billPre.header)}`,
            `预抽取交易行：${billPre.txLines.length} 条`,
          ],
        };
        void logDistill({
          source: "chat",
          rawInput: text,
          preprocessed: billPre.cleaned,
          parsedItems: enrichedItems,
          operationType: "bill_direct",
          finalResult: result,
          trace: result.trace,
          success: true,
        });
        return NextResponse.json(result, { headers: corsHeaders() });
      }
    }
  }

  const startMs = Date.now();

  async function enrichItems(items: ParsedItem[]) {
    const enriched = await enrichAiParsedItems(prisma, householdId ?? "", hidFilter, items);
    if (!defaultSpendableAccount) return enriched;
    return enriched.map((item) => {
      if (item.type !== "expense" && item.type !== "income") return item;
      if (item.accountId?.trim() || item.account?.trim()) return item;
      return {
        ...item,
        accountId: defaultSpendableAccount.id,
        account: defaultSpendableAccount.name,
      };
    });
  }

  async function routeByType(inputType: string, text: string, now: Date) {
    const pre = preprocessBillText(text);
    if (inputType === "bill_statement") {
      if (pre.txLines.length > 0 && pre.header.statementDate) {
        const issuer = extractBankKeywordFromBill(text);
        const billItems = parseBillTxLines(pre.txLines, pre.header, issuer);
        if (billItems.length) {
          const enrichedItems = await enrichItems(billItems);
          return {
            ok: true,
            items: enrichedItems,
            directImport: false,
            billHeader: pre.header.statementDate ? {
              statementDate: pre.header.statementDate,
              paymentDueDate: pre.header.paymentDueDate,
              newBalance: pre.header.newBalance,
              minPayment: pre.header.minPayment,
              currency: pre.header.currency,
              issuer,
            } : undefined,
            trace: [
              `[分类路由] bill_statement：信用卡账单规则直出 ${billItems.length} 条`,
              `账单头部：${buildBillHeaderContext(pre.header)}`,
            ],
          };
        }
      }
      return null;
    }

    if (inputType === "batch_table") {
      const parsedOut = isCMBFundRecord(text)
        ? parseCMBFundRecord(text, now)
        : parseItems(text, now, text);
      const items = await enrichItems(parsedOut.items);
      if (items.length) {
        return {
          ok: true,
          items,
          directImport: false,
          trace: [
            `[分类路由] ${isCMBFundRecord(text) ? "招行基金交易记录" : "batch_table"}：直出 ${items.length} 条`,
            `directImport=${parsedOut.directImport}`,
          ],
        };
      }
      return null;
    }

    return null;
  }

  try {
    if (text && !imageDataUrl && isCMBFundRecord(text)) {
      const now = new Date();
      const parsedOut = parseCMBFundRecord(text, now);
      if (parsedOut.items.length) {
        const enrichedItems = await enrichItems(parsedOut.items);
        return NextResponse.json(
          {
            ok: true,
            items: enrichedItems,
            directImport: true,
            trace: [
              `招行基金交易记录解析 ${parsedOut.items.length} 条（无需模型）`,
              `耗时 ${Date.now() - startMs}ms`,
            ],
          },
          { headers: corsHeaders() },
        );
      }
    }

    if (text && !imageDataUrl && looksLikeFundTrade(text)) {
      const now = new Date();
      const fundTrade = parseFundTradeFromText(text, now, fundContext);
      if (fundTrade) {
        const enrichedItems = await enrichItems(fundTrade.items);
        return NextResponse.json({
          ok: true,
          items: enrichedItems,
          directImport: fundTrade.directImport,
          trace: [
            `${fundContext ? "基金上下文直出" : "基金代码直出"}: ${fundTrade.items[0]?.remark ?? ""} (无需模型)`,
            `耗时 ${Date.now() - startMs}ms`,
          ],
        }, { headers: corsHeaders() });
      }
    }

    if (text && !imageDataUrl) {
      const classification = await classifyInput(text, modelName, cleanUrl, apiKey, isOllama, apiMode, imageDataUrl);
      if (classification) {
        const routeResult = await routeByType(classification.inputType, text, new Date());
        if (routeResult) {
          return NextResponse.json(routeResult, { headers: corsHeaders() });
        }
      }
    }

    if (text && !imageDataUrl && looksLikeBatchLedgerText(text) && text.length > 300) {
      const now = new Date();
      const parsedOut = parseItems(text, now, text);
      const items = await enrichItems(parsedOut.items);
      if (items.length) {
        const isBill = isBillStatement(text);
        const directImport = !isBill && items.every(isReadyForImport);
        return NextResponse.json(
          {
            ok: true,
            items,
            directImport,
            trace: [
              `批量文本解析 ${items.length} 条记录（无需模型）`,
              isBill ? "账单类文本：需人工确认后再导入" : `directImport=${directImport ? "true" : "false"}`,
              `耗时 ${Date.now() - startMs}ms`,
            ],
          },
          { headers: corsHeaders() },
        );
      }
    }

    const nowForPrompt = new Date();
    const accountContext = await buildAccountContextText(householdId);
    const pre = preprocessBillText(text ?? "");
    const billHeaderCtx = buildBillHeaderContext(pre.header);
    const txCtx = pre.txLines.length ? `预抽取交易行：${pre.txLines.join(" || ")}` : "";
    const systemPrompt = fundContext ? buildFundSystemPrompt(fundContext) : SYSTEM_PROMPT;
    let llmBody: Record<string, unknown>;
    if (imageDataUrl) {
      llmBody = {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n${billHeaderCtx ? `账单头部预识别：${billHeaderCtx}\n` : ""}${txCtx ? `${txCtx}\n` : ""}请解析这张账单/交易表格截图。只输出JSON，不要其他文字。` },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0.1,
      };
    } else {
      llmBody = {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n只输出JSON，不要任何解释：\n${text ?? ""}`,
          },
        ],
        temperature: 0.1,
      };
    }

    let rawContent = "";
    if (isOllama) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = (apiKey ?? "").trim();
      if (key) headers.Authorization = `Bearer ${key}`;

      const msgText =
        imageDataUrl
          ? `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n${billHeaderCtx ? `账单头部预识别：${billHeaderCtx}\n` : ""}${txCtx ? `${txCtx}\n` : ""}请解析这张账单/交易表格截图。只输出JSON，不要其他文字。`
          : `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n${billHeaderCtx ? `账单头部预识别：${billHeaderCtx}\n` : ""}${txCtx ? `${txCtx}\n` : ""}只输出JSON，不要任何解释：\n${pre.cleaned || text || ""}`;

      const base64 = imageDataUrl ? (imageDataUrl.split(",")[1] ?? "").trim() : "";
      const ollamaBody: Record<string, unknown> = {
        model: modelName,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          imageDataUrl ? { role: "user", content: msgText, images: base64 ? [base64] : [] } : { role: "user", content: msgText },
        ],
      };

      const llmRes = await fetch(joinBaseUrl(cleanUrl, "/api/chat"), {
        method: "POST",
        headers,
        body: JSON.stringify(ollamaBody),
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text().catch(() => "");
        return NextResponse.json(
          { ok: false, code: "LLM_CALL_FAILED", error: `LLM 调用失败 (${llmRes.status}): ${errText.slice(0, 300)}` },
          { status: 502, headers: corsHeaders() },
        );
      }

      const llmData = (await llmRes.json().catch(() => null)) as
        | { message?: { content?: string | null } }
        | { response?: string | null }
        | null;

      rawContent = (llmData as any)?.message?.content ?? (llmData as any)?.response ?? "";
    } else {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = (apiKey ?? "").trim();
      if (key) headers.Authorization = `Bearer ${key}`;

      const chatMessages = (llmBody.messages ?? []) as Array<{
        role: string;
        content: string | ChatContentPart[];
      }>;
      const requestBody = apiMode === "responses"
        ? buildResponsesRequestBody({
            modelName,
            instructions: systemPrompt,
            userMessage: chatMessages.find((message) => message.role === "user")?.content ?? "",
            temperature: 0.1,
          })
        : llmBody;
      const llmRes = await fetch(joinBaseUrl(cleanUrl, apiMode === "responses" ? "/v1/responses" : "/v1/chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text().catch(() => "");
        return NextResponse.json(
          { ok: false, code: "LLM_CALL_FAILED", error: `LLM 调用失败 (${llmRes.status}): ${errText.slice(0, 300)}` },
          { status: 502, headers: corsHeaders() },
        );
      }

      const llmData = (await llmRes.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        error?: { message?: string };
      } | null;

      if (llmData?.error) {
        return NextResponse.json(
          { ok: false, code: "LLM_ERROR", error: `LLM 错误: ${llmData.error.message ?? "未知错误"}` },
          { status: 400, headers: corsHeaders() },
        );
      }

      rawContent = apiMode === "responses"
        ? extractResponsesText(llmData)
        : llmData?.choices?.[0]?.message?.content ?? "";
    }

    if (!rawContent) {
      void logDistill({
        source: "chat",
        rawInput: text ?? imageDataUrl ?? "",
        preprocessed: text ? pre.cleaned : undefined,
        promptSent: undefined,
        operationType: "chat",
        modelName,
        latencyMs: Date.now() - startMs,
        success: false,
        errorMsg: "LLM 未返回内容",
      });
      return NextResponse.json({ ok: false, code: "LLM_EMPTY_RESPONSE", error: "LLM 未返回内容，请重试或更换模型" }, { status: 422, headers: corsHeaders() });
    }

    const now = new Date();

    // ── Check if fund LLM returned a batch plan ──
    if (fundContext) {
      try {
        let batchJson: any = null;
        // Try to extract JSON from the response
        for (const pat of [/```json\s*([\s\S]*?)\s*```/i, /```\s*([\s\S]*?)\s*```/, /\{[\s\S]*"operation"[\s\S]*\}/, /(\{[\s\S]*\})/]) {
          const m = rawContent.match(pat);
          if (m) {
            try { batchJson = JSON.parse(m[1] ?? m[0]); break; } catch { continue; }
          }
        }
        if (!batchJson) try { batchJson = JSON.parse(rawContent); } catch { /* not JSON */ }
        if (batchJson?.operation === "batch" && batchJson?.plan) {
          const plan = batchJson.plan;
          if (plan.amount > 0 && plan.intervalUnit && plan.startDate) {
            return NextResponse.json({
              ok: true,
              operation: "batchInvest",
              plan: {
                amount: Number(plan.amount),
                intervalUnit: String(plan.intervalUnit),
                intervalValue: Number(plan.intervalValue || 1),
                startDate: String(plan.startDate),
                endDate: plan.endDate || null,
              },
              trace: [
                `AI 解析为批量买入: ${plan.intervalUnit === "day" ? "每天" : plan.intervalUnit === "week" ? "每周" : plan.intervalUnit === "biweek" ? "每两周" : "每月"}${plan.amount}元`,
                plan.endDate ? `${plan.startDate} ~ ${plan.endDate}` : `${plan.startDate} 起，无截止`,
                `耗时 ${Date.now() - startMs}ms`,
              ],
            }, { headers: corsHeaders() });
          }
        }
      } catch { /* fall through to normal parseItems */ }
    }

    const parsedOut = parseItems(rawContent, now, text ?? "");
    const items = await enrichPreviewAccountNames(await enrichItems(parsedOut.items), hidFilter, accountId);
    const isBill = isBillStatement(text ?? "");
    const directImport = items.every(isReadyForImport);
    const finalDirectImport = !isBill && directImport;

    const duplicates: Array<{ existingEntryId: string; existingTransactionId: string; overlapStart: Date; overlapEnd: Date }> = [];

    const traceLines = [
      `通过 ${modelName} 解析 ${items.length} 条记录`,
      `directImport=${finalDirectImport ? "true" : "false"}`,
      isBill ? "账单类文本：需人工确认后再导入" : "",
      billHeaderCtx ? `账单头部预识别：${billHeaderCtx}` : "",
      txCtx ? `预抽取交易行：${pre.txLines.length} 条` : "",
      `耗时 ${Date.now() - startMs}ms`,
    ].filter(Boolean);

    const result = {
      ok: true,
      items,
      directImport: finalDirectImport,
      duplicates: duplicates.length > 0 ? duplicates : undefined,
      billHeader: isBill && pre.header.statementDate ? {
        statementDate: pre.header.statementDate,
        paymentDueDate: pre.header.paymentDueDate,
        newBalance: pre.header.newBalance,
        minPayment: pre.header.minPayment,
        currency: pre.header.currency,
        issuer: extractBankKeywordFromBill(text ?? ""),
      } : undefined,
      trace: traceLines,
    };

    void logDistill({
      source: "chat",
      rawInput: text ?? imageDataUrl ?? "",
      preprocessed: text ? pre.cleaned : undefined,
      promptSent: undefined,
      llmResponse: rawContent,
      parsedItems: items,
      operationType: "chat",
      finalResult: result,
      trace: traceLines,
      modelName,
      latencyMs: Date.now() - startMs,
      success: true,
    });

    return NextResponse.json(result, { headers: corsHeaders() });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "LLM 调用失败";
    void logDistill({
      source: "chat",
      rawInput: text ?? imageDataUrl ?? "",
      operationType: "chat",
      modelName,
      latencyMs: Date.now() - startMs,
      success: false,
      errorMsg: errMsg,
    });
    return NextResponse.json(
      { ok: false, code: "AI_SERVICE_UNAVAILABLE", error: errMsg },
      { status: 500, headers: corsHeaders() },
    );
  }
}
