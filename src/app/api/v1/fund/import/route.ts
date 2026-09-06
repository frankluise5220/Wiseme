import { NextResponse } from "next/server";
import { AccountKind, FundCashFlowKind, FundSubtype, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  buildImportAccountCandidates,
  buildImportAccountInputCandidates,
  normalizeImportAccountMatchKey,
  resolveImportAccountIdFromList,
} from "@/lib/account-import-match";
import { getFundConfirmRule, normalizeNonNegativeDays, setFundConfirmRuleInTx } from "@/lib/fund/confirmDays";
import { getFundFeeRate, getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundNav, getLatestFundNav } from "@/lib/fund/navCache";
import { resolveFundName } from "@/lib/fund/fundProfile";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { createFundTransactionWithCashFlows, type FundCashFlowInput } from "@/lib/fund/transactions";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { attachEntryTagsByNames, parseTagNamesInput } from "@/lib/server/entry-tags";
import { addTradingDaysUtc, parseFlexibleDateToYmd } from "@/lib/date-utils";
import { getCurrentUser, isReadOnly } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/fund/import
 *
 * Body:
 * - mode: "preview" | "import"; omitted mode defaults to preview
 * - items: fund import rows using the template contract fields
 *   fee is an actual fee amount; feeRateInput/feeRate is a percent value such as 1 for 1%.
 *   When fee and feeRateInput/feeRate are both provided, fee amount wins and fee rate is ignored.
 *   If NAV is blank, preview/import derives the NAV date from the application date/time and fetches the exact NAV when available.
 *   Preview/import returns calculatedFields for system-derived numeric values such as NAV, fee rate, fee, and units.
 * - context?: optional current fund-account view context used only to fill blank fund/cash account fields.
 * - overrides?: optional T+N rules keyed by fund account + fund code, used for preview recalculation and persisted on import
 *
 * Success:
 * - preview: { ok: true, items }
 * - import: { ok: true, createdCount, ids, items }
 *
 * Failure:
 * - { ok: false, error }
 */

