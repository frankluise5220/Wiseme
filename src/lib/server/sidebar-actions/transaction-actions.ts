"use server";

import { prisma } from "@/lib/db/prisma";
import { AccountKind, CreditCardInstallmentSourceType, FundCashFlowKind, TransactionType, FundSubtype } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { calculateWealthCashDividendProfit, recalcWealthPositions } from "@/lib/wealth-position";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { getFundArrivalDays, getFundConfirmDays, setFundConfirmDays, setFundArrivalDays } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDate } from "@/lib/fund/feeRate";
import { createFundTransactionWithCashFlows, detachFundTransactionCashFlow, findFundTransactionForEntryId, syncFundTransactionsFromTxRecords, upsertFundTransactionRefundCashFlow, type FundCashFlowInput } from "@/lib/fund/transactions";
import { regularInvestRefundNote } from "@/lib/fund/regular-invest-display";
import { normalizeFundDisplayName, resolveFundName } from "@/lib/fund/fundProfile";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { attachEntryTags, replaceEntryTags } from "@/lib/server/entry-tags";
import { upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { isDepositAccount, isPureInvestmentAccount, isSpecialCashTargetAccount } from "@/lib/account-kind-utils";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { resolveOrCreateDepositAccount } from "@/lib/server/deposit-account";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import { resolveOrCreateAdvanceAccount } from "@/lib/server/advance-account";
import { createCreditCardInstallmentPlan } from "@/lib/server/credit-card-installment";
import { ENTRY_ORIGIN_MANUAL, isCreditCardRepaymentTransfer, statementMonthForTransfer } from "@/lib/transaction-semantics";
import { ensureSettlementTransferCategory, resolveCategorySnapshot, resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { getCashFlowDate } from "@/lib/cash-flow-date";
import { buildWealthCashFlowNote } from "@/lib/wealth-cash-note";
import { linkExpenseToFixedAsset, syncLinkedFixedAssetTransactionFromCashEntry } from "@/lib/property/transactions";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { resolveAdvanceTransfer } from "@/lib/advance-transfer";
import { findRecentManualTransactionDuplicate } from "@/lib/server/transaction-dedupe";
import { getServerT } from "@/lib/server/i18n";
import { touchAccountUsage } from "@/lib/server/account-usage";
import { creditBillEffectiveDate } from "@/lib/credit/billing";
import { toStatementMonth, toNumber, addWorkdaysUtc } from "@/lib/date-utils";
import type { CreditCardInstallmentRateType } from "@/lib/credit/installment";

function dateFromYmd(value: string | null | undefined): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
}
function ymdFromDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}
async function upsertFundBuyRefundRecord(
  tx: any,
  params: {
    householdId: string;
    linkedRefundEntryId?: string | null;
    buyEntryId?: string | null;
    buyDate: Date;
    refundDate: Date;
    refundAmount: number;
    fundAccountId: string;
    fundAccountName: string;
    cashAccountId: string;
    cashAccountName: string;
    currency?: string | null;
    fundCode: string | null;
    fundName: string | null;
    fundProductType: string | null;
    fundConfirmDate?: Date | null;
    fundArrivalDate?: Date | null;
    regularInvestPlanId?: string | null;
    note?: string | null;
  },
) {
  const refundAmount = Math.max(0, Math.abs(Number(params.refundAmount) || 0));
  if (refundAmount <= 0 || !params.fundAccountId || !params.cashAccountId || !params.fundCode) return null;

  const directMatch = params.linkedRefundEntryId
    ? await tx.txRecord.findFirst({
        where: {
          id: params.linkedRefundEntryId,
          householdId: params.householdId,
          fundSubtype: FundSubtype.buy_failed,
          source: "regular_invest_refund",
          deletedAt: null,
        },
      })
    : null;
  const refundDateYmd = ymdFromDate(params.refundDate);
  const refundConfirmDateYmd = ymdFromDate(params.fundConfirmDate ?? null);
  const fallbackMatch = directMatch
    ? null
    : params.buyEntryId
      ? await tx.txRecord.findFirst({
          where: {
            householdId: params.householdId,
            deletedAt: null,
            type: TransactionType.investment,
            fundSubtype: FundSubtype.buy_failed,
            source: "regular_invest_refund",
            fundSourceEntryId: params.buyEntryId,
          },
          orderBy: [{ createdAt: "asc" }],
        })
      : null;
  const dateFallbackMatch = directMatch || fallbackMatch
    ? null
    : await tx.txRecord.findFirst({
        where: {
          householdId: params.householdId,
          deletedAt: null,
          type: TransactionType.investment,
          fundSubtype: FundSubtype.buy_failed,
          source: "regular_invest_refund",
          fundCode: params.fundCode,
          accountId: params.fundAccountId,
          toAccountId: params.cashAccountId,
          date: dateFromYmd(refundDateYmd) ?? params.refundDate,
          ...(refundConfirmDateYmd ? { fundConfirmDate: dateFromYmd(refundConfirmDateYmd) } : {}),
        },
        orderBy: [{ createdAt: "asc" }],
      });

  const refundRecordData = {
    date: params.refundDate,
    accountId: params.fundAccountId,
    accountName: params.fundAccountName,
    toAccountId: params.cashAccountId,
    toAccountName: params.cashAccountName,
    amount: refundAmount,
    currency: params.currency ?? "CNY",
    fundCode: null,
    fundName: null,
    fundProductType: null,
    fundSubtype: FundSubtype.buy_failed,
    source: "regular_invest_refund",
    fundUnits: null,
    fundNav: null,
    fundFee: null,
    fundConfirmDate: null,
    fundArrivalDate: null,
    fundArrivalAmount: null,
    fundSourceEntryId: params.buyEntryId ?? null,
    regularInvestPlanId: params.regularInvestPlanId ?? null,
    note: regularInvestRefundNote(
      params.fundCode,
      params.fundName,
      refundAmount,
      params.buyDate,
      params.currency ?? "CNY",
      params.note,
    ),
    deletedAt: null,
  };

  const existing = directMatch ?? fallbackMatch ?? dateFallbackMatch;
  if (existing) {
    return tx.txRecord.update({
      where: { id: existing.id },
      data: refundRecordData,
    });
  }
  return tx.txRecord.create({
    data: {
      ...refundRecordData,
      type: TransactionType.investment,
      householdId: params.householdId,
    },
  });
}
function parseMoneyInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return n;
}
async function assertWealthUnitsWhenRequiredInTx(
  t: (key: string, params?: Record<string, string | number>) => string,
  tx: any,
  params: {
    householdId: string;
    accountId: string;
    wealthProductId?: string | null;
    productName?: string | null;
    units: number | null;
  },
) {
  if (params.units != null && params.units > 0) return;
  const productName = params.productName?.trim();
  const productClauses = [
    params.wealthProductId ? { wealthProductId: params.wealthProductId } : null,
    productName ? { productName } : null,
  ].filter((clause): clause is { wealthProductId: string } | { productName: string } => !!clause);
  if (productClauses.length === 0) return;

  const existingUnitRecord = await tx.wealthTransaction.findFirst({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      deletedAt: null,
      units: { not: null },
      OR: productClauses,
    },
    select: { id: true },
  });
  if (existingUnitRecord) {
    throw new Error(t("sidebar.action.wealthUnitsRequired"));
  }
}
function parseOptionalDateTimeInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
async function createSplitWealthTransaction(
  t: (key: string, params?: Record<string, string | number>) => string,
  formData: FormData,
  householdId: string,
) {
  const dateStr = String(formData.get("date") ?? "").trim();
  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const subtypeInput = String(formData.get("subtype") ?? "buy").trim();
  const validSubtypes = Object.values(FundSubtype);
  const subtype: FundSubtype = validSubtypes.includes(subtypeInput as FundSubtype) ? (subtypeInput as FundSubtype) : FundSubtype.buy;
  const isRedeem = subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out;
  const isDividend = subtype === FundSubtype.dividend_cash;
  const amountAbs = Math.abs(parseMoneyInput(formData.get("amount") ?? null));
  if (!amountAbs) throw new Error(t("txForm.alert.invalidAmount"));

  const requestedWealthAccountId = String(formData.get("accountId") ?? formData.get("toAccountId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const productNameInput = String(formData.get("fundName") ?? "").trim();
  const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
  const note = String(formData.get("note") ?? formData.get("memo") ?? "").trim();
  const unitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const navRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const annualRateRaw = parseFloat(String(formData.get("depositAnnualRate") ?? ""));
  const interestRaw = parseFloat(String(formData.get("depositInterest") ?? ""));
  const feeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
  const arrivalAmountRaw = parseMoneyInput(formData.get("fundArrivalAmount") ?? null);
  const arrivalDate = dateFromYmd(String(formData.get("fundArrivalDate") ?? "").trim()) ?? (isRedeem || isDividend ? date : null);
  const units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : null;
  const nav = Number.isFinite(navRaw) && navRaw > 0 ? navRaw : null;
  const annualRate = Number.isFinite(annualRateRaw) && annualRateRaw > 0 ? annualRateRaw : null;
  const fee = Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : null;
  const interest = Number.isFinite(interestRaw)
    ? interestRaw
    : isDividend
      ? amountAbs
      : null;
  const principalAmount = isRedeem && units && nav ? Number((units * nav).toFixed(2)) : amountAbs;
  const grossAmount = (isRedeem || isDividend) && !isDividend ? principalAmount : amountAbs;
  const arrivalAmount = isDividend
    ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : amountAbs)
    : isRedeem
      ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : Number(Math.max(0, principalAmount + (interest ?? 0) - Math.max(0, fee ?? 0)).toFixed(2)))
      : null;

  let touchedAccountIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const cashAcc = await tx.account.findUnique({
      where: { id: cashAccountId },
      select: { id: true, name: true, currency: true },
    });
    if (!cashAcc) throw new Error(isRedeem || isDividend ? t("sidebar.action.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount"));

    const wealthAcc = isRedeem || isDividend
      ? await tx.account.findUnique({
          where: { id: requestedWealthAccountId },
          select: { id: true, name: true, institutionId: true, currency: true },
        })
      : await resolveOrCreateWealthAccount(tx, {
          householdId,
          cashAccountId: cashAcc.id,
          requestedAccountId: requestedWealthAccountId || null,
        });
    if (!wealthAcc) throw new Error(t("sidebar.action.selectWealthAccount"));

    const wealthProduct = wealthProductIdInput
      ? await tx.wealthProduct.findFirst({
          where: { id: wealthProductIdInput, householdId, institutionId: wealthAcc.institutionId, isActive: true },
        })
      : productNameInput
        ? await tx.wealthProduct.findFirst({
            where: { householdId, institutionId: wealthAcc.institutionId ?? null, name: productNameInput, isActive: true },
          }) ?? await tx.wealthProduct.create({
            data: {
              householdId,
              institutionId: wealthAcc.institutionId ?? null,
              name: productNameInput,
              currency: wealthAcc.currency ?? cashAcc.currency ?? "CNY",
              annualRate: annualRate ?? undefined,
            },
          })
        : null;
    if (!wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));
    if (!isRedeem && !isDividend) {
      await assertWealthUnitsWhenRequiredInTx(t, tx, {
        householdId,
        accountId: wealthAcc.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        units,
      });
    }

    const investmentCategoryName = getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: subtype });
    const investmentCategory = investmentCategoryName
      ? await resolveCategorySnapshot(tx, householdId, { categoryName: investmentCategoryName, type: "investment" })
      : null;
    const signedCashAmount = isRedeem || isDividend ? Math.abs(arrivalAmount ?? amountAbs) : -amountAbs;
    const cashNote = buildWealthCashFlowNote({
      action: subtype,
      productName: wealthProduct.name,
      units,
      userNote: note,
    });
    const cashEntry = await tx.txRecord.create({
      data: {
        householdId,
        date: isRedeem || isDividend ? (arrivalDate ?? date) : date,
        type: TransactionType.investment,
        accountId: isRedeem || isDividend ? wealthAcc.id : cashAcc.id,
        accountName: isRedeem || isDividend ? wealthAcc.name : cashAcc.name,
        toAccountId: isRedeem || isDividend ? cashAcc.id : wealthAcc.id,
        toAccountName: isRedeem || isDividend ? cashAcc.name : wealthAcc.name,
        amount: signedCashAmount,
        categoryId: investmentCategory?.id ?? null,
        categoryName: investmentCategory?.name ?? investmentCategoryName ?? null,
        currency: cashAcc.currency ?? wealthAcc.currency ?? "CNY",
        source: "manual",
        note: cashNote,
      },
    });

    const wealthTransaction = await tx.wealthTransaction.create({
      data: {
        householdId,
        accountId: wealthAcc.id,
        cashAccountId: cashAcc.id,
        cashEntryId: cashEntry.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        action: subtype,
        source: "manual",
        tradeDate: date,
        confirmDate: date,
        arrivalDate,
        grossAmount,
        arrivalAmount,
        units,
        nav,
        interest,
        fee,
        annualRate,
        realizedProfit: isDividend
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : isRedeem
            ? (interest ?? 0) - Math.max(0, fee ?? 0)
            : null,
        note: note || null,
      },
    });

    await upsertEntryBusinessCashFlowLink(tx, {
      householdId,
      cashEntryId: cashEntry.id,
      businessEntryId: null,
      wealthTransactionId: wealthTransaction.id,
      businessType: "wealth",
      cashFlowDirection: signedCashAmount < 0 ? "outflow" : signedCashAmount > 0 ? "inflow" : "none",
      source: "manual",
      note: "Linked cash flow to wealth transaction",
      metadata: { splitRecord: true, independentBusinessTransaction: true },
    });
    touchedAccountIds = Array.from(new Set([cashAcc.id, wealthAcc.id].filter(Boolean)));
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(() => {});
  }
  for (const id of touchedAccountIds) {
    await recalcAndSaveAccountBalance(id).catch(() => {});
  }
  await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
  revalidateAfterInvestChange();
}
export async function createTransaction(formData: FormData) {
  "use server";
  const t = await getServerT();
  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const postedAtInput = parseOptionalDateTimeInput(formData.get("postedAt"));
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = Math.abs(amountRaw);
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();
  const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);
  const createInstallment = formData.get("createInstallment") === "true";
  const installmentAmount = parseMoneyInput(formData.get("installmentAmount"));
  const installmentTotal = Number.parseInt(String(formData.get("installmentTotal") ?? "0"), 10);
  const installmentRate = Number(String(formData.get("installmentRate") ?? "0"));
  const installmentRateType = String(formData.get("installmentRateType") ?? "period_fee") as CreditCardInstallmentRateType;

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const postedAt = type === "expense" || type === "income" ? (postedAtInput ?? date) : null;
  const { householdId } = await getHouseholdScope();
  let createdEntryId: string | null = null;
  let touchedFixedAsset = false;
  const fixedAssetAccountIdsToRefresh = new Set<string>();

  const earlyFundSubtype =
    String(formData.get("fundSubtype") ?? formData.get("subtype") ?? "").trim() ||
    String(formData.get("subtype") ?? "").trim();
  const earlyFundUnitsRaw = Number.parseFloat(String(formData.get("fundUnits") ?? ""));
  const allowsZeroAmountInvestment =
    type === "investment" &&
    earlyFundSubtype === FundSubtype.dividend_reinvest &&
    Number.isFinite(earlyFundUnitsRaw) &&
    earlyFundUnitsRaw > 0;

  if (!amountAbs && !allowsZeroAmountInvestment) {
    return { ok: false as const, error: t("txForm.alert.invalidAmount") };
  }

  try {
    if (type === "transfer") {
      const formFromAccountId = String(formData.get("fromAccountId") ?? "").trim();
      const formToAccountId = String(formData.get("toAccountId") ?? "").trim();
      if (!formFromAccountId || !formToAccountId) return { ok: false as const, error: t("sidebar.action.transferAccountsRequired") };
      if (formFromAccountId === formToAccountId) return { ok: false as const, error: t("sidebar.action.transferAccountsSame") };
      const fromAccountId = amountRaw < 0 ? formToAccountId : formFromAccountId;
      const toAccountId = amountRaw < 0 ? formFromAccountId : formToAccountId;

      await prisma.$transaction(async (tx) => {
        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId }, include: { Institution: true } }),
          tx.account.findUnique({ where: { id: toAccountId }, include: { Institution: true } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error(t("sidebar.action.accountNotFound"));
        const counterpartyInstitution = counterpartyInstitutionId
          ? await tx.institution.findUnique({ where: { id: counterpartyInstitutionId } })
          : null;
        const isDebtTransfer = fromAcc.kind === AccountKind.loan || toAcc.kind === AccountKind.loan;
        if (fromAcc.kind === AccountKind.loan && toAcc.kind === AccountKind.loan) {
          throw new Error(t("sidebar.action.settlementTransferNotAllowed"));
        }
        if (!isDebtTransfer && (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc))) {
          throw new Error(t("sidebar.action.specialTargetTransferNotAllowed"));
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);
        const debtMode = isDebtTransfer
          ? fromAcc.kind === AccountKind.loan
            ? fromAcc.debtDirection === "receivable" ? "collect_in" : "borrow_in"
            : toAcc.debtDirection === "receivable" ? "lend_out" : "repay_out"
          : null;
        const signedTransferAmount = debtMode === "collect_in" ? amountAbs : -amountAbs;

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);
        const transferCategory = debtMode
          ? await ensureSettlementTransferCategory(tx, householdId)
          : isCreditCardRepaymentTransfer({
              type: TransactionType.transfer,
              accountKind: fromAcc.kind,
              toAccountKind: toAcc.kind,
            })
            ? await resolveCreditCardRepaymentCategory(tx, householdId)
            : null;
        const duplicate = await findRecentManualTransactionDuplicate(tx, {
          householdId,
          type: TransactionType.transfer,
          date,
          accountId: fromAcc.id,
          toAccountId: toAcc.id,
          amount: signedTransferAmount,
          categoryId: transferCategory?.id ?? null,
          note,
          source: debtMode ? `debt_${debtMode}` : "manual",
        });
        if (duplicate) return;

        const created = await tx.txRecord.create({
          data: {accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: signedTransferAmount,
            type: TransactionType.transfer,
            date,
            categoryId: transferCategory?.id ?? null,
            categoryName: transferCategory?.name ?? null,
            counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
            counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            statementMonth: transferStatementMonth,
            source: debtMode ? `debt_${debtMode}` : "manual",
            debtPrincipalAmount: debtMode ? amountAbs : null,
            debtInterestAmount: debtMode ? 0 : null,
            debtFeeAmount: debtMode ? 0 : null,
            ...{ householdId },
          },
        });
        createdEntryId = created.id;
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      await recalcAndSaveAccountBalance(fromAccountId).catch(() => {});
      await recalcAndSaveAccountBalance(toAccountId).catch(() => {});
    } else if (type === "expense") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const fixedAssetAccountId = String(formData.get("fixedAssetAccountId") ?? "").trim();
      const fixedAssetAssetId = String(formData.get("fixedAssetAssetId") ?? "").trim();
      const recordCurrency = String(formData.get("currency") ?? "").trim().toUpperCase() || null;

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error(t("sidebar.action.accountNotFound"));
        if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.investmentNoIncomeExpense"));
        if (createInstallment && acc.kind !== AccountKind.bank_credit) throw new Error(t("sidebar.action.installmentCreditCardOnly"));
        if (createInstallment && (installmentAmount <= 0 || installmentAmount > amountAbs)) {
          throw new Error(t("sidebar.action.installmentAmountInvalid"));
        }
        if (createInstallment && installmentRateType !== "annual_interest" && installmentRateType !== "period_fee") {
          throw new Error(t("sidebar.action.installmentRateTypeInvalid"));
        }

        const statementMonth =
          (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(creditBillEffectiveDate({ type, date, postedAt }) ?? date, acc.billingDay, acc.billingDayTxPeriod)
            : null;
        const duplicate = createInstallment
          ? null
          : await findRecentManualTransactionDuplicate(tx, {
              householdId,
              type: TransactionType.expense,
              date,
              accountId: acc.id,
              amount: amountRaw,
              categoryId: cat?.id ?? null,
              note,
            });
        if (duplicate) return;

        const created = await tx.txRecord.create({
          data: {accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: amountRaw,
            type: TransactionType.expense,
            date,
            currency: recordCurrency ?? normalizeCurrency(acc.currency),
            postedAt,
            note: note || null,
            statementMonth,
            ...{ householdId },
          },
        });
        createdEntryId = created.id;
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });

        if (fixedAssetAccountId) {
          await linkExpenseToFixedAsset(tx, {
            householdId,
            propertyAccountId: fixedAssetAccountId,
            propertyAssetId: fixedAssetAssetId || undefined,
            cashEntry: created,
            propertyName: undefined,
          });
          fixedAssetAccountIdsToRefresh.add(fixedAssetAccountId);
          touchedFixedAsset = true;
        }

        if (createInstallment) {
          if (!statementMonth) throw new Error(t("sidebar.action.creditCardMissingBillingDay"));
          await createCreditCardInstallmentPlan(tx, {
            householdId,
            account: { id: acc.id, name: acc.name },
            sourceType: CreditCardInstallmentSourceType.transaction,
            sourceEntryId: created.id,
            originalAmount: amountAbs,
            principal: installmentAmount,
            totalRuns: installmentTotal,
            rateType: installmentRateType,
            rate: installmentRate,
            adjustmentDate: date,
            adjustmentStatementMonth: statementMonth,
            billingDay: acc.billingDay ?? 1,
            firstPaymentDate: date,
            firstPaymentStatementMonth: statementMonth,
            category: cat ? { id: cat.id, name: cat.name } : null,
            label: note || cat?.name || t("creditBill.creditCardExpense"),
            tagIds,
          });
        }
      });

      await recalcAndSaveAccountBalance(accountId).catch(() => {});
      for (const fixedAssetAccountId of fixedAssetAccountIdsToRefresh) {
        await recalcAndSaveAccountBalance(fixedAssetAccountId).catch(() => {});
      }
    } else if (type === "advance") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
      if (!accountId) return { ok: false as const, error: t("investForm.selectCashAccount") };
      if (!counterpartyInstitutionId) return { ok: false as const, error: t("debtTx.placeholder.selectCounterparty") };

      let advanceAccountId = "";
      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error(t("sidebar.action.accountNotFound"));
        if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.advanceNoIncomeExpense"));
        const resolvedAdvance = await resolveOrCreateAdvanceAccount(tx, {
          householdId,
          cashAccountId: acc.id,
          debtObjectId: counterpartyInstitutionId,
        });
        const advanceAccount = resolvedAdvance.account;
        if (advanceAccount.id === acc.id) throw new Error(t("sidebar.action.cashAccountSameAsSettlement"));
        advanceAccountId = advanceAccount.id;
        const transfer = resolveAdvanceTransfer({ amount: amountRaw, cashAccount: acc, advanceAccount });
        const statementMonth = statementMonthForTransfer(date, transfer.fromAccount, transfer.toAccount);

        const created = await tx.txRecord.create({
          data: {
            accountId: transfer.fromAccount.id,
            accountName: transfer.fromAccount.name,
            toAccountId: transfer.toAccount.id,
            toAccountName: transfer.toAccount.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            counterpartyInstitutionId: resolvedAdvance.objectId,
            counterpartyInstitutionName: resolvedAdvance.objectName,
            amount: transfer.transferAmount,
            type: TransactionType.transfer,
            date,
            statementMonth,
            source: "advance",
            note: note || transfer.defaultNote,
            toNote: null,
            householdId,
          },
        });
        createdEntryId = created.id;
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      await recalcAndSaveAccountBalance(accountId).catch(() => {});
      if (advanceAccountId) await recalcAndSaveAccountBalance(advanceAccountId).catch(() => {});
    } else if (type === "income") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          accountId ? tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }) : Promise.resolve(null),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);

        const statementMonth =
          acc && (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(creditBillEffectiveDate({ type, date, postedAt }) ?? date, acc.billingDay, acc.billingDayTxPeriod)
            : null;
        if (acc) {
          const duplicate = await findRecentManualTransactionDuplicate(tx, {
            householdId,
            type: TransactionType.income,
            date,
            accountId: acc.id,
            amount: amountRaw,
            categoryId: cat?.id ?? null,
            note,
          });
          if (duplicate) return;
        }

        const created = await tx.txRecord.create({
          data: { accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? t("common.unknownAccount"),
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            amount: amountRaw,
            type: TransactionType.income,
            date,
            postedAt,
            note: note || undefined,
            statementMonth: statementMonth ?? undefined,
            ...{ householdId },
          } as any,
        });
        createdEntryId = created.id;
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      if (accountId) await recalcAndSaveAccountBalance(accountId).catch(() => {});
    } else if (type === "investment") {
      if (String(formData.get("fundProductType") ?? "").trim() === "wealth") {
        await createSplitWealthTransaction(t, formData, householdId);
        return { ok: true as const };
      }
      let createdInvestmentEntryId: string | null = null;
      let createdFundTransactionId: string | null = null;
      const accountId = String(formData.get("accountId") ?? "").trim();
      const subtype =
        String(formData.get("fundSubtype") ?? formData.get("subtype") ?? "").trim() ||
        String(formData.get("subtype") ?? "buy").trim() ||
        "buy";
      let fundCode = String(formData.get("fundCode") ?? "").trim() || null;
      const fundProductType = String(formData.get("fundProductType") ?? "").trim() || null;
      const metalQuantityRaw = parseFloat(String(formData.get("metalQuantity") ?? formData.get("fundUnits") ?? ""));
      const metalUnitPriceRaw = parseFloat(String(formData.get("metalUnitPrice") ?? formData.get("fundNav") ?? ""));
      const metalFeeRaw = parseFloat(String(formData.get("metalFee") ?? formData.get("fundFee") ?? ""));
      const fundUnitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const fundNavRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const depositAnnualRateRaw = parseFloat(String(formData.get("depositAnnualRate") ?? ""));
  const depositInterestRaw = parseFloat(String(formData.get("depositInterest") ?? ""));
  const fundFeeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
      const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
      const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
      const fundArrivalAmountRaw = parseFloat(String(formData.get("fundArrivalAmount") ?? ""));
      const buyResultStatus = String(formData.get("buyResultStatus") ?? "normal").trim();
      const refundAmountRaw = parseFloat(String(formData.get("refundAmount") ?? ""));
      const refundDateStr = String(formData.get("refundDate") ?? "").trim();
      const depositPrincipalAmountRaw = parseFloat(String(formData.get("depositPrincipalAmount") ?? ""));
      const recordCurrency = String(formData.get("currency") ?? "").trim().toUpperCase() || null;
      const depositSourceEntryId = String(formData.get("depositSourceEntryId") ?? "").trim() || null;
      const cashAccountIdInput = String(formData.get("cashAccountId") ?? "").trim() || null;
      const fundConfirmDate = fundConfirmDateStr ? new Date(fundConfirmDateStr) : null;
      const fundArrivalDate = fundArrivalDateStr ? new Date(fundArrivalDateStr) : null;
      const fundArrivalAmount = Number.isFinite(fundArrivalAmountRaw) && fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null;
      const refundAmount = Number.isFinite(refundAmountRaw) && refundAmountRaw > 0 ? Math.abs(refundAmountRaw) : null;
      const refundDate = refundDateStr ? new Date(`${refundDateStr.slice(0, 10)}T00:00:00.000Z`) : null;
      const depositPrincipalAmount = Number.isFinite(depositPrincipalAmountRaw) && depositPrincipalAmountRaw > 0 ? depositPrincipalAmountRaw : null;
      const fundUnits = Number.isFinite(fundUnitsRaw) && fundUnitsRaw > 0 ? fundUnitsRaw : null;
      const fundNav = Number.isFinite(fundNavRaw) && fundNavRaw > 0 ? fundNavRaw : null;
      const metalQuantity = Number.isFinite(metalQuantityRaw) && metalQuantityRaw > 0 ? metalQuantityRaw : fundUnits;
      const metalUnitPrice = Number.isFinite(metalUnitPriceRaw) && metalUnitPriceRaw > 0 ? metalUnitPriceRaw : fundNav;
      const metalFee = Number.isFinite(metalFeeRaw) && metalFeeRaw > 0 ? metalFeeRaw : null;
      const depositAnnualRate = Number.isFinite(depositAnnualRateRaw) && depositAnnualRateRaw > 0 ? depositAnnualRateRaw : null;
      const depositInterest = Number.isFinite(depositInterestRaw) && depositInterestRaw >= 0 ? depositInterestRaw : null;
      const fundFee = Number.isFinite(fundFeeRaw) && fundFeeRaw > 0 ? fundFeeRaw : null;

      if (!fundCode && note) {
        const codeMatch = note.match(/\b(\d{6})\b/);
        if (codeMatch) fundCode = codeMatch[1];
      }

      const fundNameInput = String(formData.get("fundName") ?? "").trim();
      const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
      const metalTypeIdInput = String(formData.get("metalTypeId") ?? "").trim();
      const metalUnitIdInput = String(formData.get("metalUnitId") ?? "").trim();
      const effectiveAccountId = accountId || (fundProductType === "deposit" ? "__auto_deposit__" : fundProductType === "wealth" ? "__auto_wealth__" : "");
      if (!effectiveAccountId) return { ok: false as const, error: t("investForm.selectAccount") };

      const redeemLike = subtype === "redeem" || subtype === "switch_out";
      const validSubtypes = Object.values(FundSubtype);
      const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;

      const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
      const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;

      // Map source field: dividend_reinvest → source='dividend', otherwise use form source or 'manual'
      const sourceValue = fundProductType === "deposit"
        ? "deposit"
        : isDividendReinvest
          ? "dividend"
          : (String(formData.get("source") ?? "manual").trim() || "manual");
      // dividend_reinvest → fundSubtype='buy'
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;

      let finalInvestmentAccId = "";
      await prisma.$transaction(async (tx) => {
        // accountId is unified as the investment (fund) account.
        const investAcc =
          fundProductType === "deposit"
            ? await resolveOrCreateDepositAccount(tx, {
                householdId,
                requestedAccountId: accountId || null,
                cashAccountId: cashAccountIdInput,
                fundName: fundNameInput || note || null,
                currency: recordCurrency,
              })
            : fundProductType === "wealth" && finalFundSubtype === FundSubtype.buy
              ? await resolveOrCreateWealthAccount(tx, {
                  householdId,
                  cashAccountId: cashAccountIdInput ?? "",
                  requestedAccountId: accountId || null,
                })
              : await tx.account.findUnique({ where: { id: accountId } });
        if (!investAcc) throw new Error(t("sidebar.action.accountNotFound"));
        if (!isPureInvestmentAccount(investAcc) && !isDepositAccount(investAcc)) throw new Error(t("sidebar.action.selectInvestmentDepositAccount"));
        finalInvestmentAccId = investAcc.id;
        const fundUnitsPrecisionAccount = await tx.account.findUnique({
          where: { id: investAcc.id },
          select: { fundUnitsDecimals: true },
        });
        const fundUnitsDecimals = normalizeFundUnitsDecimals(fundUnitsPrecisionAccount?.fundUnitsDecimals, 2);
        const roundedFundUnits = fundUnits != null ? roundFundUnits(fundUnits, fundUnitsDecimals) : null;

        const cashAcc = cashAccountIdInput && !isDividendReinvest
          ? await tx.account.findUnique({ where: { id: cashAccountIdInput }, select: { id: true, name: true, kind: true, currency: true } })
          : null;

        const metalType = fundProductType === "metal" && metalTypeIdInput
          ? await tx.preciousMetalType.findFirst({
              where: {
                id: metalTypeIdInput,
                isActive: true,
                OR: [{ householdId }, { householdId: null }],
              },
            })
          : null;
        const metalUnit = fundProductType === "metal" && metalUnitIdInput
          ? await tx.preciousMetalUnit.findFirst({
              where: {
                id: metalUnitIdInput,
                isActive: true,
                OR: [{ householdId }, { householdId: null }],
              },
            })
          : null;
        if (fundProductType === "metal" && !metalType) throw new Error(t("sidebar.action.selectMetalType"));
        if (fundProductType === "metal" && !metalUnit) throw new Error(t("sidebar.action.selectMetalUnit"));

        const wealthProduct = fundProductType === "wealth"
          ? (wealthProductIdInput
              ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, institutionId: investAcc.institutionId, isActive: true } })
              : fundNameInput
                ? await tx.wealthProduct.findFirst({
                    where: { householdId, institutionId: investAcc.institutionId ?? null, name: fundNameInput, isActive: true },
                  }) ?? await tx.wealthProduct.create({
                    data: {
                      householdId,
                      institutionId: investAcc.institutionId ?? null,
                      name: fundNameInput,
                      currency: recordCurrency ?? investAcc.currency ?? "CNY",
                      annualRate: depositAnnualRate ?? undefined,
                    },
                  })
                : null)
          : null;
        if (fundProductType === "wealth" && !wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));

        const isMetalProduct = fundProductType === "metal";
        const isWealthProduct = fundProductType === "wealth";
        const entryFundCode = isMetalProduct || isWealthProduct ? null : fundCode || null;
        const profileCreateFundDisplayName = entryFundCode
          ? await resolveFundName(entryFundCode, { householdId })
          : null;
        const inputCreateFundDisplayName = entryFundCode
          ? normalizeFundDisplayName(entryFundCode, fundNameInput)
          : fundNameInput || null;
        const effectiveCreateFundDisplayName = profileCreateFundDisplayName ?? inputCreateFundDisplayName;
        // fundName stores fund/deposit product names; precious metal names come from metalTypeName.
        const entryFundName = isMetalProduct
          ? null
          : (wealthProduct?.name || effectiveCreateFundDisplayName || entryFundCode || null);


        // Create the TxRecord, including all fund fields directly.
        // Rule: toAccountId = the cash receiving side.
        // buy/dividend_cash: accountId=cash (source), toAccountId=investment (receiver)
        // redeem/switch_out: accountId=investment (source), toAccountId=cash (receiver)
        // dividend_reinvest: accountId=investment (source), toAccountId=investment (receiver)
        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        if (redeemLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAcc?.id ?? investAcc.id;
          recordToAccountName = cashAcc?.name ?? investAcc.name;
          signedAmount = fundArrivalAmount ?? Math.max(0, amountAbs + (depositInterest ?? 0) - (fundFee ?? 0));
        } else if (isDividendReinvest) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = 0;
        } else if (isDividendCash && cashAcc) {
          // Cash dividend: investment account (source) → cash account (receiver), positive amount (cash inflow).
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAcc.id;
          recordToAccountName = cashAcc.name;
          signedAmount = amountAbs;
        } else {
          recordAccountId = cashAcc?.id ?? investAcc.id;
          recordAccountName = cashAcc?.name ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }
        const entryArrivalAmount =
          fundProductType === "deposit" && !redeemLike && !isDividendCash && !isDividendReinvest
            ? (depositPrincipalAmount ?? amountAbs)
            : fundArrivalAmount;

        const applyDateStr = date.toISOString().slice(0, 10);
        const shouldComputeArrival = finalFundSubtype === FundSubtype.buy && !redeemLike && !isDividendCash && !isDividendReinvest;
        let computedConfirmDate: Date | null = fundConfirmDate;
        let computedArrivalDate: Date | null = fundArrivalDate;

        if (!isMetalProduct && !isWealthProduct && shouldComputeArrival && entryFundCode) {
          const confirmStr = computedConfirmDate
            ? computedConfirmDate.toISOString().slice(0, 10)
            : addWorkdaysUtc(applyDateStr, await getFundConfirmDays(investAcc.id, entryFundCode));
          if (confirmStr < applyDateStr) console.warn(`[createTransaction] confirmDate ${confirmStr} < applyDate ${applyDateStr}`);
          computedConfirmDate = new Date(`${confirmStr}T00:00:00.000Z`);

          if (!computedArrivalDate) {
            const arrivalStr = addWorkdaysUtc(confirmStr, await getFundArrivalDays(investAcc.id, entryFundCode));
            computedArrivalDate = new Date(`${arrivalStr}T00:00:00.000Z`);
          }
        }

        const shouldDirectWriteFund =
          sourceValue !== "insurance" &&
          !isMetalProduct &&
          !isWealthProduct &&
          (!fundProductType || fundProductType === "fund" || fundProductType === "money") &&
          !!entryFundCode;

        if (shouldDirectWriteFund && entryFundCode) {
          const fundCashFlows: FundCashFlowInput[] = [];
          if (cashAcc && cashAcc.id !== investAcc.id && signedAmount !== 0 && !isDividendReinvest) {
            const primaryCashFlowKind =
              finalFundSubtype === FundSubtype.redeem || finalFundSubtype === FundSubtype.switch_out
                ? FundCashFlowKind.redeem_in
                : finalFundSubtype === FundSubtype.dividend_cash
                  ? FundCashFlowKind.dividend_in
                  : FundCashFlowKind.buy_out;
            fundCashFlows.push({
              kind: primaryCashFlowKind,
              date: redeemLike || isDividendCash ? computedArrivalDate ?? date : date,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              amount: signedAmount,
              currency: recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
              source: sourceValue,
              note: note || entryFundName || undefined,
            });
          }

          const effectiveRefundDate = refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date;
          if (
            finalFundSubtype === FundSubtype.buy &&
            buyResultStatus === "refund" &&
            refundAmount &&
            refundAmount > 0 &&
            cashAcc
          ) {
            fundCashFlows.push({
              kind: FundCashFlowKind.refund_in,
              date: effectiveRefundDate,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              amount: Math.abs(refundAmount),
              currency: recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
              source: "regular_invest_refund",
              note: regularInvestRefundNote(
                entryFundCode,
                entryFundName,
                refundAmount,
                date,
                recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
                note,
              ),
            });
          }

          const createdFund = await createFundTransactionWithCashFlows(tx, {
            householdId,
            fundAccountId: investAcc.id,
            cashAccountId: isDividendReinvest ? null : cashAcc?.id ?? null,
            fundCode: entryFundCode,
            fundName: entryFundName,
            fundProductType,
            fundSubtype: finalFundSubtype,
            source: sourceValue,
            entryOrigin: ENTRY_ORIGIN_MANUAL,
            applyDate: date,
            confirmDate: computedConfirmDate,
            arrivalDate: computedArrivalDate,
            grossAmount: isDividendReinvest ? 0 : amountAbs,
            refundAmount: buyResultStatus === "refund" ? refundAmount ?? 0 : 0,
            arrivalAmount: isDividendReinvest ? null : entryArrivalAmount ?? (redeemLike || isDividendCash ? Math.abs(signedAmount) : null),
            fee: isDividendReinvest ? null : fundFee ?? null,
            nav: fundNav ?? null,
            units: roundedFundUnits ?? null,
            note: note || null,
            cashFlows: fundCashFlows,
          });
          createdFundTransactionId = createdFund.fundTransaction.id;
          createdInvestmentEntryId = createdFund.cashEntry?.id ?? createdFund.fundTransaction.id;
          createdEntryId = createdFund.cashEntry?.id ?? createdInvestmentEntryId;
        } else {
          const created = await tx.txRecord.create({
            data: {
              date,
              type: TransactionType.investment,
              accountId: recordAccountId,
              accountName: recordAccountName,
              toAccountId: recordToAccountId,
              toAccountName: recordToAccountName,
              amount: signedAmount,
              currency: recordCurrency ?? (fundProductType === "deposit" ? investAcc.currency : cashAcc?.currency) ?? "CNY",
              fundName: entryFundName,
              wealthProductId: wealthProduct?.id ?? undefined,
              metalTypeId: metalType?.id ?? undefined,
              metalTypeName: metalType?.name ?? undefined,
              metalUnitId: metalUnit?.id ?? undefined,
              metalUnitName: metalUnit ? (metalUnit.symbol ? `${metalUnit.name}(${metalUnit.symbol})` : metalUnit.name) : undefined,
              metalQuantity: isMetalProduct ? (metalQuantity != null ? roundFundUnits(metalQuantity, fundUnitsDecimals) : undefined) : undefined,
              metalUnitPrice: isMetalProduct ? metalUnitPrice ?? undefined : undefined,
              metalFee: isMetalProduct ? metalFee ?? undefined : undefined,
              insuranceAction: sourceValue === "insurance" ? (redeemLike ? "refund" : "premium") : undefined,
              insuranceProductName: sourceValue === "insurance" ? entryFundName : undefined,
              fundProductType: sourceValue === "insurance" ? null : fundProductType as "fund" | "money" | "wealth" | "deposit" | "metal" | null | undefined,
              fundSubtype: finalFundSubtype,
              source: sourceValue,
              fundUnits: isMetalProduct ? undefined : roundedFundUnits ?? undefined,
              fundNav: isMetalProduct || fundProductType === "deposit" ? undefined : fundNav ?? undefined,
              depositAnnualRate: depositAnnualRate ?? undefined,
              depositInterest: depositInterest ?? undefined,
              depositSourceEntryId: depositSourceEntryId ?? undefined,
              fundFee: isMetalProduct ? undefined : fundFee ?? undefined,
              fundConfirmDate: isMetalProduct ? undefined : computedConfirmDate ?? undefined,
              fundArrivalDate: isMetalProduct ? undefined : computedArrivalDate ?? undefined,
              fundArrivalAmount: entryArrivalAmount ?? undefined,
              note: note || undefined,
              ...{ householdId },
            },
          });
          createdInvestmentEntryId = created.id;
          createdEntryId = created.id;
          if (
            finalFundSubtype === FundSubtype.buy &&
            sourceValue !== "insurance" &&
            !isMetalProduct &&
            !isWealthProduct &&
            buyResultStatus === "refund" &&
            refundAmount &&
            refundAmount > 0 &&
            cashAcc &&
            entryFundCode
          ) {
            await upsertFundBuyRefundRecord(tx, {
              householdId,
              buyEntryId: created.id,
              buyDate: date,
              refundDate: refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date,
              refundAmount,
              fundAccountId: investAcc.id,
              fundAccountName: investAcc.name,
              cashAccountId: cashAcc.id,
              cashAccountName: cashAcc.name,
              currency: recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
              fundCode: entryFundCode,
              fundName: entryFundName,
              fundProductType,
              fundConfirmDate: computedConfirmDate,
              fundArrivalDate: refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date,
              regularInvestPlanId: created.regularInvestPlanId ?? null,
              note: note || `${t("detailView.buyRefund")} ${entryFundName || entryFundCode}`,
            });
          }
        }
      });
      if (createdInvestmentEntryId && !createdFundTransactionId) {
        if (fundProductType !== "wealth") {
          await syncFundTransactionsFromTxRecords([createdInvestmentEntryId]).catch((e) => {
            console.error("createTransaction sync fund transaction:", e);
          });
        }
        await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: createdInvestmentEntryId }).catch((e) => {
          console.error("createTransaction sync independent business transaction:", e);
        });
      }

      if (sourceValue !== "insurance" && fundProductType === "metal" && finalInvestmentAccId) {
        await recalcPreciousMetalPositions(finalInvestmentAccId).catch(() => {});
      } else if (sourceValue !== "insurance" && fundProductType !== "deposit" && fundProductType !== "wealth" && finalInvestmentAccId) {
        await recalcFundPositions(finalInvestmentAccId, fundCode ? [fundCode] : undefined).catch(() => {});
      }
      const balanceAccountId = finalInvestmentAccId;
      if (balanceAccountId) {
        await recalcAndSaveAccountBalance(balanceAccountId).catch(() => {});
      }
      if (!isDividendReinvest && cashAccountIdInput && cashAccountIdInput !== balanceAccountId) {
        await recalcAndSaveAccountBalance(cashAccountIdInput).catch(() => {});
      }
    } else {
      return { ok: false as const, error: t("sidebar.action.invalidType") };
    }

    const touchedAccountIds =
      type === "transfer"
        ? [String(formData.get("fromAccountId") ?? "").trim(), String(formData.get("toAccountId") ?? "").trim()]
        : type === "investment"
          ? [
              String(formData.get("accountId") ?? "").trim(),
              earlyFundSubtype === FundSubtype.dividend_reinvest ? "" : String(formData.get("cashAccountId") ?? "").trim(),
            ]
          : [String(formData.get("accountId") ?? "").trim(), ...fixedAssetAccountIdsToRefresh];
    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
    await touchAccountUsage(touchedAccountIds);
    if (type === "investment" || touchedFixedAsset) revalidateAfterInvestChange();
    else revalidateAfterTxChange();
    return { ok: true as const, data: createdEntryId ? { id: createdEntryId } : undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : t("txForm.alert.saveFailed");
    return { ok: false as const, error: msg };
  }
}
async function editSplitWealthTransaction(
  t: (key: string, params?: Record<string, string | number>) => string,
  formData: FormData,
  householdId: string,
) {
  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) throw new Error(t("sidebar.action.missingParams"));
  const businessTransactionId = String(formData.get("businessTransactionId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!dateStr) throw new Error(t("sidebar.action.applyDateRequired"));
  const date = new Date(dateStr);
  const subtypeInput = String(formData.get("subtype") ?? "buy").trim();
  const validSubtypes = Object.values(FundSubtype);
  const subtype: FundSubtype = validSubtypes.includes(subtypeInput as FundSubtype) ? (subtypeInput as FundSubtype) : FundSubtype.buy;
  const isRedeem = subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out;
  const isDividend = subtype === FundSubtype.dividend_cash;
  const amountAbs = Math.abs(parseMoneyInput(formData.get("amount") ?? null));
  if (!amountAbs) throw new Error(t("txForm.alert.invalidAmount"));

  const requestedWealthAccountId = String(formData.get("toAccountId") ?? formData.get("accountId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const productNameInput = String(formData.get("fundName") ?? "").trim();
  const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
  const note = String(formData.get("memo") ?? formData.get("note") ?? "").trim();
  const unitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const navRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const annualRateRaw = parseFloat(String(formData.get("depositAnnualRate") ?? ""));
  const interestRaw = parseFloat(String(formData.get("depositInterest") ?? ""));
  const feeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
  const arrivalAmountRaw = parseMoneyInput(formData.get("fundArrivalAmount") ?? null);
  const arrivalDate = dateFromYmd(String(formData.get("fundArrivalDate") ?? "").trim()) ?? (isRedeem || isDividend ? date : null);
  const units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : null;
  const nav = Number.isFinite(navRaw) && navRaw > 0 ? navRaw : null;
  const annualRate = Number.isFinite(annualRateRaw) && annualRateRaw > 0 ? annualRateRaw : null;
  const fee = Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : null;
  const interest = Number.isFinite(interestRaw)
    ? interestRaw
    : isDividend
      ? amountAbs
      : null;
  const principalAmount = isRedeem && units && nav ? Number((units * nav).toFixed(2)) : amountAbs;
  const grossAmount = (isRedeem || isDividend) && !isDividend ? principalAmount : amountAbs;
  const arrivalAmount = isDividend
    ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : amountAbs)
    : isRedeem
      ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : Number(Math.max(0, principalAmount + (interest ?? 0) - Math.max(0, fee ?? 0)).toFixed(2)))
      : null;

  const touchedAccountIds = new Set<string>();
  await prisma.$transaction(async (tx) => {
    const link = await tx.entryBusinessLink.findFirst({
      where: {
        householdId,
        businessType: "wealth",
        deletedAt: null,
        OR: [
          { cashEntryId: entryId },
          ...(businessTransactionId ? [{ wealthTransactionId: businessTransactionId }] : []),
          { wealthTransactionId: entryId },
          { businessEntryId: entryId },
        ],
      },
      orderBy: { updatedAt: "desc" },
    });
    let wealthRow = businessTransactionId
      ? await tx.wealthTransaction.findFirst({ where: { id: businessTransactionId, householdId } })
      : null;
    if (!wealthRow) {
      wealthRow = link?.wealthTransactionId
        ? await tx.wealthTransaction.findUnique({ where: { id: link.wealthTransactionId } })
        : await tx.wealthTransaction.findFirst({
            where: { householdId, OR: [{ id: entryId }, { cashEntryId: entryId }] },
          });
    }
    if (!wealthRow) {
      const legacy = await tx.txRecord.findFirst({
        where: { id: entryId, householdId, deletedAt: null, type: TransactionType.investment, fundProductType: "wealth" },
      });
      if (!legacy) throw new Error(t("sidebar.action.wealthRecordNotFound"));
      await syncIndependentBusinessTransactionFromTxRecord(tx, { businessEntryId: legacy.id });
      wealthRow = await tx.wealthTransaction.findFirst({
        where: { householdId, OR: [{ id: legacy.id }, { cashEntryId: legacy.id }] },
      });
    }
    if (!wealthRow) throw new Error(t("sidebar.action.wealthRecordNotFound"));

    const oldCashEntry = wealthRow.cashEntryId
      ? await tx.txRecord.findUnique({ where: { id: wealthRow.cashEntryId } })
      : null;
    if (oldCashEntry) {
      touchedAccountIds.add(oldCashEntry.accountId);
      if (oldCashEntry.toAccountId) touchedAccountIds.add(oldCashEntry.toAccountId);
    }
    touchedAccountIds.add(wealthRow.accountId);
    if (wealthRow.cashAccountId) touchedAccountIds.add(wealthRow.cashAccountId);

    const fallbackCashAccountId =
      cashAccountId ||
      wealthRow.cashAccountId ||
      (isRedeem || isDividend ? oldCashEntry?.toAccountId : oldCashEntry?.accountId) ||
      "";
    const cashAcc = await tx.account.findUnique({
      where: { id: fallbackCashAccountId },
      select: { id: true, name: true, currency: true },
    });
    if (!cashAcc) throw new Error(isRedeem || isDividend ? t("sidebar.action.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount"));
    const wealthAcc = await tx.account.findUnique({
      where: { id: requestedWealthAccountId || wealthRow.accountId },
      select: { id: true, name: true, institutionId: true, currency: true },
    });
    if (!wealthAcc) throw new Error(t("sidebar.action.selectWealthAccount"));

    const resolvedWealthProductId = wealthProductIdInput || wealthRow.wealthProductId || "";
    const resolvedProductNameInput = productNameInput || wealthRow.productName || "";
    const wealthProduct = resolvedWealthProductId
      ? await tx.wealthProduct.findFirst({
          where: { id: resolvedWealthProductId, householdId, institutionId: wealthAcc.institutionId, isActive: true },
        })
      : resolvedProductNameInput
        ? await tx.wealthProduct.findFirst({
            where: { householdId, institutionId: wealthAcc.institutionId ?? null, name: resolvedProductNameInput, isActive: true },
          }) ?? await tx.wealthProduct.create({
            data: {
              householdId,
              institutionId: wealthAcc.institutionId ?? null,
              name: resolvedProductNameInput,
              currency: wealthAcc.currency ?? cashAcc.currency ?? "CNY",
              annualRate: annualRate ?? undefined,
            },
          })
        : null;
    if (!wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));
    if (!isRedeem && !isDividend) {
      await assertWealthUnitsWhenRequiredInTx(t, tx, {
        householdId,
        accountId: wealthAcc.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        units,
      });
    }

    const signedCashAmount = isRedeem || isDividend ? Math.abs(arrivalAmount ?? amountAbs) : -amountAbs;
    const investmentCategoryName = getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: subtype });
    const investmentCategory = investmentCategoryName
      ? await resolveCategorySnapshot(tx, householdId, { categoryName: investmentCategoryName, type: "investment" })
      : null;
    const cashNote = buildWealthCashFlowNote({
      action: subtype,
      productName: wealthProduct.name,
      units,
      userNote: note,
    });
    const cashEntryData = {
      householdId,
      date: isRedeem || isDividend ? (arrivalDate ?? date) : date,
      type: TransactionType.investment,
      accountId: isRedeem || isDividend ? wealthAcc.id : cashAcc.id,
      accountName: isRedeem || isDividend ? wealthAcc.name : cashAcc.name,
      toAccountId: isRedeem || isDividend ? cashAcc.id : wealthAcc.id,
      toAccountName: isRedeem || isDividend ? cashAcc.name : wealthAcc.name,
      amount: signedCashAmount,
      categoryId: investmentCategory?.id ?? null,
      categoryName: investmentCategory?.name ?? investmentCategoryName ?? null,
      currency: cashAcc.currency ?? wealthAcc.currency ?? "CNY",
      source: "manual",
      note: cashNote,
      fundCode: null,
      fundProductType: null,
      fundSubtype: null,
      fundName: null,
      wealthProductId: null,
      fundUnits: null,
      fundNav: null,
      fundFee: null,
      fundConfirmDate: null,
      fundArrivalDate: null,
      fundArrivalAmount: null,
      depositAnnualRate: null,
      depositInterest: null,
      realizedProfit: null,
    };
    const cashEntry = oldCashEntry
      ? await tx.txRecord.update({ where: { id: oldCashEntry.id }, data: cashEntryData })
      : await tx.txRecord.create({ data: cashEntryData });

    await tx.wealthTransaction.update({
      where: { id: wealthRow.id },
      data: {
        accountId: wealthAcc.id,
        cashAccountId: cashAcc.id,
        cashEntryId: cashEntry.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        action: subtype,
        source: "manual",
        tradeDate: date,
        confirmDate: date,
        arrivalDate,
        grossAmount,
        arrivalAmount,
        units,
        nav,
        interest,
        fee,
        annualRate,
        realizedProfit: isDividend
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : isRedeem
            ? (interest ?? 0) - Math.max(0, fee ?? 0)
            : null,
        note: note || null,
        deletedAt: null,
      },
    });

    await tx.entryBusinessLink.updateMany({
      where: {
        householdId,
        businessType: "wealth",
        linkType: "legacy_combined_record",
        OR: [{ cashEntryId: cashEntry.id }, { businessEntryId: cashEntry.id }],
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    await upsertEntryBusinessCashFlowLink(tx, {
      householdId,
      cashEntryId: cashEntry.id,
      businessEntryId: null,
      wealthTransactionId: wealthRow.id,
      businessType: "wealth",
      cashFlowDirection: signedCashAmount < 0 ? "outflow" : signedCashAmount > 0 ? "inflow" : "none",
      source: "manual",
      note: "Linked cash flow to wealth transaction",
      metadata: { splitRecord: true, independentBusinessTransaction: true },
    });
    touchedAccountIds.add(cashAcc.id);
    touchedAccountIds.add(wealthAcc.id);
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(() => {});
  }
  for (const id of touchedAccountIds) {
    await recalcAndSaveAccountBalance(id).catch(() => {});
  }
  await invalidateCreditCardCycleCacheForAccountIds(Array.from(touchedAccountIds)).catch(() => {});
  revalidateAfterInvestChange();
}
export async function editInvestment(formData: FormData) {
  "use server";
  const t = await getServerT();
  const { householdId } = await getHouseholdScope();
  const entryId = String(formData.get("entryId") ?? "").trim();
  const subtype =
    String(formData.get("fundSubtype") ?? formData.get("subtype") ?? "").trim() ||
    String(formData.get("subtype") ?? "buy").trim() ||
    "buy";
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const memo = String(formData.get("memo") ?? "").trim();
  const fundCode = String(formData.get("fundCode") ?? "").trim() || null;
  const fundName = String(formData.get("fundName") ?? "").trim() || null;
  const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
  const fundProductType = String(formData.get("fundProductType") ?? "").trim() || null;
  if (fundProductType === "wealth") {
    try {
      await editSplitWealthTransaction(t, formData, householdId);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : t("investForm.alert.saveFailed") };
    }
  }
  const metalTypeIdInput = String(formData.get("metalTypeId") ?? "").trim();
  const metalUnitIdInput = String(formData.get("metalUnitId") ?? "").trim();
  const buyResultStatus = String(formData.get("buyResultStatus") ?? "normal").trim();
  const linkedRefundEntryId = String(formData.get("linkedRefundEntryId") ?? "").trim() || null;
  const refundAmountRaw = parseFloat(String(formData.get("refundAmount") ?? ""));
  const refundDateStr = String(formData.get("refundDate") ?? "").trim();

  // Detect which fields were passed (distinguish "not updated" vs "cleared").
  const hasFundUnits = formData.has("fundUnits");
  const hasFundNav = formData.has("fundNav");
  const hasDepositAnnualRate = formData.has("depositAnnualRate");
  const hasDepositInterest = formData.has("depositInterest");
  const hasFundFee = formData.has("fundFee");
  const hasFundConfirmDate = formData.has("fundConfirmDate");
  const hasCashAccountId = formData.has("cashAccountId");
  const hasFundArrivalDate = formData.has("fundArrivalDate");
  const hasFundArrivalAmount = formData.has("fundArrivalAmount");
  const hasDepositSourceEntryId = formData.has("depositSourceEntryId");
  const hasConfirmDays = formData.has("confirmDays");
  const feeRateWasEdited = String(formData.get("feeRateEdited") ?? "").trim() === "1";
  const hasFeeRate = feeRateWasEdited && formData.has("feeRate");
  const hasArrivalDays = formData.has("arrivalDays");

  const fundUnitsStr = String(formData.get("fundUnits") ?? "").trim();
  const fundNavStr = String(formData.get("fundNav") ?? "").trim();
  const fundFeeStr = String(formData.get("fundFee") ?? "").trim();
  const metalQuantityStr = String(formData.get("metalQuantity") ?? formData.get("fundUnits") ?? "").trim();
  const metalUnitPriceStr = String(formData.get("metalUnitPrice") ?? formData.get("fundNav") ?? "").trim();
  const metalFeeStr = String(formData.get("metalFee") ?? formData.get("fundFee") ?? "").trim();
  const depositAnnualRateStr = String(formData.get("depositAnnualRate") ?? "").trim();
  const depositInterestStr = String(formData.get("depositInterest") ?? "").trim();
  const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
  const cashAccountIdStr = String(formData.get("cashAccountId") ?? "").trim();
  const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
  const fundArrivalAmountStr = String(formData.get("fundArrivalAmount") ?? "").trim();
  const depositSourceEntryIdStr = String(formData.get("depositSourceEntryId") ?? "").trim();
  const confirmDaysStr = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysStr = String(formData.get("arrivalDays") ?? "").trim();
  const feeRateStr = String(formData.get("feeRate") ?? "").trim();

  // Empty string → null (clear), value present → parsed number.
  const fundUnitsRaw = fundUnitsStr ? parseFloat(fundUnitsStr) : NaN;
  const fundNavRaw = fundNavStr ? parseFloat(fundNavStr) : NaN;
  const fundFeeRaw = fundFeeStr ? parseFloat(fundFeeStr) : NaN;
  const metalQuantityRaw = metalQuantityStr ? parseFloat(metalQuantityStr) : NaN;
  const metalUnitPriceRaw = metalUnitPriceStr ? parseFloat(metalUnitPriceStr) : NaN;
  const metalFeeRaw = metalFeeStr ? parseFloat(metalFeeStr) : NaN;
  const fundArrivalAmountRaw = fundArrivalAmountStr ? parseFloat(fundArrivalAmountStr) : NaN;
  const refundAmount = Number.isFinite(refundAmountRaw) && refundAmountRaw > 0 ? Math.abs(refundAmountRaw) : null;
  const refundDate = refundDateStr ? dateFromYmd(refundDateStr) : null;
  const depositAnnualRateRaw = depositAnnualRateStr ? parseFloat(depositAnnualRateStr) : NaN;
  const depositInterestRaw = depositInterestStr ? parseFloat(depositInterestStr) : NaN;
  const confirmDaysRaw = confirmDaysStr ? parseInt(confirmDaysStr, 10) : NaN;
  const arrivalDaysRaw = arrivalDaysStr ? parseInt(arrivalDaysStr, 10) : NaN;
  const feeRateRaw = feeRateStr ? parseFloat(feeRateStr) : NaN;

  const fundUnits: number | null | undefined = hasFundUnits
    ? (Number.isFinite(fundUnitsRaw) && fundUnitsRaw > 0 ? fundUnitsRaw : null)
    : undefined; // undefined means do not update.
  const fundUnitsExplicitlyCleared = hasFundUnits && fundUnits === null;
  const fundNav: number | null | undefined = hasFundNav
    ? (Number.isFinite(fundNavRaw) && fundNavRaw > 0 ? fundNavRaw : null)
    : undefined;
  const depositAnnualRate: number | null | undefined = hasDepositAnnualRate
    ? (Number.isFinite(depositAnnualRateRaw) && depositAnnualRateRaw > 0 ? depositAnnualRateRaw : null)
    : undefined;
  const depositInterest: number | null | undefined = hasDepositInterest
    ? (Number.isFinite(depositInterestRaw) && depositInterestRaw >= 0 ? depositInterestRaw : null)
    : undefined;
  const fundFee: number | null | undefined = hasFundFee
    ? (Number.isFinite(fundFeeRaw) && fundFeeRaw >= 0 ? fundFeeRaw : null)
    : undefined;
  const metalQuantity: number | null = Number.isFinite(metalQuantityRaw) && metalQuantityRaw > 0 ? metalQuantityRaw : fundUnits ?? null;
  const metalUnitPrice: number | null = Number.isFinite(metalUnitPriceRaw) && metalUnitPriceRaw > 0 ? metalUnitPriceRaw : fundNav ?? null;
  const metalFee: number | null = Number.isFinite(metalFeeRaw) && metalFeeRaw > 0 ? metalFeeRaw : fundFee ?? null;
  const fundConfirmDate = hasFundConfirmDate
    ? (fundConfirmDateStr ? new Date(fundConfirmDateStr) : null)
    : undefined;
  const cashAccountId = hasCashAccountId
    ? (cashAccountIdStr || null)
    : undefined;
  const fundArrivalDate = hasFundArrivalDate
    ? (fundArrivalDateStr ? new Date(fundArrivalDateStr) : null)
    : undefined;
  const fundArrivalAmount: number | null | undefined = hasFundArrivalAmount
    ? (Number.isFinite(fundArrivalAmountRaw) && fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null)
    : undefined;
  const depositSourceEntryId: string | null | undefined = hasDepositSourceEntryId
    ? (depositSourceEntryIdStr || null)
    : undefined;
  const confirmDays: number | null | undefined = hasConfirmDays
    ? (Number.isFinite(confirmDaysRaw) && confirmDaysRaw >= 0 ? confirmDaysRaw : null)
    : undefined;
  const feeRate: number | null | undefined = hasFeeRate
    ? (Number.isFinite(feeRateRaw) && feeRateRaw >= 0 ? feeRateRaw : null)
    : undefined;
  const arrivalDays: number | null | undefined = hasArrivalDays
    ? (Number.isFinite(arrivalDaysRaw) && arrivalDaysRaw >= 0 ? arrivalDaysRaw : null)
    : undefined;

  if (!entryId) return { ok: false as const, error: t("sidebar.action.missingParams") };
  const amountAbs = Number.isFinite(amountRaw) ? Math.abs(amountRaw) : 0;
  if (!dateStr) return { ok: false as const, error: t("sidebar.action.applyDateRequired") };
  const date = new Date(dateStr);
  const redeemLike = subtype === "redeem" || subtype === "switch_out";
  const validSubtypes = Object.values(FundSubtype);
  const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;
  const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;
  const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
  if (!amountAbs && !(isDividendReinvest && fundUnits != null && fundUnits > 0)) {
    return { ok: false as const, error: t("txForm.alert.invalidAmount") };
  }

  try {
    const profileFundDisplayName = fundCode ? await resolveFundName(fundCode, { householdId }) : null;
    const inputFundDisplayName = fundCode ? normalizeFundDisplayName(fundCode, fundName) : fundName;
    const effectiveFundDisplayName = profileFundDisplayName ?? inputFundDisplayName;

    // Query the TxRecord directly.
    let txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
    });

    if (!txRecord) return { ok: false as const, error: t("sidebar.action.fundRecordNotFound") };
    if (txRecord.fundSubtype === FundSubtype.buy_failed && txRecord.source === "regular_invest_refund") {
      const sourceBuy = txRecord.fundSourceEntryId
        ? await prisma.txRecord.findFirst({
            where: {
              id: txRecord.fundSourceEntryId,
              householdId,
              deletedAt: null,
              type: TransactionType.investment,
              fundSubtype: FundSubtype.buy,
            },
          })
        : null;
      if (!sourceBuy || !sourceBuy.accountId || !sourceBuy.toAccountId || !sourceBuy.fundCode) {
        return { ok: false as const, error: t("sidebar.action.buyRefundMissingBuy") };
      }
      const [fundAccount, cashAccount] = await Promise.all([
        prisma.account.findUnique({ where: { id: sourceBuy.toAccountId }, select: { id: true, name: true, currency: true } }),
        prisma.account.findUnique({ where: { id: sourceBuy.accountId }, select: { id: true, name: true } }),
      ]);
      if (!fundAccount || !cashAccount) return { ok: false as const, error: t("sidebar.action.buyRefundAccountsNotFound") };
      const nextRefundAmount = refundAmount ?? amountAbs;
      const nextRefundDate = refundDate ?? fundArrivalDate ?? date;
      await prisma.$transaction(async (tx) => {
        await upsertFundBuyRefundRecord(tx, {
          householdId,
          linkedRefundEntryId: txRecord.id,
          buyEntryId: sourceBuy.id,
          buyDate: sourceBuy.date,
          refundDate: nextRefundDate,
          refundAmount: nextRefundAmount,
          fundAccountId: fundAccount.id,
          fundAccountName: fundAccount.name,
          cashAccountId: cashAccount.id,
          cashAccountName: cashAccount.name,
          currency: sourceBuy.currency ?? fundAccount.currency ?? "CNY",
          fundCode: sourceBuy.fundCode,
          fundName: sourceBuy.fundName,
          fundProductType: sourceBuy.fundProductType,
          fundConfirmDate: sourceBuy.fundConfirmDate ?? sourceBuy.date,
          fundArrivalDate: nextRefundDate,
          regularInvestPlanId: sourceBuy.regularInvestPlanId ?? null,
          note: regularInvestRefundNote(
            sourceBuy.fundCode,
            sourceBuy.fundName,
            nextRefundAmount,
            sourceBuy.date,
            sourceBuy.currency ?? fundAccount.currency ?? "CNY",
            memo || txRecord.note,
          ),
        });
      });
      await syncFundTransactionsFromTxRecords([sourceBuy.id]).catch((e) => {
        console.error("editInvestment sync linked refund fund transaction:", e);
      });
      await recalcFundPositions(sourceBuy.toAccountId, sourceBuy.fundCode ? [sourceBuy.fundCode] : undefined).catch((e) => { console.error("editInvestment recalc linked refund fund positions:", e); });
      await recalcAndSaveAccountBalance(sourceBuy.toAccountId).catch((e) => { console.error("editInvestment recalc linked refund invest balance:", e); });
      await recalcAndSaveAccountBalance(sourceBuy.accountId).catch((e) => { console.error("editInvestment recalc linked refund cash balance:", e); });
      revalidateAfterInvestChange();
      return { ok: true as const };
    }

    const existingFundTransactionForRecalc = fundProductType !== "wealth" && fundProductType !== "metal"
      ? await findFundTransactionForEntryId(prisma, { id: entryId, householdId }).catch(() => null)
      : null;
    // Buy: cash account -> fund account; redeem / cash dividend / buy_failed refund: fund account -> cash account.
    // Migrated independent fund rows keep the fund subtype on FundTransaction while TxRecord fund fields are cleared.
    const oldFundSubtype = existingFundTransactionForRecalc?.fundSubtype ?? txRecord.fundSubtype;
    const isOldRedeemOrRefund = oldFundSubtype === "redeem" || oldFundSubtype === "switch_out"
      || oldFundSubtype === "dividend_cash"
      || (oldFundSubtype === "buy_failed" && txRecord.source === "regular_invest_refund");
    const oldInvestmentAccId = existingFundTransactionForRecalc?.fundAccountId ?? ((isOldRedeemOrRefund ? txRecord.accountId : txRecord.toAccountId) ?? "");
    const oldCashAccId = existingFundTransactionForRecalc?.cashAccountId ?? ((isOldRedeemOrRefund ? txRecord.toAccountId : txRecord.accountId) ?? "");
    const oldFundCode = existingFundTransactionForRecalc?.fundCode ?? null;

    // Detect whether a new fund account was passed (via the toAccountId field).
    const hasNewToAccountId = formData.has("toAccountId");
    const newToAccountIdStr = String(formData.get("toAccountId") ?? "").trim();
    const newToAccountId = hasNewToAccountId && newToAccountIdStr ? newToAccountIdStr : null;
    let usedIndependentFundTransaction = false;
    let independentFundCategoryId: string | null = null;
    let independentFundCategoryName: string | null = null;

    await prisma.$transaction(async (tx) => {
      const requestedInvestmentAccountId = newToAccountId ?? oldInvestmentAccId;
      const requestedCashAccountId = isDividendReinvest ? "" : cashAccountId ?? oldCashAccId;
      const resolvedWealthAccount = fundProductType === "wealth" && !redeemLike
        ? await resolveOrCreateWealthAccount(tx, {
            householdId,
            cashAccountId: requestedCashAccountId,
            requestedAccountId: requestedInvestmentAccountId || null,
          })
        : null;
      // Query the cash account info first (if needed).
      const cashAccountInfo = requestedCashAccountId
        ? await tx.account.findUnique({ where: { id: requestedCashAccountId }, select: { id: true, name: true } })
        : null;

      // Query the new fund account info (if needed).
      const newInvestmentAccountInfo = resolvedWealthAccount ?? (newToAccountId
        ? await tx.account.findUnique({ where: { id: newToAccountId }, select: { id: true, name: true, fundUnitsDecimals: true, institutionId: true, currency: true } })
        : null);
      const existingInvestmentAccountInfo = !newInvestmentAccountInfo && oldInvestmentAccId
        ? await tx.account.findUnique({ where: { id: oldInvestmentAccId }, select: { id: true, name: true, fundUnitsDecimals: true, institutionId: true, currency: true } })
        : null;
      const finalInvestmentAccountInfo = newInvestmentAccountInfo ?? existingInvestmentAccountInfo;
      const finalFundAccountId = finalInvestmentAccountInfo?.id ?? oldInvestmentAccId;
      const finalFundAccountName = finalInvestmentAccountInfo?.name ?? txRecord.toAccountName ?? txRecord.accountName ?? "";
      const finalCashAccountId = isDividendReinvest ? "" : cashAccountInfo?.id ?? oldCashAccId;
      const finalCashAccountName = isDividendReinvest ? "" : cashAccountInfo?.name ?? txRecord.accountName ?? "";
      const fundUnitsDecimals = normalizeFundUnitsDecimals(
        finalInvestmentAccountInfo?.fundUnitsDecimals,
        2,
      );
      const roundedFundUnits = fundUnits != null ? roundFundUnits(fundUnits, fundUnitsDecimals) : null;
      const metalType = fundProductType === "metal" && metalTypeIdInput
        ? await tx.preciousMetalType.findFirst({
            where: {
              id: metalTypeIdInput,
              isActive: true,
              OR: [{ householdId }, { householdId: null }],
            },
          })
        : null;
      const metalUnit = fundProductType === "metal" && metalUnitIdInput
        ? await tx.preciousMetalUnit.findFirst({
            where: {
              id: metalUnitIdInput,
              isActive: true,
              OR: [{ householdId }, { householdId: null }],
            },
          })
        : null;
      if (fundProductType === "metal" && !metalType) throw new Error(t("sidebar.action.selectMetalType"));
      if (fundProductType === "metal" && !metalUnit) throw new Error(t("sidebar.action.selectMetalUnit"));
      const wealthProduct = fundProductType === "wealth"
        ? (wealthProductIdInput
            ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, institutionId: finalInvestmentAccountInfo?.institutionId, isActive: true } })
            : fundName
              ? await tx.wealthProduct.findFirst({
                  where: { householdId, institutionId: finalInvestmentAccountInfo?.institutionId ?? null, name: fundName, isActive: true },
                }) ?? await tx.wealthProduct.create({
                  data: {
                    householdId,
                    institutionId: finalInvestmentAccountInfo?.institutionId ?? null,
                    name: fundName,
                    currency: finalInvestmentAccountInfo?.currency ?? "CNY",
                  },
                })
              : null)
        : null;
      if (fundProductType === "wealth" && !wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));

      // Build the TxRecord update data.
      const sourceValue = fundProductType === "deposit"
        ? "deposit"
        : isDividendReinvest
          ? "dividend"
          : (String(formData.get("source") ?? txRecord.source ?? "manual").trim() || "manual");
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;
      const isBuyFailedRefund =
        finalFundSubtype === FundSubtype.buy_failed &&
        sourceValue === "regular_invest_refund";
      const signedAmount = isDividendReinvest
        ? 0
        : (redeemLike || isBuyFailedRefund)
          ? (fundArrivalAmount ?? Math.max(0, amountAbs + (depositInterest ?? 0) - (fundFee ?? 0)))
          : (isDividendCash ? amountAbs : -amountAbs);
      const isMetalProduct = fundProductType === "metal";
      const isWealthProduct = fundProductType === "wealth";
      const updateData: any = {
        date,
        fundCode: isMetalProduct || isWealthProduct ? null : fundCode,
        fundName: isMetalProduct ? null : (wealthProduct?.name || effectiveFundDisplayName),
        wealthProductId: wealthProduct?.id ?? null,
        fundProductType,
        metalTypeId: metalType?.id ?? null,
        metalTypeName: metalType?.name ?? null,
        metalUnitId: metalUnit?.id ?? null,
        metalUnitName: metalUnit ? (metalUnit.symbol ? `${metalUnit.name}(${metalUnit.symbol})` : metalUnit.name) : null,
        metalQuantity: isMetalProduct ? (metalQuantity != null ? roundFundUnits(metalQuantity, fundUnitsDecimals) : null) : null,
        metalUnitPrice: isMetalProduct ? metalUnitPrice : null,
        metalFee: isMetalProduct ? metalFee : null,
        fundSubtype: finalFundSubtype,
        source: sourceValue,
        fundUnits: isMetalProduct ? null : (hasFundUnits ? roundedFundUnits : txRecord.fundUnits),
        fundNav: isMetalProduct || fundProductType === "deposit" ? null : fundNav ?? null,
        depositAnnualRate: depositAnnualRate ?? null,
        depositInterest: depositInterest ?? null,
        depositSourceEntryId: depositSourceEntryId ?? null,
        fundFee: isMetalProduct ? null : fundFee ?? null,
        fundConfirmDate: isMetalProduct ? null : fundConfirmDate ?? null,
        fundArrivalDate: isMetalProduct ? null : fundArrivalDate ?? null,
        fundArrivalAmount: fundArrivalAmount ?? null,
        note: memo || null,
      };
      if (
        !isMetalProduct &&
        !isWealthProduct &&
        finalFundSubtype === FundSubtype.buy &&
        buyResultStatus === "refund" &&
        !fundUnitsExplicitlyCleared &&
        refundAmount &&
        refundAmount > 0
      ) {
        const recalculatedUnits = calculateConfirmedBuyUnits({
          grossAmount: amountAbs,
          refundAmount,
          fee: fundFee ?? toNumber(txRecord.fundFee),
          nav: fundNav ?? toNumber(txRecord.fundNav),
          roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
        });
        if (recalculatedUnits != null) {
          updateData.fundUnits = recalculatedUnits;
        }
      }

        // Buy: cash account -> fund account; redeem/cash dividend/buy refund: fund account -> cash account.
        if (redeemLike || isDividendCash || isBuyFailedRefund) {
          updateData.accountId = finalFundAccountId;
          updateData.accountName = finalFundAccountName;
          updateData.toAccountId = finalCashAccountId || finalFundAccountId;
          updateData.toAccountName = finalCashAccountName || finalFundAccountName;
          updateData.amount = isDividendCash ? amountAbs : signedAmount;
          updateData.deletedAt = null;
        } else if (fundSubtypeValue === FundSubtype.dividend_reinvest) {
          updateData.accountId = finalFundAccountId;
          updateData.accountName = finalFundAccountName;
          updateData.toAccountId = finalFundAccountId;
          updateData.toAccountName = finalFundAccountName;
          updateData.amount = 0;
          updateData.deletedAt = null;
        } else {
          updateData.accountId = finalCashAccountId || finalFundAccountId;
          updateData.accountName = finalCashAccountName || finalFundAccountName;
          updateData.toAccountId = finalFundAccountId;
          updateData.toAccountName = finalFundAccountName;
          updateData.amount = signedAmount;
          updateData.deletedAt = null;
        }

      const isFundLikeIndependentEdit =
        !isMetalProduct &&
        !isWealthProduct &&
        fundProductType !== "deposit" &&
        !!fundCode &&
        (!fundProductType || fundProductType === "fund" || fundProductType === "money" || fundProductType === "money_fund");
      let independentFundTransaction: Awaited<ReturnType<typeof findFundTransactionForEntryId>> = null;
      if (isFundLikeIndependentEdit) {
        independentFundTransaction = await findFundTransactionForEntryId(tx, { id: entryId, householdId });
        if (!independentFundTransaction) throw new Error(t("sidebar.action.fundTransactionNotMigrated"));
        usedIndependentFundTransaction = true;
        const businessUnits = updateData.fundUnits;
        const businessNav = fundNav ?? independentFundTransaction.nav;
        const businessFee = isDividendReinvest ? null : fundFee ?? independentFundTransaction.fee;
        await tx.fundTransaction.update({
          where: { id: independentFundTransaction.id },
          data: {
            fundAccountId: finalFundAccountId,
            cashAccountId: isDividendReinvest ? null : finalCashAccountId || null,
            cashEntryId: isDividendReinvest ? null : undefined,
            fundCode,
            fundName: profileFundDisplayName ?? inputFundDisplayName ?? normalizeFundDisplayName(fundCode, independentFundTransaction.fundName) ?? fundCode,
            fundProductType: fundProductType === "money_fund" ? "money" : ((fundProductType || "fund") as any),
            fundSubtype: finalFundSubtype,
            source: sourceValue,
            applyDate: date,
            confirmDate: fundConfirmDate ?? null,
            arrivalDate: fundArrivalDate ?? null,
            grossAmount: isDividendReinvest ? 0 : amountAbs,
            refundAmount: buyResultStatus === "refund" ? refundAmount ?? 0 : 0,
            arrivalAmount: isDividendReinvest ? null : fundArrivalAmount ?? null,
            fee: businessFee,
            nav: businessNav,
            units: businessUnits,
            note: memo || null,
          },
        });
        if (isDividendReinvest) {
          await detachFundTransactionCashFlow(tx, {
            householdId,
            fundTransactionId: independentFundTransaction.id,
            cashEntryId: independentFundTransaction.cashEntryId,
            source: sourceValue,
          });
        }
        independentFundCategoryName = getInvestmentCategoryName({
          fundProductType: fundProductType === "money_fund" ? "money" : (fundProductType || "fund"),
          fundSubtype: finalFundSubtype,
          source: sourceValue,
        });
        const independentFundCategory = independentFundCategoryName
          ? await resolveCategorySnapshot(tx, householdId, {
              categoryName: independentFundCategoryName,
              type: "investment",
            })
          : null;
        independentFundCategoryId = independentFundCategory?.id ?? null;
        independentFundCategoryName = independentFundCategory?.name ?? independentFundCategoryName;
        if (independentFundTransaction.cashEntryId && finalCashAccountId && updateData.amount !== 0 && !isDividendReinvest) {
          const cashFlowDate = getCashFlowDate({
            direction: redeemLike || isDividendCash || isBuyFailedRefund ? "inflow" : "outflow",
            operationDate: date,
            settlementDate: isBuyFailedRefund ? fundArrivalDate ?? date : fundArrivalDate,
            fallbackDate: date,
          });
          const cashFlowKind =
            finalFundSubtype === FundSubtype.redeem || finalFundSubtype === FundSubtype.switch_out
              ? FundCashFlowKind.redeem_in
              : finalFundSubtype === FundSubtype.dividend_cash
                ? FundCashFlowKind.dividend_in
                : FundCashFlowKind.buy_out;
          await tx.fundTransactionCashFlow.upsert({
            where: { id: `cff_${independentFundTransaction.cashEntryId}` },
            create: {
              id: `cff_${independentFundTransaction.cashEntryId}`,
              fundTransactionId: independentFundTransaction.id,
              txRecordId: independentFundTransaction.cashEntryId,
              kind: cashFlowKind,
              amount: Math.abs(Number(updateData.amount)),
              flowDate: cashFlowDate,
              accountId: finalCashAccountId,
            },
            update: {
              kind: cashFlowKind,
              amount: Math.abs(Number(updateData.amount)),
              flowDate: cashFlowDate,
              accountId: finalCashAccountId,
            },
          });
          await upsertEntryBusinessCashFlowLink(tx, {
            householdId,
            cashEntryId: independentFundTransaction.cashEntryId,
            fundTransactionId: independentFundTransaction.id,
            businessType: "fund",
            cashFlowDirection: Number(updateData.amount) < 0 ? "outflow" : "inflow",
            source: sourceValue,
            note: "Linked cash flow to fund transaction",
            metadata: {
              splitRecord: true,
              independentBusinessTransaction: true,
            },
          });
        }
        Object.assign(updateData, {
          fundCode: null,
          fundName: null,
          fundProductType: null,
          fundSubtype: null,
          fundUnits: null,
          fundNav: null,
          fundFee: null,
          fundConfirmDate: null,
          fundArrivalDate: null,
          fundArrivalAmount: null,
        });
      }

      await tx.txRecord.update({
        where: { id: entryId },
        data: usedIndependentFundTransaction
          ? {
              ...updateData,
              categoryId: independentFundCategoryId,
              categoryName: independentFundCategoryName,
            }
          : updateData,
      });
      if (
        !isFundLikeIndependentEdit &&
        finalFundSubtype === FundSubtype.buy &&
        sourceValue !== "insurance" &&
        !isMetalProduct &&
        !isWealthProduct &&
        buyResultStatus === "refund" &&
        refundAmount &&
        refundAmount > 0 &&
        fundCode &&
        finalFundAccountId &&
        finalCashAccountId
      ) {
        const effectiveRefundDate = refundDate ?? fundArrivalDate ?? fundConfirmDate ?? date;
        await upsertFundBuyRefundRecord(tx, {
          householdId,
          linkedRefundEntryId,
          buyEntryId: entryId,
          buyDate: date,
          refundDate: effectiveRefundDate,
          refundAmount,
          fundAccountId: finalFundAccountId,
          fundAccountName: finalFundAccountName,
          cashAccountId: finalCashAccountId,
          cashAccountName: finalCashAccountName,
          currency: finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
          fundCode,
          fundName: wealthProduct?.name || effectiveFundDisplayName,
          fundProductType,
          fundConfirmDate: fundConfirmDate ?? null,
          fundArrivalDate: effectiveRefundDate,
          regularInvestPlanId: txRecord.regularInvestPlanId ?? null,
          note: regularInvestRefundNote(
            fundCode,
            wealthProduct?.name || effectiveFundDisplayName || fundCode,
            refundAmount,
            date,
            finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
            memo,
          ),
        });
      } else if (finalFundSubtype === FundSubtype.buy && linkedRefundEntryId) {
        await tx.txRecord.updateMany({
          where: {
            id: linkedRefundEntryId,
            householdId,
            fundSubtype: FundSubtype.buy_failed,
            source: "regular_invest_refund",
          },
          data: { deletedAt: new Date() },
        });
      }
      if (
        independentFundTransaction &&
        finalFundSubtype === FundSubtype.buy &&
        buyResultStatus === "refund" &&
        refundAmount &&
        refundAmount > 0 &&
        finalCashAccountId
      ) {
        const effectiveRefundDate = refundDate ?? fundArrivalDate ?? fundConfirmDate ?? date;
        await upsertFundTransactionRefundCashFlow(tx, {
          householdId,
          fundTransactionId: independentFundTransaction.id,
          linkedRefundEntryId,
          refundDate: effectiveRefundDate,
          refundAmount,
          cashAccountId: finalCashAccountId,
          cashAccountName: finalCashAccountName,
          currency: finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
          source: "regular_invest_refund",
          note: regularInvestRefundNote(
            fundCode,
            effectiveFundDisplayName ?? fundName,
            refundAmount,
            date,
            finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
            memo,
          ),
        });
      }
    }, { maxWait: 10_000, timeout: 20_000 });
    if (!usedIndependentFundTransaction) {
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: entryId }).catch((e) => {
        console.error("editInvestment sync independent business transaction:", e);
      });
    }

    // Recalculate positions: if the fund account changed, recalculate both the old and new accounts.
    const finalInvestmentAccId = newToAccountId ?? oldInvestmentAccId;
    const recalcCodes = Array.from(new Set([oldFundCode, fundCode].filter((code): code is string => !!code)));

    const wasMetal = txRecord.fundProductType === "metal" || !!txRecord.metalTypeId;
    const isMetalProduct = fundProductType === "metal";
    if (wasMetal || isMetalProduct) {
      if (oldInvestmentAccId) await recalcPreciousMetalPositions(oldInvestmentAccId).catch((e) => { console.error("editInvestment recalc old metal positions:", e); });
      if (finalInvestmentAccId && finalInvestmentAccId !== oldInvestmentAccId) {
        await recalcPreciousMetalPositions(finalInvestmentAccId).catch((e) => { console.error("editInvestment recalc new metal positions:", e); });
      }
    }
    if (!isMetalProduct && fundProductType !== "wealth") {
      if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
        // Fund account changed: recalculate both the old and new accounts.
        await recalcFundPositions(oldInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc old fund positions:", e); });
        await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc new fund positions:", e); });
      } else if (finalInvestmentAccId) {
        // Fund account unchanged: recalculate only that account.
        await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc fund positions:", e); });
      }
    }

    // Recalculate the investment account balance.
    await recalcAndSaveAccountBalance(finalInvestmentAccId).catch((e) => { console.error("editInvestment recalc invest balance:", e); });
    if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldInvestmentAccId).catch((e) => { console.error("editInvestment recalc old invest balance:", e); });
    }

    // Recalculate the cash account balance (if the cash account changed).
    if (oldCashAccId && oldCashAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldCashAccId).catch((e) => { console.error("editInvestment recalc old cash balance:", e); });
    }
    if (cashAccountId && cashAccountId !== oldCashAccId && cashAccountId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(cashAccountId).catch((e) => { console.error("editInvestment recalc new cash balance:", e); });
    }

    // Update the T+N confirm days in the unified confirm-days store.
    if (fundProductType !== "metal" && fundProductType !== "wealth" && finalInvestmentAccId && fundCode && confirmDays !== undefined && confirmDays !== null) {
      await setFundConfirmDays(finalInvestmentAccId, fundCode, confirmDays).catch(() => {});

    // Update the arrival days in the unified arrival-days store.
    if (finalInvestmentAccId && fundCode && arrivalDays !== undefined && arrivalDays !== null) {
      await setFundArrivalDays(finalInvestmentAccId, fundCode, arrivalDays).catch(() => {});
    }
    }

    // Update the fee-rate rule only when the user explicitly edited the rate.
    if (fundProductType !== "metal" && fundProductType !== "wealth" && finalInvestmentAccId && fundCode && feeRateWasEdited && feeRate !== undefined && feeRate !== null) {
      await setFundFeeRateByDate(finalInvestmentAccId, fundCode, feeRate, fundConfirmDate ?? date, redeemLike ? "redeem" : "buy").catch(() => {});
    }

    await invalidateCreditCardCycleCacheForAccountIds([
      oldInvestmentAccId,
      finalInvestmentAccId,
      oldCashAccId,
      cashAccountId,
    ]).catch(() => {});
    revalidateAfterInvestChange();
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : t("investForm.alert.saveFailed") };
  }
}
export async function updateTransactionFromDialog(formData: FormData) {
  "use server";
  const t = await getServerT();

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: t("sidebar.action.missingEntryId") };

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const postedAtInput = parseOptionalDateTimeInput(formData.get("postedAt"));
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = Math.abs(amountRaw);
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();
  const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const postedAt = type === "expense" || type === "income" ? (postedAtInput ?? date) : null;
  const earlyEditFundSubtype =
    String(formData.get("fundSubtype") ?? formData.get("subtype") ?? "").trim() ||
    String(formData.get("subtype") ?? "").trim();
  const earlyEditFundUnitsRaw = Number.parseFloat(String(formData.get("fundUnits") ?? ""));
  const allowsZeroAmountInvestmentEdit =
    type === "investment" &&
    earlyEditFundSubtype === FundSubtype.dividend_reinvest &&
    Number.isFinite(earlyEditFundUnitsRaw) &&
    earlyEditFundUnitsRaw > 0;
  if (!amountAbs && !allowsZeroAmountInvestmentEdit) return { ok: false as const, error: t("txForm.alert.invalidAmount") };

  try {
    const ctx = await getHouseholdScope();
    const undo = await prepareEntryUndo(prisma, ctx.householdId, [entryId]);
    let investRecalcAccountId: string | null = null;
    let investRecalcFundCode: string | null = null;
    const fixedAssetAccountId = String(formData.get("fixedAssetAccountId") ?? "").trim();
    const fixedAssetAssetId = String(formData.get("fixedAssetAssetId") ?? "").trim();
    let touchedFixedAsset = false;
    let independentFundCategoryId: string | null = null;
    let independentFundCategoryName: string | null = null;
    const touchedAccountIds = new Set<string>();
    await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({
        where: { id: entryId },

      });
      if (!entry) throw new Error(t("sidebar.action.recordNotFound"));
      if (entry.accountId) touchedAccountIds.add(entry.accountId);
      if (entry.toAccountId) touchedAccountIds.add(entry.toAccountId);

      await replaceEntryTags({ tx, entryId, householdId: entry.householdId, tagIds });

      if (type === "transfer") {
        const formFromAccountId = String(formData.get("fromAccountId") ?? "").trim();
        const formToAccountId = String(formData.get("toAccountId") ?? "").trim();
        if (!formFromAccountId || !formToAccountId) throw new Error(t("sidebar.action.transferAccountsRequired"));
        if (formFromAccountId === formToAccountId) throw new Error(t("sidebar.action.transferAccountsSame"));
        const fromAccountId = amountRaw < 0 ? formToAccountId : formFromAccountId;
        const toAccountId = amountRaw < 0 ? formFromAccountId : formToAccountId;

        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId } }),
          tx.account.findUnique({ where: { id: toAccountId } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error(t("sidebar.action.accountNotFound"));
        const counterpartyInstitution = counterpartyInstitutionId
          ? await tx.institution.findUnique({ where: { id: counterpartyInstitutionId } })
          : null;
        touchedAccountIds.add(fromAcc.id);
        touchedAccountIds.add(toAcc.id);
        const isDebtTransfer = fromAcc.kind === AccountKind.loan || toAcc.kind === AccountKind.loan;
        if (fromAcc.kind === AccountKind.loan && toAcc.kind === AccountKind.loan) {
          throw new Error(t("sidebar.action.settlementTransferNotAllowed"));
        }
        if (!isDebtTransfer && (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc))) {
          throw new Error(t("sidebar.action.specialTargetTransferNotAllowed"));
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);
        const debtMode = isDebtTransfer
          ? fromAcc.kind === AccountKind.loan
            ? fromAcc.debtDirection === "receivable" ? "collect_in" : "borrow_in"
            : toAcc.debtDirection === "receivable" ? "lend_out" : "repay_out"
          : null;
        if (
          !debtMode &&
          String(entry.source ?? "").startsWith("debt_") &&
          (Math.abs(toNumber(entry.debtInterestAmount)) > 0.005 || Math.abs(toNumber(entry.debtFeeAmount)) > 0.005)
        ) {
          throw new Error(t("sidebar.action.debtWithInterestNoTransfer"));
        }
        const signedTransferAmount = debtMode === "collect_in" ? amountAbs : -amountAbs;

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);
        const transferCategory = debtMode
          ? await ensureSettlementTransferCategory(tx, ctx.householdId)
          : isCreditCardRepaymentTransfer({
              type: TransactionType.transfer,
              accountKind: fromAcc.kind,
              toAccountKind: toAcc.kind,
            })
            ? await resolveCreditCardRepaymentCategory(tx, ctx.householdId)
            : null;

        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: signedTransferAmount,
            accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            categoryId: transferCategory?.id ?? null,
            categoryName: transferCategory?.name ?? null,
            statementMonth: transferStatementMonth,
            date,
            postedAt: null,
            type: TransactionType.transfer,
            counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
            counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            source: debtMode ? `debt_${debtMode}` : "manual",
            debtPrincipalAmount: debtMode ? amountAbs : null,
            debtInterestAmount: debtMode ? 0 : null,
            debtFeeAmount: debtMode ? 0 : null,
          },
        });
        return;
      }

      if (type === "investment") {
        // Edit mode: accountId=investment account (unified), cashAccountId=cash account.
        const accountIdFormData = String(formData.get("accountId") ?? "").trim();
        const cashAccountIdFormData = String(formData.get("cashAccountId") ?? "").trim();
        const fundCode = String(formData.get("fundCode") ?? "").trim();
        const productType = String(formData.get("productType") ?? "fund").trim();
        const subtype =
          String(formData.get("fundSubtype") ?? formData.get("subtype") ?? "").trim() ||
          String(formData.get("subtype") ?? "buy").trim() ||
          "buy";
        const redeemLike = subtype === "redeem" || subtype === "switch_out";
        const isDividendReinvest = subtype === FundSubtype.dividend_reinvest;
        const isInsuranceEntry = entry.source === "insurance" || !!entry.insuranceProductId;

        const investAcc = accountIdFormData ? await tx.account.findUnique({ where: { id: accountIdFormData } }) : null;
        if (!investAcc) throw new Error(t("sidebar.action.selectInvestmentAccount"));
        touchedAccountIds.add(investAcc.id);

        // Cash account: prefer the form value; otherwise infer from the original record.
        let cashAccId: string | null = null;
        let cashAccName: string | null = null;
        if (cashAccountIdFormData) {
          const cashAcc = await tx.account.findUnique({ where: { id: cashAccountIdFormData } });
          if (cashAcc) { cashAccId = cashAcc.id; cashAccName = cashAcc.name; touchedAccountIds.add(cashAcc.id); }
        }
        // Fallback: infer the cash account from the original record.
        if (!cashAccId && !isDividendReinvest) {
          if (redeemLike) {
            // Redeem records: toAccountId is the cash account (receiver).
            if (entry.toAccountId) {
              const acc = await tx.account.findUnique({ where: { id: entry.toAccountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; touchedAccountIds.add(acc.id); }
            }
          } else {
            // Buy records: accountId is the cash account (source).
            if (entry.accountId && entry.accountId !== investAcc.id) {
              const acc = await tx.account.findUnique({ where: { id: entry.accountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; touchedAccountIds.add(acc.id); }
            }
          }
        }

        // Determine record direction: toAccountId = cash receiving side.
        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        const fundArrivalAmount = parseFloat(String(formData.get("fundArrivalAmount") ?? ""));
        const fundFee = parseFloat(String(formData.get("fundFee") ?? ""));

        if (redeemLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAccId ?? investAcc.id;
          recordToAccountName = cashAccName ?? investAcc.name;
          signedAmount = Number.isFinite(fundArrivalAmount) && fundArrivalAmount > 0
            ? fundArrivalAmount
            : Math.max(0, amountAbs - (Number.isFinite(fundFee) && fundFee > 0 ? fundFee : 0));
        } else if (isDividendReinvest) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = 0;
        } else {
          recordAccountId = cashAccId ?? investAcc.id;
          recordAccountName = cashAccName ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }

        const isFundLikeIndependentEdit =
          !isInsuranceEntry &&
          !!fundCode &&
          (productType === "fund" || productType === "money" || productType === "money_fund");
        const independentFundTransaction = isFundLikeIndependentEdit
          ? await findFundTransactionForEntryId(tx, { id: entryId, householdId: ctx.householdId })
          : null;
        if (isFundLikeIndependentEdit && !independentFundTransaction) {
          throw new Error(t("sidebar.action.fundTransactionNotMigrated"));
        }
        const independentFundNameInput = String(formData.get("fundName") ?? "").trim() || null;
        const independentProfileFundName = isFundLikeIndependentEdit
          ? await resolveFundName(fundCode, { householdId: ctx.householdId })
          : null;
        const independentFundDisplayName = isFundLikeIndependentEdit
          ? independentProfileFundName
            ?? normalizeFundDisplayName(fundCode, independentFundNameInput)
            ?? normalizeFundDisplayName(fundCode, independentFundTransaction?.fundName)
            ?? fundCode
          : null;
        if (independentFundTransaction) {
          const arrivalAmount = Number.isFinite(fundArrivalAmount) && fundArrivalAmount > 0 ? fundArrivalAmount : null;
          const fee = isDividendReinvest ? null : Number.isFinite(fundFee) && fundFee > 0 ? fundFee : independentFundTransaction.fee;
          await tx.fundTransaction.update({
            where: { id: independentFundTransaction.id },
            data: {
              fundAccountId: investAcc.id,
              cashAccountId: isDividendReinvest ? null : cashAccId ?? null,
              cashEntryId: isDividendReinvest ? null : undefined,
              fundCode,
              fundName: independentFundDisplayName,
              fundProductType: productType === "money_fund" ? "money" : (productType as any),
              fundSubtype: isDividendReinvest ? FundSubtype.buy : (subtype as any),
              source: isDividendReinvest ? "dividend" : entry.source,
              applyDate: date,
              grossAmount: isDividendReinvest ? 0 : amountAbs,
              arrivalAmount: isDividendReinvest ? null : arrivalAmount,
              fee,
              note: note || null,
            },
          });
          if (isDividendReinvest) {
            await detachFundTransactionCashFlow(tx, {
              householdId: ctx.householdId,
              fundTransactionId: independentFundTransaction.id,
              cashEntryId: independentFundTransaction.cashEntryId,
              source: "dividend",
            });
          }
          independentFundCategoryName = getInvestmentCategoryName({
            fundProductType: productType === "money_fund" ? "money" : productType,
            fundSubtype: isDividendReinvest ? FundSubtype.buy : subtype,
            source: isDividendReinvest ? "dividend" : entry.source,
          });
          const independentFundCategory = independentFundCategoryName
            ? await resolveCategorySnapshot(tx, ctx.householdId, {
                categoryName: independentFundCategoryName,
                type: "investment",
              })
            : null;
          independentFundCategoryId = independentFundCategory?.id ?? null;
          independentFundCategoryName = independentFundCategory?.name ?? independentFundCategoryName;
          if (independentFundTransaction.cashEntryId && cashAccId && signedAmount !== 0 && !isDividendReinvest) {
            const cashFlowKind =
              subtype === "redeem" || subtype === "switch_out"
                ? FundCashFlowKind.redeem_in
                : subtype === "dividend_cash"
                  ? FundCashFlowKind.dividend_in
                  : FundCashFlowKind.buy_out;
            await tx.fundTransactionCashFlow.upsert({
              where: { id: `cff_${independentFundTransaction.cashEntryId}` },
              create: {
                id: `cff_${independentFundTransaction.cashEntryId}`,
                fundTransactionId: independentFundTransaction.id,
                txRecordId: independentFundTransaction.cashEntryId,
                kind: cashFlowKind,
                amount: Math.abs(signedAmount),
                flowDate: getCashFlowDate({
                  direction: redeemLike ? "inflow" : "outflow",
                  operationDate: date,
                  settlementDate: independentFundTransaction.arrivalDate,
                  fallbackDate: date,
                }),
                accountId: cashAccId,
              },
              update: {
                kind: cashFlowKind,
                amount: Math.abs(signedAmount),
                flowDate: getCashFlowDate({
                  direction: redeemLike ? "inflow" : "outflow",
                  operationDate: date,
                  settlementDate: independentFundTransaction.arrivalDate,
                  fallbackDate: date,
                }),
                accountId: cashAccId,
              },
            });
            await upsertEntryBusinessCashFlowLink(tx, {
              householdId: ctx.householdId,
              cashEntryId: independentFundTransaction.cashEntryId,
              fundTransactionId: independentFundTransaction.id,
              businessType: "fund",
              cashFlowDirection: signedAmount < 0 ? "outflow" : "inflow",
              source: entry.source,
              note: "Linked cash flow to fund transaction",
              metadata: {
                splitRecord: true,
                independentBusinessTransaction: true,
              },
            });
          }
        }

        // Update the TxRecord.
        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: signedAmount,
            accountId: recordAccountId,
            accountName: recordAccountName,
            categoryId: independentFundCategoryId,
            categoryName: independentFundCategoryName,
            toAccountId: recordToAccountId,
            toAccountName: recordToAccountName,
            fundCode: null,
            insuranceAction: isInsuranceEntry ? (redeemLike ? "refund" : "premium") : entry.insuranceAction,
            insuranceProductName: isInsuranceEntry ? (entry.fundName ?? null) : entry.insuranceProductName,
            fundProductType: isFundLikeIndependentEdit || isInsuranceEntry ? null : (productType as any) || null,
            fundSubtype: isFundLikeIndependentEdit ? null : isDividendReinvest ? FundSubtype.buy : (subtype as any) || null,
            source: isDividendReinvest ? "dividend" : entry.source,
            date,
            type: TransactionType.investment,
            note: note || null,
          },
        });

        investRecalcAccountId = investAcc.id;
        investRecalcFundCode = fundCode || null;
        return;
      }

      if (type === "advance") {
        const accountId = String(formData.get("accountId") ?? "").trim();
        const categoryId = String(formData.get("categoryId") ?? "").trim();
        const debtObjectId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
        if (!accountId) throw new Error(t("investForm.selectCashAccount"));
        if (!debtObjectId) throw new Error(t("debtTx.placeholder.selectCounterparty"));
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error(t("sidebar.action.accountNotFound"));
        if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.advanceNoIncomeExpense"));
        const resolvedAdvance = await resolveOrCreateAdvanceAccount(tx, {
          householdId: ctx.householdId,
          cashAccountId: acc.id,
          debtObjectId,
        });
        const transfer = resolveAdvanceTransfer({ amount: amountRaw, cashAccount: acc, advanceAccount: resolvedAdvance.account });
        const statementMonth = statementMonthForTransfer(date, transfer.fromAccount, transfer.toAccount);
        touchedAccountIds.add(acc.id);
        touchedAccountIds.add(resolvedAdvance.account.id);
        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: transfer.transferAmount,
            accountId: transfer.fromAccount.id,
            accountName: transfer.fromAccount.name,
            toAccountId: transfer.toAccount.id,
            toAccountName: transfer.toAccount.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            counterpartyInstitutionId: resolvedAdvance.objectId,
            counterpartyInstitutionName: resolvedAdvance.objectName,
            statementMonth,
            date,
            postedAt: null,
            type: TransactionType.transfer,
            source: "advance",
            note: note || transfer.defaultNote,
            toNote: null,
            fundCode: null,
            fundProductType: null,
            fundSubtype: null,
          },
        });
        return;
      }

      if (type !== "expense" && type !== "income") throw new Error(t("sidebar.action.invalidType"));
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const keepFundDetail = formData.get("keepFundDetail") === "true";

      const [acc, cat] = await Promise.all([
        accountId ? tx.account.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
        categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
      ]);
      if (!acc) throw new Error(t("investForm.selectAccount"));
      touchedAccountIds.add(acc.id);
      if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.investmentNoIncomeExpense"));

      // Check whether this is a fund transaction (via toAccountId + fundProductType).
      const isFundTransaction = entry.toAccountId && entry.fundProductType;

      const statementMonth =
        (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
          ? toStatementMonth(creditBillEffectiveDate({ type, date, postedAt }) ?? date, acc.billingDay, acc.billingDayTxPeriod)
          : null;

      const expenseOrIncomeData: Record<string, unknown> = {
        amount: amountRaw,
        accountId: acc.id,
        accountName: acc.name,
        categoryId: cat ? cat.id : null,
        categoryName: cat?.name ?? null,
        statementMonth,
        toAccountId: null,
        toAccountName: null,
        fundCode: null,
        fundProductType: null,
            toNote: null,
            date,
            postedAt,
            type: type === "income" ? TransactionType.income : TransactionType.expense,
            note: note || null,
      };
      // The expense form always sends a currency field: a non-empty value sets
      // the transaction currency; an empty value resets it to the account currency.
      const formCurrencyRaw = formData.get("currency");
      if (type === "expense" && formCurrencyRaw != null) {
        const formCurrency = String(formCurrencyRaw).trim().toUpperCase();
        expenseOrIncomeData.currency = formCurrency || normalizeCurrency(acc.currency);
      }
      if (isFundTransaction && !keepFundDetail) {
        expenseOrIncomeData.fundSubtype = null;
        expenseOrIncomeData.fundUnits = null;
        expenseOrIncomeData.fundNav = null;
        expenseOrIncomeData.fundFee = null;
        expenseOrIncomeData.fundConfirmDate = null;
        expenseOrIncomeData.fundArrivalDate = null;
        expenseOrIncomeData.fundArrivalAmount = null;
      }

      await tx.txRecord.update({
        where: { id: entryId },
        data: expenseOrIncomeData,
      });
    });

    if (investRecalcAccountId) {
      await recalcFundPositions(
        investRecalcAccountId,
        investRecalcFundCode ? [investRecalcFundCode] : undefined,
      ).catch(() => {});
    }

    const updatedEntry = await prisma.txRecord.findUnique({ where: { id: entryId } });
    if (updatedEntry) {
      if (type === "expense" && fixedAssetAccountId) {
        await linkExpenseToFixedAsset(prisma, {
          householdId: ctx.householdId,
          propertyAccountId: fixedAssetAccountId,
          propertyAssetId: fixedAssetAssetId || undefined,
          cashEntry: updatedEntry,
          propertyName: undefined,
        });
        touchedAccountIds.add(fixedAssetAccountId);
        touchedFixedAsset = true;
      } else {
        const syncResult = await syncLinkedFixedAssetTransactionFromCashEntry(prisma, {
          householdId: ctx.householdId,
          cashEntry: updatedEntry,
        });
        if (syncResult.touched) {
          touchedFixedAsset = true;
          for (const accountId of syncResult.accountIds) touchedAccountIds.add(accountId);
        }
      }
    }
    for (const accountId of touchedAccountIds) {
      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }
    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
    if (type === "investment" || touchedFixedAsset) revalidateAfterInvestChange();
    else revalidateAfterTxChange();
    await saveEntryUndo(prisma, ctx, undo, "edit", t("sidebar.undo.editEntry"));
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : t("investForm.alert.saveFailed");
    return { ok: false as const, error: msg };
  }
}
