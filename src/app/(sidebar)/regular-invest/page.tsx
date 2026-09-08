import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { buildAccountDisplayOption, buildFlatAccountOptions, buildGroupedAccountOptions } from "@/lib/account-display";
import { buildCategorySmartSelectOptions } from "@/components/categorySmartSelect";
import { categoryOrderBy } from "@/lib/category-order";
import { decodeScheduledTaskMemo, getLoanScheduledPlanRole, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { AccountKind, TransactionType } from "@prisma/client";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { toStatementMonth } from "@/lib/date-utils";
import { allocateBuyFailedRefunds, getConfirmedBuyAmount } from "@/lib/fund/refund-link";
import { getFundProfileNameMap, normalizeFundDisplayName } from "@/lib/fund/fundProfile";
import { RegularInvestClient } from "./RegularInvestClient";
import { MobileRegularInvest } from "@/components/mobile/MobileRegularInvest";
import { resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { isCreditCardRepaymentTransfer, recordMatchesRegularInvestPlan } from "@/lib/transaction-semantics";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";
import { getServerAccountDropdownRestrictType } from "@/lib/server/account-dropdown-restrict";
import { getServerT } from "@/lib/server/i18n";
import { createTransaction } from "@/lib/server/sidebar-actions/transaction-actions";
import { normalizeLoanRepaymentMethod } from "@/lib/loan-repayment";

async function updateScheduledTransferRecord(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();

  const entryId = String(formData.get("entryId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = Number(String(formData.get("amount") ?? "").trim());
  const fromAccountId = String(formData.get("fromAccountId") ?? "").trim();
  const toAccountId = String(formData.get("toAccountId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();

  if (!entryId) return { ok: false as const, error: "缺少记录 ID" };
  if (!dateStr || Number.isNaN(new Date(dateStr).getTime())) return { ok: false as const, error: "日期不正确" };
  const amountAbs = Number.isFinite(amountRaw) ? Math.abs(amountRaw) : 0;
  if (amountAbs <= 0) return { ok: false as const, error: "金额不正确" };
  if (!fromAccountId || !toAccountId) return { ok: false as const, error: "转出和转入账户都必须填写" };
  if (fromAccountId === toAccountId) return { ok: false as const, error: "转出/转入账户不能相同" };

  try {
    const date = new Date(dateStr);
    const updated = await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({ where: { id: entryId } });
      if (!entry) throw new Error("记录不存在");
      if (entry.householdId && entry.householdId !== householdId) throw new Error("记录不属于当前账簿");
      if (!entry.regularInvestPlanId || entry.source !== "scheduled_task") throw new Error("这不是计划任务生成的转账记录");

      const [fromAcc, toAcc] = await Promise.all([
        tx.account.findUnique({ where: { id: fromAccountId } }),
        tx.account.findUnique({ where: { id: toAccountId } }),
      ]);
      if (!fromAcc || !toAcc) throw new Error("账户不存在");
      if (fromAcc.householdId !== householdId || toAcc.householdId !== householdId) throw new Error("账户不属于当前账簿");

      const statementMonth =
        (toAcc.kind === AccountKind.bank_credit || toAcc.kind === AccountKind.loan) && toAcc.billingDay
          ? toStatementMonth(date, toAcc.billingDay)
          : null;
      const repaymentCategory = isCreditCardRepaymentTransfer({
        type: TransactionType.transfer,
        accountKind: fromAcc.kind,
        toAccountKind: toAcc.kind,
      })
        ? await resolveCreditCardRepaymentCategory(tx, householdId)
        : null;

      const updated = await tx.txRecord.update({
        where: { id: entryId },
        data: {
          type: TransactionType.transfer,
          date,
          amount: -amountAbs,
          accountId: fromAcc.id,
          accountName: fromAcc.name,
          toAccountId: toAcc.id,
          toAccountName: toAcc.name,
          categoryId: repaymentCategory?.id ?? null,
          categoryName: repaymentCategory?.name ?? null,
          statementMonth,
          note: note || null,
          toNote: (toNote || note) || null,
        },
        select: {
          accountId: true,
          toAccountId: true,
        },
      });
      return {
        oldAccountId: entry.accountId,
        oldToAccountId: entry.toAccountId,
        accountId: updated.accountId,
        toAccountId: updated.toAccountId,
      };
    });

    const accountsToRecalc = new Set([updated.oldAccountId, updated.oldToAccountId, updated.accountId, updated.toAccountId].filter(Boolean));
    await Promise.all([...accountsToRecalc].map((accountId) => recalcAndSaveAccountBalance(accountId!).catch(() => {})));
    revalidateAfterTxChange();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "保存失败" };
  }
}

function recordMatchesTask(taskType: string, entry: { source: string | null }) {
  return recordMatchesRegularInvestPlan(taskType, entry);
}

export default async function RegularInvestPage() {
  const { hidFilter } = await getHouseholdScope();
  const t = await getServerT();
  const accountLabelFields = await getServerAccountLabelFields();
  const restrictAccountDropdownTypes = await getServerAccountDropdownRestrictType();
  const restrictAccountList = <T extends { kind?: string | null }>(items: T[], predicate: (a: T) => boolean) =>
    restrictAccountDropdownTypes ? items.filter(predicate) : items;

  const [plans, accounts, groups, institutions, insuranceProducts, categories] = await Promise.all([
    prisma.regularInvestPlan.findMany({
      where: hidFilter,
      orderBy: { nextRunDate: "asc" },
    }),
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, ...hidFilter },
      include: { Institution: true, AccountGroup: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    prisma.accountGroup.findMany({
      where: hidFilter,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: hidFilter,
      orderBy: { name: "asc" },
    }),
    prisma.insuranceProduct.findMany({
      where: hidFilter,
      include: {
        Account: true,
        Institution: true,
        OwnerGroup: true,
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.category.findMany({
      where: hidFilter,
      select: {
        id: true,
        name: true,
        type: true,
        parentId: true,
        sortOrder: true,
        isSystem: true,
      },
      orderBy: categoryOrderBy(),
    }),
  ]);

  const scheduledTaskByPlanId = new Map(plans.map((plan) => [plan.id, decodeScheduledTaskMemo(plan.memo)]));
  const planIds = plans.map((plan) => plan.id);
  const allEntries = planIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          regularInvestPlanId: { in: planIds },
          deletedAt: null,
        },
        select: {
          id: true,
          date: true,
          createdAt: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          accountId: true,
          toAccountId: true,
          fundCode: true,
          fundSubtype: true,
          fundSourceEntryId: true,
          regularInvestPlanId: true,
          source: true,
          amount: true,
          fundUnits: true,
        },
      })
    : [];

  const { refundAmountByBuyId } = allocateBuyFailedRefunds(allEntries.map((entry) => ({
    id: entry.id,
    date: entry.date,
    createdAt: entry.createdAt,
    fundConfirmDate: entry.fundConfirmDate,
    fundArrivalDate: entry.fundArrivalDate,
    accountId: entry.accountId,
    toAccountId: entry.toAccountId,
    fundCode: entry.fundCode,
    fundSubtype: entry.fundSubtype,
    source: entry.source,
    amount: Number(entry.amount),
    fundSourceEntryId: entry.fundSourceEntryId,
  })));

  const statsByPlanId = new Map<string, { executedCount: number; executedAmount: number; confirmedCount: number; confirmedAmount: number }>();
  for (const entry of allEntries) {
    const planId = entry.regularInvestPlanId;
    if (!planId) continue;
    const task = scheduledTaskByPlanId.get(planId);
    if (!recordMatchesTask(task?.type ?? "fund_regular_invest", entry)) continue;
    if (!statsByPlanId.has(planId)) {
      statsByPlanId.set(planId, { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 });
    }
    const stats = statsByPlanId.get(planId)!;
    stats.executedCount++;
    stats.executedAmount += Math.abs(Number(entry.amount));
    if (entry.fundUnits != null && Number(entry.fundUnits) > 0) {
      stats.confirmedCount++;
      stats.confirmedAmount += getConfirmedBuyAmount(
        Number(entry.amount),
        refundAmountByBuyId.get(entry.id) ?? 0,
      );
    }
  }

  const accountOptions = accounts.map((account) => buildAccountDisplayOption(account, undefined, { fields: accountLabelFields }));
  const accountById = new Map(accountOptions.map((account) => [account.id, account]));
  const profileFundNames = await getFundProfileNameMap(
    plans
      .filter((plan) => normalizeScheduledTaskType(plan.taskType ?? scheduledTaskByPlanId.get(plan.id)?.type) === "fund_regular_invest")
      .map((plan) => plan.fundCode),
  );

  const plansData = plans.map((plan) => {
    const stats = statsByPlanId.get(plan.id) ?? { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 };
    const fundAccount = accountById.get(plan.accountId);
    const cashAccount = plan.cashAccountId ? accountById.get(plan.cashAccountId) : null;
    const scheduledTask = scheduledTaskByPlanId.get(plan.id) ?? decodeScheduledTaskMemo(plan.memo);
    const taskType = normalizeScheduledTaskType(plan.taskType ?? scheduledTask.type);
    const profileFundName = taskType === "fund_regular_invest" ? profileFundNames.get(plan.fundCode) ?? null : null;
    const displayFundName = profileFundName ?? normalizeFundDisplayName(plan.fundCode, plan.fundName) ?? plan.fundName;
    const displayTargetName = taskType === "fund_regular_invest"
      ? profileFundName ?? normalizeFundDisplayName(plan.fundCode, plan.targetName) ?? displayFundName
      : plan.targetName;

    return {
      ...plan,
      planName: plan.planName ?? null,
      fundName: displayFundName,
      taskType,
      taskTypeLabel: scheduledTaskTypeLabel(taskType),
      taskTitle: displayTargetName ?? scheduledTask.title ?? null,
      targetName: displayTargetName ?? null,
      insuranceProductName: plan.insuranceProductName ?? null,
      taskFromAccountId: scheduledTask.fromAccountId ?? null,
      taskToAccountId: scheduledTask.toAccountId ?? null,
      taskCategoryId: scheduledTask.categoryId ?? null,
      taskCategoryName: scheduledTask.categoryName ?? null,
      taskInsuranceProductId: scheduledTask.insuranceProductId ?? null,
      taskNote: scheduledTask.note ?? null,
      taskAnnualRate: scheduledTask.annualRate ?? null,
      taskRepaymentMethod: scheduledTask.repaymentMethod ? normalizeLoanRepaymentMethod(scheduledTask.repaymentMethod) : null,
      taskRepaymentIntervalMonths: scheduledTask.repaymentIntervalMonths ?? null,
      taskLoanPlanRole: getLoanScheduledPlanRole(scheduledTask),
      isSystemTask: scheduledTask.type === "loan_repayment" && getLoanScheduledPlanRole(scheduledTask) === "bill",
      amount: Number(plan.amount),
      feeRate: plan.feeRate ? Number(plan.feeRate) : null,
      startDate: plan.startDate && Number.isFinite(plan.startDate.getTime()) ? plan.startDate.toISOString() : null,
      endDate: plan.endDate && Number.isFinite(plan.endDate.getTime()) ? plan.endDate.toISOString() : null,
      nextRunDate: plan.nextRunDate && Number.isFinite(plan.nextRunDate.getTime()) ? plan.nextRunDate.toISOString() : null,
      lastRunDate: plan.lastRunDate && Number.isFinite(plan.lastRunDate.getTime()) ? plan.lastRunDate.toISOString() : null,
      createdAt: plan.createdAt && Number.isFinite(plan.createdAt.getTime()) ? plan.createdAt.toISOString() : null,
      updatedAt: plan.updatedAt && Number.isFinite(plan.updatedAt.getTime()) ? plan.updatedAt.toISOString() : null,
      executedCount: stats.executedCount,
      executedAmount: stats.executedAmount,
      confirmedCount: stats.confirmedCount,
      confirmedAmount: stats.confirmedAmount,
      accountLabel: fundAccount?.label ?? plan.accountName,
      accountFullLabel: fundAccount?.fullLabel ?? plan.accountName,
      accountHoverTitle: fundAccount?.hoverTitle ?? null,
      accountGroupName: fundAccount?.groupName ?? "",
      cashAccountLabel: cashAccount?.label ?? plan.cashAccountName,
      cashAccountFullLabel: cashAccount?.fullLabel ?? plan.cashAccountName,
      cashAccountHoverTitle: cashAccount?.hoverTitle ?? null,
      cashAccountGroupName: cashAccount?.groupName ?? "",
    };
  });

  const investmentAccounts = restrictAccountList(accountOptions, (account) => account.kind === "investment" && account.investProductType === "fund");
  const cashAccounts = restrictAccountList(accountOptions, (account) => ["bank_debit", "ewallet", "cash", "bank_credit"].includes(account.kind));
  const ordinaryAccounts = restrictAccountList(accountOptions, (account) => ["bank_debit", "bank_credit", "ewallet", "cash"].includes(account.kind));
  const loanAccounts = restrictAccountList(accountOptions, (account) => account.kind === "loan");
  const transferTargetAccounts = restrictAccountList(accountOptions, (account) => !account.id || !["insurance"].includes(account.kind));
  const incomeCategoryOptions = buildCategorySmartSelectOptions({
    categories,
    types: ["income"],
    typeLabels: { income: t("categoryType.income") },
    typeHeaderPrefix: "scheduled-income-category",
    includeTypeHeaders: false,
    t,
  });
  const expenseCategoryOptions = buildCategorySmartSelectOptions({
    categories,
    types: ["expense"],
    typeLabels: { expense: t("stats.expenseCategories") },
    typeHeaderPrefix: "scheduled-expense-category",
    includeTypeHeaders: false,
    t,
  });
  const expenseCategories = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ id: c.id, label: c.name, parentId: c.parentId, type: c.type, sortOrder: c.sortOrder, isSystem: c.isSystem }));
  const incomeCategories = categories
    .filter((c) => c.type === "income")
    .map((c) => ({ id: c.id, label: c.name, parentId: c.parentId, type: c.type, sortOrder: c.sortOrder, isSystem: c.isSystem }));
  const advanceCategories = categories
    .filter((c) => c.type === "advance")
    .map((c) => ({ id: c.id, label: c.name, parentId: c.parentId, type: c.type, sortOrder: c.sortOrder, isSystem: c.isSystem }));
  const insuranceProductOptions = insuranceProducts.map((product) => ({
    id: product.id,
    label: product.name,
    accountId: product.accountId,
    accountLabel: accountById.get(product.accountId)?.label ?? product.Account?.name ?? "",
    ownerGroupId: product.ownerGroupId ?? null,
    ownerGroupName: product.OwnerGroup?.name ?? null,
    premiumAmount: product.premiumAmount == null ? null : Number(product.premiumAmount),
    premiumFrequencyMonths: product.premiumFrequencyMonths == null ? null : Number(product.premiumFrequencyMonths),
    subLabel: [
      product.Institution?.shortName || product.Institution?.name,
      product.OwnerGroup?.name,
    ].filter(Boolean).join(" · "),
  }));

  return (
    <>
      <div className="h-full md:hidden">
        <MobileRegularInvest plans={plansData} />
      </div>
      <div className="hidden h-full md:block">
        <RegularInvestClient
      initialPlans={plansData}
      investmentAccounts={investmentAccounts}
      cashAccounts={cashAccounts}
      loanAccounts={loanAccounts}
      transferTargetAccounts={transferTargetAccounts}
      ordinaryAccounts={ordinaryAccounts}
      insuranceProductOptions={insuranceProductOptions}
      investmentAccountSSOptions={buildFlatAccountOptions(investmentAccounts)}
      cashAccountSSOptions={buildGroupedAccountOptions(cashAccounts)}
      transferTargetAccountSSOptions={buildGroupedAccountOptions(transferTargetAccounts)}
      ordinaryAccountSSOptions={buildGroupedAccountOptions(ordinaryAccounts)}
      incomeCategoryOptions={incomeCategoryOptions}
      expenseCategoryOptions={expenseCategoryOptions}
      expenseCategories={expenseCategories}
      incomeCategories={incomeCategories}
      advanceCategories={advanceCategories}
      allAccountSSOptions={buildGroupedAccountOptions(accountOptions)}
      nestedFieldData={{
        groupId: groups.map((group) => ({ id: group.id, name: group.name })),
        institutionId: institutions.map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? undefined })),
      }}
      transactionCreateAction={createTransaction}
          transactionEditAction={updateScheduledTransferRecord}
        />
      </div>
    </>
  );
}
