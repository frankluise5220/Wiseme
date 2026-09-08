import { AccountKind, FundProductType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { computePositionDisplay } from "@/lib/invest-balance";
import type { HouseholdContext } from "@/lib/server/household-scope";

/** Resolve fund company names for a set of fund codes in one query. */
async function loadFundCompanyByCode(fundCodes: Iterable<string>): Promise<Map<string, string>> {
  const codes = Array.from(new Set(Array.from(fundCodes).map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code))));
  if (codes.length === 0) return new Map();
  const rows = await prisma.fundProfile.findMany({
    where: { fundCode: { in: codes } },
    select: { fundCode: true, fundCompany: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    const company = (row.fundCompany ?? "").trim();
    if (company) map.set(row.fundCode, company);
  }
  return map;
}

/**
 * Fund holding / cleared-position summary report.
 *
 * Reuses the existing display layer (`computePositionDisplay`) so the numbers
 * shown here stay identical to the fund account detail view. Each fund account
 * contributes its current positions (units > 0 or pending cost) and its cleared
 * positions (fully redeemed funds), which are merged into a single summary.
 */

export type FundHoldingReportRow = {
  // Synthetic stable key: accountId::fundCode (positions) or accountId::fundCode (cleared).
  id: string;
  accountId: string;
  accountName: string;
  institutionName: string;
  fundCompany: string;
  fundCode: string;
  fundName: string;
  holdingDate: string;
  units: number;
  avgCost: number;
  cost: number;
  nav: number | null;
  navDate: string;
  marketValue: number;
  pendingCost: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit: number;
  totalProfit: number;
  currency: string;
};

export type FundClearedReportRow = {
  id: string;
  accountId: string;
  accountName: string;
  institutionName: string;
  fundCompany: string;
  fundCode: string;
  fundName: string;
  firstBuyDate: string;
  clearedDate: string;
  totalInvested: number;
  totalBuyAmount: number;
  totalRedeemAmount: number;
  historicalProfit: number;
  returnRate: number;
  currency: string;
};

export type FundHoldingReportTotals = {
  marketValue: number;
  cost: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit: number;
  totalProfit: number;
  holdingCount: number;
  clearedCount: number;
  clearedTotalInvested: number;
  clearedHistoricalProfit: number;
};

export type FundHoldingReport = {
  rows: FundHoldingReportRow[];
  clearedRows: FundClearedReportRow[];
  totals: FundHoldingReportTotals;
  /** Distinct fund company names across current holdings AND cleared positions (for the institution filter's "fund company" group). */
  fundCompanies: string[];
  /** Subset of `fundCompanies` that no longer holds any position — kept selectable so cleared-only managers stay reachable, but rendered separately in the filter. */
  clearedOnlyFundCompanies: string[];
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundUnits(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export async function loadFundHoldingReport(
  ctx: HouseholdContext,
  options: { accountIds?: string[]; fundCompanies?: string[] } = {},
): Promise<FundHoldingReport> {
  const accountFilter = options.accountIds && options.accountIds.length > 0
    ? { id: { in: options.accountIds } }
    : {};

  const accounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      ...accountFilter,
      kind: AccountKind.investment,
      investProductType: { in: [FundProductType.fund, FundProductType.money] },
      isActive: true,
      isPlaceholder: { not: true },
    },
    select: {
      id: true,
      name: true,
      currency: true,
      institutionId: true,
      Institution: { select: { name: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountIds = accounts.map((account) => account.id);

  if (accountIds.length === 0) {
    return {
      rows: [],
      clearedRows: [],
      fundCompanies: [],
      clearedOnlyFundCompanies: [],
      totals: {
        marketValue: 0,
        cost: 0,
        floatingPnL: 0,
        floatingPnLRate: 0,
        historicalProfit: 0,
        totalProfit: 0,
        holdingCount: 0,
        clearedCount: 0,
        clearedTotalInvested: 0,
        clearedHistoricalProfit: 0,
      },
    };
  }

  const rows: FundHoldingReportRow[] = [];
  const clearedRows: FundClearedReportRow[] = [];

  for (const accountId of accountIds) {
    const account = accountById.get(accountId);
    const institutionName = account?.Institution?.name ?? "";
    const currency = account?.currency || "CNY";
    const display = await computePositionDisplay(ctx, accountId);

    for (const position of display.positions) {
      const cost = roundMoney(position.cost);
      const marketValue = roundMoney(position.marketValue);
      const floatingPnL = roundMoney(position.floatingPnL);
      const historicalProfit = roundMoney(position.historicalProfit);
      rows.push({
        id: `${accountId}::${position.fundCode}`,
        accountId,
        accountName: account?.name ?? accountId,
        institutionName,
        fundCompany: "",
        fundCode: position.fundCode,
        fundName: position.name || position.fundCode,
        holdingDate: position.holdingDate ?? "",
        units: roundUnits(position.units),
        avgCost: position.avgCost,
        cost,
        nav: position.nav,
        navDate: position.navDate ?? "",
        marketValue,
        pendingCost: roundMoney(position.pendingCost),
        floatingPnL,
        floatingPnLRate: position.floatingPnLRate ?? (cost > 0 ? floatingPnL / cost : 0),
        historicalProfit,
        totalProfit: roundMoney(floatingPnL + historicalProfit),
        currency,
      });
    }

    for (const cleared of display.clearedPositions) {
      clearedRows.push({
        id: `${accountId}::${cleared.fundCode}`,
        accountId,
        accountName: account?.name ?? accountId,
        institutionName,
        fundCompany: "",
        fundCode: cleared.fundCode,
        fundName: cleared.name || cleared.fundCode,
        firstBuyDate: cleared.firstBuyDate ?? "",
        clearedDate: cleared.clearedDate ?? "",
        totalInvested: roundMoney(cleared.totalInvested),
        totalBuyAmount: roundMoney(cleared.totalBuyAmount),
        totalRedeemAmount: roundMoney(cleared.totalRedeemAmount),
        historicalProfit: roundMoney(cleared.historicalProfit),
        returnRate: cleared.returnRate ?? 0,
        currency,
      });
    }
  }

  const fundCompanyByCode = await loadFundCompanyByCode([
    ...rows.map((row) => row.fundCode),
    ...clearedRows.map((row) => row.fundCode),
  ]);
  for (const row of rows) row.fundCompany = fundCompanyByCode.get(row.fundCode) ?? "";
  for (const row of clearedRows) row.fundCompany = fundCompanyByCode.get(row.fundCode) ?? "";

  const selectedFundCompanies = options.fundCompanies?.map((name) => name.trim()).filter(Boolean) ?? [];
  const filteredRows = selectedFundCompanies.length > 0
    ? rows.filter((row) => selectedFundCompanies.includes(row.fundCompany))
    : rows;

  filteredRows.sort((left, right) => {
    if (right.marketValue !== left.marketValue) return right.marketValue - left.marketValue;
    if (left.institutionName !== right.institutionName) {
      return left.institutionName.localeCompare(right.institutionName, "zh-Hans-CN");
    }
    if (left.accountName !== right.accountName) {
      return left.accountName.localeCompare(right.accountName, "zh-Hans-CN");
    }
    return left.fundCode.localeCompare(right.fundCode);
  });

  clearedRows.sort((left, right) => {
    const leftKey = left.clearedDate || left.firstBuyDate;
    const rightKey = right.clearedDate || right.firstBuyDate;
    if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
    return left.fundCode.localeCompare(right.fundCode);
  });

  const filteredClearedRows = selectedFundCompanies.length > 0
    ? clearedRows.filter((row) => selectedFundCompanies.includes(row.fundCompany))
    : clearedRows;

  const totals: FundHoldingReportTotals = {
    marketValue: roundMoney(filteredRows.reduce((sum, row) => sum + row.marketValue, 0)),
    cost: roundMoney(filteredRows.reduce((sum, row) => sum + row.cost, 0)),
    floatingPnL: roundMoney(filteredRows.reduce((sum, row) => sum + row.floatingPnL, 0)),
    floatingPnLRate: 0,
    historicalProfit: roundMoney(filteredRows.reduce((sum, row) => sum + row.historicalProfit, 0)),
    totalProfit: 0,
    holdingCount: filteredRows.length,
    clearedCount: filteredClearedRows.length,
    clearedTotalInvested: roundMoney(filteredClearedRows.reduce((sum, row) => sum + row.totalInvested, 0)),
    clearedHistoricalProfit: roundMoney(filteredClearedRows.reduce((sum, row) => sum + row.historicalProfit, 0)),
  };
  totals.floatingPnLRate = totals.cost > 0 ? totals.floatingPnL / totals.cost : 0;
  totals.totalProfit = roundMoney(totals.floatingPnL + totals.historicalProfit);

  // The dropdown lists holdings AND cleared managers (cleared funds still carry
  // realised profit worth reviewing), but the two are reported separately so the
  // longer union list does not look like a miscount of currently held managers.
  const holdingCompanies = new Set(rows.map((row) => row.fundCompany).filter(Boolean));
  const clearedCompanies = new Set(clearedRows.map((row) => row.fundCompany).filter(Boolean));
  const byName = (left: string, right: string) => left.localeCompare(right, "zh-Hans-CN");
  const fundCompanies = Array.from(new Set([...holdingCompanies, ...clearedCompanies])).sort(byName);
  const clearedOnlyFundCompanies = Array.from(clearedCompanies)
    .filter((name) => !holdingCompanies.has(name))
    .sort(byName);

  return {
    rows: filteredRows,
    clearedRows: filteredClearedRows,
    totals,
    fundCompanies,
    clearedOnlyFundCompanies,
  };
}