type AccountLookupRow = {
  id: string;
  name: string;
  kind: AccountKind;
  investProductType: string | null;
  tradingCalendar: string | null;
  billingDay: number | null;
  defaultConfirmDays: number | null;
  defaultArrivalDays: number | null;
  fundUnitsDecimals: number | null;
  numberMasked: string | null;
  Institution: { name: string | null; shortName?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type ImportIssue = {
  level: "error" | "warning";
  code?: string;
  message: string;
};

const FUND_IMPORT_CALCULATED_FIELDS = [
  "feeRate",
  "fee",
  "nav",
  "units",
] as const;

type FundImportCalculatedField = typeof FUND_IMPORT_CALCULATED_FIELDS[number];

const FUND_IMPORT_CALCULATED_FIELD_SET = new Set<string>(FUND_IMPORT_CALCULATED_FIELDS);

type FundImportInput = {
  rawText?: string;
  date?: string;
  fundSubtype?: string;
  source?: string;
  cashAccountId?: string | null;
  fundAccountId?: string | null;
  cashAccount?: string;
  fundAccount?: string;
  fundCode?: string;
  fundName?: string;
  amount?: number;
  units?: number | null;
  nav?: number | null;
  fee?: number | null;
  feeRate?: number | null;
  feeRateInput?: number | null;
  confirmDate?: string | null;
  arrivalDate?: string | null;
  remark?: string;
  tags?: string | string[];
  calculatedFields?: FundImportCalculatedField[] | null;
};

type FundImportEnrichedItem = {
  rawText: string;
  date: string;
  fundSubtype: string;
  source: string;
  cashAccount: string;
  fundAccount: string;
  fundCode: string;
  fundName: string | null;
  amount: number;
  units: number | null;
  nav: number | null;
  fee: number | null;
  confirmDate: string | null;
  arrivalDate: string | null;
  remark: string;
  tags: string;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  calculatedFields: FundImportCalculatedField[];
  issues: ImportIssue[];
};

type FundImportRuleOverride = {
  fundAccountId?: string | null;
  fundAccount?: string | null;
  fundCode?: string | null;
  confirmDays?: number | null;
  arrivalDays?: number | null;
};

type FundImportRequestContext = {
  fundAccountId?: string | null;
  fundAccount?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
};

type ResolvedFundImportRequestContext = {
  fundAccountMeta: AccountLookupRow | null;
  fundAccount: string;
  fundCode: string | null;
  fundName: string | null;
};

type ImportContext = {
  householdId: string;
  accountIdByMatchKey: Map<string, string>;
  accountLookupRows: AccountLookupRow[];
  navLookupCache: Map<string, Promise<Awaited<ReturnType<typeof getFundNav>>>>;
  fundNameLookupCache: Map<string, Promise<string | null>>;
  inferredCashAccountByFundAccountId: Map<string, Promise<AccountLookupRow | null>>;
  requestContext: ResolvedFundImportRequestContext | null;
};

type ParsedRuleOverride = {
  fundAccountId: string | null;
  fundAccountKey: string | null;
  fundCode: string;
  confirmDays?: number;
  arrivalDays?: number;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

// Enrichment runs per-row DB and external-API lookups; cap the concurrency so
// large imports do not exhaust the pg pool (and its connection wait timeout).
const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.FUND_IMPORT_ENRICH_CONCURRENCY ?? 6));

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isPureInvestmentAccount(account: Pick<AccountLookupRow, "kind" | "investProductType"> | null | undefined) {
  return !!account && account.kind === AccountKind.investment && account.investProductType !== "deposit";
}

const FUND_NAV_CUTOFF_SECONDS = 15 * 60 * 60;

function normalizeImportDatePart(value: string | null | undefined) {
  return parseFlexibleDateToYmd(value);
}

function importDateTimeSeconds(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return hour * 60 * 60 + minute * 60 + second;
}

function deriveBuyNavDate(applyDate: string, confirmDays: number, tradingCalendar?: string | null) {
  const applyDatePart = normalizeImportDatePart(applyDate);
  if (!applyDatePart) return null;
  const applySeconds = importDateTimeSeconds(applyDate);
  const offsetDays = applySeconds == null
    ? confirmDays
    : applySeconds >= FUND_NAV_CUTOFF_SECONDS ? 1 : 0;
  return addTradingDaysUtc(applyDatePart, offsetDays, tradingCalendar);
}

function addImportTradingDays(dateStr: string, days: number, tradingCalendar?: string | null) {
  const datePart = normalizeImportDatePart(dateStr);
  return datePart ? addTradingDaysUtc(datePart, days, tradingCalendar) : addTradingDaysUtc(dateStr, days, tradingCalendar);
}

function toUtcDate(dateStr: string): Date {
  const datePart = normalizeImportDatePart(dateStr) ?? dateStr;
  const [y, m, d] = datePart.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function parsePositiveNumber(value: unknown): number | null {
  const num = Number(String(value ?? "").replace(/[,，￥¥\s]/g, ""));
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  return abs > 0 ? abs : null;
}

function parseNonNegativeNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/[,，￥¥\s]/g, ""));
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function importCalculatedFieldSet(input: FundImportInput) {
  return new Set(
    (input.calculatedFields ?? []).filter((field): field is FundImportCalculatedField =>
      FUND_IMPORT_CALCULATED_FIELD_SET.has(String(field)),
    ),
  );
}

function parseUserPositiveNumber(
  input: FundImportInput,
  field: FundImportCalculatedField,
  calculatedFields: Set<FundImportCalculatedField>,
) {
  return calculatedFields.has(field) ? null : parsePositiveNumber(input[field]);
}

function parseUserNonNegativeNumber(
  input: FundImportInput,
  field: "fee" | "feeRate",
  calculatedFields: Set<FundImportCalculatedField>,
) {
  return calculatedFields.has(field) ? null : parseNonNegativeNumber(input[field]);
}

function sortedCalculatedFields(fields: Set<FundImportCalculatedField>) {
  return FUND_IMPORT_CALCULATED_FIELDS.filter((field) => fields.has(field));
}

function normalizeUsableFundName(value: unknown, fundCode: string) {
  const name = String(value ?? "").trim();
  return name && name !== fundCode ? name : null;
}

function firstUsableFundName(fundCode: string, ...values: unknown[]) {
  for (const value of values) {
    const name = normalizeUsableFundName(value, fundCode);
    if (name) return name;
  }
  return null;
}

function normalizeSubtype(raw: string) {
  const value = String(raw ?? "").trim().toLowerCase();
  const valid = new Set(["buy", "redeem", "dividend_cash", "dividend_reinvest"]);
  return valid.has(value) ? value : "";
}

function normalizeSource(raw: string, subtype: string, rawSubtype?: string) {
  const rawValue = String(raw ?? "").trim();
  const rawSubtypeValue = String(rawSubtype ?? "").trim();
  const isRefundAlias = rawSubtypeValue === "refund" || rawSubtypeValue === "returned" || rawSubtypeValue === "buy_refund";

  let value = rawValue;
  if (value === "regular_invest_refund" && subtype !== "buy_failed") {
    value = "regular_invest";
  }
  if (isRefundAlias && (!value || value === "manual" || value === "regular_invest" || value === "regular_invest_refund")) {
    return "regular_invest_refund";
  }
  if (!value) return subtype === "dividend_reinvest" ? "dividend" : "manual";
  return value;
}

