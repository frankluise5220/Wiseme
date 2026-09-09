/**
 * Cross-request cache module for the display layer
 *
 * Principles (CLAUDE.md):
 * - First read hits the DB → subsequent reads go through the cache → only writes/edits/deletes touch the DB and refresh the cache
 * - common data (not account-dependent): unstable_cache cross-request cache
 * - per-account data (account-dependent): React.cache() request-level deduplication
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { computeFixedAssetPositionDisplay, computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import {
  CATEGORY_HIERARCHY_NORMALIZATION_VERSION,
  normalizeDefaultCategoryHierarchyForHousehold,
} from "@/lib/default-categories";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { loadStockHoldingReport } from "@/lib/server/stock-holding-report";
import { loadFundHoldingReport } from "@/lib/server/fund-holding-report";
import { listPreciousMetalDictionaries } from "@/lib/server/precious-metals";
import { entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import { loadFundTransactionEntryLike } from "@/lib/fund/transactions";
import {
  loadPreciousMetalTransactionEntryLike,
  loadPropertyTransactionEntryLike,
  loadWealthTransactionEntryLike,
} from "@/lib/server/business-transaction-entries";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import { loadReadableTagsByRecentUse } from "@/lib/server/tag-scope";
import { categoryOrderBy } from "@/lib/category-order";
import { DETAIL_ALL_PAGE_SIZE } from "@/lib/detail-pagination-preference";

// ── Types ──

export type CommonData = Awaited<ReturnType<typeof _loadCommonData>>;

export type BaseData = CommonData & {
  selectedAccount: Awaited<ReturnType<typeof loadSelectedAccount>>;
};

// ── Common base data (shared across accounts, cached across requests) ──

async function _loadCommonData(hidFilter: { householdId: string }) {
  await normalizeDefaultCategoryHierarchyForHousehold(prisma, hidFilter.householdId);

  const [categories, accounts, tags, groups, institutions, counterparties, preciousMetalDictionaries] = await Promise.all([
    prisma.category.findMany({
      where: { ...hidFilter },
      orderBy: categoryOrderBy(),
    }),
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, ...hidFilter },
      include: { Institution: true, Counterparty: true, AccountGroup: true, AccountAlias: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    loadReadableTagsByRecentUse(hidFilter.householdId),
    prisma.accountGroup.findMany({
      where: { ...hidFilter },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: { ...hidFilter },
      orderBy: { name: "asc" },
    }),
    prisma.counterparty.findMany({
      where: { ...hidFilter },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    listPreciousMetalDictionaries(hidFilter.householdId),
  ]);
  return { categories, accounts, tags, groups, institutions, counterparties, preciousMetalDictionaries };
}

/** Cross-request cache: data that does not vary by account */
export const loadCommonData = unstable_cache(_loadCommonData, ["common-data", CATEGORY_HIERARCHY_NORMALIZATION_VERSION], {
  revalidate: false,
  tags: ["common-data"],
});

// ── Per-account data (request-level cache, deduplicated only within the same request) ──

export const loadSelectedAccount = cache(
  async (accountId: string | undefined, hidFilter: { householdId: string }) => {
    if (!accountId) return null;
    return prisma.account.findFirst({
      where: { id: accountId, isPlaceholder: { not: true }, ...hidFilter },
      include: { Institution: true, Counterparty: true, AccountGroup: true },
    });
  },
);

// ── entries data (request-level cache) ──

async function _loadEntriesForAccount(
  accountId: string,
  hidFilterStr: string,
) {
  const hidFilter = JSON.parse(hidFilterStr) as { householdId: string };
  const hid = { householdId: hidFilter.householdId };
  const where = {
    ...txRecordAccountScopeWhere(accountId),
    deletedAt: null,
    ...hid,
  };

  return prisma.txRecord.findMany({
    where,
    include: {
      EntryTag: { include: { Tag: true } },
      Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
      ...entryBusinessLinkSummaryInclude,
      account: {
        include: {
          Institution: { select: { name: true, shortName: true } },
          AccountGroup: { select: { name: true } },
          Counterparty: { select: { name: true, shortName: true } },
        },
      },
      toAccount: {
        include: {
          Institution: { select: { name: true, shortName: true } },
          AccountGroup: { select: { name: true } },
          Counterparty: { select: { name: true, shortName: true } },
        },
      },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: DETAIL_ALL_PAGE_SIZE,
  });
}

/**
 * Account transaction details can exceed the 2MB per-entry limit of the Next.js data cache.
 * This only uses React.cache request-level deduplication to avoid unstable_cache write failures for large accounts.
 */
export const loadEntriesForAccount = cache(_loadEntriesForAccount);

async function _loadInvestBalances(_hidFilterStr: string) {
  const hidFilter = JSON.parse(_hidFilterStr) as { householdId: string };
  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };

  const balances = await computeInvestBalances(ctx);
  return Object.fromEntries(balances);
}

