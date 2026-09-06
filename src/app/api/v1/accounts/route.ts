import { NextRequest, NextResponse } from "next/server";
import { AccountKind, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import { verifyPassword } from "@/lib/auth/password";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import { resolveTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import {
  getCreditCardInstitutionDefaults,
  normalizeCreditBillMode,
  syncCreditCardInstitutionSettings,
} from "@/lib/server/credit-card-institution-settings";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import {
  accountSupportsNumberMasked,
  assertAccountIdentityUnique,
  isAccountIdentityUniqueError,
} from "@/lib/server/account-identity-unique";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { BALANCE_INITIALIZATION_SOURCE, encodeBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { ensureBrokerageCashAccountForStockAccount } from "@/lib/server/brokerage-cash-account";
import {
  ACCOUNT_INSTITUTION_REQUIRED_ERROR,
  ACCOUNT_INSTITUTION_TYPE_ERROR,
  STOCK_ACCOUNT_INSTITUTION_ERROR,
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  isConsumerLoanInstitutionType,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";
import { normalizeCurrency } from "@/lib/currency";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";
import { normalizeDebtDirection } from "@/lib/debt";
import { normalizeLoanType } from "@/lib/loan-type";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import {
  ensureInitialCreditCardBillingDayRules,
  recordCreditCardBillingDayChange,
} from "@/lib/server/credit-card-billing-day-rules";

export const runtime = "nodejs";

/**
 * /api/v1/accounts account-type contract:
 * - settlement accounts require counterpartyId and never store institutionId or loanType.
 * - loan accounts require an institutionId, never store counterpartyId, and support loanType home/mortgage/consumer/other.
 */

const costBasisMethods = ["moving_avg", "fifo", "lifo"] as const;

function normalizeFundProductType(raw: unknown) {
  const value = String(raw ?? "").trim();
  return PRODUCT_TYPES.includes(value as (typeof PRODUCT_TYPES)[number]) ? value : "fund";
}

function normalizeCostBasisMethod(raw: unknown) {
  const value = String(raw ?? "").trim();
  return costBasisMethods.includes(value as (typeof costBasisMethods)[number]) ? value : "moving_avg";
}

function parseDay(raw: unknown) {
  if (raw === undefined) return undefined;
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n > 31) return undefined;
  return n;
}

function parseDateOnly(raw: unknown) {
  const value = String(raw ?? "").trim();
  if (!value) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function groupCreditCardIdsByBillingDay(rows: Array<{ id: string; billingDay: number | null }>) {
  const groups = new Map<number, string[]>();
  for (const row of rows) {
    if (row.billingDay == null) continue;
    const ids = groups.get(row.billingDay) ?? [];
    ids.push(row.id);
    groups.set(row.billingDay, ids);
  }
  return groups;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// === Internal: POST (create) ===
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const kind = (typeof body?.kind === "string" ? body.kind.trim() : "other") as any;
    const requestedGroupId = String(body.groupId ?? "").trim() || null;
    const requestedInstitutionId = String(body.institutionId ?? "").trim() || null;
    const requestedCounterpartyId = String(body.counterpartyId ?? "").trim() || null;
    const requestedUserId = String(body.userId ?? "").trim() || null;
    const rawIsConsumerLoan = body.isConsumerLoan === true || String(body.isConsumerLoan ?? "").trim().toLowerCase() === "true";
    const loanType = normalizeLoanType(body.loanType)
      ?? (kind === "loan" ? (rawIsConsumerLoan ? "consumer" : "home") : null);
    const isConsumerLoan = kind === "loan" && loanType === "consumer";
    const isInvestment = kind === "investment";
    const isCreditLike = kind === "bank_credit";
    const investProductType = isInvestment ? normalizeFundProductType(body.investProductType) : null;
    const fixedAssetType = isInvestment && investProductType === "property" ? normalizeFixedAssetType(body.fixedAssetType) : null;
    const tradingCalendar = resolveTradingCalendarForAccount(kind, investProductType, body.tradingCalendar);
    const initialBalanceRaw = String(body.initialBalance ?? "").trim();
    const initialBalance = initialBalanceRaw ? Number(initialBalanceRaw) : null;
    const initialBalanceDate = initialBalanceRaw ? parseDateOnly(body.initialBalanceDate) : null;

    if (isConsumerLoan && kind !== "loan") {
      return NextResponse.json({ ok: false, code: "CONSUMER_LOAN_KIND_REQUIRED", error: "Consumer loan accounts must use loan account kind" }, { status: 400 });
    }
    if (!name) return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "名称必填" }, { status: 400 });
    if (initialBalanceRaw && !Number.isFinite(initialBalance)) {
      return NextResponse.json({ ok: false, code: "INVALID_BALANCE", error: "余额必须是有效数字" }, { status: 400 });
    }
    if (initialBalanceRaw && !initialBalanceDate) {
      return NextResponse.json({ ok: false, code: "INVALID_DATE_FORMAT", error: "时间节点格式必须是 YYYY-MM-DD" }, { status: 400 });
    }

    const { householdId } = await getHouseholdScope();
    const currencyInput = String(body.currency ?? "").trim();
    const currency = normalizeCurrency(currencyInput || await getHouseholdBaseCurrency(householdId));

    const group = requestedGroupId
      ? await prisma.accountGroup.findFirst({ where: { id: requestedGroupId, householdId } })
      : await prisma.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    const ensuredGroup = group ?? { id: await getOrCreateDefaultAccountGroupId(prisma, householdId) };

    const institution = requestedInstitutionId
      ? await prisma.institution.findFirst({ where: { id: requestedInstitutionId, householdId } })
      : null;
    if (requestedInstitutionId && !institution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在或不属于当前账簿" }, { status: 400 });
    if (kind === "settlement" && requestedInstitutionId) {
      return NextResponse.json({ ok: false, code: "SETTLEMENT_INSTITUTION_FORBIDDEN", error: "Settlement accounts must be linked to a counterparty, not an institution" }, { status: 400 });
    }
    if (kind === "loan" && !institution) {
      return NextResponse.json({ ok: false, code: "LOAN_INSTITUTION_REQUIRED", error: "Loan accounts must be linked to a lending institution" }, { status: 400 });
    }
    if (accountRequiresInstitution(kind, investProductType) && !institution) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_INSTITUTION_REQUIRED", error: ACCOUNT_INSTITUTION_REQUIRED_ERROR }, { status: 400 });
    }
    if (kind === "loan" && (!institution || !isConsumerLoanInstitutionType(institution.type))) {
      return NextResponse.json({ ok: false, code: "LOAN_INSTITUTION_TYPE_REQUIRED", error: "Loan accounts must use bank, payment, or other lending institutions" }, { status: 400 });
    }
    if (isStockInvestmentAccount(kind, investProductType) && !isStockAccountInstitutionType(institution?.type)) {
      return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_INSTITUTION_REQUIRED", error: STOCK_ACCOUNT_INSTITUTION_ERROR }, { status: 400 });
    }
    if (institution && !accountInstitutionTypeIsAllowed(kind, investProductType, institution.type)) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_INSTITUTION_TYPE_MISMATCH", error: ACCOUNT_INSTITUTION_TYPE_ERROR }, { status: 400 });
    }
    const counterparty = requestedCounterpartyId
      ? await prisma.counterparty.findFirst({ where: { id: requestedCounterpartyId, householdId } })
      : null;
    if (requestedCounterpartyId && !counterparty) return NextResponse.json({ ok: false, code: "COUNTERPARTY_NOT_FOUND", error: "往来对象不存在或不属于当前账簿" }, { status: 400 });
    if (kind === "settlement" && !counterparty) {
      return NextResponse.json({ ok: false, code: "SETTLEMENT_COUNTERPARTY_REQUIRED", error: "Settlement accounts must be linked to a counterparty" }, { status: 400 });
    }
    if (kind === "loan" && requestedCounterpartyId) {
      return NextResponse.json({ ok: false, code: "LOAN_COUNTERPARTY_FORBIDDEN", error: "Loan accounts must not be linked to a counterparty" }, { status: 400 });
    }

    const owner = requestedUserId
      ? await prisma.user.findFirst({ where: { id: requestedUserId, householdId } })
      : null;
    if (requestedUserId && !owner) return NextResponse.json({ ok: false, code: "OWNER_NOT_FOUND", error: "所有人不存在或不属于当前账簿" }, { status: 400 });

    const creditDefaults = isCreditLike
      ? await getCreditCardInstitutionDefaults(prisma, householdId, institution?.id)
      : null;
    const requestedBillingDay = parseDay(body.billingDay);
    const requestedRepaymentDay = parseDay(body.repaymentDay);
    const billingDay = isCreditLike
      ? requestedBillingDay ?? creditDefaults?.billingDay ?? null
      : null;
    const repaymentDay = isCreditLike
      ? requestedRepaymentDay ?? creditDefaults?.repaymentDay ?? null
      : null;
    const creditLimit = isCreditLike
      ? String(body.creditLimit ?? "").trim() || creditDefaults?.creditLimit || null
      : null;
    const creditBillMode = isCreditLike
      ? body.creditBillMode !== undefined
        ? normalizeCreditBillMode(body.creditBillMode)
        : creditDefaults?.creditBillMode ?? normalizeCreditBillMode(null)
      : normalizeCreditBillMode(null);
    const numberMasked = accountSupportsNumberMasked(kind)
      ? String(body.numberMasked ?? "").trim() || null
      : null;
    const note = String(body.note ?? "").trim() || null;

    await assertAccountIdentityUnique(prisma, {
      householdId,
      groupId: ensuredGroup.id,
      institutionId: kind === "settlement" ? null : institution?.id ?? null,
      counterpartyId: kind === "settlement" ? counterparty?.id ?? null : null,
      kind,
      name,
      numberMasked,
    });

    const requestedDebtDirection = body.debtDirection !== undefined ? normalizeDebtDirection(kind, body.debtDirection) : null;
    const supportsDefaultFundQueryApi = isInvestment && (investProductType === "fund" || investProductType === "money");
    const shouldCreateInitialBalance = !isInvestment && initialBalance != null && initialBalance !== 0;
    let brokerageCashAccount: Awaited<ReturnType<typeof ensureBrokerageCashAccountForStockAccount>> = null;
    const account = await prisma.$transaction(async (tx) => {
      const createdAccount = await tx.account.create({
        data: {
          name,
          kind,
          debtDirection: kind === "bank_credit" || isConsumerLoan
            ? "payable"
            : kind === "loan"
              ? "payable"
              : kind === "settlement" && counterparty?.id
                ? requestedDebtDirection ?? "receivable"
              : null,
          isConsumerLoan,
          loanType,
          currency,
          groupId: ensuredGroup.id,
          institutionId: kind === "settlement" ? null : institution?.id ?? null,
          counterpartyId: kind === "settlement" ? counterparty?.id ?? null : null,
          userId: owner?.id ?? null,
          householdId,
          isActive: true,
          billingDay,
          repaymentDay,
          creditLimit,
          creditBillMode,
          numberMasked,
          note,
          investProductType: investProductType as any,
          fixedAssetType: fixedAssetType as any,
          costBasisMethod: isInvestment && supportsCostBasisMethod(investProductType) ? normalizeCostBasisMethod(body.costBasisMethod) as any : null,
          ...(tradingCalendar ? { tradingCalendar: tradingCalendar as any } : {}),
          defaultFundQueryApiId: supportsDefaultFundQueryApi ? String(body.defaultFundQueryApiId ?? "").trim() || null : null,
          fundUnitsDecimals: isInvestment ? normalizeFundUnitsDecimals(body.fundUnitsDecimals, 2) : 2,
        },
        include: {
          AccountGroup: { select: { id: true, name: true } },
          Institution: { select: { id: true, name: true, shortName: true, type: true } },
          Counterparty: { select: { id: true, name: true, shortName: true, type: true } },
        },
      });

      if (shouldCreateInitialBalance && initialBalanceDate) {
        const initialBalanceValue = initialBalance ?? 0;
        const isLiability = kind === "bank_credit" || kind === "loan" || kind === "settlement";
        const targetBalance = isLiability ? -Math.abs(initialBalanceValue) : initialBalanceValue;
        await tx.txRecord.create({
          data: {
            householdId,
            date: initialBalanceDate,
            type: TransactionType.income,
            accountId: createdAccount.id,
            accountName: createdAccount.name,
            amount: 0,
            categoryName: "初始余额",
            source: BALANCE_INITIALIZATION_SOURCE,
            note: null,
            toNote: encodeBalanceReconcileTarget(targetBalance),
            currency: createdAccount.currency,
          },
        });
      }

      if (createdAccount.kind === AccountKind.bank_credit) {
        await ensureInitialCreditCardBillingDayRules(tx, {
          accountIds: [createdAccount.id],
          billingDay: createdAccount.billingDay,
        });
      }

      if (createdAccount.kind === AccountKind.investment && createdAccount.investProductType === "stock") {
        brokerageCashAccount = await ensureBrokerageCashAccountForStockAccount(tx, createdAccount);
      }

      return createdAccount;
    });
    if (shouldCreateInitialBalance) {
      await recalcAndSaveAccountBalance(account.id);
    }
    if (isCreditLike) {
      await syncCreditCardInstitutionSettings(prisma, {
        householdId,
        institutionId: account.institutionId,
        billingDay: account.billingDay,
        repaymentDay: account.repaymentDay,
        creditBillMode: account.creditBillMode,
      });
      const institutionCards = account.institutionId
        ? await prisma.account.findMany({
            where: { householdId, institutionId: account.institutionId, kind: "bank_credit" },
            select: { id: true },
          })
        : [{ id: account.id }];
      const institutionCardIds = institutionCards.map((item) => item.id);
      await prisma.$transaction(async (tx) => {
        await ensureInitialCreditCardBillingDayRules(tx, {
          accountIds: institutionCardIds,
          billingDay: account.billingDay,
        });
      });
      await invalidateCreditCardCycleCacheForAccountIds(institutionCardIds, { deleteManualCycles: true });
    }
    revalidateAfterSettingsChange();
    // Client-side handles page refresh
    return NextResponse.json({ ok: true, account, brokerageCashAccount });
  } catch (e) {
    if (isAccountIdentityUniqueError(e)) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_IDENTITY_CONFLICT", error: e.message }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}

// === Internal: PUT (update) ===
export async function PUT(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    }

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.kind !== undefined) data.kind = String(body.kind).trim();
    if (body.currency !== undefined) {
      const currencyInput = String(body.currency ?? "").trim();
      data.currency = normalizeCurrency(currencyInput || await getHouseholdBaseCurrency(householdId));
    }
    if (body.groupId !== undefined) data.groupId = String(body.groupId).trim() || null;
    if (body.institutionId !== undefined) data.institutionId = String(body.institutionId).trim() || null;
    if (body.counterpartyId !== undefined) data.counterpartyId = String(body.counterpartyId).trim() || null;
    if (body.isConsumerLoan !== undefined) {
      data.isConsumerLoan = body.isConsumerLoan === true || String(body.isConsumerLoan ?? "").trim().toLowerCase() === "true";
    }
    if (body.note !== undefined) data.note = String(body.note ?? "").trim() || null;

    if (body.fundUnitsDecimals !== undefined) {
      data.fundUnitsDecimals = normalizeFundUnitsDecimals(body.fundUnitsDecimals ?? existing.fundUnitsDecimals);
    }

    const nextKind = String(data.kind ?? existing.kind);
    const rawNextIsConsumerLoan = data.isConsumerLoan === undefined ? existing.isConsumerLoan === true : data.isConsumerLoan === true;
    let nextIsConsumerLoan = false;
    if (nextKind === "loan") {
      const nextLoanType = normalizeLoanType(body.loanType)
        ?? normalizeLoanType(existing.loanType)
        ?? (rawNextIsConsumerLoan ? "consumer" : "home");
      data.loanType = nextLoanType;
      nextIsConsumerLoan = nextLoanType === "consumer";
      data.isConsumerLoan = nextIsConsumerLoan;
    } else {
      data.loanType = null;
      data.isConsumerLoan = false;
    }
    const nextCounterpartyId = nextKind === "settlement"
      ? data.counterpartyId === undefined
        ? existing.counterpartyId
        : data.counterpartyId
          ? String(data.counterpartyId)
          : null
      : null;
    const nextCounterparty = nextCounterpartyId
      ? await prisma.counterparty.findFirst({ where: { id: nextCounterpartyId, householdId } })
      : null;
    if (nextCounterpartyId && !nextCounterparty) return NextResponse.json({ ok: false, code: "COUNTERPARTY_NOT_FOUND", error: "往来对象不存在或不属于当前账簿" }, { status: 400 });
    if (nextKind === "settlement" && !nextCounterparty) {
      return NextResponse.json({ ok: false, code: "SETTLEMENT_COUNTERPARTY_REQUIRED", error: "Settlement accounts must be linked to a counterparty" }, { status: 400 });
    }
    if (nextKind === "loan" && body.counterpartyId !== undefined && String(body.counterpartyId ?? "").trim()) {
      return NextResponse.json({ ok: false, code: "LOAN_COUNTERPARTY_FORBIDDEN", error: "Loan accounts must not be linked to a counterparty" }, { status: 400 });
    }
    const requestedDebtDirection = body.debtDirection !== undefined ? normalizeDebtDirection(nextKind, body.debtDirection) : null;
    if (nextKind === "bank_credit") {
      data.billingDay = body.billingDay !== undefined ? parseDay(body.billingDay) : existing.billingDay;
      data.repaymentDay = body.repaymentDay !== undefined ? parseDay(body.repaymentDay) : existing.repaymentDay;
      data.creditLimit = body.creditLimit !== undefined ? (String(body.creditLimit ?? "").trim() || null) : existing.creditLimit;
      data.numberMasked = body.numberMasked !== undefined ? (String(body.numberMasked ?? "").trim() || null) : existing.numberMasked;
      data.creditBillMode = body.creditBillMode !== undefined
        ? normalizeCreditBillMode(body.creditBillMode)
        : existing.creditBillMode;
    } else {
      data.billingDay = null;
      data.repaymentDay = null;
      data.creditLimit = null;
      data.numberMasked = accountSupportsNumberMasked(nextKind)
        ? body.numberMasked !== undefined
          ? String(body.numberMasked ?? "").trim() || null
          : existing.numberMasked
        : null;
      data.creditBillMode = normalizeCreditBillMode(null);
    }
    if (nextKind === "settlement") {
      data.institutionId = null;
      data.counterpartyId = nextCounterparty?.id ?? null;
    } else {
      data.counterpartyId = null;
    }
    if (nextKind === "investment") {
      if (body.investProductType !== undefined || existing.kind !== "investment") data.investProductType = normalizeFundProductType(body.investProductType ?? existing.investProductType) as any;
      const nextInvestProductType = String(data.investProductType ?? existing.investProductType ?? "");
      data.costBasisMethod = supportsCostBasisMethod(nextInvestProductType)
        ? normalizeCostBasisMethod(body.costBasisMethod ?? existing.costBasisMethod) as any
        : null;
      if (body.tradingCalendar !== undefined || body.investProductType !== undefined || existing.kind !== "investment") {
        data.tradingCalendar = resolveTradingCalendarForAccount(nextKind, nextInvestProductType, body.tradingCalendar ?? existing.tradingCalendar) as any;
      }
      const supportsDefaultFundQueryApi = nextInvestProductType === "fund" || nextInvestProductType === "money";
      if (body.defaultFundQueryApiId !== undefined || !supportsDefaultFundQueryApi) {
        data.defaultFundQueryApiId = supportsDefaultFundQueryApi ? String(body.defaultFundQueryApiId ?? "").trim() || null : null;
      }
    } else {
      data.investProductType = null;
      data.costBasisMethod = null;
      data.tradingCalendar = null;
      data.defaultFundQueryApiId = null;
    }
    if (nextKind === "investment" && String(data.investProductType ?? existing.investProductType ?? "") === "property") {
      data.fixedAssetType = normalizeFixedAssetType(body.fixedAssetType ?? existing.fixedAssetType) as any;
    } else {
      data.fixedAssetType = null;
    }
    const nextInvestProductTypeForInstitution = nextKind === "investment"
      ? String(data.investProductType ?? existing.investProductType ?? "fund")
      : null;

    const hasNextName = Object.prototype.hasOwnProperty.call(data, "name");
    const hasNextNumberMasked = Object.prototype.hasOwnProperty.call(data, "numberMasked");
    const nextName = hasNextName ? String(data.name ?? "").trim() : existing.name;
    const nextNumberMasked = hasNextNumberMasked ? data.numberMasked : existing.numberMasked;
    if (!nextName) return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "名称必填" }, { status: 400 });

    const nextGroupId = data.groupId === undefined ? existing.groupId : String(data.groupId ?? "");
    if (!nextGroupId) return NextResponse.json({ ok: false, code: "OWNER_REQUIRED", error: "请选择所有人" }, { status: 400 });
    const nextInstitutionId = nextKind === "settlement"
      ? null
      : data.institutionId === undefined
        ? existing.institutionId
        : data.institutionId
          ? String(data.institutionId)
          : null;
    if (nextGroupId) {
      const group = await prisma.accountGroup.findFirst({ where: { id: nextGroupId, householdId } });
      if (!group) return NextResponse.json({ ok: false, code: "OWNER_NOT_FOUND", error: "所有人不存在或不属于当前账簿" }, { status: 400 });
    }
    const nextInstitution = nextInstitutionId
      ? await prisma.institution.findFirst({ where: { id: nextInstitutionId, householdId } })
      : null;
    if (nextInstitutionId) {
      if (!nextInstitution) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在或不属于当前账簿" }, { status: 400 });
    }
    if (nextKind === "loan" && !nextInstitution) {
      return NextResponse.json({ ok: false, code: "LOAN_INSTITUTION_REQUIRED", error: "Loan accounts must be linked to a lending institution" }, { status: 400 });
    }
    if (accountRequiresInstitution(nextKind, nextInvestProductTypeForInstitution) && !nextInstitution) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_INSTITUTION_REQUIRED", error: ACCOUNT_INSTITUTION_REQUIRED_ERROR }, { status: 400 });
    }
    if (nextKind === "loan" && (!nextInstitution || !isConsumerLoanInstitutionType(nextInstitution.type))) {
      return NextResponse.json({ ok: false, code: "LOAN_INSTITUTION_TYPE_REQUIRED", error: "Loan accounts must use bank, payment, or other lending institutions" }, { status: 400 });
    }
    if (isStockInvestmentAccount(nextKind, nextInvestProductTypeForInstitution) && !isStockAccountInstitutionType(nextInstitution?.type)) {
      return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_INSTITUTION_REQUIRED", error: STOCK_ACCOUNT_INSTITUTION_ERROR }, { status: 400 });
    }
    if (nextInstitution && !accountInstitutionTypeIsAllowed(nextKind, nextInvestProductTypeForInstitution, nextInstitution.type)) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_INSTITUTION_TYPE_MISMATCH", error: ACCOUNT_INSTITUTION_TYPE_ERROR }, { status: 400 });
    }
    data.debtDirection = nextKind === "bank_credit" || nextKind === "loan"
      ? "payable"
      : nextKind === "settlement" && nextCounterparty?.id
        ? requestedDebtDirection ?? existing.debtDirection ?? "receivable"
        : null;
    await assertAccountIdentityUnique(prisma, {
      householdId,
      groupId: nextGroupId,
      institutionId: nextInstitutionId,
      counterpartyId: nextKind === "settlement" ? nextCounterparty?.id ?? null : null,
      kind: nextKind,
      name: nextName,
      numberMasked: nextNumberMasked,
      excludeId: existing.id,
    });

    const creditCycleRuleChanged =
      nextKind === "bank_credit" &&
      (
        existing.kind !== "bank_credit" ||
        nextInstitutionId !== existing.institutionId ||
        (body.billingDay !== undefined && data.billingDay !== existing.billingDay) ||
        (body.repaymentDay !== undefined && data.repaymentDay !== existing.repaymentDay) ||
        (body.creditBillMode !== undefined && data.creditBillMode !== existing.creditBillMode)
      );

    const updated = await prisma.account.update({ where: { id }, data });
    const brokerageCashAccount =
      updated.kind === AccountKind.investment && updated.investProductType === "stock"
        ? await ensureBrokerageCashAccountForStockAccount(prisma, updated)
        : null;
    let affectedCreditAccountIds: string[] = [];
    if (updated.kind === "bank_credit") {
      const institutionCardsBeforeSync = updated.institutionId
        ? await prisma.account.findMany({
            where: { householdId: updated.householdId, institutionId: updated.institutionId, kind: "bank_credit" },
            select: { id: true, billingDay: true },
          })
        : [{ id: updated.id, billingDay: updated.billingDay }];
      const priorBillingDayRows = institutionCardsBeforeSync.map((account) => ({
        id: account.id,
        billingDay: account.id === existing.id && existing.kind === "bank_credit"
          ? existing.billingDay
          : account.billingDay,
      }));
      await syncCreditCardInstitutionSettings(prisma, {
        householdId: updated.householdId,
        institutionId: updated.institutionId,
        billingDay: updated.billingDay,
        repaymentDay: updated.repaymentDay,
        creditBillMode: updated.creditBillMode,
      });
      const institutionCards = updated.institutionId
        ? await prisma.account.findMany({
            where: { householdId: updated.householdId, institutionId: updated.institutionId, kind: "bank_credit" },
            select: { id: true },
          })
        : [{ id: updated.id }];
      affectedCreditAccountIds = institutionCards.map((item) => item.id);
      await prisma.$transaction(async (tx) => {
        for (const [billingDay, accountIds] of groupCreditCardIdsByBillingDay(priorBillingDayRows)) {
          await ensureInitialCreditCardBillingDayRules(tx, { accountIds, billingDay });
        }
        if (body.billingDay !== undefined && data.billingDay !== existing.billingDay && updated.billingDay != null) {
          await recordCreditCardBillingDayChange(tx, {
            accountIds: affectedCreditAccountIds,
            billingDay: updated.billingDay,
          });
        }
      });
      await invalidateCreditCardCycleCacheForAccountIds(
        affectedCreditAccountIds,
        { deleteManualCycles: false },
      );
    }
    revalidateAfterSettingsChange();
    return NextResponse.json({
      ok: true,
      data: {
        id: updated.id,
        kind: updated.kind,
        billingDay: updated.billingDay,
        repaymentDay: updated.repaymentDay,
        creditBillMode: updated.creditBillMode,
        institutionId: updated.institutionId,
        note: updated.note,
        brokerageCashAccountId: brokerageCashAccount?.id ?? null,
        affectedCreditAccountIds,
        creditCycleRuleChanged,
      },
    });
  } catch (e) {
    if (isAccountIdentityUniqueError(e)) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_IDENTITY_CONFLICT", error: e.message }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "更新失败" }, { status: 500 });
  }
}

