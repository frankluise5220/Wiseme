"use server";

import { AccountKind, IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeLoanPrincipalBalancesAsOf, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { ensureMortgageFundCategory, ensureSettlementTransferCategory } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { replaceLoanRateAdjustmentsForAccount } from "@/lib/server/loan-rate-adjustments";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { executeNonFundScheduledTaskPlan } from "@/lib/server/scheduled-task-executor";
import { encodeLoanPrepayStrategy, normalizeLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { resolveLoanRepaymentPeriodForDate } from "@/lib/loan-repayment-period";
import {
  EQUAL_PAYMENT_REPAYMENT_METHOD,
  EQUAL_PRINCIPAL_REPAYMENT_METHOD,
  INTEREST_FIRST_REPAYMENT_METHOD,
  INSTALLMENT_REPAYMENT_METHOD,
  allowsZeroAnnualRateRepaymentMethod,
  calcLoanScheduledAmount,
  normalizeLoanRateAdjustments,
  normalizeLoanRepaymentMethod,
} from "@/lib/loan-repayment";
import { buildMortgageLprRateAdjustments, getMortgageBankExecutionRate, MORTGAGE_BASE_BENCHMARK_RATE } from "@/lib/loan-lpr";
import {
  decodeScheduledTaskMemo,
  encodeScheduledTaskMemo,
  getLoanScheduledPlanRole,
  shouldPreferLoanAutoDebitPlan,
  shouldPreferLoanScheduledPlan,
} from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { formatDateUtc, toNumber, toStatementMonth } from "@/lib/date-utils";
import { linkExpenseToFixedAsset } from "@/lib/property/transactions";
import { releaseMortgagedAssetsForSettledLoanAccounts } from "@/lib/server/collateral-mortgage";
import { ACTIVE_DEBT_EPSILON } from "@/lib/server/debt-view-data";
import { assertAccountIdentityUnique } from "@/lib/server/account-identity-unique";
import { attachEntryTags, replaceEntryTags } from "@/lib/server/entry-tags";
import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { isCollateralLoanType, isHomeLoanType, normalizeLoanType, type LoanTypeValue } from "@/lib/loan-type";

const SETTLEMENT_ACCOUNT_SUFFIX = "\u7684\u5f80\u6765\u6b3e";
const SETTLEMENT_GROUP_NAME = "\u5f80\u6765\u6b3e";
const BORROW_LEND_GROUP_NAME = "\u501f\u5165/\u501f\u51fa";
const LIABILITY_GROUP_NAME = "\u8d1f\u503a";
const DEFAULT_SETTLEMENT_CATEGORY_NAME = "\u501f\u5165\u501f\u51fa";
const INSTALLMENT_BILL_TITLE_PREFIX = "\u5206\u671f\u51fa\u8d26\uff1a";
const REPAYMENT_TITLE_PREFIX = "\u8fd8\u6b3e\uff1a";
const AUTO_DEBIT_TITLE_PREFIX = "\u81ea\u52a8\u6263\u6b3e\uff1a";
const FINANCED_PURCHASE_NOTE = "\u6d88\u8d39\u5206\u671f";
const INSTITUTION_BORROW_NOTE = "\u673a\u6784\u501f\u5165";
const BORROW_NOTE = "\u501f\u5165";

function parseMoneyInput(value: FormDataEntryValue | null) {
  const parsed = parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSubmittedTagIds(value: FormDataEntryValue | null) {
  if (value == null) return [];
  const parsed = JSON.parse(String(value));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

async function resolveOrCreateDebtAccount(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  debtObjectId: string,
  direction: "payable" | "receivable",
  loanType: LoanTypeValue | null,
) {
  const debtObject = await resolveDebtObject(tx, householdId, debtObjectId);

  const objectName = debtObject.shortName?.trim() || debtObject.name;
  const accountName = `${objectName}${SETTLEMENT_ACCOUNT_SUFFIX}`;
  const objectWhere = debtObject.kind === "counterparty"
    ? { counterpartyId: debtObject.id, institutionId: null }
    : { institutionId: debtObject.id, counterpartyId: null };
  const existing = debtObject.kind === "counterparty"
    ? await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: { in: [AccountKind.settlement, AccountKind.loan] },
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      })
    : (await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: AccountKind.loan,
          debtDirection: direction,
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      })) ??
      (await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: AccountKind.loan,
          debtDirection: null,
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      }));
  if (existing) {
    const shouldPatchMissingLoanType = debtObject.kind === "institution" && loanType != null && !existing.loanType;
    if (
      !existing.isActive ||
      (debtObject.kind === "counterparty" && existing.kind !== AccountKind.settlement) ||
      (debtObject.kind !== "counterparty" && existing.debtDirection !== direction) ||
      shouldPatchMissingLoanType
    ) {
      return tx.account.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          ...(debtObject.kind === "counterparty" ? { kind: AccountKind.settlement } : {}),
          ...(debtObject.kind !== "counterparty" ? { debtDirection: direction } : {}),
          ...(shouldPatchMissingLoanType ? { loanType, isConsumerLoan: loanType === "consumer" } : {}),
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
      });
    }
    return existing;
  }

  const group =
    (await tx.accountGroup.findFirst({ where: { householdId, name: { in: [SETTLEMENT_GROUP_NAME, BORROW_LEND_GROUP_NAME, LIABILITY_GROUP_NAME] } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })) ??
    (await tx.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
  if (!group) throw new Error("Missing account group; cannot create a settlement account");

  const accountLoanType = debtObject.kind === "institution" ? loanType ?? "home" : null;
  return tx.account.create({
    data: {
      name: accountName,
      kind: debtObject.kind === "counterparty" ? AccountKind.settlement : AccountKind.loan,
      debtDirection: debtObject.kind === "counterparty" ? "receivable" : direction,
      isConsumerLoan: accountLoanType === "consumer",
      loanType: accountLoanType,
      currency: "CNY",
      groupId: group.id,
      institutionId: debtObject.kind === "institution" ? debtObject.id : null,
      counterpartyId: debtObject.kind === "counterparty" ? debtObject.id : null,
      householdId,
      isActive: true,
    },
    include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
  });
}

async function resolveDebtObject(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  debtObjectId: string,
) {
  const refMatch = /^(counterparty|institution):(.+)$/.exec(debtObjectId);
  const sourceKind = refMatch?.[1] ?? "counterparty";
  const sourceId = refMatch?.[2] ?? debtObjectId;
  if (sourceKind === "institution") {
    const institution = await tx.institution.findFirst({
      where: { id: sourceId, householdId, type: { in: ["bank", "debt"] } },
      select: { id: true, name: true, shortName: true, type: true },
    });
    if (!institution) throw new Error("贷款机构只能选择银行或贷款机构");
    return { ...institution, kind: "institution" as const };
  }

  const counterparty = await tx.counterparty.findFirst({
    where: { id: sourceId, householdId },
    select: { id: true, name: true, shortName: true, type: true },
  });
  if (!counterparty) throw new Error("请选择往来对象");
  return { ...counterparty, kind: "counterparty" as const };
}


function parseDateOnlyUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

const FIXED_LOAN_REPAYMENT_METHODS = new Set([
  EQUAL_PAYMENT_REPAYMENT_METHOD,
  EQUAL_PRINCIPAL_REPAYMENT_METHOD,
  INSTALLMENT_REPAYMENT_METHOD,
  INTEREST_FIRST_REPAYMENT_METHOD,
]);

function parseLoanRateAdjustmentsText(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = rows.map((line) => {
    const match = /^(\d{4}-\d{2}-\d{2})\s*[,，\s]\s*([0-9]+(?:\.[0-9]+)?)%?$/.exec(line);
    if (!match) throw new Error(`Invalid historical rate format: ${line}`);
    return {
      effectiveDate: match[1],
      annualRate: Number(match[2]),
    };
  });
  const invalid = parsed.find((item) => !Number.isFinite(item.annualRate) || item.annualRate < 0);
  if (invalid) throw new Error(`Invalid historical rate on ${invalid.effectiveDate}`);
  return normalizeLoanRateAdjustments(parsed);
}

function calculateLoanPlanAmount(params: {
  principal: number;
  annualRate: number | null;
  totalRuns: number;
  intervalMonths: number;
  repaymentMethod: string;
}) {
  return calcLoanScheduledAmount(params);
}

function calculateLoanNextRunDate(
  startDate: Date,
  intervalMonths: number,
  executionDay: number,
  executedRuns: number,
) {
  let nextRunDate = calcInitialScheduledRunDate(
    startDate,
    IntervalUnit.month,
    intervalMonths,
    executionDay,
    false,
  );
  for (let index = 0; index < Math.max(0, executedRuns); index += 1) {
    nextRunDate = calcNextScheduledRunDate(
      nextRunDate,
      IntervalUnit.month,
      intervalMonths,
      executionDay,
      false,
    );
  }
  return nextRunDate;
}

function selectLoanSchedulePlan<T extends { memo: string | null; status: string; nextRunDate: Date }>(plans: T[]) {
  let selected: T | null = null;
  for (const plan of plans) {
    if (shouldPreferLoanScheduledPlan(plan, selected)) selected = plan;
  }
  return selected;
}

function selectLoanAutoDebitPlan<T extends { id: string; memo: string | null; status: string; nextRunDate: Date }>(plans: T[], excludePlanId?: string | null) {
  let selected: T | null = null;
  for (const plan of plans) {
    if (plan.id === excludePlanId) continue;
    if (shouldPreferLoanAutoDebitPlan(plan, selected)) selected = plan;
  }
  return selected;
}

export async function createDebtTransaction(formData: FormData) {
  "use server";

  const mode = String(formData.get("mode") ?? "").trim();
  const loanFundingMode = String(formData.get("loanFundingMode") ?? "cash_disbursement").trim();
  const editEntryId = String(formData.get("editEntryId") ?? "").trim();
  const debtAccountId = String(formData.get("debtAccountId") ?? "").trim();
  const debtObjectId = String(formData.get("debtObjectId") ?? formData.get("debtInstitutionId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const autoDebitCashAccountId = String(formData.get("autoDebitCashAccountId") ?? "").trim();
  const submittedLoanRepaymentPlanId = String(formData.get("loanRepaymentPlanId") ?? "").trim();
  const submittedLoanRepaymentPeriod = Number.parseInt(String(formData.get("loanRepaymentPeriod") ?? ""), 10);
  const dateStr = String(formData.get("date") ?? "").trim();
  const principal = parseMoneyInput(formData.get("principal"));
  const principalAbs = Math.abs(principal);
  const rawInterest = Math.abs(parseMoneyInput(formData.get("interest")));
  const penalty = Math.abs(parseMoneyInput(formData.get("penalty")));
  const prepayStrategyRaw = String(formData.get("prepayStrategy") ?? "").trim();
  const prepayStrategy = normalizeLoanPrepayStrategy(prepayStrategyRaw);
  const annualRateRaw = String(formData.get("annualRate") ?? "").trim();
  const mortgageLprDiscountRaw = String(formData.get("mortgageLprDiscount") ?? "").trim();
  const repaymentMethod = normalizeLoanRepaymentMethod(String(formData.get("repaymentMethod") ?? "").trim());
  const loanYearsRaw = parseInt(String(formData.get("loanYears") ?? ""), 10);
  const repaymentIntervalMonthsRaw = parseInt(String(formData.get("repaymentIntervalMonths") ?? "1"), 10);
  const loanTotalRunsRaw = parseInt(String(formData.get("loanTotalRuns") ?? ""), 10);
  const firstBillDateStr = String(formData.get("firstBillDate") ?? "").trim();
  const firstRepaymentDateStr = String(formData.get("firstRepaymentDate") ?? "").trim();
  const autoDebitFirstDateStr = String(formData.get("autoDebitFirstDate") ?? "").trim();
  const createRepaymentPlan = String(formData.get("createRepaymentPlan") ?? "false") === "true";
  const loanType = normalizeLoanType(formData.get("loanType"));
  // Loan repayment execution mode: true = auto-debit (cash transfer when due,
  // mortgage-style); false = bill only (generate the bill, pay manually).
  const submittedAutoDebit = String(formData.get("autoDebit") ?? "true") !== "false";
  const isHomeLoanTypeValue = loanType != null && isHomeLoanType(loanType);
  const isCollateralLoanTypeValue = loanType != null && isCollateralLoanType(loanType);
  const autoDebit = isHomeLoanTypeValue ? true : submittedAutoDebit;
  const repaymentCashAccountId = autoDebit
    ? isCollateralLoanTypeValue ? autoDebitCashAccountId : cashAccountId
    : "";
  const createHistoricalRepaymentRecords = String(formData.get("createHistoricalRepaymentRecords") ?? "false") === "true";
  const historicalLoanRatesText = String(formData.get("historicalLoanRates") ?? "").trim();
  const acceptedLprRateEffectiveDateStr = String(formData.get("acceptedLprRateEffectiveDate") ?? "").trim();
  const acceptedLprAnnualRateRaw = String(formData.get("acceptedLprAnnualRate") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const debtItemName = String(formData.get("debtItemName") ?? "").trim();
  const loanPurposeCategoryId = String(formData.get("loanPurposeCategoryId") ?? "").trim();
  const fixedAssetAccountId = String(formData.get("fixedAssetAccountId") ?? "").trim();
  const fixedAssetAssetId = String(formData.get("fixedAssetAssetId") ?? "").trim();
  const tagIdsWereSubmitted = formData.has("tagIds");
  let tagIds: string[] = [];
  try {
    tagIds = tagIdsWereSubmitted ? parseSubmittedTagIds(formData.get("tagIds")) : [];
  } catch {
    return { ok: false as const, error: "INVALID_TAG_IDS" };
  }
  const { householdId } = await getHouseholdScope();
  let recalculateAfterSave: { accountId: string; startDate: string } | null = null;
  const isFinancedPurchase = mode === "borrow_in" && loanFundingMode === "financed_purchase";
  const allowsMissingCashAccount = isFinancedPurchase && autoDebit === false;
  const allowsZeroAnnualRate = allowsZeroAnnualRateRepaymentMethod(repaymentMethod);

  if (!["borrow_in", "repay_out", "prepay_out", "lend_out", "collect_in"].includes(mode)) {
    return { ok: false as const, error: "操作类型不正确" };
  }
  if ((mode === "repay_out" || mode === "prepay_out") && !debtAccountId) {
    return { ok: false as const, error: "REPAYMENT_REQUIRES_EXISTING_LOAN_ACCOUNT" };
  }
  if ((!debtAccountId && !debtObjectId) || (!cashAccountId && !allowsMissingCashAccount)) {
    return { ok: false as const, error: "请选择往来对象和资金账户" };
  }
  if (mode === "borrow_in" && isCollateralLoanTypeValue && (!fixedAssetAccountId || !fixedAssetAssetId)) {
    return { ok: false as const, error: "COLLATERAL_ASSET_REQUIRED" };
  }
  if (autoDebit && !repaymentCashAccountId) {
    return { ok: false as const, error: "Auto-debit requires a debit account" };
  }
  if (cashAccountId && debtAccountId && debtAccountId === cashAccountId) {
    return { ok: false as const, error: "往来对象账户与资金账户不能相同" };
  }
  if (repaymentCashAccountId && debtAccountId && debtAccountId === repaymentCashAccountId) {
    return { ok: false as const, error: "Loan account and debit account cannot be the same" };
  }
  if (principalAbs <= 0) {
    return { ok: false as const, error: "请输入正确的金额" };
  }
  const interest = mode === "prepay_out" ? 0 : rawInterest;
  if (interest < 0) {
    return { ok: false as const, error: "利息不能小于 0" };
  }
  if (penalty < 0) {
    return { ok: false as const, error: "手续费不能小于 0" };
  }
  const debtPrincipalForRecord = principalAbs;
  const realizedProfitForRecord = interest > 0
    ? (mode === "collect_in" ? Math.abs(interest) : -Math.abs(interest))
    : null;

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const mortgageLprDiscount = isHomeLoanTypeValue && mortgageLprDiscountRaw
    ? parseFloat(mortgageLprDiscountRaw)
    : null;
  if (
    isHomeLoanTypeValue &&
    mortgageLprDiscountRaw &&
    (mortgageLprDiscount == null || !Number.isFinite(mortgageLprDiscount) || mortgageLprDiscount <= 0)
  ) {
    return { ok: false as const, error: "LPR 利率折扣不正确" };
  }
  const annualRate = annualRateRaw
    ? parseFloat(annualRateRaw)
    : mortgageLprDiscount != null
      ? Math.round(((getMortgageBankExecutionRate(formatDateUtc(date))?.rate ?? MORTGAGE_BASE_BENCHMARK_RATE) * mortgageLprDiscount) * 1000) / 1000
      : allowsZeroAnnualRate
        ? 0
        : null;
  if (
    annualRateRaw &&
    (annualRate == null || !Number.isFinite(annualRate) || annualRate < 0 || (!allowsZeroAnnualRate && annualRate <= 0))
  ) {
    return { ok: false as const, error: "年利率不正确" };
  }
  const acceptedLprRateEffectiveDate = acceptedLprRateEffectiveDateStr
    ? parseDateOnlyUtc(acceptedLprRateEffectiveDateStr)
    : null;
  const acceptedLprAnnualRate = acceptedLprAnnualRateRaw ? parseFloat(acceptedLprAnnualRateRaw) : null;
  if (acceptedLprRateEffectiveDateStr && !acceptedLprRateEffectiveDate) {
    return { ok: false as const, error: "接受的 LPR 利率生效日期不正确" };
  }
  if (
    acceptedLprAnnualRateRaw &&
    (acceptedLprAnnualRate == null || !Number.isFinite(acceptedLprAnnualRate) || acceptedLprAnnualRate <= 0)
  ) {
    return { ok: false as const, error: "接受的 LPR 年利率不正确" };
  }
  const firstBillDate = firstBillDateStr ? parseDateOnlyUtc(firstBillDateStr) : null;
  if (firstBillDateStr && !firstBillDate) return { ok: false as const, error: "Invalid first bill date" };
  const firstRepaymentDate = firstRepaymentDateStr ? parseDateOnlyUtc(firstRepaymentDateStr) : null;
  if (firstRepaymentDateStr && !firstRepaymentDate) return { ok: false as const, error: "Invalid repayment due date" };
  const autoDebitFirstDate = autoDebitFirstDateStr ? parseDateOnlyUtc(autoDebitFirstDateStr) : null;
  if (autoDebitFirstDateStr && !autoDebitFirstDate) return { ok: false as const, error: "Invalid auto-debit date" };
  const repaymentIntervalMonths =
    Number.isFinite(repaymentIntervalMonthsRaw) && repaymentIntervalMonthsRaw > 0 ? repaymentIntervalMonthsRaw : 1;
  const loanTotalRuns =
    Number.isFinite(loanTotalRunsRaw) && loanTotalRunsRaw > 0
      ? loanTotalRunsRaw
      : Number.isFinite(loanYearsRaw) && loanYearsRaw > 0
        ? loanYearsRaw * 12
        : NaN;
  const isFixedRepaymentMethod = FIXED_LOAN_REPAYMENT_METHODS.has(repaymentMethod);
  const calculatedPlanAmount = calculateLoanPlanAmount({
    principal: principalAbs,
    annualRate,
    totalRuns: loanTotalRuns,
    intervalMonths: repaymentIntervalMonths,
    repaymentMethod,
  });
  const repaymentPlanAmount = calculatedPlanAmount;

  if (mode === "borrow_in" && isFixedRepaymentMethod) {
    if (annualRate == null || !Number.isFinite(annualRate) || annualRate < 0 || (!allowsZeroAnnualRate && annualRate <= 0)) {
      return { ok: false as const, error: "固定还款方式需要填写年利率" };
    }
    if (!Number.isFinite(repaymentIntervalMonths) || repaymentIntervalMonths <= 0) {
      return { ok: false as const, error: "固定还款方式需要填写还款周期" };
    }
    if (!Number.isFinite(loanTotalRuns) || loanTotalRuns <= 0) {
      return { ok: false as const, error: "固定还款方式需要填写总期数" };
    }
    if (!firstRepaymentDate) {
      return { ok: false as const, error: "固定还款方式需要填写首次还款日" };
    }
    if (!autoDebit && !firstBillDate) {
      return { ok: false as const, error: "A manual-payment loan requires a first bill date" };
    }
    if (autoDebit && !repaymentCashAccountId) {
      return { ok: false as const, error: "Auto-debit requires a debit account" };
    }
    if (autoDebit && !autoDebitFirstDate) {
      return { ok: false as const, error: "Auto-debit requires a debit date" };
    }
    if (!repaymentPlanAmount || repaymentPlanAmount <= 0) {
      return { ok: false as const, error: "无法计算计划还款金额，请检查借款总额、利率和期数" };
    }
  }
  if ((mode === "repay_out" || mode === "prepay_out") && debtAccountId) {
    const repaymentDebtAccount = await prisma.account.findFirst({
      where: {
        id: debtAccountId,
        householdId,
        kind: AccountKind.loan,
        isPlaceholder: { not: true },
      },
      select: {
        id: true,
        kind: true,
        investProductType: true,
        billingDay: true,
      },
    });
    if (repaymentDebtAccount) {
      const balanceByAccountId = await computeLoanPrincipalBalancesAsOf([repaymentDebtAccount], { householdId }, date, {
        excludeEntryId: editEntryId || null,
      });
      const repaymentDateBalance = balanceByAccountId.get(repaymentDebtAccount.id) ?? 0;
      if (repaymentDateBalance >= -ACTIVE_DEBT_EPSILON) {
        return { ok: false as const, error: "LOAN_ACCOUNT_HAS_NO_PAYABLE_BALANCE" };
      }
    }
  }
  let historicalLoanRateAdjustments: ReturnType<typeof parseLoanRateAdjustmentsText> = [];
  try {
    historicalLoanRateAdjustments = parseLoanRateAdjustmentsText(historicalLoanRatesText);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "历史利率格式不正确" };
  }
  if (isHomeLoanTypeValue && historicalLoanRateAdjustments.length === 0 && mortgageLprDiscount != null && mortgageLprDiscount > 0) {
    historicalLoanRateAdjustments = buildMortgageLprRateAdjustments({
      discount: mortgageLprDiscount,
      throughDate: formatDateUtc(new Date()),
      fromDate: formatDateUtc(date),
    });
  }

  try {
    let resolvedDebtAccountId = debtAccountId;
    let createdRepaymentPlanId: string | null = null;
    const affectedAccountIds = new Set<string>();
    await prisma.$transaction(async (tx) => {
      const debtDirection = mode === "borrow_in" || mode === "repay_out" || mode === "prepay_out" ? "payable" : "receivable";
      const cashAccount = cashAccountId ? await tx.account.findUnique({ where: { id: cashAccountId } }) : null;
      const repaymentCashAccount = repaymentCashAccountId
        ? repaymentCashAccountId === cashAccountId
          ? cashAccount
          : await tx.account.findUnique({ where: { id: repaymentCashAccountId } })
        : null;
      const debtAccount = debtObjectId
        ? await resolveOrCreateDebtAccount(tx, householdId, debtObjectId, debtDirection, loanType)
        : await tx.account.findUnique({
            where: { id: debtAccountId },
            include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
          });

      if (!debtAccount || !isLoanOrSettlementAccountKind(debtAccount.kind)) {
        throw new Error("往来对象账户不存在");
      }
      if (cashAccountId && (!cashAccount || isPureInvestmentAccount(cashAccount) || isLoanOrSettlementAccountKind(cashAccount.kind))) {
        throw new Error("Invalid cash account");
      }
      if (!cashAccount && !allowsMissingCashAccount) {
        throw new Error("Invalid cash account");
      }
      if (
        repaymentCashAccountId &&
        (!repaymentCashAccount || isPureInvestmentAccount(repaymentCashAccount) || isLoanOrSettlementAccountKind(repaymentCashAccount.kind))
      ) {
        throw new Error("Invalid repayment account");
      }
      if (autoDebit && !repaymentCashAccount) {
        throw new Error("Auto-debit requires a debit account");
      }
      const requireCashAccount = () => {
        if (!cashAccount) throw new Error("Invalid cash account");
        return cashAccount;
      };
      const syncCollateralAssetLink = async () => {
        if (mode !== "borrow_in" || !isCollateralLoanTypeValue) return;
        if (!fixedAssetAccountId || !fixedAssetAssetId) throw new Error("COLLATERAL_ASSET_REQUIRED");
        const collateralAsset = await tx.propertyAsset.findFirst({
          where: {
            id: fixedAssetAssetId,
            householdId,
            accountId: fixedAssetAccountId,
            deletedAt: null,
          },
        });
        if (!collateralAsset) throw new Error("COLLATERAL_ASSET_NOT_FOUND");
        if (["sold", "disposed", "deleted"].includes(collateralAsset.status ?? "")) {
          throw new Error("COLLATERAL_ASSET_NOT_AVAILABLE");
        }
        if (collateralAsset.mortgageLoanAccountId && collateralAsset.mortgageLoanAccountId !== debtAccount.id) {
          throw new Error("COLLATERAL_ASSET_ALREADY_MORTGAGED");
        }
        await tx.propertyAsset.updateMany({
          where: {
            householdId,
            mortgageLoanAccountId: debtAccount.id,
            id: { not: fixedAssetAssetId },
            deletedAt: null,
            status: { notIn: ["sold", "disposed", "deleted"] },
          },
          data: { mortgageLoanAccountId: null, status: "active" },
        });
        await tx.propertyAsset.update({
          where: { id: fixedAssetAssetId },
          data: { mortgageLoanAccountId: debtAccount.id, status: "mortgaged" },
        });
        // 贷款账户记录当时的抵押物。结清自动解除时只清资产侧标记，这个字段保留，
        // 已还清的贷款记录仍能表明当时使用的抵押物。
        await tx.account.update({
          where: { id: debtAccount.id },
          data: { collateralAssetId: fixedAssetAssetId },
        });
        affectedAccountIds.add(fixedAssetAccountId);
      };
      const isCounterpartyDebtAccount = !!debtAccount.counterpartyId && !debtAccount.institutionId;
      if (!isCounterpartyDebtAccount && (mode === "repay_out" || mode === "prepay_out") && debtAccount.debtDirection !== "payable") {
        throw new Error("还款只能选择已有借款项");
      }
      if (!isCounterpartyDebtAccount && mode === "lend_out" && debtAccount.debtDirection !== "receivable") {
        throw new Error("借出只能选择已有借出项或往来对象");
      }
      if (!isCounterpartyDebtAccount && mode === "collect_in" && debtAccount.debtDirection !== "receivable") {
        throw new Error("收回只能选择已有借出项");
      }
      let loanRepaymentLink: { planId: string; period: number } | null = null;
      if (mode === "repay_out" && !isCounterpartyDebtAccount) {
        const repaymentPlans = await tx.regularInvestPlan.findMany({
          where: {
            householdId,
            accountId: debtAccount.id,
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
        });
        const repaymentPlan = selectLoanSchedulePlan(repaymentPlans);
        if (!repaymentPlan) throw new Error("LOAN_REPAYMENT_PLAN_NOT_FOUND");
        const repaymentPlanMemo = decodeScheduledTaskMemo(repaymentPlan.memo);
        const repaymentStartDate = repaymentPlanMemo.firstRepaymentDate
          ? parseDateOnlyUtc(repaymentPlanMemo.firstRepaymentDate) ?? repaymentPlan.startDate
          : repaymentPlan.startDate;
        const repaymentPeriod = resolveLoanRepaymentPeriodForDate({
          startDate: repaymentStartDate,
          intervalUnit: repaymentPlan.intervalUnit,
          intervalValue: repaymentPlan.intervalValue,
          executionDay: repaymentPlan.executionDay,
          secondaryExecutionDay: repaymentPlan.secondaryExecutionDay,
          totalRuns: repaymentPlan.totalRuns,
        }, date);
        if (!repaymentPeriod) throw new Error("LOAN_REPAYMENT_PERIOD_NOT_FOUND");
        if (submittedLoanRepaymentPlanId && submittedLoanRepaymentPlanId !== repaymentPlan.id) {
          throw new Error("LOAN_REPAYMENT_PLAN_CHANGED");
        }
        if (Number.isFinite(submittedLoanRepaymentPeriod) && submittedLoanRepaymentPeriod !== repaymentPeriod.period) {
          throw new Error("LOAN_REPAYMENT_PERIOD_CHANGED");
        }
        loanRepaymentLink = { planId: repaymentPlan.id, period: repaymentPeriod.period };
      }
      const settlementTransferCategory = await ensureSettlementTransferCategory(tx, householdId);
      const isMortgageBorrow = mode === "borrow_in" && isHomeLoanTypeValue;
      // Mortgage loan borrow records use a cash-account transfer category instead
      // of the settlement transfer category.
      const mortgageFundCategory = isMortgageBorrow ? await ensureMortgageFundCategory(tx, householdId) : null;
      // Loan purpose category: when a purpose is provided (loan dialog), the
      // borrow record is categorized under it instead of the default category.
      const loanPurposeCategory = loanPurposeCategoryId
        ? await tx.category.findFirst({ where: { id: loanPurposeCategoryId, householdId } })
        : null;
      if (loanPurposeCategoryId && !loanPurposeCategory) {
        throw new Error("LOAN_PURPOSE_CATEGORY_NOT_FOUND");
      }
      const borrowCategoryId = loanPurposeCategory?.id ?? mortgageFundCategory?.id ?? settlementTransferCategory?.id ?? null;
      const borrowCategoryName = loanPurposeCategory?.name ?? mortgageFundCategory?.name ?? settlementTransferCategory?.name ?? DEFAULT_SETTLEMENT_CATEGORY_NAME;
      resolvedDebtAccountId = debtAccount.id;
      if (
        acceptedLprRateEffectiveDate &&
        acceptedLprAnnualRate != null &&
        mode === "repay_out"
      ) {
        const repaymentPlan = await tx.regularInvestPlan.findFirst({
          where: {
            householdId,
            accountId: debtAccount.id,
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
          select: { id: true },
        });
        await tx.loanRateAdjustment.deleteMany({
          where: {
            householdId,
            accountId: debtAccount.id,
            effectiveDate: acceptedLprRateEffectiveDate,
          },
        });
        await tx.loanRateAdjustment.create({
          data: {
            householdId,
            accountId: debtAccount.id,
            regularInvestPlanId: repaymentPlan?.id ?? null,
            effectiveDate: acceptedLprRateEffectiveDate,
            annualRate: acceptedLprAnnualRate,
          },
        });
      }
      const outstandingPrincipalBefore = Math.abs(toNumber(debtAccount.balance));
      if (!editEntryId && mode === "prepay_out" && principalAbs - outstandingPrincipalBefore > 0.005) {
        throw new Error(`提前还本金不能超过当前贷款本金余额 ${outstandingPrincipalBefore.toFixed(2)}`);
      }
      if (!editEntryId && mode === "prepay_out" && prepayStrategy === "settle" && Math.abs(principalAbs - outstandingPrincipalBefore) > 0.005) {
        throw new Error(`全部结清时，提前还本金应等于当前贷款本金余额 ${outstandingPrincipalBefore.toFixed(2)}`);
      }
      const isInstitutionBorrow =
        mode === "borrow_in" &&
        !!debtAccount.institutionId &&
        !!debtAccount.Institution &&
        (debtAccount.Institution.type === "bank" || debtAccount.Institution.type === "debt");
      const effectiveDebtAccountName = editEntryId && debtItemName ? debtItemName : debtAccount.name;
      if (isInstitutionBorrow) {
        if (effectiveDebtAccountName !== debtAccount.name) {
          await assertAccountIdentityUnique(tx, {
            householdId,
            groupId: debtAccount.groupId,
            institutionId: debtAccount.institutionId,
            counterpartyId: debtAccount.counterpartyId,
            kind: debtAccount.kind,
            name: effectiveDebtAccountName,
            numberMasked: debtAccount.numberMasked,
            excludeId: debtAccount.id,
          });
        }
        await tx.account.update({
          where: { id: debtAccount.id },
          data: {
            ...(editEntryId && debtItemName ? { name: debtItemName } : {}),
            ...(isFixedRepaymentMethod
              ? {
                  billingDay: firstBillDate?.getUTCDate() ?? null,
                  repaymentDay: firstRepaymentDate?.getUTCDate() ?? null,
                }
              : {}),
          },
        });
      }
      const isFinancedPurchaseForRecord = mode === "borrow_in" && isFinancedPurchase;
      if (editEntryId) {
        if (!["borrow_in", "repay_out", "prepay_out", "lend_out", "collect_in"].includes(mode)) {
          throw new Error("只能在借入、借出、还款、提前还款或收回界面编辑往来款记录");
        }
        const original = await tx.txRecord.findFirst({
          where: {
            id: editEntryId,
            householdId,
            deletedAt: null,
            type: TransactionType.transfer,
          },
        });
        if (!original) throw new Error("原还款记录不存在");
        affectedAccountIds.add(original.accountId);
        if (original.toAccountId) affectedAccountIds.add(original.toAccountId);
        if (cashAccount) affectedAccountIds.add(cashAccount.id);
        if (repaymentCashAccount) affectedAccountIds.add(repaymentCashAccount.id);
        affectedAccountIds.add(debtAccount.id);

        const isDebtAccountFromSide = mode === "borrow_in" || mode === "collect_in";
        const transferFromAccount = isDebtAccountFromSide ? debtAccount : requireCashAccount();
        const transferToAccount = isFinancedPurchaseForRecord ? null : isDebtAccountFromSide ? requireCashAccount() : debtAccount;
        const transferStatementMonth =
          transferToAccount &&
          (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
          transferToAccount.billingDay
            ? toStatementMonth(date, transferToAccount.billingDay)
            : null;
        await tx.txRecord.update({
          where: { id: original.id },
          data: {
            accountId: transferFromAccount.id,
            accountName: transferFromAccount.id === debtAccount.id ? effectiveDebtAccountName : transferFromAccount.name,
            toAccountId: transferToAccount?.id ?? null,
            toAccountName: transferToAccount?.id === debtAccount.id ? effectiveDebtAccountName : transferToAccount?.name ?? null,
            amount: mode === "repay_out" || mode === "prepay_out"
              ? -Math.abs(principalAbs + interest + (mode === "prepay_out" ? penalty : 0))
              : mode === "collect_in"
                ? debtPrincipalForRecord + interest
                : -debtPrincipalForRecord,
            debtPrincipalAmount: debtPrincipalForRecord,
            debtInterestAmount: ["repay_out", "lend_out", "collect_in"].includes(mode) ? Math.abs(interest) : 0,
            debtFeeAmount: mode === "prepay_out" ? Math.abs(penalty) : 0,
            realizedProfit: realizedProfitForRecord,
            date,
            note: note || null,
            toNote: mode === "prepay_out" ? encodeLoanPrepayStrategy(prepayStrategy) : original.toNote,
            statementMonth: transferStatementMonth,
            source: isFinancedPurchaseForRecord ? "debt_financed_purchase" : `debt_${mode}`,
            regularInvestPlanId: loanRepaymentLink?.planId ?? original.regularInvestPlanId,
            installmentNo: loanRepaymentLink?.period ?? original.installmentNo,
            categoryId: mode === "borrow_in" && isFinancedPurchaseForRecord && !loanPurposeCategory
              ? original.categoryId
              : borrowCategoryId,
            categoryName: mode === "borrow_in" && isFinancedPurchaseForRecord && !loanPurposeCategory
              ? original.categoryName
              : borrowCategoryName,
          },
        });
        if (tagIdsWereSubmitted) {
          await replaceEntryTags({ tx, entryId: original.id, householdId, tagIds });
        }
        await syncCollateralAssetLink();
        if (mode === "prepay_out" && transferToAccount?.id) {
          recalculateAfterSave = {
            accountId: transferToAccount.id,
            startDate: formatDateUtc(date),
          };
        }

        await tx.txRecord.updateMany({
          where: {
            householdId,
            id: { not: original.id },
            accountId: original.accountId,
            toAccountId: original.toAccountId,
            date: original.date,
            deletedAt: null,
            type: { not: TransactionType.transfer },
            OR: [
              { source: { in: ["debt_repay_out_interest", "debt_prepay_out_interest", "debt_collect_in_interest", "debt_prepay_out_fee"] } },
              { categoryName: { contains: "利息" } },
              { note: { contains: "利息" } },
              { categoryName: { contains: "手续费" } },
              { note: { contains: "违约金" } },
            ],
          },
          data: { deletedAt: new Date() },
        });
        if (mode === "borrow_in") {
          const existingPlans = await tx.regularInvestPlan.findMany({
            where: {
              householdId,
              accountId: debtAccount.id,
              fundCode: "loan_repayment",
              status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
            },
            orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
          });
          const existingPlan = selectLoanSchedulePlan(existingPlans);
          if (existingPlan) {
            const existingAutoDebitPlan = selectLoanAutoDebitPlan(existingPlans, existingPlan.id);
            const intervalMonths = Number.isFinite(repaymentIntervalMonths) && repaymentIntervalMonths > 0
              ? repaymentIntervalMonths
              : existingPlan.intervalValue;
            const totalRuns = Number.isFinite(loanTotalRuns) && loanTotalRuns > 0
              ? loanTotalRuns
              : existingPlan.totalRuns ?? 0;
            const startDate = firstRepaymentDate ?? existingPlan.startDate;
            const executionDay = firstRepaymentDate
              ? firstRepaymentDate.getUTCDate()
              : existingPlan.executionDay ?? startDate.getUTCDate();
            const planAmount = Number.isFinite(repaymentPlanAmount) && repaymentPlanAmount != null && repaymentPlanAmount > 0
              ? repaymentPlanAmount
              : (existingPlan.amount ?? 0);
            const loanLabel = effectiveDebtAccountName;
            const primaryPlanRole = (isFinancedPurchaseForRecord && !isHomeLoanTypeValue) || !autoDebit ? "bill" : "auto_debit";
            const primaryPlanCashAccount = primaryPlanRole === "auto_debit" ? repaymentCashAccount : null;
            const title = isFinancedPurchaseForRecord && primaryPlanRole === "bill" ? `${INSTALLMENT_BILL_TITLE_PREFIX}${loanLabel}` : `${REPAYMENT_TITLE_PREFIX}${loanLabel}`;
            const nextRunDate = calculateLoanNextRunDate(
              startDate,
              intervalMonths,
              executionDay,
              existingPlan.executedRuns ?? 0,
            );
            await tx.regularInvestPlan.update({
              where: { id: existingPlan.id },
              data: {
                accountName: effectiveDebtAccountName,
                cashAccountId: primaryPlanCashAccount?.id ?? null,
                cashAccountName: primaryPlanCashAccount?.name ?? null,
                amount: planAmount,
                intervalValue: intervalMonths,
                executionDay,
                startDate,
                nextRunDate,
                totalRuns,
                fundName: title,
                memo: encodeScheduledTaskMemo({
                  type: "loan_repayment",
                  title,
                  fromAccountId: primaryPlanCashAccount?.id ?? null,
                  toAccountId: debtAccount.id,
                  annualRate: annualRate ?? null,
                  mortgageLprDiscount: mortgageLprDiscount ?? null,
                  repaymentMethod,
                  repaymentIntervalMonths: intervalMonths,
                  originalTotalRuns: totalRuns,
                  firstBillDate: firstBillDate ? formatDateUtc(firstBillDate) : null,
                  firstRepaymentDate: firstRepaymentDate ? formatDateUtc(firstRepaymentDate) : null,
                  loanPlanRole: primaryPlanRole,
                  autoDebit: primaryPlanRole === "auto_debit",
                }),
              },
            });
            await replaceLoanRateAdjustmentsForAccount(tx, {
              householdId,
              accountId: debtAccount.id,
              regularInvestPlanId: existingPlan.id,
              adjustments: historicalLoanRateAdjustments,
            });
            await tx.txRecord.update({
              where: { id: original.id },
              data: { regularInvestPlanId: existingPlan.id },
            });

            if (isFinancedPurchaseForRecord) {
              const autoDebitPlanIds = existingPlans
                .filter((plan) => plan.id !== existingPlan.id && getLoanScheduledPlanRole(decodeScheduledTaskMemo(plan.memo)) === "auto_debit")
                .map((plan) => plan.id);
              if (primaryPlanRole === "bill" && autoDebit && repaymentCashAccount && (autoDebitFirstDate ?? firstRepaymentDate)) {
                const debitStartDate = autoDebitFirstDate ?? firstRepaymentDate ?? existingAutoDebitPlan?.startDate ?? startDate;
                const debitExecutionDay = debitStartDate.getUTCDate();
                const debitTitle = `${AUTO_DEBIT_TITLE_PREFIX}${loanLabel}`;
                const debitNextRunDate = calculateLoanNextRunDate(
                  debitStartDate,
                  intervalMonths,
                  debitExecutionDay,
                  existingAutoDebitPlan?.executedRuns ?? existingPlan.executedRuns ?? 0,
                );
                if (existingAutoDebitPlan) {
                  await tx.regularInvestPlan.update({
                    where: { id: existingAutoDebitPlan.id },
                    data: {
                      accountName: effectiveDebtAccountName,
                      cashAccountId: repaymentCashAccount.id,
                      cashAccountName: repaymentCashAccount.name,
                      amount: planAmount,
                      intervalValue: intervalMonths,
                      executionDay: debitExecutionDay,
                      startDate: debitStartDate,
                      nextRunDate: debitNextRunDate,
                      totalRuns,
                      status: RegularInvestStatus.active,
                      fundName: debitTitle,
                      memo: encodeScheduledTaskMemo({
                        type: "loan_repayment",
                        title: debitTitle,
                        fromAccountId: repaymentCashAccount.id,
                        toAccountId: debtAccount.id,
                        annualRate: annualRate ?? null,
                        mortgageLprDiscount: mortgageLprDiscount ?? null,
                        repaymentMethod,
                        repaymentIntervalMonths: intervalMonths,
                        originalTotalRuns: totalRuns,
                        firstBillDate: null,
                        firstRepaymentDate: formatDateUtc(debitStartDate),
                        loanPlanRole: "auto_debit",
                        autoDebit: true,
                      }),
                    },
                  });
                } else {
                  await tx.regularInvestPlan.create({
                    data: {
                      accountId: debtAccount.id,
                      accountName: effectiveDebtAccountName,
                      cashAccountId: repaymentCashAccount.id,
                      cashAccountName: repaymentCashAccount.name,
                      fundCode: "loan_repayment",
                      fundName: debitTitle,
                      fundProductType: null,
                      amount: planAmount,
                      intervalUnit: IntervalUnit.month,
                      intervalValue: intervalMonths,
                      executionDay: debitExecutionDay,
                      startDate: debitStartDate,
                      nextRunDate: debitNextRunDate,
                      endDate: null,
                      totalRuns,
                      executedRuns: existingPlan.executedRuns ?? 0,
                      lastRunDate: existingPlan.lastRunDate,
                      status: RegularInvestStatus.active,
                      feeRate: 0,
                      confirmDays: 0,
                      arrivalDays: 0,
                      memo: encodeScheduledTaskMemo({
                        type: "loan_repayment",
                        title: debitTitle,
                        fromAccountId: repaymentCashAccount.id,
                        toAccountId: debtAccount.id,
                        annualRate: annualRate ?? null,
                        mortgageLprDiscount: mortgageLprDiscount ?? null,
                        repaymentMethod,
                        repaymentIntervalMonths: intervalMonths,
                        originalTotalRuns: totalRuns,
                        firstBillDate: null,
                        firstRepaymentDate: formatDateUtc(debitStartDate),
                        loanPlanRole: "auto_debit",
                        autoDebit: true,
                      }),
                      skipPendingPreceding: false,
                      householdId,
                    },
                  });
                }
              } else if (autoDebitPlanIds.length > 0) {
                await tx.regularInvestPlan.updateMany({
                  where: { householdId, id: { in: autoDebitPlanIds } },
                  data: { status: RegularInvestStatus.completed },
                });
              }
            }
          }
        }
        // 还款/提前还款记录被编辑后，若贷款就此结清，同步解除抵押资产状态
        if (mode === "repay_out" || mode === "prepay_out") {
          await releaseMortgagedAssetsForSettledLoanAccounts(tx, { householdId, debtAccountIds: [debtAccount.id] });
        }
        return;
      }
      const shouldCreateRepaymentPlan =
        mode === "borrow_in" &&
        createRepaymentPlan &&
        !!firstRepaymentDate &&
        !!repaymentPlanAmount &&
        repaymentPlanAmount > 0 &&
        Number.isFinite(loanTotalRuns) &&
        loanTotalRuns > 0;

      const transferFromAccount = mode === "borrow_in" || mode === "collect_in" ? debtAccount : requireCashAccount();
      const transferToAccount = isFinancedPurchaseForRecord ? null : mode === "borrow_in" || mode === "collect_in" ? requireCashAccount() : debtAccount;
      const transferStatementMonth =
        transferToAccount &&
        (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
        transferToAccount.billingDay
          ? toStatementMonth(date, transferToAccount.billingDay)
          : null;

      const createdBorrow = await tx.txRecord.create({
        data: {
          accountId: transferFromAccount.id,
          accountName: transferFromAccount.id === debtAccount.id ? effectiveDebtAccountName : transferFromAccount.name,
          toAccountId: transferToAccount?.id ?? null,
          toAccountName: transferToAccount?.id === debtAccount.id ? effectiveDebtAccountName : transferToAccount?.name ?? null,
          amount: mode === "repay_out" || mode === "prepay_out"
            ? -Math.abs(principalAbs + interest + (mode === "prepay_out" ? penalty : 0))
            : mode === "collect_in"
              ? debtPrincipalForRecord + interest
              : -debtPrincipalForRecord,
          debtPrincipalAmount: debtPrincipalForRecord,
          debtInterestAmount: ["repay_out", "lend_out", "collect_in"].includes(mode) ? Math.abs(interest) : null,
          debtFeeAmount: mode === "prepay_out" ? Math.abs(penalty) : null,
          realizedProfit: realizedProfitForRecord,
          type: TransactionType.transfer,
          date,
          note: mode === "borrow_in"
            ? (isInstitutionBorrow || isFixedRepaymentMethod)
              ? [
                  note || (isFinancedPurchaseForRecord && !isInstitutionBorrow ? FINANCED_PURCHASE_NOTE : isInstitutionBorrow ? INSTITUTION_BORROW_NOTE : BORROW_NOTE),
                  `还款方式：${repaymentMethod}`,
                  isFixedRepaymentMethod && Number.isFinite(repaymentIntervalMonths) && repaymentIntervalMonths > 0
                    ? `周期：每${repaymentIntervalMonths === 1 ? "月" : `${repaymentIntervalMonths}个月`}`
                    : "",
                  isFixedRepaymentMethod && Number.isFinite(loanTotalRuns) && loanTotalRuns > 0 ? `期数：${loanTotalRuns}` : "",
                  isFixedRepaymentMethod && annualRate != null ? `年利率：${annualRate}%` : "",
                  isInstitutionBorrow && isFixedRepaymentMethod && mortgageLprDiscount != null ? `LPR折扣：${mortgageLprDiscount}` : "",
                ].filter(Boolean).join("；")
              : note || "借入"
            : note || null,
          toNote: mode === "prepay_out" ? encodeLoanPrepayStrategy(prepayStrategy) : null,
          statementMonth: transferStatementMonth,
          source: isFinancedPurchaseForRecord ? "debt_financed_purchase" : `debt_${mode}`,
          regularInvestPlanId: loanRepaymentLink?.planId ?? null,
          installmentNo: loanRepaymentLink?.period ?? null,
          categoryId: borrowCategoryId,
          categoryName: borrowCategoryName,
          householdId,
        },
      });

      if (tagIdsWereSubmitted) {
        await attachEntryTags({ tx, entryId: createdBorrow.id, householdId, tagIds });
      }

      if (mode === "borrow_in" && isCollateralLoanTypeValue) {
        await syncCollateralAssetLink();
      } else if (mode === "borrow_in" && fixedAssetAccountId) {
        // Link direct-purchase loan principal to a fixed asset when selected.
        // Financed purchases are paid by the lender, so the loan account is the
        // funding side even when a later auto-debit cash account is selected.
        const fixedAssetFundingAccount = isFinancedPurchaseForRecord ? debtAccount : cashAccount ?? debtAccount;
        await linkExpenseToFixedAsset(tx, {
          householdId,
          propertyAccountId: fixedAssetAccountId,
          propertyAssetId: fixedAssetAssetId || undefined,
          cashEntry: {
            id: createdBorrow.id,
            accountId: fixedAssetFundingAccount.id,
            accountName: fixedAssetFundingAccount.name,
            amount: createdBorrow.amount,
            type: "expense",
            date: createdBorrow.date,
            postedAt: createdBorrow.postedAt,
            currency: createdBorrow.currency,
            note: createdBorrow.note,
          },
          propertyName: undefined,
        });
      }

      if (shouldCreateRepaymentPlan && firstRepaymentDate) {
        const totalRuns = loanTotalRuns;
        const executionDay = firstRepaymentDate.getUTCDate();
        const loanLabel = effectiveDebtAccountName;
        const primaryPlanRole = (isFinancedPurchaseForRecord && !isHomeLoanTypeValue) || !autoDebit ? "bill" : "auto_debit";
        const primaryPlanCashAccount = primaryPlanRole === "auto_debit" ? repaymentCashAccount : null;
        const title = isFinancedPurchaseForRecord && primaryPlanRole === "bill" ? `${INSTALLMENT_BILL_TITLE_PREFIX}${loanLabel}` : `${REPAYMENT_TITLE_PREFIX}${loanLabel}`;
        const plan = await tx.regularInvestPlan.create({
          data: {
            accountId: debtAccount.id,
            accountName: effectiveDebtAccountName,
            cashAccountId: primaryPlanCashAccount?.id ?? null,
            cashAccountName: primaryPlanCashAccount?.name ?? null,
            fundCode: "loan_repayment",
            fundName: title,
            fundProductType: null,
            amount: repaymentPlanAmount,
            intervalUnit: IntervalUnit.month,
            intervalValue: repaymentIntervalMonths,
            executionDay,
            startDate: firstRepaymentDate,
            nextRunDate: calcInitialScheduledRunDate(firstRepaymentDate, IntervalUnit.month, repaymentIntervalMonths, executionDay, false),
            endDate: null,
            totalRuns,
            status: RegularInvestStatus.active,
            feeRate: 0,
            confirmDays: 0,
            arrivalDays: 0,
            memo: encodeScheduledTaskMemo({
              type: "loan_repayment",
              title,
              fromAccountId: primaryPlanCashAccount?.id ?? null,
              toAccountId: debtAccount.id,
              annualRate: annualRate ?? null,
              mortgageLprDiscount: mortgageLprDiscount ?? null,
              repaymentMethod,
              repaymentIntervalMonths,
              originalTotalRuns: totalRuns,
              firstBillDate: firstBillDate ? formatDateUtc(firstBillDate) : null,
              firstRepaymentDate: firstRepaymentDate ? formatDateUtc(firstRepaymentDate) : null,
              loanPlanRole: primaryPlanRole,
              autoDebit: primaryPlanRole === "auto_debit",
            }),
            skipPendingPreceding: false,
            householdId,
          },
        });
        await replaceLoanRateAdjustmentsForAccount(tx, {
          householdId,
          accountId: debtAccount.id,
          regularInvestPlanId: plan.id,
          adjustments: historicalLoanRateAdjustments,
        });
        createdRepaymentPlanId = plan.id;
        await tx.txRecord.update({
          where: { id: createdBorrow.id },
          data: { regularInvestPlanId: plan.id },
        });

        if (isFinancedPurchaseForRecord && primaryPlanRole === "bill" && autoDebit && repaymentCashAccount && autoDebitFirstDate) {
          const debitExecutionDay = autoDebitFirstDate.getUTCDate();
          const debitTitle = `${AUTO_DEBIT_TITLE_PREFIX}${loanLabel}`;
          await tx.regularInvestPlan.create({
            data: {
              accountId: debtAccount.id,
              accountName: effectiveDebtAccountName,
              cashAccountId: repaymentCashAccount.id,
              cashAccountName: repaymentCashAccount.name,
              fundCode: "loan_repayment",
              fundName: debitTitle,
              fundProductType: null,
              amount: repaymentPlanAmount,
              intervalUnit: IntervalUnit.month,
              intervalValue: repaymentIntervalMonths,
              executionDay: debitExecutionDay,
              startDate: autoDebitFirstDate,
              nextRunDate: calcInitialScheduledRunDate(autoDebitFirstDate, IntervalUnit.month, repaymentIntervalMonths, debitExecutionDay, false),
              endDate: null,
              totalRuns,
              status: RegularInvestStatus.active,
              feeRate: 0,
              confirmDays: 0,
              arrivalDays: 0,
              memo: encodeScheduledTaskMemo({
                type: "loan_repayment",
                title: debitTitle,
                fromAccountId: repaymentCashAccount.id,
                toAccountId: debtAccount.id,
                annualRate: annualRate ?? null,
                mortgageLprDiscount: mortgageLprDiscount ?? null,
                repaymentMethod,
                repaymentIntervalMonths,
                originalTotalRuns: totalRuns,
                firstBillDate: null,
                firstRepaymentDate: formatDateUtc(autoDebitFirstDate),
                loanPlanRole: "auto_debit",
                autoDebit: true,
              }),
              skipPendingPreceding: false,
              householdId,
            },
          });
        }
      }

      if (mode === "prepay_out") {
        recalculateAfterSave = {
          accountId: debtAccount.id,
          startDate: formatDateUtc(date),
        };
      }

      // 还款/提前还款落库后，若贷款就此结清，同步解除抵押资产状态
      if (mode === "repay_out" || mode === "prepay_out") {
        await releaseMortgagedAssetsForSettledLoanAccounts(tx, { householdId, debtAccountIds: [debtAccount.id] });
      }
    });

    await Promise.all([
      ...Array.from(new Set([resolvedDebtAccountId, cashAccountId, repaymentCashAccountId, fixedAssetAccountId, ...affectedAccountIds].filter(Boolean)))
        .map((id) => recalcAndSaveAccountBalance(id).catch(() => {})),
    ]);
    await invalidateCreditCardCycleCacheForAccountIds([
      resolvedDebtAccountId,
      cashAccountId,
      repaymentCashAccountId,
      fixedAssetAccountId,
      ...affectedAccountIds,
    ]).catch(() => {});
    let historicalGenerationWarning: string | null = null;
    if (createdRepaymentPlanId && createHistoricalRepaymentRecords && !isFinancedPurchase) {
      const createdPlan = await prisma.regularInvestPlan.findFirst({
        where: { id: createdRepaymentPlanId, householdId },
      });
      if (createdPlan) {
        try {
          await executeNonFundScheduledTaskPlan({
            householdId,
            plan: createdPlan,
            task: decodeScheduledTaskMemo(createdPlan.memo),
            initialLoanPrincipal: principalAbs,
          });
        } catch (error) {
          historicalGenerationWarning = error instanceof Error ? error.message : "历史还款记录补生成失败";
        }
      }
    }
    revalidateAfterTxChange();
    if (historicalGenerationWarning) {
      return {
        ok: true as const,
        warning: `借款和还款计划已保存，但历史还款记录没有补生成：${historicalGenerationWarning}`,
        recalculateAfterSave,
      };
    }
    return { ok: true as const, recalculateAfterSave };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "借还款失败" };
  }
}