function amountForSubtype(amount: number, subtype: string) {
  if (!Number.isFinite(amount)) return 0;
  if (subtype.includes("buy")) return Math.abs(amount);
  return amount;
}

function isSupportedFundCode(value: string) {
  return /^\d{6}$/.test(value.trim());
}

function indexAccountLookup(
  map: Map<string, string>,
  account: AccountLookupRow,
) {
  for (const candidate of buildImportAccountCandidates(account)) {
    const key = normalizeImportAccountMatchKey(candidate);
    if (key) map.set(key, account.id);
  }
}

async function buildImportContext(): Promise<ImportContext> {
  const { householdId } = await getHouseholdScope();
  const accounts = await prisma.account.findMany({
    where: { householdId, isPlaceholder: { not: true } },
    select: {
      id: true,
      name: true,
      kind: true,
      investProductType: true,
      tradingCalendar: true,
      billingDay: true,
      defaultConfirmDays: true,
      defaultArrivalDays: true,
      fundUnitsDecimals: true,
      numberMasked: true,
      Institution: { select: { name: true, shortName: true } },
      AccountAlias: { select: { alias: true } },
    },
  });
  const accountIdByMatchKey = new Map<string, string>();
  for (const account of accounts) indexAccountLookup(accountIdByMatchKey, account);
  return {
    householdId,
    accountIdByMatchKey,
    accountLookupRows: accounts,
    navLookupCache: new Map(),
    fundNameLookupCache: new Map(),
    inferredCashAccountByFundAccountId: new Map(),
    requestContext: null,
  };
}

async function resolveFundNameByCode(ctx: ImportContext, fundCode: string) {
  const code = String(fundCode ?? "").trim();
  if (!code) return null;
  const existing = ctx.fundNameLookupCache.get(code);
  if (existing) return existing;

  const lookup = (async () => {
    const resolved = await resolveFundName(code, { householdId: ctx.householdId }).catch(() => null);
    const resolvedName = normalizeUsableFundName(resolved, code);
    if (resolvedName) return resolvedName;

    const latestNav = await getLatestFundNav(code).catch(() => null);
    return normalizeUsableFundName(latestNav?.name, code);
  })();
  ctx.fundNameLookupCache.set(code, lookup);
  return lookup;
}

function findAccountById(ctx: ImportContext, accountId: string | null | undefined) {
  const id = String(accountId ?? "").trim();
  return id ? ctx.accountLookupRows.find((item) => item.id === id) ?? null : null;
}

async function resolveAccount(
  ctx: ImportContext,
  accountName: string,
): Promise<AccountLookupRow | null> {
  const normalizedTarget = normalizeImportAccountMatchKey(accountName);
  if (!normalizedTarget) return null;
  const cachedId = ctx.accountIdByMatchKey.get(normalizedTarget);
  if (cachedId) return ctx.accountLookupRows.find((item) => item.id === cachedId) ?? null;
  const resolvedId = resolveImportAccountIdFromList(accountName, ctx.accountLookupRows);
  if (resolvedId) {
    for (const candidate of buildImportAccountInputCandidates(accountName)) {
      const key = normalizeImportAccountMatchKey(candidate);
      if (key) ctx.accountIdByMatchKey.set(key, resolvedId);
    }
    return ctx.accountLookupRows.find((item) => item.id === resolvedId) ?? null;
  }
  for (const account of ctx.accountLookupRows) {
    for (const candidate of buildImportAccountCandidates(account)) {
      const key = normalizeImportAccountMatchKey(candidate);
      if (!key) continue;
      if ((key.length >= 3 || normalizedTarget.length >= 3) && (normalizedTarget.includes(key) || key.includes(normalizedTarget))) {
        ctx.accountIdByMatchKey.set(normalizedTarget, account.id);
        return account;
      }
    }
  }
  return null;
}

async function resolveAccountInput(
  ctx: ImportContext,
  accountId: string | null | undefined,
  accountName: string,
) {
  return findAccountById(ctx, accountId) ?? (await resolveAccount(ctx, accountName));
}