// === Internal: PATCH (toggle active) ===
export async function PATCH(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    }

    await prisma.account.update({ where: { id }, data: { isActive: !existing.isActive } });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}

// === Internal: DELETE (permanent) ===
// Deletes the account permanently. When the account is referenced by records,
// the first DELETE without a password returns needPassword plus recordCount and
// toRecordCount; the caller then confirms by sending the admin password in the
// body, and the account, its records, and derived data are deleted permanently.
// id: Account.id
async function deleteAccountPermanently(accountId: string): Promise<{ deletedRecords: number }> {
  // Peer accounts whose balances change because their transactions referenced
  // the deleted account are recalculated after deletion.
  const referencingRows = await prisma.txRecord.findMany({
    where: { OR: [{ accountId }, { toAccountId: accountId }] },
    select: { accountId: true, toAccountId: true },
  });
  const peerAccountIds = new Set<string>();
  for (const row of referencingRows) {
    if (row.accountId && row.accountId !== accountId) peerAccountIds.add(row.accountId);
    if (row.toAccountId && row.toAccountId !== accountId) peerAccountIds.add(row.toAccountId);
  }

  const planIds = await prisma.regularInvestPlan.findMany({
    where: { accountId },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    // Remove referencing transactions (cascades attachments, tags, installment sources).
    await tx.txRecord.deleteMany({ where: { accountId } });
    await tx.txRecord.deleteMany({ where: { toAccountId: accountId } });
    // Remove transactions generated by this account's regular invest plans.
    if (planIds.length > 0) {
      await tx.txRecord.deleteMany({
        where: { regularInvestPlanId: { in: planIds.map((plan) => plan.id) } },
      });
    }
    // cashAccountId has no cascade rule, so detach it before deleting the account.
    await tx.regularInvestPlan.updateMany({
      where: { cashAccountId: accountId },
      data: { cashAccountId: null },
    });
    await tx.regularInvestPlan.deleteMany({ where: { accountId } });
    // Derived data that is no longer meaningful.
    await tx.accountAlias.deleteMany({ where: { accountId } });
    await tx.creditCardCycle.deleteMany({ where: { accountId } });
    await tx.fundHolding.deleteMany({ where: { accountId } });
    await tx.preciousMetalHolding.deleteMany({ where: { accountId } });
    // Delete the account; remaining child tables cascade.
    await tx.account.delete({ where: { id: accountId } });
  });

  for (const peerId of peerAccountIds) {
    await recalcAndSaveAccountBalance(peerId).catch((error) => {
      console.error("recalc peer account balance after account delete failed", error);
    });
  }

  return { deletedRecords: referencingRows.length };
}

