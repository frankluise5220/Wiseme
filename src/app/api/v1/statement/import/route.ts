import { NextResponse } from "next/server";
import { z } from "zod";
import { AccountKind } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, toStatementMonth } from "@/lib/date-utils";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { normalizeDefaultCategoryHierarchyForHousehold, resolveCategorySnapshot } from "@/lib/default-categories";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { expandImportBankName, isImportPaymentTailSourceHint, normalizeImportAccountMatchKey, parseImportAccountId, resolveImportAccountFromList } from "@/lib/account-import-match";
import { INCOME_EXPENSE_INSTITUTION_TYPES } from "@/lib/institution-rules";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";
import { resolveDebtAccountByCounterpartyName } from "@/lib/server/import-debt-account";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { refreshCreditCardCycleCachesForAccountIds } from "@/lib/server/credit-bill-page-data";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import {
  CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
  mergeCreditCardCycleLockSources,
} from "@/lib/credit/billing";
import { upsertStatementCategoryRuleFromTx } from "@/lib/statement/category-rules";
import { upsertStatementInstitutionRuleFromUserEdit } from "@/lib/statement/recognition-rules";
import { ENTRY_ORIGIN_EMAIL_IMPORT, ENTRY_ORIGIN_EXCEL_IMPORT } from "@/lib/transaction-semantics";

export const runtime = "nodejs";

