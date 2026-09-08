import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { getEffectiveLatestFundNavMap, getLatestFundNav, refreshLatestFundNav } from "@/lib/fund/navCache";
import { getFundProfileNameMap, normalizeFundDisplayName } from "@/lib/fund/fundProfile";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { optionalPrismaFindMany } from "@/lib/server/optional-prisma-delegate";
import { categoryOrderBy } from "@/lib/category-order";
import { decodeScheduledTaskMemo, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function parseSince(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseBoolean(value: string | null) {
  return value === "1" || value === "true";
}

function changedBetween(since: Date | null, serverTime: Date) {
  return since ? { gt: since, lte: serverTime } : undefined;
}

type LatestFundNav = NonNullable<Awaited<ReturnType<typeof getLatestFundNav>>>;
type SyncFundNavRow = {
  id: string;
  fundCode: string;
  navDate: Date;
  nav: unknown;
  cumNav: unknown | null;
  name: string | null;
  updatedAt: Date;
};

function mergeLatestFundNav(rows: SyncFundNavRow[], latestByCode: Map<string, LatestFundNav>): SyncFundNavRow[] {
  const byKey = new Map(rows.map((row) => [`${row.fundCode}:${row.navDate.toISOString()}`, row]));
  for (const [fundCode, latest] of latestByCode) {
    const key = `${fundCode}:${latest.navDate.toISOString()}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: latest.id,
        fundCode,
        navDate: latest.navDate,
        nav: latest.nav,
        cumNav: latest.cumNav,
        name: latest.name,
        updatedAt: latest.navDate,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.navDate.getTime() - b.navDate.getTime());
}

/**
 * GET /api/v1/mobile/sync
 *
 * Android-only incremental sync endpoint. The mobile client should keep a local
 * Room cursor and call this endpoint with `since=<serverTime from previous sync>`.
 * Category currently has no updatedAt/deletedAt fields, so categories are returned
 * as a full table snapshot each time while other tables use updatedAt/deletedAt.
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  let scope;
  try {
    scope = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unauthorized" },
      { status: 401, headers: corsHeaders() },
    );
  }

  try {
    const url = new URL(req.url);
    const since = parseSince(url.searchParams.get("since"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const refreshDaily = parseBoolean(url.searchParams.get("refreshDaily"));
    const serverTime = new Date();
    const updatedAt = changedBetween(since, serverTime);

    const accountWhere = {
      ...scope.hidFilter,
      ...(updatedAt ? { updatedAt } : {}),
    };
    const transactionWhere = since
      ? {
          ...scope.hidFilter,
          OR: [{ updatedAt }, { deletedAt: updatedAt }],
        }
      : { ...scope.hidFilter, deletedAt: null };
    const stockTransactionWhere = since
      ? {
          ...scope.hidFilter,
          OR: [{ updatedAt }, { deletedAt: updatedAt }],
        }
      : { ...scope.hidFilter, deletedAt: null };
    const propertyWhere = since
      ? {
          ...scope.hidFilter,
          OR: [{ updatedAt }, { deletedAt: updatedAt }],
        }
      : { ...scope.hidFilter, deletedAt: null };

    const [
      accounts,
      categories,
      transactionsRaw,
      fundHoldings,
      stockHoldings,
      stockTransactions,
      propertyAssets,
      propertyTransactions,
      fundConfirmDays,
      fundFeeRates,
      regularInvestPlans,
    ] = await Promise.all([
      prisma.account.findMany({
        where: accountWhere,
        select: {
          id: true,
          name: true,
          note: true,
          balance: true,
          kind: true,
          debtDirection: true,
          loanType: true,
          currency: true,
          isActive: true,
          isPlaceholder: true,
          investProductType: true,
          tradingCalendar: true,
          creditLimit: true,
          billingDay: true,
          repaymentDay: true,
          repaymentOffsetDays: true,
          creditBillMode: true,
          numberMasked: true,
          institutionId: true,
          groupId: true,
          costBasisMethod: true,
          updatedAt: true,
          AccountGroup: { select: { id: true, name: true, sortOrder: true } },
          Institution: { select: { id: true, name: true, type: true } },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.category.findMany({
        where: scope.hidFilter,
        select: { id: true, name: true, type: true, parentId: true, sortOrder: true },
        orderBy: categoryOrderBy(),
      }),
      prisma.txRecord.findMany({
        where: transactionWhere,
        select: {
          id: true,
          date: true,
          postedAt: true,
          type: true,
          amount: true,
          dayOrder: true,
          accountId: true,
          accountName: true,
          toAccountId: true,
          toAccountName: true,
          categoryId: true,
          categoryName: true,
          note: true,
          fundCode: true,
          fundName: true,
          fundProductType: true,
          fundSubtype: true,
          fundNav: true,
          fundUnits: true,
          fundFee: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          fundArrivalAmount: true,
          creditCardInstallmentPlanId: true,
          installmentNo: true,
          installmentTotal: true,
          installmentPrincipal: true,
          installmentInterest: true,
          installmentRole: true,
          CreditCardInstallmentPlan: { select: { sourceType: true, sourceStatementMonth: true } },
          source: true,
          deletedAt: true,
          updatedAt: true,
          account: { select: { name: true, kind: true, Institution: { select: { name: true } } } },
          toAccount: { select: { name: true, kind: true, Institution: { select: { name: true } } } },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.fundHolding.findMany({
        where: {
          Account: scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          fundCode: true,
          fundName: true,
          units: true,
          avgCost: true,
          cost: true,
          nav: true,
          pendingCost: true,
          historicalProfit: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.stockHolding.findMany({
        where: {
          ...scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          securityId: true,
          market: true,
          stockCode: true,
          stockName: true,
          quantity: true,
          avgCost: true,
          cost: true,
          latestPrice: true,
          marketValue: true,
          historicalProfit: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.stockTransaction.findMany({
        where: stockTransactionWhere,
        select: {
          id: true,
          stockAccountId: true,
          cashAccountId: true,
          cashEntryId: true,
          securityId: true,
          market: true,
          stockCode: true,
          stockName: true,
          action: true,
          source: true,
          tradeDate: true,
          settleDate: true,
          grossAmount: true,
          netAmount: true,
          quantity: true,
          price: true,
          fee: true,
          commission: true,
          stampTax: true,
          transferFee: true,
          exchangeFee: true,
          regulatoryFee: true,
          otherFee: true,
          realizedProfit: true,
          externalLinkId: true,
          brokerTradeId: true,
          note: true,
          deletedAt: true,
          updatedAt: true,
          EntryBusinessLink: {
            where: { deletedAt: null },
            select: { id: true },
          },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      optionalPrismaFindMany<any>(
        prisma,
        "propertyAsset",
        {
          where: propertyWhere,
          select: {
            id: true,
            accountId: true,
            name: true,
            propertyType: true,
            address: true,
            currency: true,
            purchaseDate: true,
            purchasePrice: true,
            cost: true,
            marketValue: true,
            latestValuationDate: true,
            status: true,
            note: true,
            deletedAt: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        },
        { tableNames: ["property_assets"] },
      ),
      optionalPrismaFindMany<any>(
        prisma,
        "propertyTransaction",
        {
          where: propertyWhere,
          select: {
            id: true,
            accountId: true,
            cashAccountId: true,
            cashEntryId: true,
            propertyAssetId: true,
            action: true,
            source: true,
            tradeDate: true,
            settlementDate: true,
            amount: true,
            fee: true,
            tax: true,
            realizedProfit: true,
            note: true,
            deletedAt: true,
            updatedAt: true,
            EntryBusinessLink: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        },
        { tableNames: ["property_transactions"] },
      ),
      prisma.fundConfirmDays.findMany({
        where: {
          Account: scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          fundCode: true,
          days: true,
          redeemCostDays: true,
          arrivalDays: true,
          effectiveDate: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.fundFeeRate.findMany({
        where: {
          Account: scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          fundCode: true,
          rate: true,
          feeType: true,
          effectiveDate: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.regularInvestPlan.findMany({
        where: {
          ...scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          householdId: true,
          accountId: true,
          accountName: true,
          cashAccountId: true,
          cashAccountName: true,
          taskType: true,
          planName: true,
          targetName: true,
          insuranceProductName: true,
          fundCode: true,
          fundName: true,
          fundProductType: true,
          amount: true,
          intervalUnit: true,
          intervalValue: true,
          executionDay: true,
          secondaryExecutionDay: true,
          startDate: true,
          endDate: true,
          totalRuns: true,
          executedRuns: true,
          lastRunDate: true,
          nextRunDate: true,
          status: true,
          feeRate: true,
          confirmDays: true,
          arrivalDays: true,
          memo: true,
          skipPendingPreceding: true,
          createdAt: true,
          updatedAt: true,
          Account_RegularInvestPlan_accountIdToAccount: {
            select: { name: true, Institution: { select: { name: true } } },
          },
          Account_RegularInvestPlan_cashAccountIdToAccount: {
            select: { name: true, Institution: { select: { name: true } } },
          },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
    ]);

    const accountBatch = accounts.slice(0, limit);
    const transactionBatch = transactionsRaw.slice(0, limit);
    const holdingBatch = fundHoldings.slice(0, limit);
    const stockHoldingBatch = stockHoldings.slice(0, limit);
    const stockTransactionBatch = stockTransactions.slice(0, limit);
    const propertyAssetBatch = propertyAssets.slice(0, limit);
    const propertyTransactionBatch = propertyTransactions.slice(0, limit);
    const confirmDaysBatch = fundConfirmDays.slice(0, limit);
    const feeRateBatch = fundFeeRates.slice(0, limit);
    const regularInvestPlanBatch = regularInvestPlans.slice(0, limit);
    const fundRegularInvestPlanCodes = regularInvestPlanBatch
      .filter((item) => normalizeScheduledTaskType(item.taskType ?? decodeScheduledTaskMemo(item.memo).type) === "fund_regular_invest")
      .map((item) => item.fundCode)
      .filter((code): code is string => /^\d{6}$/.test(String(code ?? "")));

    const currentHoldingCodes = await prisma.fundHolding.findMany({
      where: { Account: scope.hidFilter },
      select: { fundCode: true },
      distinct: ["fundCode"],
    });
    const fundCodes = Array.from(
      new Set([
        ...currentHoldingCodes.map((item) => item.fundCode),
        ...holdingBatch.map((item) => item.fundCode),
        ...fundRegularInvestPlanCodes,
        ...transactionBatch.map((item) => item.fundCode).filter((code): code is string => Boolean(code)),
      ]),
    );

    if (refreshDaily && fundCodes.length) {
      await Promise.allSettled(fundCodes.map((fundCode) => refreshLatestFundNav(fundCode)));
    }

    const latestNavByCode = await getEffectiveLatestFundNavMap(fundCodes);
    const fundProfileNameByCode = await getFundProfileNameMap(fundCodes);

    const fundNav = fundCodes.length
      ? await prisma.fundNavCache.findMany({
          where: {
            fundCode: { in: fundCodes },
            ...(updatedAt ? { updatedAt } : {}),
          },
          select: {
            id: true,
            fundCode: true,
            navDate: true,
            nav: true,
            cumNav: true,
            name: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        })
      : [];

    const hasMore =
      accounts.length > limit ||
      transactionsRaw.length > limit ||
      fundHoldings.length > limit ||
      stockHoldings.length > limit ||
      stockTransactions.length > limit ||
      propertyAssets.length > limit ||
      propertyTransactions.length > limit ||
      fundConfirmDays.length > limit ||
      fundFeeRates.length > limit ||
      regularInvestPlans.length > limit ||
      fundNav.length > limit;
    const [investBalByAccountId, displayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId] = await Promise.all([
      computeInvestBalances(scope),
      computeAccountDisplayBalances(
        accountBatch
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
          accountId: { in: accountBatch.filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay).map((account) => account.id) },
          isCurrentCycle: true,
        },
        select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
      }),
      computeInsuranceAccountDisplayBalances(
        accountBatch.filter((account) => account.kind === AccountKind.insurance).map((account) => account.id),
        scope.hidFilter,
      ),
    ]);
    const currentCreditBalanceByAccountId = new Map(
      currentCreditCycles.map((cycle) => [
        cycle.accountId,
        creditCardDisplayBalanceFromCurrentCycle(cycle),
      ]),
    );

    return NextResponse.json(
      {
        ok: true,
        serverTime: serverTime.toISOString(),
        hasMore,
        accounts: accountBatch.map((account) => ({
          id: account.id,
          name: account.name,
          note: account.note,
          balance: isPureInvestmentAccount(account)
            ? investBalByAccountId.get(account.id)?.marketValue ?? 0
            : account.kind === AccountKind.insurance
              ? insuranceDisplayBalanceByAccountId.get(account.id) ?? 0
              : account.kind === AccountKind.bank_credit && account.billingDay
                ? currentCreditBalanceByAccountId.get(account.id) ?? toNumber(account.balance)
                : displayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
          kind: account.kind,
          debtDirection: account.debtDirection,
          loanType: account.loanType,
          currency: account.currency,
          isActive: account.isActive,
          isPlaceholder: account.isPlaceholder,
          investProductType: account.investProductType,
          tradingCalendar: account.tradingCalendar,
          creditLimit: account.creditLimit == null ? null : toNumber(account.creditLimit),
          billingDay: account.billingDay,
          repaymentDay: account.repaymentDay,
          repaymentOffsetDays: account.repaymentOffsetDays,
          creditBillMode: account.creditBillMode,
          numberMasked: account.numberMasked,
          institutionId: account.institutionId,
          institutionName: account.Institution?.name ?? null,
          groupId: account.groupId,
          groupName: account.kind === AccountKind.loan || account.kind === AccountKind.settlement ? "" : account.AccountGroup.name,
          costBasisMethod: account.costBasisMethod,
          updatedAt: account.updatedAt.toISOString(),
        })),
        categories,
        transactions: transactionBatch
          .filter((tx) => !tx.deletedAt)
          .map((tx) => ({
            id: tx.id,
            date: formatDateUtc(tx.date),
            postedAt: tx.postedAt ? tx.postedAt.toISOString() : null,
            type: tx.type,
            amount: toNumber(tx.amount),
            dayOrder: tx.dayOrder,
            accountId: tx.accountId,
            accountName: tx.account.name ?? tx.accountName,
            accountKind: tx.account.kind,
            accountInstitutionName: tx.account.Institution?.name ?? null,
            toAccountId: tx.toAccountId,
            toAccountName: tx.toAccount?.name ?? tx.toAccountName,
            toAccountKind: tx.toAccount?.kind ?? null,
            toAccountInstitutionName: tx.toAccount?.Institution?.name ?? null,
            categoryId: tx.categoryId,
            categoryName: tx.categoryName,
            note: tx.note,
            fundCode: tx.fundCode,
            fundName: tx.fundName,
            fundProductType: tx.fundProductType,
            fundSubtype: tx.fundSubtype,
            fundNav: tx.fundNav == null ? null : toNumber(tx.fundNav),
            fundUnits: tx.fundUnits == null ? null : toNumber(tx.fundUnits),
            fundFee: tx.fundFee == null ? null : toNumber(tx.fundFee),
            fundConfirmDate: tx.fundConfirmDate ? formatDateUtc(tx.fundConfirmDate) : null,
            fundArrivalDate: tx.fundArrivalDate ? formatDateUtc(tx.fundArrivalDate) : null,
            fundArrivalAmount: tx.fundArrivalAmount == null ? null : toNumber(tx.fundArrivalAmount),
            creditCardInstallmentPlanId: tx.creditCardInstallmentPlanId,
            installmentNo: tx.installmentNo,
            installmentTotal: tx.installmentTotal,
            installmentPrincipal: tx.installmentPrincipal == null ? null : toNumber(tx.installmentPrincipal),
            installmentInterest: tx.installmentInterest == null ? null : toNumber(tx.installmentInterest),
            installmentRole: tx.installmentRole,
            installmentSourceType: tx.CreditCardInstallmentPlan?.sourceType ?? null,
            installmentSourceStatementMonth: tx.CreditCardInstallmentPlan?.sourceStatementMonth ?? null,
            source: tx.source,
            updatedAt: tx.updatedAt.toISOString(),
          })),
        deletedTransactionIds: transactionBatch.filter((tx) => tx.deletedAt).map((tx) => tx.id),
        fundHoldings: holdingBatch.map((item) => {
          const latestNav = latestNavByCode.get(item.fundCode);
          return {
            id: item.id,
            accountId: item.accountId,
            fundCode: item.fundCode,
            fundName: item.fundName ?? latestNav?.name ?? null,
            units: toNumber(item.units),
            avgCost: toNumber(item.avgCost),
            cost: toNumber(item.cost),
            nav: latestNav?.nav ?? (item.nav == null ? null : toNumber(item.nav)),
            navDate: latestNav ? formatDateUtc(latestNav.navDate) : null,
            pendingCost: toNumber(item.pendingCost),
            historicalProfit: toNumber(item.historicalProfit),
            updatedAt: item.updatedAt.toISOString(),
          };
        }),
        stockHoldings: stockHoldingBatch.map((item) => ({
          id: item.id,
          accountId: item.accountId,
          securityId: item.securityId,
          market: item.market,
          stockCode: item.stockCode,
          stockName: item.stockName,
          quantity: toNumber(item.quantity),
          avgCost: toNumber(item.avgCost),
          cost: toNumber(item.cost),
          latestPrice: item.latestPrice == null ? null : toNumber(item.latestPrice),
          marketValue: toNumber(item.marketValue),
          floatingPnL: toNumber(item.marketValue) - toNumber(item.cost),
          historicalProfit: toNumber(item.historicalProfit),
          updatedAt: item.updatedAt.toISOString(),
        })),
        stockTransactions: stockTransactionBatch
          .filter((item) => !item.deletedAt)
          .map((item) => ({
            id: item.id,
            linkId: item.EntryBusinessLink[0]?.id ?? null,
            stockAccountId: item.stockAccountId,
            cashAccountId: item.cashAccountId,
            cashEntryId: item.cashEntryId,
            securityId: item.securityId,
            market: item.market,
            stockCode: item.stockCode,
            stockName: item.stockName,
            action: item.action,
            source: item.source,
            tradeDate: formatDateUtc(item.tradeDate),
            settleDate: item.settleDate ? formatDateUtc(item.settleDate) : null,
            grossAmount: toNumber(item.grossAmount),
            netAmount: item.netAmount == null ? null : toNumber(item.netAmount),
            quantity: item.quantity == null ? null : toNumber(item.quantity),
            price: item.price == null ? null : toNumber(item.price),
            fee: item.fee == null ? null : toNumber(item.fee),
            commission: item.commission == null ? null : toNumber(item.commission),
            stampTax: item.stampTax == null ? null : toNumber(item.stampTax),
            transferFee: item.transferFee == null ? null : toNumber(item.transferFee),
            exchangeFee: item.exchangeFee == null ? null : toNumber(item.exchangeFee),
            regulatoryFee: item.regulatoryFee == null ? null : toNumber(item.regulatoryFee),
            otherFee: item.otherFee == null ? null : toNumber(item.otherFee),
            realizedProfit: item.realizedProfit == null ? null : toNumber(item.realizedProfit),
            externalLinkId: item.externalLinkId,
            brokerTradeId: item.brokerTradeId,
            note: item.note,
            updatedAt: item.updatedAt.toISOString(),
          })),
        deletedStockTransactionIds: stockTransactionBatch.filter((item) => item.deletedAt).map((item) => item.id),
        propertyAssets: propertyAssetBatch
          .filter((item) => !item.deletedAt)
          .map((item) => ({
            id: item.id,
            accountId: item.accountId,
            name: item.name,
            propertyType: item.propertyType,
            address: item.address,
            currency: item.currency,
            purchaseDate: item.purchaseDate ? formatDateUtc(item.purchaseDate) : null,
            purchasePrice: item.purchasePrice == null ? null : toNumber(item.purchasePrice),
            cost: toNumber(item.cost),
            marketValue: toNumber(item.marketValue),
            latestValuationDate: item.latestValuationDate ? formatDateUtc(item.latestValuationDate) : null,
            status: item.status,
            note: item.note,
            updatedAt: item.updatedAt.toISOString(),
          })),
        deletedPropertyAssetIds: propertyAssetBatch.filter((item) => item.deletedAt).map((item) => item.id),
        propertyTransactions: propertyTransactionBatch
          .filter((item) => !item.deletedAt)
          .map((item) => ({
            id: item.id,
            linkId: item.EntryBusinessLink[0]?.id ?? null,
            accountId: item.accountId,
            cashAccountId: item.cashAccountId,
            cashEntryId: item.cashEntryId,
            propertyAssetId: item.propertyAssetId,
            action: item.action,
            source: item.source,
            tradeDate: formatDateUtc(item.tradeDate),
            settlementDate: item.settlementDate ? formatDateUtc(item.settlementDate) : null,
            amount: toNumber(item.amount),
            fee: item.fee == null ? null : toNumber(item.fee),
            tax: item.tax == null ? null : toNumber(item.tax),
            realizedProfit: item.realizedProfit == null ? null : toNumber(item.realizedProfit),
            note: item.note,
            updatedAt: item.updatedAt.toISOString(),
          })),
        deletedPropertyTransactionIds: propertyTransactionBatch.filter((item) => item.deletedAt).map((item) => item.id),
        regularInvestPlans: regularInvestPlanBatch.map((item) => {
          const task = decodeScheduledTaskMemo(item.memo);
          const taskType = normalizeScheduledTaskType(item.taskType ?? task.type);
          const itemFundCode = String(item.fundCode ?? "").trim();
          const isFundRegularInvest = taskType === "fund_regular_invest" && /^\d{6}$/.test(itemFundCode);
          const displayFundName = isFundRegularInvest
            ? fundProfileNameByCode.get(itemFundCode)
              ?? normalizeFundDisplayName(itemFundCode, item.fundName)
              ?? normalizeFundDisplayName(itemFundCode, item.targetName)
              ?? normalizeFundDisplayName(itemFundCode, latestNavByCode.get(itemFundCode)?.name)
              ?? itemFundCode
            : item.fundName ?? "";
          const displayTargetName = isFundRegularInvest ? displayFundName : item.targetName;
          return {
            id: item.id,
            householdId: item.householdId ?? "",
            accountId: item.accountId,
            accountName: item.Account_RegularInvestPlan_accountIdToAccount?.name ?? item.accountName,
            accountInstitutionName: item.Account_RegularInvestPlan_accountIdToAccount.Institution?.name ?? null,
            cashAccountId: item.cashAccountId,
            cashAccountName: item.Account_RegularInvestPlan_cashAccountIdToAccount?.name ?? item.cashAccountName,
            cashAccountInstitutionName: item.Account_RegularInvestPlan_cashAccountIdToAccount?.Institution?.name ?? null,
            taskType,
            planName: item.planName ?? null,
            taskTitle: isFundRegularInvest ? displayFundName : item.targetName ?? task.title ?? null,
            targetName: displayTargetName,
            insuranceProductName: item.insuranceProductName,
            taskCategoryId: task.categoryId ?? null,
            taskCategoryName: task.categoryName ?? null,
            taskTypeLabel: scheduledTaskTypeLabel(taskType),
            taskNote: task.note ?? null,
            fundCode: item.fundCode,
            fundName: displayFundName,
            fundProductType: item.fundProductType,
            amount: toNumber(item.amount),
            intervalUnit: item.intervalUnit,
            intervalValue: item.intervalValue,
            executionDay: item.executionDay,
            secondaryExecutionDay: item.secondaryExecutionDay,
            startDate: formatDateUtc(item.startDate),
            endDate: item.endDate ? formatDateUtc(item.endDate) : null,
            totalRuns: item.totalRuns,
            executedRuns: item.executedRuns,
            lastRunDate: item.lastRunDate ? formatDateUtc(item.lastRunDate) : null,
            nextRunDate: formatDateUtc(item.nextRunDate),
            status: item.status,
            feeRate: item.feeRate == null ? null : toNumber(item.feeRate),
            confirmDays: item.confirmDays,
            arrivalDays: item.arrivalDays,
            memo: item.memo,
            skipPendingPreceding: item.skipPendingPreceding,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
          };
        }),
        fundConfirmDays: confirmDaysBatch.map((item) => ({
          id: item.id,
          accountId: item.accountId,
          fundCode: item.fundCode,
          days: item.days,
          redeemCostDays: item.redeemCostDays,
          arrivalDays: item.arrivalDays,
          effectiveDate: item.effectiveDate.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
        fundFeeRates: feeRateBatch.map((item) => ({
          id: item.id,
          accountId: item.accountId,
          fundCode: item.fundCode,
          rate: toNumber(item.rate),
          feeType: item.feeType,
          effectiveDate: item.effectiveDate.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
        fundNav: mergeLatestFundNav(fundNav.slice(0, limit), latestNavByCode).map((item) => ({
          id: item.id,
          fundCode: item.fundCode,
          navDate: formatDateUtc(item.navDate),
          nav: toNumber(item.nav),
          cumNav: item.cumNav == null ? null : toNumber(item.cumNav),
          name: item.name,
          updatedAt: item.updatedAt.toISOString(),
        })),
      },
      { headers: corsHeaders() },
    );
  } catch (e) {
    console.error("GET /api/v1/mobile/sync error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
