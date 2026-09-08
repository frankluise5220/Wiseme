import { TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import {
  normalizeDefaultCategoryHierarchyForHousehold,
  SYSTEM_INSURANCE_EXPENSE_CATEGORY,
  SYSTEM_INSURANCE_RETURN_CATEGORY,
} from "@/lib/default-categories";
import { loadFundStatisticSourceEntries, loadWealthStatisticSourceEntries } from "@/lib/server/investment-statistic-sources";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { getBusinessResultStatisticItems, getIncomeExpenseStatisticAmount, getInvestmentStatisticItems } from "@/lib/transaction-statistics";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE } from "@/lib/balance-reconcile";
import { buildStatisticsCurrencyConverter } from "@/lib/server/statistics-currency";
import { getServerT } from "@/lib/server/i18n";

export type IncomeExpenseGroupBy = "month" | "year";

export type IncomeExpenseReportColumn = {
  key: string;
  label: string;
};

export type IncomeExpenseReportRow = {
  key: string;
  name: string;
  depth: number;
  count: number;
  counts: number[];
  total: number;
  values: number[];
};

export type IncomeExpenseReportSection = {
  type: "income" | "expense";
  label: string;
  count: number;
  periodCounts: number[];
  total: number;
  periodTotals: number[];
  rows: IncomeExpenseReportRow[];
};

export type IncomeExpenseReportDetailType = "income" | "expense" | "net";

export type IncomeExpenseReportDetailRow = {
  id: string;
  entryId: string;
  canEdit: boolean;
  date: string;
  type: ReportCategoryType;
  accountId: string;
  accountName: string;
  categoryName: string;
  counterpartyName: string;
  note: string;
  amount: number;
};

export type IncomeExpenseReportDetails = {
  type: IncomeExpenseReportDetailType;
  typeLabel: string;
  categoryKey: string | null;
  categoryName: string | null;
  columnKey: string | null;
  columnLabel: string;
  total: number;
  rows: IncomeExpenseReportDetailRow[];
};

export type IncomeExpenseReport = {
  baseCurrency: string;
  missingFxCurrencies: string[];
  start: string;
  end: string;
  groupBy: IncomeExpenseGroupBy;
  columns: IncomeExpenseReportColumn[];
  income: IncomeExpenseReportSection;
  expense: IncomeExpenseReportSection;
  netPeriodTotals: number[];
  netTotal: number;
  details: IncomeExpenseReportDetails | null;
};

type ReportCategoryType = "income" | "expense";

type ReportCategoryNode = {
  id: string;
  name: string;
  type: ReportCategoryType;
  parentId: string | null;
  count: number;
  counts: number[];
  total: number;
  values: number[];
  children: ReportCategoryNode[];
};

type ReportStatisticRecord = {
  id: string;
  entryId: string;
  canEdit: boolean;
  date: Date;
  type: ReportCategoryType;
  amount: number;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string;
  accountName: string;
  counterpartyName: string | null;
  note: string | null;
  createdAt: Date;
};

function parseDateOnlyUtc(value: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
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

function createColumns(start: Date, end: Date, groupBy: IncomeExpenseGroupBy) {
  const columns: IncomeExpenseReportColumn[] = [];
  if (groupBy === "year") {
    for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) {
      columns.push({ key: String(year), label: String(year) });
    }
    return columns;
  }

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endCursor.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    columns.push({ key: `${year}-${month}`, label: `${year}-${month}` });
    cursor = new Date(Date.UTC(year, cursor.getUTCMonth() + 1, 1));
  }
  return columns;
}

function columnKeyForDate(date: Date, groupBy: IncomeExpenseGroupBy) {
  if (groupBy === "year") return String(date.getUTCFullYear());
  return formatDateUtc(date).slice(0, 7);
}

function createEmptyValues(length: number) {
  return Array.from({ length }, () => 0);
}

function accountDisplayName(
  account: { name?: string | null } | null | undefined,
  fallback?: string | null,
) {
  return account?.name?.trim() || fallback?.trim() || "";
}