type Db = typeof prisma;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function getProvidedApiKey(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

function requireApiKey(req: Request) {
  const required = (process.env.STATEMENT_API_KEY ?? "").trim();
  if (!required) return { ok: true as const };
  const provided = getProvidedApiKey(req);
  if (!provided || provided !== required) return { ok: false as const };
  return { ok: true as const };
}

const ParsedItemSchema = z.object({
  rawText: z.string(),
  type: z.enum(["expense", "income", "transfer", "investment"]),
  date: z.string().optional(),
  amount: z.number().finite().min(0),
  outflow: z.number().finite().min(0).optional(),
  inflow: z.number().finite().min(0).optional(),
  account: z.string().optional(),
  fromAccount: z.string().optional(),
  toAccount: z.string().optional(),
  category: z.string().optional(),
  categoryUserEdited: z.boolean().optional(),
  institutionUserEdited: z.boolean().optional(),
  remark: z.string().optional(),
  counterparty: z.string().optional(),
  institution: z.string().optional(),
  postedDate: z.string().optional(),
  currency: z.string().optional(),
  transferDirection: z.enum(["in", "out"]).optional(),
  _meta: z.object({
    institutionName: z.string().optional(),
    ownerName: z.string().optional(),
    cardNumberMasked: z.string().optional(),
    statementCurrency: z.string().optional(),
    minimumPayment: z.number().finite().optional(),
    creditLimit: z.number().optional(),
    billingDay: z.number().int().min(1).max(31).optional(),
    repaymentDay: z.number().int().min(1).max(31).optional(),
    statementAmount: z.number().finite().optional(),
    statementPeriodStart: z.string().optional(),
    statementPeriodEnd: z.string().optional(),
    statementDueDate: z.string().optional(),
  }).optional(),
});

type ParsedItem = z.infer<typeof ParsedItemSchema>;
type ParsedItemMeta = NonNullable<ParsedItem["_meta"]>;
type ImportOptions = {
  autoCreateAccounts: boolean;
  importBatchId?: string | null;
  createdAccounts?: Array<{ id: string; name: string; kind: string; institutionName?: string | null }>;
};

const MailSourceSchema = z.object({
  emailAccountId: z.string().min(1),
  uid: z.number().int().min(1),
  hash: z.string().min(16).max(128).optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  date: z.string().optional(),
});

type MailSource = z.infer<typeof MailSourceSchema>;

function buildMailImportNote(mailSource: Pick<MailSource, "emailAccountId" | "uid">) {
  return `email:${mailSource.emailAccountId}:${mailSource.uid}`;
}

function normalizeHash(value?: string | null) {
  const hash = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{32,128}$/.test(hash) ? hash : "";
}

function normalizeFingerprintPart(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function buildStatementFingerprint(items: ParsedItem[], defaultAccountName?: string) {
  const firstMeta = items.find((item) => item._meta)?._meta;
  const cardNumberMasked =
    normalizeFingerprintPart(firstMeta?.cardNumberMasked) ||
    normalizeFingerprintPart(items.map((item) => [item.account, item.fromAccount, item.toAccount].join(" ")).join(" ").match(/(\d{4})(?!.*\d)/)?.[1]) ||
    normalizeFingerprintPart(defaultAccountName?.match(/(\d{4})(?!.*\d)/)?.[1]);
  const datedItems = items
    .map((item) => normalizeFingerprintPart(item.date).slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort((a, b) => a.localeCompare(b));
  const metaStatementPeriod = firstMeta?.statementPeriodStart || firstMeta?.statementPeriodEnd
    ? `${normalizeFingerprintPart(firstMeta.statementPeriodStart)}~${normalizeFingerprintPart(firstMeta.statementPeriodEnd)}`
    : "";
  const statementPeriod = metaStatementPeriod || (datedItems.length > 0
    ? `${datedItems[0]}~${datedItems[datedItems.length - 1]}`
    : normalizeFingerprintPart(items.find((item) => item.postedDate)?.postedDate).slice(0, 7));
  const payload = {
    version: 2,
    institutionName: normalizeFingerprintPart(
      firstMeta?.institutionName ||
      items.find((item) => item._meta?.institutionName)?._meta?.institutionName ||
      items.find((item) => item.institution)?.institution,
    ),
    cardNumberMasked,
    statementPeriod,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function parseDate(date?: string) {
  const raw = String(date ?? "").trim();
  if (!raw) return new Date();
  const match = raw.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日)?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    return new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
      Number(match[6] ?? 0),
    ));
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function normalizeDateOnlyText(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日)?/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseDateOnlyUtc(value?: string | null) {
  const normalized = normalizeDateOnlyText(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDateUtc(date?: Date | null) {
  if (!date) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function statementMonthForAccountId(tx: Db, accountId: string | null, date: Date) {
  if (!accountId) return null;
  const acc = await tx.account.findUnique({ where: { id: accountId }, select: { kind: true, billingDay: true, billingDayTxPeriod: true } });
  if (!acc) return null;
  if (acc.kind !== AccountKind.bank_credit && acc.kind !== AccountKind.loan) return null;
  if (!acc.billingDay) return null;
  return toStatementMonth(date, acc.billingDay, acc.billingDayTxPeriod);
}

type StatementBillLock = {
  storageAccountId: string;
  billAccountIds: string[];
  statementMonth: string;
  amount?: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dueDate?: Date | null;
};

type ManualRecordConflictDetail = {
  accountId: string;
  statementMonth: string;
  count: number;
  recordIds: string[];
};

/**
 * Detect manual (hand-entered) records that fall inside the statement periods
 * covered by the items being imported. Scope is precise: same household, the
 * credit-card bill accounts (including shared bill accounts) resolved from the
 * item metadata, and the statement month derived from the period/posted date.
 * Manual transfers whose toAccountId is a bill account are matched by either
 * statement month or the period date range, because transfers may not carry a
 * statement month.
 */
async function detectManualRecordConflicts(
  tx: Db,
  householdId: string,
  items: ParsedItem[],
): Promise<{ total: number; details: ManualRecordConflictDetail[] }> {
  type PeriodScope = { accountIds: string[]; months: Set<string>; periodStart: Date | null; periodEnd: Date | null };
  const scopeByCardMonth = new Map<string, PeriodScope>();

  for (const item of items) {
    const meta = item._meta;
    const accountName = pickAccountName(item.account) || pickAccountName(item.toAccount, pickAccountName(item.fromAccount));
    const isCreditCard = Boolean(
      meta?.cardNumberMasked ||
      meta?.statementAmount !== undefined ||
      meta?.statementPeriodStart ||
      meta?.statementPeriodEnd ||
      isCreditAccountText(accountName),
    );
    if (!isCreditCard) continue;

    const account = await findCreditAccount(tx, householdId, accountName, meta);
    if (!account?.billingDay) continue;

    const fullAccount = await tx.account.findUnique({
      where: { id: account.id },
      select: {
        id: true,
        householdId: true,
        institutionId: true,
        kind: true,
        creditBillMode: true,
      },
    });
    const billAccountIds = fullAccount
      ? await getCreditBillAccountIds(tx, fullAccount)
      : [account.id];
    const periodStart = parseDateOnlyUtc(meta?.statementPeriodStart);
    const periodEnd = parseDateOnlyUtc(meta?.statementPeriodEnd);
    const statementDate = periodEnd ?? postedDateForStatement(item, parseDate(item.date));
    const statementMonth = toStatementMonth(statementDate, account.billingDay, account.billingDayTxPeriod);
    const key = `${account.id}:${statementMonth}`;
    const scope = scopeByCardMonth.get(key) ?? {
      accountIds: [],
      months: new Set<string>(),
      periodStart,
      periodEnd,
    };
    for (const id of billAccountIds.length > 0 ? billAccountIds : [account.id]) scope.accountIds.push(id);
    scope.months.add(statementMonth);
    scope.periodStart = scope.periodStart ?? periodStart;
    scope.periodEnd = scope.periodEnd ?? periodEnd;
    scopeByCardMonth.set(key, scope);
  }

  const details: ManualRecordConflictDetail[] = [];
  for (const [key, scope] of scopeByCardMonth) {
    const accountIds = Array.from(new Set(scope.accountIds));
    const months = Array.from(scope.months);
    const accountId = key.split(":")[0] ?? "";

    const accountFilters: Record<string, unknown>[] = [
      { accountId: { in: accountIds }, statementMonth: { in: months } },
      { toAccountId: { in: accountIds }, statementMonth: { in: months } },
    ];
    if (scope.periodStart && scope.periodEnd) {
      accountFilters.push({
        toAccountId: { in: accountIds },
        date: { gte: scope.periodStart, lt: addDaysUtc(scope.periodEnd, 1) },
      });
    }

    const records = await tx.txRecord.findMany({
      where: {
        householdId,
        deletedAt: null,
        AND: [
          { OR: [{ source: "manual" }, { source: null }] },
          { OR: accountFilters },
        ],
      },
      select: { id: true },
    });
    if (records.length > 0) {
      details.push({
        accountId,
        statementMonth: months[0] ?? "",
        count: records.length,
        recordIds: records.map((record) => record.id),
      });
    }
  }

  const total = details.reduce((sum, detail) => sum + detail.count, 0);
  return { total, details };
}

async function statementBillLockForImportedRecord(tx: Db, householdId: string, item: ParsedItem, record: { accountId: string | null; toAccountId: string | null }): Promise<StatementBillLock | null> {
  const amount = Number.isFinite(item._meta?.statementAmount) ? item._meta?.statementAmount : undefined;
  const periodStart = parseDateOnlyUtc(item._meta?.statementPeriodStart);
  const periodEnd = parseDateOnlyUtc(item._meta?.statementPeriodEnd);
  const dueDate = parseDateOnlyUtc(item._meta?.statementDueDate);
  if (amount === undefined && !periodStart && !periodEnd && !dueDate) return null;
  const candidateIds = [record.toAccountId, record.accountId].filter((id): id is string => Boolean(id));
  if (candidateIds.length === 0) return null;
  const accounts = await tx.account.findMany({
    where: {
      id: { in: candidateIds },
      householdId,
      kind: AccountKind.bank_credit,
      billingDay: { not: null },
    },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      kind: true,
      billingDay: true,
      billingDayTxPeriod: true,
      creditBillMode: true,
    },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const account = candidateIds.map((id) => accountById.get(id)).find(Boolean);
  if (!account?.billingDay) return null;

  const billAccountIds = await getCreditBillAccountIds(tx, account);
  const statementMonth = toStatementMonth(periodEnd ?? postedDateForStatement(item, parseDate(item.date)), account.billingDay, account.billingDayTxPeriod);
  return {
    storageAccountId: billAccountIds[0] ?? account.id,
    billAccountIds,
    statementMonth,
    amount,
    periodStart,
    periodEnd,
    dueDate,
  };
}

async function lockImportedStatementBills(tx: Db, locks: StatementBillLock[]) {
  const latestByKey = new Map<string, StatementBillLock>();
  for (const lock of locks) {
    const key = `${lock.storageAccountId}:${lock.statementMonth}`;
    const existing = latestByKey.get(key);
    latestByKey.set(key, {
      ...existing,
      ...lock,
      billAccountIds: Array.from(new Set([...(existing?.billAccountIds ?? []), ...lock.billAccountIds])),
      amount: lock.amount ?? existing?.amount,
      periodStart: lock.periodStart ?? existing?.periodStart,
      periodEnd: lock.periodEnd ?? existing?.periodEnd,
      dueDate: lock.dueDate ?? existing?.dueDate,
    });
  }
  const uniqueLocks = Array.from(latestByKey.values());
  for (const lock of uniqueLocks) {
    if (lock.periodStart && lock.periodEnd) {
      const existingCycle = await tx.creditCardCycle.findUnique({
        where: {
          accountId_statementMonth: {
            accountId: lock.storageAccountId,
            statementMonth: lock.statementMonth,
          },
        },
        select: { lockSource: true, dueDate: true },
      });
      const now = new Date();
      const isCurrentCycle = now >= lock.periodStart && now < addDaysUtc(lock.periodEnd, 1);
      const lockSource = mergeCreditCardCycleLockSources(
        existingCycle?.lockSource,
        CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
      );
      await tx.creditCardCycle.upsert({
        where: {
          accountId_statementMonth: {
            accountId: lock.storageAccountId,
            statementMonth: lock.statementMonth,
          },
        },
        create: {
          accountId: lock.storageAccountId,
          statementMonth: lock.statementMonth,
          periodStart: lock.periodStart,
          periodEnd: lock.periodEnd,
          dueDate: lock.dueDate ?? null,
          expenseAbs: "0",
          income: "0",
          paid: "0",
          rawBill: "0",
          effectiveBill: "0",
          cumulativeRemain: "0",
          cumulativeOverpaid: "0",
          isCurrentCycle,
          isLocked: true,
          lockSource,
        },
        update: {
          periodStart: lock.periodStart,
          periodEnd: lock.periodEnd,
          dueDate: lock.dueDate ?? existingCycle?.dueDate ?? null,
          isCurrentCycle,
          isLocked: true,
          lockSource,
        },
      });
    }

    if (lock.amount !== undefined && Number.isFinite(lock.amount)) {
      await tx.billOverride.upsert({
        where: {
          accountId_statementMonth: {
            accountId: lock.storageAccountId,
            statementMonth: lock.statementMonth,
          },
        },
        create: {
          accountId: lock.storageAccountId,
          statementMonth: lock.statementMonth,
          amount: String(lock.amount),
          note: "statement_import",
        },
        update: {
          amount: String(lock.amount),
          note: "statement_import",
        },
      });
    }
  }
  await invalidateCreditCardCycleCacheForAccountIds(uniqueLocks.flatMap((lock) => lock.billAccountIds));
  return uniqueLocks;
}

async function accountCurrencyMeta(tx: Db, accountId: string | null) {
  if (!accountId) return null;
  return tx.account.findUnique({
    where: { id: accountId },
    select: { name: true, currency: true },
  });
}

function postedDateForStatement(item: ParsedItem, fallbackDate: Date) {
  const postedDateText = normalizeDateOnlyText(item.postedDate);
  const postedDate = postedDateText ? parseDate(postedDateText) : null;
  return postedDate && !Number.isNaN(postedDate.getTime()) ? postedDate : fallbackDate;
}

function normalizeAccountCell(value?: string) {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v === "无" || v === "-" || v.toLowerCase() === "none") return "";
  if (v === "未识别账户") return "";
  return v;
}

function pickAccountName(value?: string, defaultAccountName?: string) {
  const normalized = normalizeAccountCell(value);
  if (normalized) return normalized;
  const fallback = normalizeAccountCell(defaultAccountName);
  return fallback;
}

async function resolveAccountId(tx: Db, householdId: string, accountName?: string) {
  if (!accountName) return null;
  const found = await tx.account.findFirst({ where: { householdId, name: accountName } });
  return found?.id ?? null;
}

function stripOwnerPrefix(value: string) {
  const match = value.trim().match(/^(.+?)的(.+)$/);
  return match?.[2]?.trim() || value.trim();
}

function creditAccountNameCore(meta?: ParsedItemMeta) {
  const bank = String(meta?.institutionName ?? "").trim();
  if (!bank) return "";
  const last4 = String(meta?.cardNumberMasked ?? "").trim();
  return `${bank}信用卡${last4 ? `(${last4})` : ""}`;
}

function creditAccountNameCandidates(accountName: string, meta?: ParsedItemMeta) {
  const names = new Set<string>();
  const name = normalizeAccountCell(accountName);
  if (name) {
    names.add(name);
    names.add(stripOwnerPrefix(name));
  }
  const core = creditAccountNameCore(meta);
  if (core) {
    names.add(core);
    const ownerName = String(meta?.ownerName ?? "").trim();
    if (ownerName) names.add(`${ownerName}的${core}`);
  }
  return Array.from(names).filter(Boolean);
}

function inferCardLast4(accountName: string, meta?: ParsedItemMeta) {
  const fromMeta = String(meta?.cardNumberMasked ?? "").trim();
  if (fromMeta) return fromMeta;
  const match = String(accountName ?? "").match(/(\d{4})(?!.*\d)/);
  return match?.[1] ?? "";
}

function isCreditAccountText(value?: string | null) {
  return /信用卡|贷记卡/i.test(String(value ?? ""));
}

async function ensureDefaultAccountGroupId(tx: Db, householdId: string) {
  const existing = await tx.accountGroup.findFirst({ where: { householdId, name: "未指定" } });
  if (existing?.id) return existing.id;
  const legacy = await tx.accountGroup.findFirst({ where: { householdId, name: "默认" } });
  if (legacy?.id) {
    try {
      await tx.accountGroup.update({ where: { id: legacy.id }, data: { name: "未指定" } });
    } catch {}
    return legacy.id;
  }
  try {
    const created = await tx.accountGroup.create({
      data: {
        name: "未指定",
        sortOrder: 0,
        householdId,
      },
    });
    return created.id;
  } catch {
    const retry = await tx.accountGroup.findFirst({ where: { householdId, name: "未指定" } });
    return retry?.id ?? null;
  }
}

function normalizeInstitutionKey(value: string) {
  return normalizeImportAccountMatchKey(value);
}

async function findInstitution(tx: Db, householdId: string, institutionName?: string) {
  const name = String(institutionName ?? "").trim();
  if (!name) return null;
  const targetKeys = expandImportBankName(name).map(normalizeInstitutionKey).filter(Boolean);
  const key = normalizeInstitutionKey(name);
  if (!targetKeys.includes(key)) targetKeys.push(key);
  const institutions = await tx.institution.findMany({
    where: { householdId, type: { in: [...INCOME_EXPENSE_INSTITUTION_TYPES] } },
    select: { id: true, name: true, shortName: true, type: true },
  });
  const exactKey = normalizeInstitutionKey(name);
  const exact = institutions.find((item) => {
    const nameKey = normalizeInstitutionKey(item.name);
    const shortKey = normalizeInstitutionKey(item.shortName ?? "");
    return nameKey === exactKey || (!!shortKey && shortKey === exactKey);
  });
  if (exact) return exact;
  return institutions.find((item) => {
    const itemKeys = [
      item.name,
      item.shortName ?? "",
      ...expandImportBankName(item.name),
      ...expandImportBankName(item.shortName ?? ""),
    ].map(normalizeInstitutionKey).filter(Boolean);
    return targetKeys.some((targetKey) =>
      itemKeys.some((itemKey) => itemKey === targetKey || itemKey.includes(targetKey) || targetKey.includes(itemKey)),
    );
  }) ?? null;
}

async function findExistingImportAccount(tx: Db, householdId: string, accountName: string) {
  const accounts = await tx.account.findMany({
    where: {
      householdId,
      isPlaceholder: { not: true },
    },
    select: {
      id: true,
      name: true,
      kind: true,
      numberMasked: true,
      Institution: { select: { name: true, shortName: true } },
      AccountAlias: { select: { alias: true } },
    },
  });
  return resolveImportAccountFromList(accountName, accounts);
}

async function ensureBankInstitutionId(tx: Db, householdId: string, institutionName?: string) {
  const name = String(institutionName ?? "").trim();
  if (!name) return null;
  const existing = await findInstitution(tx, householdId, name);
  if (existing) return existing.id;
  await assertInstitutionDisplayNamesUnique(tx, { householdId, name });
  const created = await tx.institution.create({
    data: {
      name,
      shortName: null,
      type: "bank",
      householdId,
    },
  });
  return created.id;
}

async function resolveUserIdByName(tx: Db, householdId: string, ownerName?: string) {
  const name = String(ownerName ?? "").trim();
  if (!name) return null;
  const user = await tx.user.findFirst({
    where: { householdId, name },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function findCreditAccount(tx: Db, householdId: string, accountName: string, meta?: ParsedItemMeta) {
  const last4 = inferCardLast4(accountName, meta);
  const bank = await findInstitution(tx, householdId, meta?.institutionName);
  const exactName = normalizeAccountCell(accountName);
  const sharedCandidates = await tx.account.findMany({
    where: {
      householdId,
      kind: AccountKind.bank_credit,
      isPlaceholder: { not: true },
    },
    select: {
      id: true,
      name: true,
      kind: true,
      institutionId: true,
      userId: true,
      numberMasked: true,
      currency: true,
      creditLimit: true,
      billingDay: true,
      billingDayTxPeriod: true,
      repaymentDay: true,
      updatedAt: true,
      Institution: { select: { name: true, shortName: true } },
      AccountAlias: { select: { alias: true } },
    },
  });
  const sharedMatch = resolveImportAccountFromList(
    creditAccountNameCandidates(accountName, meta)[0] ?? accountName,
    sharedCandidates,
  );
  if (sharedMatch) return sharedMatch;

  if (exactName && (!last4 || exactName !== last4)) {
    const exact = await tx.account.findFirst({
      where: {
        householdId,
        name: exactName,
        kind: AccountKind.bank_credit,
        ...(bank?.id ? { institutionId: bank.id } : {}),
        ...(last4 ? {
          OR: [
            { numberMasked: last4 },
            { name: last4 },
            { name: { contains: last4 } },
          ],
        } : {}),
      },
      select: {
        id: true,
        name: true,
        kind: true,
        institutionId: true,
        userId: true,
        numberMasked: true,
        currency: true,
        creditLimit: true,
        billingDay: true,
        billingDayTxPeriod: true,
        repaymentDay: true,
        updatedAt: true,
      },
    });
    if (exact) return exact;
  }

  if (last4) {
    const matches = await tx.account.findMany({
      where: {
        householdId,
        kind: AccountKind.bank_credit,
        ...(bank?.id ? { institutionId: bank.id } : {}),
        OR: [
          { numberMasked: last4 },
          { name: last4 },
          { name: { contains: last4 } },
        ],
      },
      select: {
        id: true,
        name: true,
        kind: true,
        institutionId: true,
        userId: true,
        numberMasked: true,
        creditLimit: true,
        billingDay: true,
        billingDayTxPeriod: true,
        repaymentDay: true,
        updatedAt: true,
      },
      orderBy: [
        { updatedAt: "desc" },
      ],
      take: 10,
    });
    const ranked = matches.sort((a, b) => {
      const score = (item: (typeof matches)[number]) =>
        (item.numberMasked === last4 ? 100 : 0) +
        (item.name === last4 ? -20 : 0) +
        (bank?.id && item.institutionId === bank.id ? 10 : 0);
      const byScore = score(b) - score(a);
      if (byScore !== 0) return byScore;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    if (bank?.id) return ranked[0] ?? null;
    if (ranked.length === 1 || ranked[0]?.numberMasked === last4) return ranked[0] ?? null;
  }

  const names = creditAccountNameCandidates(accountName, meta);
  if (names.length > 0) {
    const byName = await tx.account.findFirst({
      where: { householdId, name: { in: names } },
      select: {
        id: true,
        name: true,
        kind: true,
        institutionId: true,
        userId: true,
        numberMasked: true,
        creditLimit: true,
        billingDay: true,
        billingDayTxPeriod: true,
        repaymentDay: true,
        updatedAt: true,
      },
    });
    if (byName) return byName;
  }

  if (!last4) return null;
  const matches = await tx.account.findMany({
    where: {
      householdId,
      kind: AccountKind.bank_credit,
      ...(bank?.id ? { institutionId: bank.id } : {}),
      OR: [
        { numberMasked: last4 },
        { name: last4 },
        { name: { contains: last4 } },
      ],
    },
    select: {
      id: true,
      name: true,
      kind: true,
      institutionId: true,
      userId: true,
      numberMasked: true,
      currency: true,
      creditLimit: true,
      billingDay: true,
      billingDayTxPeriod: true,
      repaymentDay: true,
      updatedAt: true,
    },
    take: 2,
  });
  if (bank?.id) return matches[0] ?? null;
  return matches.length === 1 ? matches[0] : null;
}

async function updateCreditAccountMeta(tx: Db, householdId: string, accountId: string, meta?: ParsedItemMeta) {
  if (!meta) return;
  const existing = await tx.account.findUnique({
    where: { id: accountId },
    select: {
      kind: true,
      institutionId: true,
      userId: true,
      numberMasked: true,
      currency: true,
      creditLimit: true,
      billingDay: true,
      billingDayTxPeriod: true,
      repaymentDay: true,
    },
  });
  if (!existing) return;

  const data: any = {};
  if (existing.kind !== AccountKind.bank_credit && (meta.institutionName || meta.cardNumberMasked)) {
    data.kind = AccountKind.bank_credit;
    data.debtDirection = "payable";
  }
  if (!existing.institutionId && meta.institutionName) {
    data.institutionId = await ensureBankInstitutionId(tx, householdId, meta.institutionName);
  }
  if (!existing.userId && meta.ownerName) {
    data.userId = await resolveUserIdByName(tx, householdId, meta.ownerName);
  }
  if (!existing.numberMasked && meta.cardNumberMasked) data.numberMasked = meta.cardNumberMasked;
  if (!existing.currency && meta.statementCurrency) data.currency = normalizeCurrency(meta.statementCurrency);
  if (meta.creditLimit != null && Number(existing.creditLimit ?? NaN) !== meta.creditLimit) data.creditLimit = String(meta.creditLimit);
  if (meta.billingDay && existing.billingDay !== meta.billingDay) data.billingDay = meta.billingDay;
  if (meta.repaymentDay && existing.repaymentDay !== meta.repaymentDay) data.repaymentDay = meta.repaymentDay;

  const filtered = Object.fromEntries(Object.entries(data).filter(([, value]) => value != null && value !== ""));
  if (Object.keys(filtered).length > 0) {
    await tx.account.update({ where: { id: accountId }, data: filtered });
  }
}

async function ensureAccountId(tx: Db, householdId: string, accountName?: string, _meta?: ParsedItemMeta, options: ImportOptions = { autoCreateAccounts: true }) {
  const name = normalizeAccountCell(accountName);
  if (!name) return null;
  const directAccountId = parseImportAccountId(name);
  if (directAccountId) {
    const found = await tx.account.findFirst({
      where: { id: directAccountId, householdId },
      select: { id: true },
    });
    if (found?.id) return found.id;
    throw new Error(`账户不存在：${name}`);
  }
  if (isImportPaymentTailSourceHint(name)) {
    const matchedTailAccount = await findExistingImportAccount(tx, householdId, name);
    if (matchedTailAccount?.id) return matchedTailAccount.id;
    throw new Error(`未找到付款尾号对应账户：${name}`);
  }
  // When the account name matches the "<owner>'s debt" naming convention and a Counterparty exists,
  // resolve or create the loan account linked to that counterparty.
  const debtAccountId = await resolveDebtAccountByCounterpartyName(tx, householdId, name);
  if (debtAccountId) return debtAccountId;
  const inferredLast4 = inferCardLast4(name, _meta);
  const isCreditCard = !!(_meta?.cardNumberMasked || isCreditAccountText(name));
  const existingCredit = isCreditCard ? await findCreditAccount(tx, householdId, name, _meta) : null;
  if (existingCredit?.id) {
    await updateCreditAccountMeta(tx, householdId, existingCredit.id, _meta);
    return existingCredit.id;
  }

  const matchedAccount = await findExistingImportAccount(tx, householdId, name);
  if (matchedAccount?.id) {
    if (isCreditCard) await updateCreditAccountMeta(tx, householdId, matchedAccount.id, _meta);
    return matchedAccount.id;
  }

  const existingId = await resolveAccountId(tx, householdId, name);
  if (existingId) {
    if (isCreditCard) await updateCreditAccountMeta(tx, householdId, existingId, _meta);
    return existingId;
  }

  if (!options.autoCreateAccounts) {
    throw new Error(`账户不存在：${name}`);
  }

  const groupId = await ensureDefaultAccountGroupId(tx, householdId);
  if (!groupId) return null;

  const accountData: any = { name, householdId, groupId };

  if (isCreditCard) {
    accountData.kind = AccountKind.bank_credit;
    accountData.debtDirection = "payable";
    accountData.institutionId = await ensureBankInstitutionId(tx, householdId, _meta?.institutionName);
    accountData.userId = await resolveUserIdByName(tx, householdId, _meta?.ownerName);
    accountData.numberMasked = inferredLast4 || null;
    accountData.currency = normalizeCurrency(_meta?.statementCurrency);
    accountData.creditLimit = _meta?.creditLimit != null ? String(_meta.creditLimit) : null;
    accountData.billingDay = _meta?.billingDay ?? null;
    accountData.repaymentDay = _meta?.repaymentDay ?? null;
  }

  try {
    const created = await tx.account.create({ data: accountData });
    options.createdAccounts?.push({
      id: created.id,
      name: created.name,
      kind: created.kind,
      institutionName: _meta?.institutionName ?? null,
    });
    return created.id;
  } catch {
    return (await resolveAccountId(tx, householdId, name)) ?? null;
  }
}

async function resolveInstitution(tx: Db, householdId: string, institutionName?: string) {
  const name = String(institutionName ?? "").trim();
  if (!name) return { id: null as string | null, name: null as string | null };
  const found = await findInstitution(tx, householdId, name);
  return { id: found?.id ?? null, name: found?.name ?? null };
}

function sourceKeywordForInstitutionLearning(item: ParsedItem) {
  return String(item.counterparty ?? item.remark ?? item.rawText ?? "").trim();
}

function buildNote(item: ParsedItem) {
  const base = (item.remark ?? item.rawText ?? "").trim();
  const postedDate = normalizeDateOnlyText(item.postedDate);
  const tradeDate = normalizeDateOnlyText(item.date);
  if (postedDate && postedDate !== tradeDate && !base.includes("入账日") && !base.includes("入账日期") && !base.includes("记账日")) {
    return `${base}（入账日期 ${postedDate}）`;
  }
  return base;
}

async function createTransactionFromItem(tx: Db, householdId: string, item: ParsedItem, defaultAccountName?: string, options: ImportOptions = { autoCreateAccounts: true }) {
  const date = parseDate(item.date);
  const confirmDate = postedDateForStatement(item, date);
  const meta = item._meta;
  const counterpartyInstitution = await resolveInstitution(tx, householdId, item.institution);
  const note = buildNote(item);

  if (item.type === "transfer") {
    const from = normalizeAccountCell(item.fromAccount);
    const to = pickAccountName(item.toAccount, pickAccountName(item.account, defaultAccountName));
    if (!from || !to) {
      throw new Error("转账缺少转出/转入账户");
    }
  }

  const shouldUseDoubleEntry =
    item.type === "transfer" ||
    (item.type === "investment" && !!item.fromAccount && !!item.toAccount);

  const amountAbs = Number.isFinite(item.amount) ? Math.abs(item.amount) : 0;

  if (shouldUseDoubleEntry) {
    const fromAccountName = normalizeAccountCell(item.fromAccount);
    const toAccountName = pickAccountName(item.toAccount, pickAccountName(item.account, defaultAccountName));
    const transferAccountOptions = item.type === "transfer"
      ? { ...options, autoCreateAccounts: false }
      : options;

    const [fromAccountId, toAccountId] = await Promise.all([
      ensureAccountId(tx, householdId, fromAccountName, undefined, transferAccountOptions),
      ensureAccountId(tx, householdId, toAccountName, undefined, transferAccountOptions),
    ]);
    if (item.type === "transfer" && (!fromAccountId || !toAccountId)) {
      throw new Error("转账账户未匹配，不能导入");
    }

    const fromStatementMonth = await statementMonthForAccountId(tx, fromAccountId, confirmDate);
    const [fromCurrencyMeta, toCurrencyMeta] = await Promise.all([
      accountCurrencyMeta(tx, fromAccountId),
      accountCurrencyMeta(tx, toAccountId),
    ]);
    const transactionCurrency = item.type === "transfer" && fromCurrencyMeta && toCurrencyMeta
      ? resolveSameCurrencyTransfer(fromCurrencyMeta, toCurrencyMeta)
      : normalizeCurrency(fromCurrencyMeta?.currency ?? toCurrencyMeta?.currency);

    // For investment type, query account kinds to determine fund fields
    let fundCode: string | null = null;
    let fundSubtype: string | null = null;
    let investAccId: string | null = null;
    let investAccName: string | null = null;

    if (item.type === "investment") {
      const rawText = item.rawText ?? "";
      const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
      fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
      const fromAccKind: any = await tx.account.findUnique({ where: { id: fromAccountId! } });
      const toAccKind: any = await tx.account.findUnique({ where: { id: toAccountId! } });
      const isFromInvest = fromAccKind?.kind === "investment";
      const isToInvest = toAccKind?.kind === "investment";
      investAccId = isToInvest ? toAccountId : isFromInvest ? fromAccountId : null;
      investAccName = isToInvest ? toAccountName : isFromInvest ? fromAccountName : null;
      const isRedeem = /赎回|卖出/.test(rawText);
      fundSubtype = isRedeem ? "redeem" : "buy";
    }

    const displayFundCode = investAccId && investAccName ? (fundCode || investAccName) : null;
    const txRecord = await tx.txRecord.create({
      data: {
        type: item.type as any,
        date,
        amount: -amountAbs,
        accountId: fromAccountId ?? undefined,
        accountName: fromAccountName || "未识别账户",
        toAccountId: investAccId || toAccountId || undefined,
        toAccountName: investAccName || toAccountName || "未识别账户",
        householdId,
        note,
        confirmDate: item.postedDate ? confirmDate : undefined,
        counterpartyInstitutionId: counterpartyInstitution.id,
        counterpartyInstitutionName: counterpartyInstitution.name,
        statementMonth: fromStatementMonth ?? undefined,
        importBatchId: options.importBatchId ?? undefined,
        source: options.importBatchId ? "statement_import" : "manual",
        entryOrigin: options.importBatchId ? ENTRY_ORIGIN_EMAIL_IMPORT : ENTRY_ORIGIN_EXCEL_IMPORT,
        currency: transactionCurrency,
      } as any,
    });

    return txRecord;
  }

  const accountName = pickAccountName(item.account, defaultAccountName);
  const [accountId, category] = await Promise.all([
    ensureAccountId(tx, householdId, accountName, meta, options),
    resolveCategorySnapshot(tx, householdId, {
      categoryName: item.category,
      type: item.type === "income" ? "income" : item.type === "expense" ? "expense" : null,
    }),
  ]);
  if (!accountId) {
    throw new Error("Account is required and must match an existing account");
  }
  const statementMonth = await statementMonthForAccountId(tx, accountId, confirmDate);
  const currencyMeta = await accountCurrencyMeta(tx, accountId);

  const inflowAbs = Number.isFinite(item.inflow) ? Math.abs(item.inflow ?? 0) : 0;
  const outflowAbs = Number.isFinite(item.outflow) ? Math.abs(item.outflow ?? 0) : 0;
  const isExpenseRefund = item.type === "expense" && inflowAbs > 0 && outflowAbs <= 0;
  const sign = item.type === "income" || isExpenseRefund ? 1 : -1;
  const amount = sign * (amountAbs || inflowAbs || outflowAbs);

  // For investment type, query account kind to determine fund fields
  let fundCode: string | null = null;
  let fundSubtype: string | null = null;
  let isInvestAccount = false;
  let investAccountName: string | null = null;

  if (item.type === "investment" && accountId) {
    const rawText = item.rawText ?? "";
    const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
    fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
    const acc = await tx.account.findUnique({ where: { id: accountId }, select: { kind: true, name: true } });
    isInvestAccount = acc?.kind === "investment";
    investAccountName = acc?.name ?? null;
    const isRedeem = /赎回|卖出/.test(rawText);
    fundSubtype = isRedeem ? "redeem" : "buy";
  }

  const displayFundCode = isInvestAccount && investAccountName ? (fundCode || investAccountName) : null;
  const txRecord = await tx.txRecord.create({
    data: {
      type: item.type as any,
      date,
      postedAt: item.type === "expense" || item.type === "income" ? confirmDate : null,
      amount,
      accountId: accountId ?? "",
      accountName: currencyMeta?.name || accountName || "未识别账户",
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      toAccountId: isInvestAccount ? accountId : null,
      toAccountName: isInvestAccount ? investAccountName : null,
      householdId,
      note,
      confirmDate: item.postedDate ? confirmDate : undefined,
      counterpartyInstitutionId: counterpartyInstitution.id,
      counterpartyInstitutionName: counterpartyInstitution.name,
      statementMonth,
      importBatchId: options.importBatchId ?? undefined,
      source: options.importBatchId ? "statement_import" : "manual",
      entryOrigin: options.importBatchId ? ENTRY_ORIGIN_EMAIL_IMPORT : ENTRY_ORIGIN_EXCEL_IMPORT,
      currency: normalizeCurrency(currencyMeta?.currency),
    },
  });

  if (item.categoryUserEdited && category?.id && category.name && (item.type === "income" || item.type === "expense")) {
    await upsertStatementCategoryRuleFromTx(tx, {
      householdId,
      type: item.type,
      categoryId: category.id,
      categoryName: category.name,
      counterpartyInstitutionName: counterpartyInstitution.name,
      paymentChannelName: null,
      source: "user_statement_preview_edit",
      note,
    });
  }

  if (item.institutionUserEdited && counterpartyInstitution.id && counterpartyInstitution.name) {
    await upsertStatementInstitutionRuleFromUserEdit(tx, {
      householdId,
      institutionId: counterpartyInstitution.id,
      institutionName: counterpartyInstitution.name,
      keyword: sourceKeywordForInstitutionLearning(item),
      transactionType: item.type === "income" || item.type === "expense" ? item.type : "any",
      source: "user_statement_preview_institution_edit",
    });
  }

  return txRecord;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * POST /api/v1/statement/import
 * Import parsed transaction items from bill recognition, quick add, or credit-card mail.
 *
 * Body: { items, defaultAccountName?, autoCreateAccounts?, mailSource?, manualRecordConflictPolicy? }
 * - item.type is one of expense/income/transfer/investment.
 * - item.amount is the absolute display amount for statement-import callers.
 * - item.inflow/item.outflow may carry account-side direction. For an original-spend
 *   refund, send { type: "expense", amount, inflow: amount } so the row offsets the
 *   original expense category while increasing the account balance.
 * - item.categoryUserEdited=true means the user manually changed the preview
 *   category; only these confirmed income/expense rows are learned into
 *   statement category rules and mirrored into
 *   statement_recognition_rules(targetType="category").
 * - item.institutionUserEdited=true means the user manually filled/selected
 *   a counterparty institution; only values that match the Institution table
 *   are saved and learned. Unmatched institutions are left blank.
 * - transfer rows use fromAccount/toAccount and may carry transferDirection.
 *   Both sides must match existing accounts; incomplete transfers are skipped.
 * - item._meta may carry statementAmount, statementPeriodStart,
 *   statementPeriodEnd, statementDueDate, and creditLimit from a bank statement.
 *
 * Returns: { ok: true, createdCount, skippedCount, ids, importBatchId?, lockedStatementBills?, createdAccounts?, errors }
 * - lockedStatementBills items may include amount, periodStart, periodEnd, and dueDate.
 */
export async function POST(req: Request) {
  const currentUser = await getCurrentUser();
  if (!currentUser && !requireApiKey(req).ok) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const body = (await req.json().catch(() => null)) as null | {
    items?: unknown;
    defaultAccountName?: unknown;
    autoCreateAccounts?: unknown;
    mailSource?: unknown;
  };

  const parse = z
    .object({
      items: z.array(ParsedItemSchema).min(1),
      defaultAccountName: z.string().optional(),
      autoCreateAccounts: z.boolean().optional().default(true),
      mailSource: MailSourceSchema.optional(),
      manualRecordConflictPolicy: z.enum(["overwrite", "keep"]).optional(),
    })
    .safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, code: "INVALID_ITEMS_FORMAT", error: "items 格式不正确" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const items = parse.data.items;
  const defaultAccountName = parse.data.defaultAccountName;
  const options: ImportOptions = { autoCreateAccounts: parse.data.autoCreateAccounts, createdAccounts: [] };
  const { householdId } = await getHouseholdScope();
  await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);

  const created: { id: string }[] = [];
  const touchedAccountIds = new Set<string>();
  const errors: Array<{ index: number; rawText: string; error: string }> = [];
  const statementBillLocks: StatementBillLock[] = [];
  const mailSource = parse.data.mailSource;
  const statementFingerprint = mailSource ? buildStatementFingerprint(items, defaultAccountName) : "";
  let importBatchId: string | null = null;

  // Credit-card mail import: before creating the import batch, check whether
  // manual records already exist for the same household + bill accounts +
  // statement periods. Without a policy, return a structured conflict so the
  // caller can ask the user; with "overwrite", soft-delete only the exact
  // conflicting manual records; with "keep", import alongside them.
  let deletedManualRecordCount = 0;
  if (mailSource) {
    const conflict = await detectManualRecordConflicts(prisma, householdId, items);
    if (conflict.total > 0) {
      if (!parse.data.manualRecordConflictPolicy) {
        return NextResponse.json({
          ok: false,
          code: "MANUAL_RECORD_CONFLICT",
          error: "Manual records exist in the same statement period",
          conflict: {
            total: conflict.total,
            details: conflict.details.map((detail) => ({
              accountId: detail.accountId,
              statementMonth: detail.statementMonth,
              count: detail.count,
            })),
          },
        }, { headers: corsHeaders() });
      }
      if (parse.data.manualRecordConflictPolicy === "overwrite") {
        const conflictIds = conflict.details.flatMap((detail) => detail.recordIds);
        if (conflictIds.length > 0) {
          const deleted = await prisma.txRecord.updateMany({
            where: {
              id: { in: conflictIds },
              householdId,
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
          deletedManualRecordCount = deleted.count;
        }
      }
    }
  }

  if (mailSource) {
    const mailHash = normalizeHash(mailSource.hash);
    const importBatch = await prisma.importBatch.create({
      data: {
        source: "credit_bill_mail",
        note: buildMailImportNote(mailSource),
        rawText: JSON.stringify({
          emailAccountId: mailSource.emailAccountId,
          uid: mailSource.uid,
          mailHash,
          statementFingerprint,
          subject: mailSource.subject ?? "",
          from: mailSource.from ?? "",
          date: mailSource.date ?? "",
        }),
        householdId,
      },
      select: { id: true },
    });
    importBatchId = importBatch.id;
    options.importBatchId = importBatch.id;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const createdRecord = await createTransactionFromItem(prisma, householdId, item, defaultAccountName, options);
      created.push({ id: createdRecord.id });
      if (createdRecord.accountId) touchedAccountIds.add(createdRecord.accountId);
      if (createdRecord.toAccountId) touchedAccountIds.add(createdRecord.toAccountId);
      const statementBillLock = await statementBillLockForImportedRecord(prisma, householdId, item, {
        accountId: createdRecord.accountId,
        toAccountId: createdRecord.toAccountId,
      });
      if (statementBillLock) statementBillLocks.push(statementBillLock);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      errors.push({ index: i, rawText: item.rawText, error: msg });
    }
  }

  const lockedStatementBills = statementBillLocks.length > 0
    ? await lockImportedStatementBills(prisma, statementBillLocks)
    : [];

  await refreshCreditCardCycleCachesForAccountIds({
    householdId,
    accountIds: touchedAccountIds,
  }).catch((error) => {
    console.error("Failed to refresh credit-card cycles after statement import:", error);
  });

  if (importBatchId && created.length === 0) {
    await prisma.importBatch.delete({ where: { id: importBatchId } }).catch(() => null);
    importBatchId = null;
  }

  // Client-side handles page refresh
  revalidateAfterTxChange();
  return NextResponse.json({
    ok: true,
    createdCount: created.length,
    skippedCount: errors.length,
    ids: created.map((t) => t.id),
    importBatchId,
    deletedManualRecordCount,
    lockedStatementBills: lockedStatementBills.map((lock) => ({
      accountId: lock.storageAccountId,
      billAccountIds: lock.billAccountIds,
      statementMonth: lock.statementMonth,
      amount: lock.amount,
      periodStart: formatDateUtc(lock.periodStart),
      periodEnd: formatDateUtc(lock.periodEnd),
      dueDate: formatDateUtc(lock.dueDate),
    })),
    createdAccounts: options.createdAccounts ?? [],
    errors,
  }, { headers: corsHeaders() });
}
