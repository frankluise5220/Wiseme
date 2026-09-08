import { NextRequest, NextResponse } from "next/server";
import { FundCashFlowKind, FundProductType, FundSubtype } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { addWorkdaysUtc, isWithinRecentTradingDaysUtc } from "@/lib/date-utils";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundNav, getFundNavFromCacheOnly, refreshHeldFundLatestNavs } from "@/lib/fund/navCache";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { ensureFundTransactionCashFlowLinks } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * POST /api/v1/fund/refresh
 *
 * Refreshes the current fund view for one fund account. It fills exact NAVs
 * already present in the cache regardless of age, fetches missing exact NAVs
 * only for confirmation dates within today or the previous three trading days,
 * skips older cache misses for manual backfill, recalculates affected holdings,
 * and refreshes the latest available NAV for current holdings.
 *
 * Body: { accountId: string, symbols?: string[] }
 * `symbols` is accepted for client compatibility and does not expand the
 * refresh scope beyond the selected account's current holdings.
 */

const toNum = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function refundAmountOf(row: {
  refundAmount: unknown;
  cashFlows: Array<{ kind: FundCashFlowKind; amount: unknown }>;
}) {
  const byRow = Math.abs(toNum(row.refundAmount));
  const byFlows = row.cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(toNum(flow.amount)), 0);
  return Math.max(byRow, byFlows);
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少 accountId" }, { status: 400 });

    let entryFilled = 0;
    let entryFailed = 0;
    let entryNavFilled = 0;
    let entryDeferred = 0;
    const syncedEntryIds: string[] = [];

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId },
      select: { tradingCalendar: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "基金账户不存在" }, { status: 404 });
    }

    const fundUnitsDecimals = await getAccountFundUnitsDecimals(accountId);

    // Query unconfirmed fund transactions directly from FundTransaction.
    const unconfirmedEntries = await prisma.fundTransaction.findMany({
      where: {
        householdId,
        fundAccountId: accountId,
        deletedAt: null,
        fundProductType: { in: [FundProductType.fund, FundProductType.money] },
        OR: [
          { nav: null },
          { units: null },
          { units: { lte: 0 } },
        ],
        fundSubtype: { in: [FundSubtype.buy, FundSubtype.redeem, FundSubtype.switch_out] },
      },
      include: { cashFlows: true },
      orderBy: { createdAt: "asc" },
    });

    const now = new Date();
    const todayDate = now.toISOString().slice(0, 10);

    for (const entry of unconfirmedEntries) {
      if (!entry.fundCode) continue;
      try {
        const applyDate = entry.applyDate.toISOString().slice(0, 10);
        const confirmDays = entry.confirmDate ? null : await getFundConfirmDays(accountId, entry.fundCode);
        const confirmDate = entry.confirmDate
          ? entry.confirmDate.toISOString().slice(0, 10)
          : addWorkdaysUtc(applyDate, confirmDays ?? 0);
        if (confirmDate < applyDate) logger.warn(`confirmDate ${confirmDate} < applyDate ${applyDate}, confirmDays=${confirmDays}`, "fund/refresh");

        // Existing exact cache data is valid regardless of age. Only query the
        // external API for recent confirmation dates; older misses are manual.
        const cachedNav = await getFundNavFromCacheOnly(entry.fundCode, utcDate(confirmDate));
        let navData: { nav: number; cumNav: number | null; name: string | null; dateMatch: boolean; actualDate?: string } | null = cachedNav
          ? { ...cachedNav, dateMatch: true, actualDate: confirmDate }
          : null;
        const isRecentConfirmation = isWithinRecentTradingDaysUtc(
          confirmDate,
          todayDate,
          3,
          account.tradingCalendar ?? "cn_fund",
        );
        if (!navData && isRecentConfirmation) {
          navData = await getFundNav(entry.fundCode, utcDate(confirmDate), accountId);
        }

        const hasExactNav = !!navData && navData.dateMatch;
        if (!hasExactNav || !navData || !(navData.nav > 0)) {
          entryDeferred++;
          continue;
        }

        const actualConfirmDate = utcDate(confirmDate);

        // Determine fee type based on fundSubtype (buy vs redeem/switch_out)
        const feeType = (entry.fundSubtype === FundSubtype.redeem || entry.fundSubtype === FundSubtype.switch_out)
          ? "redeem"
          : "buy";
        const feeRateRaw = await getFundFeeRateByDate(accountId, entry.fundCode, actualConfirmDate, feeType);
        const feeRate = feeRateRaw / 100;

        const amount = Math.abs(toNum(entry.grossAmount));
        const isBuyEntry = entry.fundSubtype === FundSubtype.buy;
        const refundAmount = isBuyEntry ? refundAmountOf(entry) : 0;
        const confirmedAmount = isBuyEntry ? Math.max(0, amount - refundAmount) : amount;
        const fee = confirmedAmount * feeRate;

        let units: number | null = null;
        if (entry.fundSubtype === FundSubtype.redeem || entry.fundSubtype === FundSubtype.switch_out) {
          // Redeem: received = units * nav * (1 - feeRate) => units = received / (nav * (1 - feeRate))
          const divisor = navData.nav * (1 - feeRate);
          units = divisor > 0 ? roundFundUnits(amount / divisor, fundUnitsDecimals) : null;
        } else {
          units = calculateConfirmedBuyUnits({
            grossAmount: amount,
            refundAmount,
            fee,
            nav: navData.nav,
            roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
          });
        }

        // Update FundTransaction: write NAV, confirm date, fee, and units.
        const updateData: {
          nav?: number;
          confirmDate: Date;
          fee: number;
          units?: number;
          fundName?: string;
        } = {
          confirmDate: actualConfirmDate,
          fee,
        };
        if (hasExactNav && navData) {
          updateData.nav = navData.nav;
          if (navData.name) {
            updateData.fundName = navData.name;
          }
        }
        if (units != null && Number.isFinite(units) && units > 0) {
          updateData.units = units;
        }

        await prisma.fundTransaction.update({
          where: { id: entry.id },
          data: updateData,
        });
        syncedEntryIds.push(entry.id);
        entryFilled++;
        if (hasExactNav) entryNavFilled++;
      } catch {
        entryFailed++;
      }
    }

    if (entryFilled > 0) {
      await ensureFundTransactionCashFlowLinks(prisma, syncedEntryIds);
      await recalcFundPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    const heldNavResult = await refreshHeldFundLatestNavs({ accountId });

    // Client-side handles page refresh

    return NextResponse.json({
      ok: true,
      entryFilled,
      entryNavFilled,
      entryFailed,
      entryDeferred,
      holdingNavChecked: heldNavResult.checked,
      holdingNavRefreshed: heldNavResult.latestNavAvailable,
      holdingNavFailed: heldNavResult.failed,
      nameFixed: heldNavResult.nameFixed,
      message: `补填确认净值 ${entryFilled} 笔${entryFailed > 0 ? `，${entryFailed} 笔失败` : ""}${heldNavResult.nameFixed > 0 ? `，修正名称 ${heldNavResult.nameFixed} 个` : ""}`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "REFRESH_FAILED", error: e instanceof Error ? e.message : "刷新失败" },
      { status: 500 }
    );
  }
}