export async function DELETE(req: NextRequest) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing account id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" }, { status: 404 });
    if (!isAdmin(user) && existing.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Forbidden" }, { status: 403 });
    }

    // Only active records require password confirmation. Soft-deleted history
    // is already removed from normal views and must not block account cleanup.
    const [recordCount, toRecordCount] = await Promise.all([
      prisma.txRecord.count({ where: { accountId: id, deletedAt: null } }),
      prisma.txRecord.count({ where: { toAccountId: id, deletedAt: null } }),
    ]);

    let body: { password?: string } | null = null;
    try { body = await req.json(); } catch { /* no body */ }
    const password = (body?.password ?? "").trim();

    if (recordCount === 0 && toRecordCount === 0) {
      await deleteAccountPermanently(id);
      revalidateAfterSettingsChange();
      return NextResponse.json({ ok: true });
    }

    if (!password) {
      return NextResponse.json({
        ok: false,
        code: "PASSWORD_REQUIRED_FOR_DELETE",
        error: "This account has records. Enter your password to delete the account and its records permanently.",
        needPassword: true,
        recordCount,
        toRecordCount,
      }, { status: 409 });
    }

    // Verify password against current user
    if (!user) return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Not signed in" }, { status: 401 });
    const currentUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!currentUser) return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "User not found" }, { status: 401 });

    if (currentUser.passwordHash) {
      const match = await verifyPassword(password, currentUser.passwordHash);
      if (!match) return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "Incorrect password" }, { status: 401 });
    } else {
      return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "Please set a password first" }, { status: 400 });
    }

    await deleteAccountPermanently(id);
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "Delete failed" }, { status: 500 });
  }
}