export const loadInvestBalances = unstable_cache(
  _loadInvestBalances,
  ["invest-balances"],
  { revalidate: false, tags: ["invest-balances", "fund-holding"] },
);

async function _loadFixedAssetPositionDisplay(hidFilterStr: string, accountId: string) {
  const hidFilter = JSON.parse(hidFilterStr) as { householdId: string };
  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };
  return accountId
    ? computePositionDisplay(ctx, accountId)
    : computeFixedAssetPositionDisplay(ctx);
}

/** Cross-request cache for fixed-asset positions. */
export const loadFixedAssetPositionDisplay = unstable_cache(
  _loadFixedAssetPositionDisplay,
  ["fixed-asset-display"],
  { revalidate: false, tags: ["fixed-asset-display", "invest-balances"] },
);

async function _loadFixedAssetTransactionEntries(householdId: string, accountIdsStr: string) {
  const accountIds = JSON.parse(accountIdsStr) as string[];
  return loadPropertyTransactionEntryLike({ householdId, accountIds });
}

/** Cross-request cache for the serialized fixed-asset transaction detail list. */
export const loadFixedAssetTransactionEntries = unstable_cache(
  _loadFixedAssetTransactionEntries,
  ["fixed-asset-transactions"],
  { revalidate: false, tags: ["fixed-asset-transactions"] },
);

async function _loadStockHoldingReport(
  hidFilterStr: string,
  accountIdsStr: string,
) {
  const hidFilter = JSON.parse(hidFilterStr) as { householdId: string };
  const accountIds = JSON.parse(accountIdsStr) as string[];
  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };
  return loadStockHoldingReport(ctx, {
    accountIds: accountIds.length > 0 ? accountIds : undefined,
  });
}

/** Cross-request cache: the stock holding P&L report reads recalculated StockHolding rows and does not re-query the DB per page filter */
export const loadCachedStockHoldingReport = unstable_cache(
  _loadStockHoldingReport,
  ["stock-holding-report"],
  { revalidate: false, tags: ["stock-holding-report", "invest-balances"] },
);

async function _loadFundHoldingReport(
  hidFilterStr: string,
  accountIdsStr: string,
  fundCompaniesStr: string,
) {
  const hidFilter = JSON.parse(hidFilterStr) as { householdId: string };
  const accountIds = JSON.parse(accountIdsStr) as string[];
  const fundCompanies = JSON.parse(fundCompaniesStr) as string[];
  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };
  return loadFundHoldingReport(ctx, {
    accountIds: accountIds.length > 0 ? accountIds : undefined,
    fundCompanies: fundCompanies.length > 0 ? fundCompanies : undefined,
  });
}

/** Cross-request cache: the fund holding summary reads the display layer (FundHolding) so numbers stay consistent with the fund detail view */
export const loadCachedFundHoldingReport = unstable_cache(
  _loadFundHoldingReport,
  ["fund-holding-report"],
  { revalidate: false, tags: ["fund-holding-report", "invest-balances"] },
);

// ── Investment account holding data (request-level cache) ──