async function resolveFundImportRequestContext(
  ctx: ImportContext,
  input: FundImportRequestContext | null | undefined,
): Promise<ResolvedFundImportRequestContext | null> {
  const rawFundAccount = String(input?.fundAccount ?? "").trim();
  const fundAccountMeta = await resolveAccountInput(ctx, input?.fundAccountId, rawFundAccount);
  const usableFundAccountMeta = isPureInvestmentAccount(fundAccountMeta) ? fundAccountMeta : null;
  const fundCode = String(input?.fundCode ?? "").trim() || null;
  const fundName = fundCode
    ? normalizeUsableFundName(input?.fundName, fundCode)
    : String(input?.fundName ?? "").trim() || null;
  if (!usableFundAccountMeta && !rawFundAccount && !fundCode && !fundName) return null;
  return {
    fundAccountMeta: usableFundAccountMeta,
    fundAccount: usableFundAccountMeta?.name ?? rawFundAccount,
    fundCode,
    fundName,
  };
}

function subtypeNeedsCashAccount(subtype: string, source: string) {
  return subtype === "buy"
    || subtype === "redeem"
    || subtype === "dividend_cash"
    || (subtype === "buy_failed" && source === "regular_invest_refund");
}

function canInferCashAccountFromContext(
  ctx: ImportContext,
  fundAccountMeta: AccountLookupRow | null,
) {
  return !!ctx.requestContext?.fundAccountMeta
    && !!fundAccountMeta
    && ctx.requestContext.fundAccountMeta.id === fundAccountMeta.id;
}

async function loadInferredCashAccountForFundAccount(
  ctx: ImportContext,
  fundAccountId: string,
) {
  const existing = ctx.inferredCashAccountByFundAccountId.get(fundAccountId);
  if (existing) return existing;

  const lookup = prisma.fundTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      fundAccountId,
      cashAccountId: { not: null },
      deletedAt: null,
    },
    select: {
      cashAccountId: true,
    },
    orderBy: [
      { createdAt: "desc" },
      { applyDate: "desc" },
    ],
    take: 100,
  }).then((rows) => {
    const stats = new Map<string, { count: number; firstIndex: number }>();
    rows.forEach((row, index) => {
      if (!row.cashAccountId) return;
      const current = stats.get(row.cashAccountId);
      if (current) {
        current.count += 1;
      } else {
        stats.set(row.cashAccountId, { count: 1, firstIndex: index });
      }
    });
    const best = Array.from(stats.entries()).sort((left, right) => {
      const countDiff = right[1].count - left[1].count;
      return countDiff || left[1].firstIndex - right[1].firstIndex;
    })[0]?.[0];
    const account = best ? ctx.accountLookupRows.find((item) => item.id === best) ?? null : null;
    return account && !isPureInvestmentAccount(account) ? account : null;
  });
  ctx.inferredCashAccountByFundAccountId.set(fundAccountId, lookup);
  return lookup;
}

function buildRuleOverrideMap(overrides: FundImportRuleOverride[] | undefined) {
  const map = new Map<string, ParsedRuleOverride>();
  for (const override of overrides ?? []) {
    const fundCode = String(override.fundCode ?? "").trim();
    if (!fundCode) continue;
    const fundAccountId = String(override.fundAccountId ?? "").trim() || null;
    const fundAccountKey = normalizeImportAccountMatchKey(String(override.fundAccount ?? "").trim()) || null;
    if (!fundAccountId && !fundAccountKey) continue;
    const key = `${fundAccountId ?? fundAccountKey}::${fundCode}`;
    const next: ParsedRuleOverride = {
      fundAccountId,
      fundAccountKey,
      fundCode,
    };
    if (override.confirmDays != null) {
      next.confirmDays = normalizeNonNegativeDays(override.confirmDays, 0);
    }
    if (override.arrivalDays != null) {
      next.arrivalDays = normalizeNonNegativeDays(override.arrivalDays, 2);
    }
    map.set(key, next);
  }
  return map;
}

function findRuleOverride(
  overrideMap: Map<string, ParsedRuleOverride>,
  fundAccountMeta: AccountLookupRow | null,
  fundAccount: string,
  fundCode: string,
) {
  const normalizedFundCode = String(fundCode ?? "").trim();
  if (!normalizedFundCode) return null;
  if (fundAccountMeta?.id) {
    const matched = overrideMap.get(`${fundAccountMeta.id}::${normalizedFundCode}`);
    if (matched) return matched;
  }
  const accountKey = normalizeImportAccountMatchKey(fundAccount);
  if (!accountKey) return null;
  return overrideMap.get(`${accountKey}::${normalizedFundCode}`) ?? null;
}