// === External: GET (summaries, supports cookie session and API key fallback) ===
export async function GET(req: Request) {
  let scope;
  try {
    scope = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: e instanceof Error ? e.message : "未授权" }, { status: 401, headers: corsHeaders() });
  }

  const rows = await prisma.account.findMany({
    where: {
      ...scope.hidFilter,
      isActive: true,
      isPlaceholder: { not: true },
    },
    include: {
      AccountGroup: { select: { name: true } },
      Institution: { select: { name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  const [investBalByAccountId, displayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId] = await Promise.all([
    computeInvestBalances(scope),
    computeAccountDisplayBalances(
      rows
        .filter((account) => !isPureInvestmentAccount(account))
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      scope.hidFilter,
    ),
    prisma.creditCardCycle.findMany({
      where: {
        accountId: { in: rows.filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay).map((account) => account.id) },
        isCurrentCycle: true,
      },
      select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
    }),
    computeInsuranceAccountDisplayBalances(
      rows.filter((account) => account.kind === AccountKind.insurance).map((account) => account.id),
      scope.hidFilter,
    ),
  ]);
  const currentCreditBalanceByAccountId = new Map(
    currentCreditCycles.map((cycle) => [
      cycle.accountId,
      creditCardDisplayBalanceFromCurrentCycle(cycle),
    ]),
  );

  const accounts = rows
    .map((account) => ({
      id: account.id,
      name: account.name,
      balance: isPureInvestmentAccount(account)
        ? investBalByAccountId.get(account.id)?.marketValue ?? 0
        : account.kind === AccountKind.insurance
          ? insuranceDisplayBalanceByAccountId.get(account.id) ?? 0
          : account.kind === AccountKind.bank_credit && account.billingDay
            ? currentCreditBalanceByAccountId.get(account.id) ?? toNumber(account.balance)
            : displayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
      count: 0,
      kind: account.kind,
      investProductType: account.investProductType,
      fixedAssetType: account.fixedAssetType,
      debtDirection: account.debtDirection,
      loanType: account.loanType,
      note: account.note,
      currency: account.currency,
      groupName: account.kind === AccountKind.loan || account.kind === AccountKind.settlement ? "" : account.AccountGroup?.name ?? "",
      institutionName: account.Institution?.name ?? "",
      usageCount: account.usageCount,
      lastUsedAt: account.lastUsedAt ? account.lastUsedAt.toISOString() : null,
    }))
    // Most frequently used accounts first, then alphabetical, so entry forms
    // (Web and Android) surface the accounts the user actually uses.
    .sort((a, b) => (b.usageCount - a.usageCount) || a.name.localeCompare(b.name, "zh-Hans-CN"));

  return NextResponse.json({ ok: true, accounts }, { headers: corsHeaders() });
}

/**
 * Android-friendly investment account list.
 * Returns real Account ids so native clients can call investment/fund APIs that require accountId.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 405, headers: corsHeaders() });
}