async function _loadInvestAccountData(
  _hidFilterStr: string,
  accountId: string,
  _paramsStr: string,
) {
  const hidFilter = JSON.parse(_hidFilterStr) as { householdId: string };
  const params = JSON.parse(_paramsStr) as {
    fundSortParam: string;
    fundSortDirParam: "asc" | "desc";
    fundPageSize: number;
    fundPage: number;
    fundCodeParam: string;
    wealthProductIdParam?: string;
  };

  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };

  const account = await prisma.account.findFirst({
    where: { id: accountId, isPlaceholder: { not: true }, ...hidFilter },
  });
  if (!account) return null;

  const positionDisplay = await computePositionDisplay(ctx, accountId);

  const dir = params.fundSortDirParam === "asc" ? 1 : -1;
  const sortFn = (a: { marketValue: number; cost: number; floatingPnL: number; floatingPnLRate: number; historicalProfit: number; fundCode: string }, b: typeof a) => {
    let value = 0;
    switch (params.fundSortParam) {
      case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
      case "cost": value = a.cost - b.cost; break;
      case "floatingPnL": value = a.floatingPnL - b.floatingPnL; break;
      case "floatingPnLRate": value = a.floatingPnLRate - b.floatingPnLRate; break;
      case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
      case "marketValue":
      default: value = a.marketValue - b.marketValue; break;
    }
    return value * dir;
  };

  positionDisplay.positions = [...positionDisplay.positions].sort(sortFn);

  const clearedSortFn = (a: { fundCode: string; firstBuyDate: string; clearedDate: string; returnRate: number; historicalProfit: number }, b: typeof a) => {
    let value = 0;
    switch (params.fundSortParam) {
      case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
      case "firstBuyDate": value = a.firstBuyDate.localeCompare(b.firstBuyDate); break;
      case "clearedDate": value = a.clearedDate.localeCompare(b.clearedDate); break;
      case "returnRate": value = a.returnRate - b.returnRate; break;
      case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
      case "clearedDate":
      default: value = a.clearedDate.localeCompare(b.clearedDate); break;
    }
    return value * dir;
  };
  positionDisplay.clearedPositions = [...positionDisplay.clearedPositions].sort(clearedSortFn);

  const selectedFundCode =
    account.investProductType === "wealth"
      ? (params.wealthProductIdParam || "")
      : (params.fundCodeParam || "");

  const fundEntries =
    account.investProductType === "wealth"
      ? await loadWealthTransactionEntryLike({
          householdId: hidFilter.householdId,
          accountIds: [accountId],
        })
      : account.investProductType === "metal"
        ? await loadPreciousMetalTransactionEntryLike({
            householdId: hidFilter.householdId,
            accountIds: [accountId],
          })
        : await loadFundTransactionEntryLike({
            householdId: hidFilter.householdId,
            accountId,
            entryScope: "account",
          });

  const feeRateRecords = await prisma.fundFeeRate.findMany({
    where: { accountId },
    orderBy: { effectiveDate: "desc" },
  });
  const feeRateMap = new Map<string, string>();
  for (const fr of feeRateRecords) {
    const key = `${fr.fundCode}:${fr.feeType}`;
    if (!feeRateMap.has(key)) feeRateMap.set(key, String(fr.rate));
  }

  const confirmDaysRecords = await prisma.fundConfirmDays.findMany({
    where: { accountId },
  });
  const confirmDaysMap = new Map<string, number>();
  for (const cd of confirmDaysRecords) {
    confirmDaysMap.set(cd.fundCode, cd.days ?? 0);
  }

  const pendingByCode = new Map<string, number>();
  for (const p of positionDisplay.positions) {
    if (p.pendingCost > 0) pendingByCode.set(p.fundCode, p.pendingCost);
  }

  const filtered = selectedFundCode
    ? fundEntries.filter((e: any) =>
        account.investProductType === "wealth"
          ? e.wealthProductId === selectedFundCode
          : account.investProductType === "metal"
            ? e.metalTypeId === selectedFundCode
            : e.fundCode === selectedFundCode
      )
    : [];
  const totalEntries = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / params.fundPageSize));
  const safePage = Math.min(params.fundPage, totalPages);
  const pagedEntries = filtered.slice(
    (safePage - 1) * params.fundPageSize,
    safePage * params.fundPageSize,
  );

  return {
    ...positionDisplay,
    filteredEntries: pagedEntries,
    allEntries: fundEntries,
    totalEntries,
    totalPages,
    safePage,
    selectedFundCode,
    selectedWealthProductId: account.investProductType === "wealth" ? selectedFundCode : "",
    pendingByCode: Object.fromEntries(pendingByCode),
    feeRateMap: Object.fromEntries(feeRateMap),
    confirmDaysMap: Object.fromEntries(confirmDaysMap),
    account,
  };
}

/**
 * Investment account holdings + detail data can contain a large number of allEntries.
 * The Next.js data cache has a 2MB per-entry limit, so this only does request-level deduplication to avoid unstable_cache write failures when fund details are numerous.
 */
export const loadInvestAccountData = cache(_loadInvestAccountData);
