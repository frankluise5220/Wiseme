import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { computePositionDisplay } from "@/lib/invest-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadFixedAssetPositionDisplay, loadFixedAssetTransactionEntries } from "@/lib/server/cached-data";
import { loadFundTransactionEntryLike } from "@/lib/fund/transactions";
import {
  loadPreciousMetalTransactionEntryLike,
  loadWealthTransactionEntryLike,
} from "@/lib/server/business-transaction-entries";

export async function GET(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;
    const url = new URL(req.url);
    const accountId = url.searchParams.get("accountId");
    const fundCodeParam = url.searchParams.get("fundCode") || undefined;
    const wealthProductIdParam = url.searchParams.get("wealthProductId") || undefined;
    const entryScope = url.searchParams.get("entryScope") === "account" ? "account" : "fund";
    const showCleared = url.searchParams.get("showCleared") === "1";

    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少 accountId" }, { status: 400 });
    }

    // Verify account exists and is investment type
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...hidFilter },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    }

    // Compute positions
    const positionDisplay = account.investProductType === "property"
      ? await loadFixedAssetPositionDisplay(JSON.stringify(hidFilter), accountId)
      : await computePositionDisplay(ctx, accountId);

    const selectedFundCode =
      account.investProductType === "wealth"
        ? (wealthProductIdParam || fundCodeParam || "")
        : fundCodeParam || (positionDisplay.positions.length > 0
          ? [...positionDisplay.positions].sort((a, b) => b.marketValue - a.marketValue)[0]?.fundCode
          : (positionDisplay.clearedPositions.length > 0
            ? [...positionDisplay.clearedPositions].sort((a, b) => b.clearedDate.localeCompare(a.clearedDate))[0]?.fundCode
            : ""));

    // Do not limit here: the client paginates details locally.
    // entryScope=account is used when the client needs a complete local cache for fast fund switching.
    const allIndependentEntries =
      account.investProductType === "wealth"
        ? await loadWealthTransactionEntryLike({
            accountIds: [accountId],
            householdId: ctx.householdId,
          })
        : account.investProductType === "metal"
          ? await loadPreciousMetalTransactionEntryLike({
              accountIds: [accountId],
              householdId: ctx.householdId,
            })
          : account.investProductType === "property"
            ? await loadFixedAssetTransactionEntries(
                ctx.householdId,
                JSON.stringify([accountId]),
              )
          : await loadFundTransactionEntryLike({
              accountId,
              householdId: ctx.householdId,
              fundCode: selectedFundCode || undefined,
              entryScope,
            });
    const fundEntries = entryScope === "account" || (account.investProductType === "wealth" && !selectedFundCode)
      ? allIndependentEntries
      : allIndependentEntries.filter((entry: any) =>
          account.investProductType === "wealth"
            ? entry.wealthProductId === selectedFundCode
            : entry.fundCode === selectedFundCode
        );

    // Fee rates
    const feeRateRecords = await prisma.fundFeeRate.findMany({
      where: { accountId },
      orderBy: { effectiveDate: "desc" },
    });
    const feeRateMap: Record<string, string> = {};
    for (const fr of feeRateRecords) {
      const key = `${fr.fundCode}:${fr.feeType}`;
      if (!(key in feeRateMap)) feeRateMap[key] = String(fr.rate);
    }

    // Confirm days
    const confirmDaysRecords = await prisma.fundConfirmDays.findMany({
      where: { accountId },
    });
    const confirmDaysMap: Record<string, number> = {};
    for (const cd of confirmDaysRecords) {
      confirmDaysMap[cd.fundCode] = cd.days ?? 0;
    }

    // Pending by code
    const pendingByCode: Record<string, number> = {};
    for (const p of positionDisplay.positions) {
      if (p.pendingCost > 0) {
        pendingByCode[p.fundCode] = p.pendingCost;
      }
    }

    // Sort positions
    const sortedPositions = [...positionDisplay.positions].sort((a, b) => b.marketValue - a.marketValue);
    const sortedCleared = [...positionDisplay.clearedPositions].sort((a, b) => b.clearedDate.localeCompare(a.clearedDate));
    const totalMarketValue = sortedPositions.reduce((sum, p) => sum + p.marketValue, 0);
    const totalCost = sortedPositions.reduce((sum, p) => sum + p.cost, 0);
    const positionHistoricalProfit = sortedPositions.reduce((sum, p) => sum + p.historicalProfit, 0);
    const clearedHistoricalProfit = sortedCleared.reduce((sum, p) => sum + p.historicalProfit, 0);
    const totalHistoricalProfit = positionHistoricalProfit + clearedHistoricalProfit;

    return NextResponse.json({
      ok: true,
      positions: sortedPositions,
      clearedPositions: sortedCleared,
      allEntries: fundEntries,
      entryScope,
      selectedFundCode,
      selectedWealthProductId: account.investProductType === "wealth" ? selectedFundCode : "",
      totalMarketValue,
      totalCost,
      positionHistoricalProfit,
      clearedHistoricalProfit,
      totalHistoricalProfit,
      confirmDaysMap,
      feeRateMap,
      pendingByCode,
    });
  } catch (e) {
    console.error("[fund/shell-data]", e);
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "获取数据失败" }, { status: 500 });
  }
}