async function enrichImportItem(
  ctx: ImportContext,
  input: FundImportInput,
  overrideMap: Map<string, ParsedRuleOverride>,
): Promise<FundImportEnrichedItem> {
  const sourceCalculatedFields = importCalculatedFieldSet(input);
  const calculatedFields = new Set<FundImportCalculatedField>();
  const date = String(input.date ?? "").trim();
  const rawSubtype = String(input.fundSubtype ?? "");
  const subtype = normalizeSubtype(rawSubtype);
  const source = normalizeSource(String(input.source ?? ""), subtype, rawSubtype);
  const isDividendReinvest = subtype === "dividend_reinvest";
  let cashAccount = isDividendReinvest ? "" : String(input.cashAccount ?? "").trim();
  let fundAccount = String(input.fundAccount ?? "").trim();
  let fundCode = String(input.fundCode ?? "").trim();
  const contextFundCodeUsed = !fundCode && !!ctx.requestContext?.fundCode;
  if (contextFundCodeUsed && ctx.requestContext?.fundCode) fundCode = ctx.requestContext.fundCode;
  const supportedFundCode = isSupportedFundCode(fundCode);
  const amount = amountForSubtype(Number(input.amount ?? 0), subtype);
  const issues: ImportIssue[] = [];

  const inputCashAccountId = isDividendReinvest ? "" : String(input.cashAccountId ?? "").trim();
  const inputFundAccountId = String(input.fundAccountId ?? "").trim();
  const hasCashAccountInput = !isDividendReinvest && (!!inputCashAccountId || !!cashAccount);
  const hasFundAccountInput = !!inputFundAccountId || !!fundAccount;

  let cashAccountMeta = hasCashAccountInput
    ? await resolveAccountInput(ctx, inputCashAccountId, cashAccount)
    : null;
  let fundAccountMeta = hasFundAccountInput
    ? await resolveAccountInput(ctx, inputFundAccountId, fundAccount)
    : null;

  if (!hasFundAccountInput && ctx.requestContext?.fundAccountMeta) {
    fundAccountMeta = ctx.requestContext.fundAccountMeta;
    fundAccount = ctx.requestContext.fundAccount || fundAccountMeta.name;
  } else if (fundAccountMeta) {
    fundAccount = fundAccountMeta.name;
  } else if (!fundAccount && inputFundAccountId) {
    fundAccount = inputFundAccountId;
  }

  const needsCashAccount = subtypeNeedsCashAccount(subtype, source);
  if (!hasCashAccountInput && needsCashAccount && fundAccountMeta && canInferCashAccountFromContext(ctx, fundAccountMeta)) {
    cashAccountMeta = await loadInferredCashAccountForFundAccount(ctx, fundAccountMeta.id);
    if (cashAccountMeta) cashAccount = cashAccountMeta.name;
  } else if (cashAccountMeta) {
    cashAccount = cashAccountMeta.name;
  } else if (!cashAccount && inputCashAccountId) {
    cashAccount = inputCashAccountId;
  }

  if (!date) issues.push({ level: "error", message: "缺少日期" });
  if (!subtype) issues.push({ level: "error", message: "基金动作无效，仅支持买入、赎回、现金分红、红利再投" });
  if (!fundAccount) issues.push({ level: "error", message: "缺少基金账户" });
  else if (!fundAccountMeta) issues.push({ level: "error", message: `基金账户“${fundAccount}”未匹配` });
  else if (!isPureInvestmentAccount(fundAccountMeta)) issues.push({ level: "error", message: `基金账户“${fundAccount}”不是开放式基金账户` });

  if (needsCashAccount && !cashAccount) {
    issues.push({ level: "error", code: "MISSING_CASH_ACCOUNT", message: "MISSING_CASH_ACCOUNT" });
  } else if (cashAccount) {
    if (!cashAccountMeta) issues.push({ level: "error", message: `资金账户“${cashAccount}”未匹配，无法建立资金流水关联` });
    else if (isPureInvestmentAccount(cashAccountMeta)) issues.push({ level: "error", message: `资金账户“${cashAccount}”不是资金侧账户` });
  }
  if (!fundCode) issues.push({ level: "error", message: "缺少基金代码" });
  else if (!supportedFundCode) issues.push({ level: "error", code: "INVALID_FUND_CODE", message: "INVALID_FUND_CODE" });
  const canResolveDividendReinvestUnits =
    subtype === "dividend_reinvest" &&
    (parsePositiveNumber(input.units) != null || (amount > 0 && parsePositiveNumber(input.nav) != null));
  if (subtype === "dividend_reinvest" ? !canResolveDividendReinvestUnits : !(amount > 0)) {
    issues.push({ level: "error", message: "金额无效" });
  }

  let confirmDays: number | null = null;
  let arrivalDays: number | null = null;
  let confirmDate = normalizeImportDatePart(String(input.confirmDate ?? "").trim()) ?? null;
  let nav = parseUserPositiveNumber(input, "nav", sourceCalculatedFields);
  let fee = parseUserNonNegativeNumber(input, "fee", sourceCalculatedFields);
  const feeRateInput = sourceCalculatedFields.has("feeRate")
    ? null
    : parseNonNegativeNumber(input.feeRateInput ?? input.feeRate);
  let units = parseUserPositiveNumber(input, "units", sourceCalculatedFields);
  let feeRate: number | null = fee == null ? feeRateInput : 0;
  let fundName = firstUsableFundName(fundCode, input.fundName, contextFundCodeUsed ? ctx.requestContext?.fundName : null);
  let arrivalDate = normalizeImportDatePart(String(input.arrivalDate ?? "").trim()) ?? null;
  const remark = String(input.remark ?? "").trim();
  const tags = parseTagNamesInput(input.tags).join(",");

  if (fundAccountMeta && fundCode && supportedFundCode && date) {
    const override = findRuleOverride(overrideMap, fundAccountMeta, fundAccount, fundCode);
    const confirmRule = await getFundConfirmRule(fundAccountMeta.id, fundCode, {
      days: fundAccountMeta.defaultConfirmDays,
      arrivalDays: fundAccountMeta.defaultArrivalDays,
    });
    confirmDays = override?.confirmDays ?? confirmRule.days;
    arrivalDays = override?.arrivalDays ?? confirmRule.arrivalDays;
    if (!confirmDate && (subtype === "buy" || (subtype === "buy_failed" && source === "regular_invest_refund"))) {
      confirmDate = deriveBuyNavDate(date, confirmDays, fundAccountMeta.tradingCalendar);
    } else if (!confirmDate && subtype === "dividend_reinvest") {
      confirmDate = normalizeImportDatePart(date);
    } else if (!confirmDate) {
      confirmDate = normalizeImportDatePart(date);
    }
    if (!arrivalDate && (subtype === "buy" || (subtype === "buy_failed" && source === "regular_invest_refund")) && date && arrivalDays != null) {
      arrivalDate = addImportTradingDays(date, arrivalDays, fundAccountMeta.tradingCalendar);
    } else if (!arrivalDate && subtype === "dividend_cash" && date && arrivalDays != null) {
      arrivalDate = addImportTradingDays(date, arrivalDays, fundAccountMeta.tradingCalendar);
    }

    if (nav == null && confirmDate && (subtype === "buy" || subtype === "redeem" || subtype === "dividend_reinvest")) {
      const navDate = toUtcDate(confirmDate);
      const navKey = `${fundAccountMeta.id}:${fundCode}:${confirmDate}`;
      let navLookup = ctx.navLookupCache.get(navKey);
      if (!navLookup) {
        navLookup = getFundNav(fundCode, navDate, fundAccountMeta.id).catch(() => null);
        ctx.navLookupCache.set(navKey, navLookup);
      }
      const navData = await navLookup;
      if (navData?.dateMatch && navData.nav > 0) {
        nav = navData.nav;
        calculatedFields.add("nav");
        fundName = fundName ?? normalizeUsableFundName(navData.name, fundCode);
      }
    }

    if (fee == null && feeRateInput != null) {
      fee = Number((amount * (feeRateInput / 100)).toFixed(2));
      calculatedFields.add("fee");
    } else if (fee == null) {
      const feeType = subtype === "redeem" ? "redeem" : "buy";
      const baseDate = confirmDate ? toUtcDate(confirmDate) : toUtcDate(date);
      let feeRateRaw = await getFundFeeRateByDate(fundAccountMeta.id, fundCode, baseDate, feeType).catch(() => 0);
      if (!feeRateRaw) {
        feeRateRaw = await getFundFeeRate(fundAccountMeta.id, fundCode, feeType).catch(() => 0);
      }
      feeRate = feeRateRaw || 0;
      calculatedFields.add("feeRate");
      if (feeRate > 0 && (subtype === "buy" || subtype === "redeem")) {
        fee = Number((amount * (feeRate / 100)).toFixed(2));
        calculatedFields.add("fee");
      }
    } else {
      feeRate = 0;
    }

    if ((subtype === "buy" || subtype === "dividend_reinvest") && units == null && nav != null) {
      const fundUnitsDecimals = normalizeFundUnitsDecimals(fundAccountMeta.fundUnitsDecimals);
      units = calculateConfirmedBuyUnits({
        grossAmount: amount,
        refundAmount: 0,
        fee: subtype === "buy" ? fee : 0,
        nav,
        roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
      });
      calculatedFields.add("units");
    }
  }

  if (!fundName && fundCode && supportedFundCode) fundName = await resolveFundNameByCode(ctx, fundCode);
  if (!fundName && fundCode) fundName = fundCode;

  return {
    rawText: String(input.rawText ?? "").trim() || JSON.stringify(input),
    date,
    fundSubtype: subtype,
    source,
    cashAccount,
    fundAccount,
    fundCode,
    fundName,
    amount,
    units,
    nav,
    fee,
    confirmDate,
    arrivalDate,
    remark,
    tags,
    feeRate,
    confirmDays,
    arrivalDays,
    cashAccountId: isDividendReinvest ? null : cashAccountMeta?.id ?? null,
    fundAccountId: fundAccountMeta?.id ?? null,
    fundProductType: fundAccountMeta?.investProductType ?? "fund",
    calculatedFields: sortedCalculatedFields(calculatedFields),
    issues,
  };
}

