import { NextResponse } from "next/server";
import { AccountKind, FundCashFlowKind, FundProductType, FundSubtype } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { addWorkdaysUtc, toNumber } from "@/lib/date-utils";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundNav, refreshHeldFundLatestNavs } from "@/lib/fund/navCache";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { ensureFundTransactionCashFlowLinks } from "@/lib/fund/transactions";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { logger } from "@/lib/logger";

/**
 * POST /api/v1/fund/refresh-pending
 *
 * Scans the active household for fund buy rows whose confirmation date has arrived
 * but NAV or confirmed units are still missing, and refreshes latest NAV for all
 * current fund-like holdings. It fills NAV, fee, and units using the canonical
 * rule: units use gross buy amount - linked refund amount - buy fee.
 * Response shape: { ok: true, checked, filled, navFilled, skippedFuture,
 * skippedNoNav, failed, holdingNavChecked, holdingNavRefreshed,
 * holdingNavFailed, nameFixed, entryIds }.
 */
function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function isFundLikeProduct(value: unknown) {
  return value == null || value === FundProductType.fund || value === FundProductType.money;
}

function refundAmountOf(row: {
  refundAmount: unknown;
  cashFlows: Array<{ kind: FundCashFlowKind; amount: unknown }>;
}) {
  const byRow = Math.abs(toNumber(row.refundAmount));
  const byFlows = row.cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(toNumber(flow.amount)), 0);
  return Math.max(byRow, byFlows);
}

export async function POST() {
  try {
    const { householdId } = await getHouseholdScope();
    const todayStr = ymd(new Date());

    const candidateRows = await prisma.fundTransaction.findMany({
      where: {
        householdId,
        deletedAt: null,
        fundProductType: { in: [FundProductType.fund, FundProductType.money] },
        AND: [
          { fundSubtype: FundSubtype.buy },
          {
            OR: [
              { nav: null },
              { units: null },
              { units: { lte: 0 } },
            ],
          },
        ],
      },
      include: { cashFlows: true },
      orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }],
    });
    const heldNavResult = await refreshHeldFundLatestNavs({ householdId });

    if (candidateRows.length === 0) {
      if (heldNavResult.latestNavAvailable > 0 || heldNavResult.nameFixed > 0) {
        revalidateAfterInvestChange();
      }
      return NextResponse.json({
        ok: true,
        checked: 0,
        filled: 0,
        navFilled: 0,
        skippedFuture: 0,
        skippedNoNav: 0,
        failed: 0,
        holdingNavChecked: heldNavResult.checked,
        holdingNavRefreshed: heldNavResult.latestNavAvailable,
        nameFixed: heldNavResult.nameFixed,
        holdingNavFailed: heldNavResult.failed,
      });
    }

    const fundAccountIds = Array.from(new Set(candidateRows.map((row) => row.fundAccountId).filter(Boolean)));
    const accounts = await prisma.account.findMany({
      where: { id: { in: fundAccountIds }, householdId, kind: AccountKind.investment },
      select: { id: true, investProductType: true, fundUnitsDecimals: true },
    });
    const accountById = new Map(accounts.filter((account) => isFundLikeProduct(account.investProductType)).map((account) => [account.id, account]));

    let filled = 0;
    let navFilled = 0;
    let skippedFuture = 0;
    let skippedNoNav = 0;
    let failed = 0;
    const changedEntryIds: string[] = [];
    const recalcByAccount = new Map<string, Set<string>>();

    for (const row of candidateRows) {
      const fundAccountId = row.fundAccountId;
      if (!fundAccountId || !row.fundCode) continue;
      const account = accountById.get(fundAccountId);
      if (!account) continue;

      try {
        const applyDate = ymd(row.applyDate);
        const confirmDateStr = row.confirmDate
          ? ymd(row.confirmDate)
          : addWorkdaysUtc(applyDate, await getFundConfirmDays(fundAccountId, row.fundCode));
        if (confirmDateStr > todayStr) {
          skippedFuture++;
          continue;
        }

        const confirmDate = utcDate(confirmDateStr);
        const navData = await getFundNav(row.fundCode, confirmDate, fundAccountId);
        if (!navData || !navData.dateMatch || !(navData.nav > 0)) {
          skippedNoNav++;
          continue;
        }

        const grossAmount = Math.abs(toNumber(row.grossAmount));
        const refundAmount = refundAmountOf(row);
        const confirmedAmount = Math.max(0, grossAmount - refundAmount);
        const fee = row.fee != null
          ? Math.max(0, toNumber(row.fee))
          : Math.max(0, confirmedAmount * ((await getFundFeeRateByDate(fundAccountId, row.fundCode, confirmDate, "buy")) / 100));
        const fundUnitsDecimals = normalizeFundUnitsDecimals(account.fundUnitsDecimals);
        const units = calculateConfirmedBuyUnits({
          grossAmount,
          refundAmount,
          fee,
          nav: navData.nav,
          roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
        });

        if (units == null || !Number.isFinite(units) || units <= 0) {
          skippedNoNav++;
          continue;
        }

        await prisma.fundTransaction.update({
          where: { id: row.id },
          data: {
            confirmDate,
            nav: navData.nav,
            units,
            fee,
            ...(navData.name ? { fundName: navData.name } : {}),
          },
        });
        changedEntryIds.push(row.id);
        filled++;
        navFilled++;
        if (!recalcByAccount.has(fundAccountId)) recalcByAccount.set(fundAccountId, new Set());
        recalcByAccount.get(fundAccountId)?.add(row.fundCode);
      } catch (error) {
        failed++;
        logger.warn(error instanceof Error ? error.message : String(error), "fund/refresh-pending");
      }
    }

    if (changedEntryIds.length > 0) {
      await ensureFundTransactionCashFlowLinks(prisma, changedEntryIds);
      for (const [accountId, codes] of recalcByAccount) {
        await recalcFundPositions(accountId, Array.from(codes)).catch(logger.catchLog("recalc", "fund/refresh-pending"));
        await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("balance", "fund/refresh-pending"));
      }
    }
    if (changedEntryIds.length > 0 || heldNavResult.latestNavAvailable > 0 || heldNavResult.nameFixed > 0) {
      revalidateAfterInvestChange();
    }

    return NextResponse.json({
      ok: true,
      checked: candidateRows.length,
      filled,
      navFilled,
      skippedFuture,
      skippedNoNav,
      failed,
      holdingNavChecked: heldNavResult.checked,
      holdingNavRefreshed: heldNavResult.latestNavAvailable,
      nameFixed: heldNavResult.nameFixed,
      holdingNavFailed: heldNavResult.failed,
      entryIds: changedEntryIds,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "刷新未确认基金记录失败" }, { status: 500 });
  }
}