function buildSectionRows(
  roots: ReportCategoryNode[],
  uncategorized: ReportCategoryNode,
): IncomeExpenseReportRow[] {
  const rows: IncomeExpenseReportRow[] = [];

  function visit(node: ReportCategoryNode, depth: number) {
    if (node.count === 0) return;
    rows.push({
      key: node.id,
      name: node.name,
      depth,
      count: node.count,
      counts: node.counts,
      total: node.total,
      values: node.values,
    });
    for (const child of node.children) visit(child, depth + 1);
  }

  for (const root of roots) visit(root, 0);
  if (uncategorized.count !== 0) {
    rows.push({
      key: uncategorized.id,
      name: uncategorized.name,
      depth: 0,
      count: uncategorized.count,
      counts: uncategorized.counts,
      total: uncategorized.total,
      values: uncategorized.values,
    });
  }
  return rows;
}

export async function getIncomeExpenseReport(
  ctx: HouseholdContext,
  params: {
    start: string;
    end: string;
    groupBy: IncomeExpenseGroupBy;
    accountIds?: string[];
    institutionId?: string;
    institutionIds?: string[];
    userIds?: string[];
    detail?: {
      type: IncomeExpenseReportDetailType;
      categoryKey?: string;
      columnKey?: string;
    };
  },
): Promise<IncomeExpenseReport> {
  const t = await getServerT();
  const parsedStart = parseDateOnlyUtc(params.start) ?? startOfDayUtc(new Date());
  const parsedEnd = parseDateOnlyUtc(params.end) ?? parsedStart;
  const rangeStart = parsedStart.getTime() <= parsedEnd.getTime() ? parsedStart : parsedEnd;
  const rangeEnd = parsedStart.getTime() <= parsedEnd.getTime() ? parsedEnd : parsedStart;
  const endExclusive = addDaysUtc(rangeEnd, 1);
  const columns = createColumns(rangeStart, rangeEnd, params.groupBy);
  const columnIndexByKey = new Map(columns.map((column, index) => [column.key, index]));
  const valueLength = columns.length;
  const { hidFilter } = ctx;
  const scopedAccounts = await prisma.account.findMany({
    where: {
      ...hidFilter,
      isActive: true,
      counterpartyId: null,
      kind: { notIn: ["loan", "settlement", "insurance"] },
      ...((params.institutionIds?.length || params.institutionId) ? { institutionId: { in: params.institutionIds?.length ? params.institutionIds : [params.institutionId!] } } : {}),
      ...(params.userIds?.length ? { groupId: { in: params.userIds } } : {}),
      ...(params.accountIds?.length ? { id: { in: params.accountIds } } : {}),
    },
    select: { id: true },
  });
  const scopedAccountIds = scopedAccounts.map((account) => account.id);
  const accountFilter = (params.institutionIds?.length || params.institutionId || params.userIds?.length || params.accountIds?.length)
    ? { OR: [{ accountId: { in: scopedAccountIds } }, { toAccountId: { in: scopedAccountIds } }] }
    : {};

  await normalizeDefaultCategoryHierarchyForHousehold(prisma, ctx.householdId);

  const hasScopedAccountFilter = Boolean(
    params.institutionIds?.length ||
    params.institutionId ||
    params.userIds?.length ||
    params.accountIds?.length,
  );
  const [categories, records, fundStatisticRecords, investmentRecords, businessResultRecords, wealthStatisticRecords] = await Promise.all([
    prisma.category.findMany({
      where: {
        ...hidFilter,
        type: { in: ["income", "expense"] },
      },
      select: {
        id: true,
        name: true,
        type: true,
        parentId: true,
      },
      orderBy: [{ type: "asc" }, { parentId: "asc" }, { name: "asc" }],
    }),
    prisma.txRecord.findMany({
      where: {
        ...hidFilter,
        deletedAt: null,
        OR: [
          { type: { in: [TransactionType.income, TransactionType.expense] } },
          { type: TransactionType.investment, source: "insurance" },
        ],
        date: { gte: rangeStart, lt: endExclusive },
        ...accountFilter,
      },
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        source: true,
        insuranceAction: true,
        fundSubtype: true,
        categoryId: true,
        categoryName: true,
        accountId: true,
        accountName: true,
        account: { select: { name: true } },
        counterpartyInstitutionName: true,
        note: true,
        createdAt: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
    loadFundStatisticSourceEntries(ctx, {
      start: rangeStart,
      endExclusive,
      accountIds: hasScopedAccountFilter ? scopedAccountIds : undefined,
    }),
    prisma.txRecord.findMany({
      where: {
        ...hidFilter,
        deletedAt: null,
        type: TransactionType.investment,
        date: { gte: rangeStart, lt: endExclusive },
        AND: [
          ...((params.institutionIds?.length || params.institutionId || params.userIds?.length || params.accountIds?.length) ? [accountFilter] : []),
          {
            OR: [
              { realizedProfit: { not: null } },
              { depositInterest: { not: null } },
              { fundFee: { not: null } },
              { fundSubtype: "dividend_cash" },
            ],
          },
        ],
      },
      select: {
        id: true,
        date: true,
        amount: true,
        fundSubtype: true,
        fundProductType: true,
        realizedProfit: true,
        depositInterest: true,
        fundFee: true,
        fundUnits: true,
        fundNav: true,
        fundCode: true,
        fundName: true,
        accountId: true,
        accountName: true,
        account: { select: { name: true } },
        note: true,
        createdAt: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.txRecord.findMany({
      where: {
        ...hidFilter,
        deletedAt: null,
        type: TransactionType.transfer,
        date: { gte: rangeStart, lt: endExclusive },
        AND: [
          ...((params.institutionIds?.length || params.institutionId || params.userIds?.length || params.accountIds?.length) ? [accountFilter] : []),
          {
            OR: [
              { realizedProfit: { not: null } },
              { debtInterestAmount: { not: null } },
            ],
          },
        ],
      },
      select: {
        id: true,
        date: true,
        type: true,
        source: true,
        amount: true,
        realizedProfit: true,
        debtInterestAmount: true,
        accountId: true,
        accountName: true,
        account: { select: { name: true } },
        toAccountId: true,
        toAccountName: true,
        toAccount: { select: { name: true } },
        note: true,
        createdAt: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
    loadWealthStatisticSourceEntries(ctx, {
      start: rangeStart,
      endExclusive,
      accountIds: (params.institutionIds?.length || params.institutionId || params.userIds?.length || params.accountIds?.length) ? scopedAccountIds : undefined,
    }),
  ]);

  const nodesById = new Map<string, ReportCategoryNode>();
  const nodesByTypeAndName = new Map<string, ReportCategoryNode>();
  const rootsByType: Record<ReportCategoryType, ReportCategoryNode[]> = {
    income: [],
    expense: [],
  };

  for (const category of categories) {
    const type = category.type === "income" ? "income" : "expense";
    const node: ReportCategoryNode = {
      id: category.id,
      name: category.name,
      type,
      parentId: category.parentId,
      count: 0,
      counts: createEmptyValues(valueLength),
      total: 0,
      values: createEmptyValues(valueLength),
      children: [],
    };
    nodesById.set(category.id, node);
    nodesByTypeAndName.set(`${type}:${category.name}`, node);
  }

  for (const category of categories) {
    const node = nodesById.get(category.id);
    if (!node) continue;
    const parent = category.parentId ? nodesById.get(category.parentId) : null;
    if (parent && parent.type === node.type) parent.children.push(node);
    else rootsByType[node.type].push(node);
  }

  const uncategorized: Record<ReportCategoryType, ReportCategoryNode> = {
    income: {
      id: "__uncategorized_income__",
      name: t("systemCategory.uncategorizedIncome"),
      type: "income",
      parentId: null,
      count: 0,
      counts: createEmptyValues(valueLength),
      total: 0,
      values: createEmptyValues(valueLength),
      children: [],
    },
    expense: {
      id: "__uncategorized_expense__",
      name: t("systemCategory.uncategorizedExpenses"),
      type: "expense",
      parentId: null,
      count: 0,
      counts: createEmptyValues(valueLength),
      total: 0,
      values: createEmptyValues(valueLength),
      children: [],
    },
  };

  const sectionPeriodTotals: Record<ReportCategoryType, number[]> = {
    income: createEmptyValues(valueLength),
    expense: createEmptyValues(valueLength),
  };
  const sectionPeriodCounts: Record<ReportCategoryType, number[]> = {
    income: createEmptyValues(valueLength),
    expense: createEmptyValues(valueLength),
  };

  function findCategoryByName(type: ReportCategoryType, names: string[]) {
    for (const name of names) {
      const node = nodesByTypeAndName.get(`${type}:${name}`);
      if (node) return node;
    }
    return null;
  }

  function resolveRecordNode(record: ReportStatisticRecord) {
    const node = record.categoryId ? nodesById.get(record.categoryId) ?? null : null;
    if (node?.type === record.type) return node;
    return record.categoryName ? findCategoryByName(record.type, [record.categoryName]) : null;
  }

  let statisticRecords: ReportStatisticRecord[] = records.flatMap((record) => {
    const isInsurance = record.source === "insurance";
    if (
      record.source === BALANCE_RECONCILE_SOURCE ||
      record.source === BALANCE_INITIALIZATION_SOURCE ||
      record.type === TransactionType.transfer ||
      (record.type === TransactionType.investment && !isInsurance)
    ) return [];
    const insuranceType: ReportCategoryType =
      record.insuranceAction === "refund" || record.fundSubtype === "redeem" || record.fundSubtype === "switch_out"
        ? "income"
        : "expense";
    const type: ReportCategoryType = isInsurance
      ? insuranceType
      : record.type === TransactionType.income ? "income" : "expense";
    return [{
      id: record.id,
      entryId: record.id,
      canEdit: true,
      date: record.date,
      type,
      amount: isInsurance ? Math.abs(toNumber(record.amount)) : getIncomeExpenseStatisticAmount(record.type, record.amount),
      categoryId: isInsurance ? null : record.categoryId,
      categoryName: isInsurance
        ? (type === "income" ? SYSTEM_INSURANCE_RETURN_CATEGORY : SYSTEM_INSURANCE_EXPENSE_CATEGORY)
        : record.categoryName?.trim() || null,
      accountId: record.accountId,
      accountName: accountDisplayName(record.account, record.accountName),
      counterpartyName: record.counterpartyInstitutionName,
      note: record.note,
      createdAt: record.createdAt,
    }];
  });

  const independentFundEntryIds = new Set(
    fundStatisticRecords.flatMap((record) => [record.id, record.entryId]),
  );
  const representedLegacyInvestmentEntryIds = new Set(
    investmentRecords
      .filter((record) => getInvestmentStatisticItems(record).length > 0)
      .map((record) => record.id),
  );
  const representedStatisticEntryIds = new Set([
    ...independentFundEntryIds,
    ...representedLegacyInvestmentEntryIds,
  ]);

  for (const record of investmentRecords) {
    if (independentFundEntryIds.has(record.id)) continue;
    const investmentName = record.fundName?.trim() || record.fundCode?.trim() || "";
    for (const item of getInvestmentStatisticItems(record)) {
      const category = findCategoryByName(item.type, item.categoryCandidates);
      statisticRecords.push({
        id: `${record.id}:${item.idSuffix}`,
        entryId: record.id,
        canEdit: false,
        date: record.date,
        type: item.type,
        amount: item.amount,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? item.categoryName,
        accountId: record.accountId,
        accountName: accountDisplayName(record.account, record.accountName),
        counterpartyName: investmentName || item.label,
        note: record.note,
        createdAt: record.createdAt,
      });
    }
  }

  for (const record of fundStatisticRecords) {
    const investmentName = record.fundName?.trim() || record.fundCode?.trim() || "";
    for (const item of getInvestmentStatisticItems(record)) {
      const category = findCategoryByName(item.type, item.categoryCandidates);
      statisticRecords.push({
        id: `${record.id}:${item.idSuffix}`,
        entryId: record.entryId,
        canEdit: false,
        date: record.date,
        type: item.type,
        amount: item.amount,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? item.categoryName,
        accountId: record.accountId,
        accountName: record.accountName,
        counterpartyName: investmentName || item.label,
        note: record.note,
        createdAt: record.createdAt,
      });
    }
  }

  for (const record of businessResultRecords) {
    for (const item of getBusinessResultStatisticItems(record)) {
      const category = findCategoryByName(item.type, item.categoryCandidates);
      statisticRecords.push({
        id: `${record.id}:${item.idSuffix}`,
        entryId: record.id,
        canEdit: false,
        date: record.date,
        type: item.type,
        amount: item.amount,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? item.categoryName,
        accountId: item.type === "income" ? record.toAccountId ?? record.accountId : record.accountId,
        accountName: item.type === "income" && record.toAccountId
          ? accountDisplayName(record.toAccount, record.toAccountName)
          : accountDisplayName(record.account, record.accountName),
        counterpartyName: item.label,
        note: record.note,
        createdAt: record.createdAt,
      });
    }
  }

  for (const record of wealthStatisticRecords) {
    if (representedStatisticEntryIds.has(record.id) || representedStatisticEntryIds.has(record.entryId)) continue;
    const investmentName = record.fundName?.trim() || record.fundCode?.trim() || record.counterpartyName?.trim() || "";
    for (const item of getInvestmentStatisticItems(record)) {
      const category = findCategoryByName(item.type, item.categoryCandidates);
      statisticRecords.push({
        id: `${record.id}:${item.idSuffix}`,
        entryId: record.entryId,
        canEdit: record.canEdit,
        date: record.date,
        type: item.type,
        amount: item.amount,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? item.categoryName,
        accountId: record.accountId,
        accountName: record.accountName,
        counterpartyName: investmentName || item.label,
        note: record.note,
        createdAt: record.createdAt,
      });
    }
  }

  const fx = await buildStatisticsCurrencyConverter(ctx.householdId, statisticRecords);
  statisticRecords = statisticRecords.flatMap((record) => fx.convertItems(record, [record]));

  statisticRecords.sort((a, b) =>
    b.date.getTime() - a.date.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    b.id.localeCompare(a.id),
  );

  for (const record of statisticRecords) {
    const type = record.type;
    const columnIndex = columnIndexByKey.get(columnKeyForDate(record.date, params.groupBy));
    if (columnIndex == null) continue;
    const node = resolveRecordNode(record) ?? uncategorized[type];

    sectionPeriodTotals[type][columnIndex] += record.amount;
    sectionPeriodCounts[type][columnIndex] += 1;
    node.count += 1;
    node.counts[columnIndex] += 1;
    node.total += record.amount;
    node.values[columnIndex] += record.amount;

    let parentId = node.parentId;
    while (parentId) {
      const parent = nodesById.get(parentId);
      if (!parent || parent.type !== type) break;
      parent.count += 1;
      parent.counts[columnIndex] += 1;
      parent.total += record.amount;
      parent.values[columnIndex] += record.amount;
      parentId = parent.parentId;
    }
  }

  const incomeRows = buildSectionRows(rootsByType.income, uncategorized.income);
  const expenseRows = buildSectionRows(rootsByType.expense, uncategorized.expense);
  const incomeTotal = sectionPeriodTotals.income.reduce((sum, value) => sum + value, 0);
  const expenseTotal = sectionPeriodTotals.expense.reduce((sum, value) => sum + value, 0);
  const netPeriodTotals = sectionPeriodTotals.income.map((value, index) => value - sectionPeriodTotals.expense[index]);

  const detailSelection = params.detail;
  let details: IncomeExpenseReportDetails | null = null;
  if (detailSelection) {
    const selectedColumn = detailSelection.columnKey
      ? columns.find((column) => column.key === detailSelection.columnKey) ?? null
      : null;
    const categoryKey = detailSelection.categoryKey?.trim() || null;
    const categoryType = detailSelection.type === "net" ? null : detailSelection.type;
    const selectedCategory = categoryKey ? nodesById.get(categoryKey) ?? null : null;
    const uncategorizedKey = categoryType ? uncategorized[categoryType].id : null;
    const categoryIsValid =
      !categoryKey ||
      (categoryType != null &&
        (categoryKey === uncategorizedKey || selectedCategory?.type === categoryType));
    const columnIsValid = !detailSelection.columnKey || selectedColumn != null;

    if (categoryIsValid && columnIsValid) {
      const rows = statisticRecords.flatMap((record): IncomeExpenseReportDetailRow[] => {
        const recordType = record.type;
        if (detailSelection.type !== "net" && recordType !== detailSelection.type) return [];
        if (
          selectedColumn &&
          columnKeyForDate(record.date, params.groupBy) !== selectedColumn.key
        ) {
          return [];
        }

        const validRecordNode = resolveRecordNode(record);
        if (categoryKey) {
          if (categoryKey === uncategorizedKey) {
            if (validRecordNode) return [];
          } else {
            let cursor = validRecordNode;
            let matchesCategory = false;
            while (cursor) {
              if (cursor.id === categoryKey) {
                matchesCategory = true;
                break;
              }
              cursor = cursor.parentId ? nodesById.get(cursor.parentId) ?? null : null;
            }
            if (!matchesCategory) return [];
          }
        }

        const displayAmount =
          detailSelection.type === "net" && recordType === "expense"
            ? -record.amount
            : record.amount;
        return [{
          id: record.id,
          entryId: record.entryId,
          canEdit: record.canEdit,
          date: formatDateUtc(record.date),
          type: recordType,
          accountId: record.accountId,
          accountName: record.accountName.trim() || t("investments.unspecified"),
          categoryName:
            validRecordNode?.name ??
            record.categoryName ??
            uncategorized[recordType].name,
          counterpartyName: record.counterpartyName?.trim() ?? "",
          note: record.note?.trim() ?? "",
          amount: displayAmount,
        }];
      });

      const typeLabel =
        detailSelection.type === "income"
          ? t("stats.income")
          : detailSelection.type === "expense"
            ? t("stats.expense")
            : t("stats.netIncome");
      details = {
        type: detailSelection.type,
        typeLabel,
        categoryKey,
        categoryName:
          categoryKey === uncategorizedKey
            ? categoryType === "income"
              ? uncategorized.income.name
              : uncategorized.expense.name
            : selectedCategory?.name ?? null,
        columnKey: selectedColumn?.key ?? null,
        columnLabel: selectedColumn?.label ?? `${formatDateUtc(rangeStart)} ~ ${formatDateUtc(rangeEnd)}`,
        total: rows.reduce((sum, row) => sum + row.amount, 0),
        rows,
      };
    }
  }

  return {
    start: formatDateUtc(rangeStart),
    baseCurrency: fx.baseCurrency,
    missingFxCurrencies: fx.missingFxCurrencies,
    end: formatDateUtc(rangeEnd),
    groupBy: params.groupBy,
    columns,
    income: {
      type: "income",
      label: t("stats.income"),
      count: sectionPeriodCounts.income.reduce((sum, value) => sum + value, 0),
      periodCounts: sectionPeriodCounts.income,
      total: incomeTotal,
      periodTotals: sectionPeriodTotals.income,
      rows: incomeRows,
    },
    expense: {
      type: "expense",
      label: t("stats.expense"),
      count: sectionPeriodCounts.expense.reduce((sum, value) => sum + value, 0),
      periodCounts: sectionPeriodCounts.expense,
      total: expenseTotal,
      periodTotals: sectionPeriodTotals.expense,
      rows: expenseRows,
    },
    netPeriodTotals,
    netTotal: incomeTotal - expenseTotal,
    details,
  };
}