async function createFundTransaction(tx: Prisma.TransactionClient, householdId: string, item: FundImportEnrichedItem) {
  if (!item.fundAccountId) throw new Error("基金账户未匹配");
  const fundAccount = await tx.account.findUnique({
    where: { id: item.fundAccountId },
    select: { id: true, name: true, investProductType: true, fundUnitsDecimals: true, tradingCalendar: true },
  });
  if (!fundAccount) throw new Error("基金账户不存在");
  const subtype = normalizeSubtype(item.fundSubtype);
  const source = normalizeSource(item.source, subtype, item.fundSubtype);
  const amountAbs = Math.abs(item.amount);
  const redeemLike = subtype === "redeem";
  const isDividendCash = subtype === "dividend_cash";
  const isDividendReinvest = subtype === "dividend_reinvest";
  const isBuyFailedRefund = subtype === "buy_failed" && source === "regular_invest_refund";
  const finalFundSubtype = isDividendReinvest ? FundSubtype.buy : subtype as FundSubtype;
  const cashAccount = !isDividendReinvest && item.cashAccountId
    ? await tx.account.findUnique({ where: { id: item.cashAccountId }, select: { id: true, name: true } })
    : null;
  if (!isDividendReinvest && item.cashAccount && !item.cashAccountId) throw new Error(`资金账户“${item.cashAccount}”未匹配，无法建立资金流水关联`);
  if (!isDividendReinvest && item.cashAccountId && !cashAccount) throw new Error(`资金账户“${item.cashAccount || item.cashAccountId}”不存在，无法建立资金流水关联`);

  const confirmDate = item.confirmDate ? toUtcDate(item.confirmDate) : null;
  const arrivalDate = item.arrivalDate ? toUtcDate(item.arrivalDate) : (
    (subtype === "buy" || isBuyFailedRefund) && item.date && item.arrivalDays != null
      ? toUtcDate(addTradingDaysUtc(item.date, item.arrivalDays, fundAccount.tradingCalendar))
      : null
  );
  const recordDate = toUtcDate(item.date);
  const importFundUnitsDecimals = normalizeFundUnitsDecimals(fundAccount.fundUnitsDecimals);
  const normalizedUnits = (subtype === "buy" || isDividendReinvest) && item.units == null && item.nav != null
    ? calculateConfirmedBuyUnits({
      grossAmount: amountAbs,
      refundAmount: 0,
      fee: subtype === "buy" ? item.fee : 0,
      nav: item.nav,
      roundUnits: (value) => roundFundUnits(value, importFundUnitsDecimals),
    })
    : item.units;
  const storedFundName = normalizeUsableFundName(item.fundName, item.fundCode) ?? item.fundCode;

  const cashFlows: FundCashFlowInput[] = [];
  if (cashAccount && !isDividendReinvest) {
    const cashAmount = redeemLike || isDividendCash || isBuyFailedRefund ? amountAbs : -amountAbs;
    const kind = isBuyFailedRefund
      ? FundCashFlowKind.refund_in
      : redeemLike
        ? FundCashFlowKind.redeem_in
        : isDividendCash
          ? FundCashFlowKind.dividend_in
          : FundCashFlowKind.buy_out;
    cashFlows.push({
      kind,
      date: isBuyFailedRefund || redeemLike || isDividendCash ? arrivalDate ?? recordDate : recordDate,
      accountId: cashAccount.id,
      accountName: cashAccount.name,
      amount: cashAmount,
      source,
      note: item.remark || storedFundName,
    });
  }

  const created = await createFundTransactionWithCashFlows(tx, {
    householdId,
    fundAccountId: fundAccount.id,
    cashAccountId: isDividendReinvest ? null : cashAccount?.id ?? null,
    fundCode: item.fundCode,
    fundName: storedFundName,
    fundProductType: item.fundProductType ?? "fund",
    fundSubtype: finalFundSubtype,
    source,
    applyDate: recordDate,
    confirmDate,
    arrivalDate,
    grossAmount: isDividendReinvest ? 0 : amountAbs,
    refundAmount: isBuyFailedRefund ? amountAbs : 0,
    arrivalAmount: isDividendReinvest ? null : redeemLike || isDividendCash || isBuyFailedRefund ? amountAbs : null,
    fee: isDividendReinvest ? null : item.fee ?? null,
    nav: item.nav ?? null,
    units: normalizedUnits ?? null,
    note: item.remark || null,
    cashFlows,
  });

  return {
    id: created.cashEntry?.id ?? created.fundTransaction.id,
    fundTransactionId: created.fundTransaction.id,
    cashEntryId: created.cashEntry?.id ?? null,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as null | {
      mode?: "preview" | "import";
      items?: FundImportInput[] | FundImportEnrichedItem[];
      overrides?: FundImportRuleOverride[];
      context?: FundImportRequestContext | null;
    };
    const mode = body?.mode === "import" ? "import" : "preview";
    if (mode === "import" && isReadOnly(await getCurrentUser())) {
      return NextResponse.json(
        { ok: false, code: "READ_ONLY", error: "Read-only users cannot import data." },
        { status: 403, headers: corsHeaders() },
      );
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    const overrideMap = buildRuleOverrideMap(Array.isArray(body?.overrides) ? body.overrides : []);
    if (items.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_IMPORT_ITEMS", error: "缺少导入记录" }, { status: 400, headers: corsHeaders() });
    }

    const ctx = await buildImportContext();
    ctx.requestContext = await resolveFundImportRequestContext(ctx, body?.context);
    const enrichedItems = await mapWithConcurrency(
      items as FundImportInput[],
      ENRICH_CONCURRENCY,
      (item) => enrichImportItem(ctx, item, overrideMap),
    );

    if (mode === "preview") {
      return NextResponse.json({ ok: true, items: enrichedItems }, { headers: corsHeaders() });
    }

    const blockingIssues = enrichedItems.flatMap((item, index) =>
      item.issues.filter((issue) => issue.level === "error").map((issue) => `第 ${index + 1} 条：${issue.message}`),
    );
    if (blockingIssues.length > 0) {
      return NextResponse.json(
        { ok: false, code: "IMPORT_VALIDATION_FAILED", error: `导入前校验未通过：${blockingIssues.join("；")}` },
        { status: 400, headers: corsHeaders() },
      );
    }

    const { householdId } = await getHouseholdScope();
    const created = await prisma.$transaction(async (tx) => {
      const rows: Array<Awaited<ReturnType<typeof createFundTransaction>>> = [];
      const persistedRuleKeys = new Set<string>();
      for (const item of enrichedItems) {
        if (item.fundAccountId && item.fundCode) {
          const ruleKey = `${item.fundAccountId}::${item.fundCode}`;
          const override = overrideMap.get(ruleKey);
          if (override && !persistedRuleKeys.has(ruleKey)) {
            await setFundConfirmRuleInTx(
              tx,
              item.fundAccountId,
              item.fundCode,
              override.confirmDays ?? item.confirmDays ?? 0,
              override.arrivalDays ?? item.arrivalDays ?? 2,
            );
            persistedRuleKeys.add(ruleKey);
          }
        }
        rows.push(await createFundTransaction(tx, householdId, item));
        const cashEntryId = rows[rows.length - 1]?.cashEntryId ?? null;
        if (cashEntryId && item.tags) {
          await attachEntryTagsByNames({
            tx,
            entryId: cashEntryId,
            householdId,
            names: parseTagNamesInput(item.tags),
          });
        }
      }
      return rows;
    }, {
      maxWait: 10_000,
      timeout: 60_000,
    });

    const fundAccountIds = new Set<string>();
    const cashAccountIds = new Set<string>();
    for (const item of enrichedItems) {
      if (item.fundAccountId) fundAccountIds.add(item.fundAccountId);
      if (item.cashAccountId) cashAccountIds.add(item.cashAccountId);
    }

    for (const accountId of fundAccountIds) {
      const fundCodes = Array.from(new Set(enrichedItems.filter((item) => item.fundAccountId === accountId).map((item) => item.fundCode)));
      await recalcFundPositions(accountId, fundCodes).catch(() => {});
      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }
    for (const accountId of cashAccountIds) {
      if (!fundAccountIds.has(accountId)) await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }

    return NextResponse.json(
      { ok: true, createdCount: created.length, ids: created.map((item) => item.id), items: enrichedItems },
      { headers: corsHeaders() },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "IMPORT_FAILED", error: error instanceof Error ? error.message : "基金导入失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
