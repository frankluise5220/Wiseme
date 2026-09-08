import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { addWorkdaysUtc, isWithinRecentTradingDaysUtc } from "@/lib/date-utils";
import { getFundNav, getLatestFundNav, refreshLatestFundNav, setFundNav } from "@/lib/fund/navCache";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { ensureFundTransactionCashFlowLinks, findFundTransactionForEntryId } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * GET /api/v1/fund/nav?code=&date=&accountId=&purpose=&applyDate=
 * - Returns the exact requested NAV when available.
 * - For recent buy applications (`purpose=buy`), a NAV from another date is
 *   rejected so the client can leave NAV and units empty for startup retry.
 * POST { entryId, date?, confirmDate?, amount?, fee? } backfills a fund entry.
 * PUT { fundCode, date, nav } writes a manual NAV cache record.
 */

const toNum = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function getNav(fundCode: string, dateStr: string, accountId?: string) {
  const navDate = utcDate(dateStr);
  const cached = await getFundNav(fundCode, navDate, accountId);
  if (cached) {
    return {
      date: cached.actualDate ?? dateStr,
      nav: cached.nav,
      cumNav: cached.cumNav ?? undefined,
      name: cached.name ?? undefined,
    };
  }
  // If the requested date is in the future or not a trading day, the historical NAV may be missing.
  // Fall back to the cached or latest NAV so the redeem UI does not treat this as a failed call;
  // the returned date shows the actual NAV date.
  const latest = await getLatestFundNav(fundCode);
  if (latest) {
    return {
      date: latest.navDate.toISOString().slice(0, 10),
      nav: latest.nav,
      cumNav: latest.cumNav ?? undefined,
      name: latest.name ?? undefined,
    };
  }
  return null;
}

/*
async function fetchNavFromEastmoney(fundCode: string, date?: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: `http://fundf10.eastmoney.com/jjjz_${fundCode}.html`,
  };

  if (date) {
    // Query with the exact date first
    const exactUrl = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=5&startDate=${date}&endDate=${date}`;
    const exactRes = await fetch(exactUrl, { headers, cache: "no-store" });
    let json: any = null;
    try { json = await exactRes.json(); } catch { ignore }
    const list: { FSRQ: string; DWJZ: string; LJJZ: string }[] =
      json?.Data?.LSJZList ?? [];
    if (list.length > 0) {
      return { date: list[0]!.FSRQ, nav: parseFloat(list[0]!.DWJZ), cumNav: parseFloat(list[0]!.LJJZ) };
    }

    // No data for the exact date (non-trading day); widen the search to the surrounding 30 days
    const target = new Date(date + "T00:00:00Z");
    const startDate = new Date(target.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = new Date(target.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const rangeUrl = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=50&startDate=${startDate}&endDate=${endDate}`;
    const rangeRes = await fetch(rangeUrl, { headers, cache: "no-store" });
    let rangeJson: any = null;
    try { rangeJson = await rangeRes.json(); } catch { return null; }
    const rangeList: { FSRQ: string; DWJZ: string; LJJZ: string }[] =
      rangeJson?.Data?.LSJZList ?? [];
    if (rangeList.length === 0) return null;

    // Sort by date descending and find the nearest trading-day NAV on or before the target date
    const sorted = rangeList
      .map((item: any) => ({ ...item, _t: new Date(item.FSRQ + "T00:00:00Z").getTime() }))
      .sort((a: any, b: any) => b._t - a._t);
    const targetTime = target.getTime();
    for (const item of sorted) {
      if (item._t <= targetTime) {
        return { date: item.FSRQ, nav: parseFloat(item.DWJZ), cumNav: parseFloat(item.LJJZ) };
      }
    }
    // No NAV on or before the target date; return the latest one
    const latest = sorted[0];
    return latest ? { date: latest.FSRQ, nav: parseFloat(latest.DWJZ), cumNav: parseFloat(latest.LJJZ) } : null;
  }

  const url = `http://fundgz.1234567.com.cn/js/${fundCode}.js?rt=${Date.now()}`;
  const res = await fetch(url, { headers, cache: "no-store" });
  const text = await res.text();
  const m = text.match(/\{.+\}/);
  if (!m) return null;
  let data: any;
  try { data = JSON.parse(m[0]); } catch { return null; }
  if (!data?.dwjz) return null;
  return {
    date: data.jzrq as string,
    nav: parseFloat(data.dwjz),
    cumNav: parseFloat(data.dwjz),
    name: data.name as string,
    estimatedNav: parseFloat(data.gsz),
    estimatedTime: data.gztime as string,
  };
}

*/
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fundCode = searchParams.get("code")?.trim();
  const date = searchParams.get("date")?.trim();
  const accountId = searchParams.get("accountId")?.trim() || undefined;
  const purpose = searchParams.get("purpose")?.trim();
  const applyDate = searchParams.get("applyDate")?.trim();

  if (!fundCode) {
    return NextResponse.json({ ok: false, code: "FUND_CODE_REQUIRED", error: "缺少基金代码" }, { status: 400 });
  }

  try {
    if (date) {
      const account = accountId
        ? await prisma.account.findUnique({ where: { id: accountId }, select: { tradingCalendar: true } })
        : null;
      const recentBuyWithoutExactNav = purpose === "buy" && !!applyDate && isWithinRecentTradingDaysUtc(
        applyDate,
        new Date().toISOString().slice(0, 10),
        2,
        account?.tradingCalendar ?? "cn_fund",
      );
      // Use getNav() (cache -> Eastmoney -> latest NAV fallback chain) so missing data for
      // future dates or non-trading days does not error directly
      const data = await getNav(fundCode, date, accountId);
      if (!data) {
        return NextResponse.json({ ok: false, code: "NAV_NOT_FOUND", error: `未找到基金代码 ${fundCode} 的净值，请确认代码是否正确` }, { status: 404 });
      }
      if (recentBuyWithoutExactNav && data.date !== date) {
        return NextResponse.json(
          { ok: false, code: "EXACT_NAV_UNAVAILABLE", error: "Exact NAV is not available yet; buy units were not calculated." },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, ...data });
    }

    // Without a date: query the real-time estimate
    const latest = await refreshLatestFundNav(fundCode, accountId);
    if (!latest) {
      return NextResponse.json({ ok: false, code: "NAV_NOT_FOUND", error: `未找到基金代码 ${fundCode} 的净值，请确认代码是否正确` }, { status: 404 });
    }
    const navDateStr = latest.navDate.toISOString().slice(0, 10);
    return NextResponse.json({
      ok: true,
      date: navDateStr,
      nav: latest.nav,
      cumNav: latest.cumNav ?? undefined,
      name: latest.name ?? undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}

/**
 * Backfills the fund NAV (queries the NAV, calculates the fee and units, and writes FundTransaction)
 *
 * POST { entryId: string, date?: string, confirmDays?: number, amount?: number, fee?: number }
 *   entryId can be a FundTransaction.id or the linked cash TxRecord.id
 *   Returns { ok: true, nav, units, confirmDate, fee } or { ok: false, error }
 *
 * Automatically looks up the fee rate from the fee-rate store, calculates the fee and units,
 * and writes the fund business transaction table.
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const entryId = String(body.entryId ?? "").trim();
    if (!entryId) return NextResponse.json({ ok: false, code: "ENTRY_ID_REQUIRED", error: "缺少 entryId" }, { status: 400 });

    const fundTransaction = await findFundTransactionForEntryId(prisma, { id: entryId, householdId });
    if (!fundTransaction || fundTransaction.deletedAt) {
      return NextResponse.json({ ok: false, code: "NOT_FUND_TRANSACTION", error: "该记录不是基金交易" }, { status: 400 });
    }

    const fundCode = fundTransaction.fundCode;
    if (!fundCode) return NextResponse.json({ ok: false, code: "FUND_CODE_MISSING", error: "该记录无基金代码" }, { status: 400 });

    // Prefer the user-supplied application date; otherwise use the date from the database
    const userDate = body.date ? String(body.date) : null;
    const applyDate = userDate ?? fundTransaction.applyDate.toISOString().slice(0, 10);
    const accountId = fundTransaction.fundAccountId;
    const userConfirmDate = body.confirmDate ? String(body.confirmDate) : null;

    let confirmDate: string;
    let confirmDateObj: Date;
    if (userConfirmDate) {
      confirmDate = userConfirmDate;
      confirmDateObj = utcDate(confirmDate);
    } else {
      // Query the confirm days from the confirm-days store (using the unified module)
      const confirmDays = await getFundConfirmDays(accountId, fundCode);
      confirmDate = addWorkdaysUtc(applyDate, confirmDays);
      confirmDateObj = utcDate(confirmDate);
    }

    const navData = await getNav(fundCode, confirmDate, accountId);
    if (!navData) {
      return NextResponse.json({ ok: false, code: "NAV_NOT_FOUND", error: `未找到 ${confirmDate} 的净值，可能是非交易日` }, { status: 404 });
    }
    if (navData.date && navData.date !== confirmDate) {
      return NextResponse.json(
        { ok: false, code: "EXACT_NAV_UNAVAILABLE", error: `${confirmDate} 没有精确净值，最新可用净值日期是 ${navData.date}，未写入份额` },
        { status: 404 }
      );
    }

    const nav = navData.nav;
    // Prefer the user-supplied amount; otherwise use the value from the database
    const userAmount = body.amount ? parseFloat(String(body.amount)) : null;
    const amount = Math.abs(userAmount ?? toNum(fundTransaction.grossAmount));

    // Query the fee rate from the fee-rate store (by confirm date)
    const feeType = (fundTransaction.fundSubtype === "redeem" || fundTransaction.fundSubtype === "switch_out") ? "redeem" : "buy";
    const feeRateRaw = await getFundFeeRateByDate(accountId, fundCode, confirmDateObj, feeType);
    const feeRate = feeRateRaw / 100;
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(accountId);
    const refundAmount = fundTransaction.fundSubtype === "buy" ? Math.abs(toNum(fundTransaction.refundAmount)) : 0;
    const confirmedAmount = fundTransaction.fundSubtype === "buy" ? Math.max(0, amount - refundAmount) : amount;
    const userFee = body.fee != null && String(body.fee).trim() !== "" ? parseFloat(String(body.fee)) : null;
    const fee = userFee != null && Number.isFinite(userFee) ? Math.max(0, userFee) : confirmedAmount * feeRate;
    let units: number | null = null;
    if (fundTransaction.fundSubtype === "redeem" || fundTransaction.fundSubtype === "switch_out") {
      const divisor = nav * (1 - feeRate);
      units = divisor > 0 ? roundFundUnits(amount / divisor, fundUnitsDecimals) : null;
    } else {
      units = calculateConfirmedBuyUnits({
        grossAmount: amount,
        refundAmount,
        fee,
        nav,
        roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
      });
    }

    const updateData: {
      nav: number;
      confirmDate: Date;
      fee: number;
      units?: number;
      fundName?: string;
    } = {
      nav,
      confirmDate: confirmDateObj,
      fee,
    };
    if (units != null) {
      updateData.units = units;
    }
    if (navData.name) {
      updateData.fundName = navData.name;
    }

    await prisma.$transaction(async (tx) => {
      await tx.fundTransaction.update({
        where: { id: fundTransaction.id },
        data: updateData,
      });
      await ensureFundTransactionCashFlowLinks(tx, [fundTransaction.id]);
    });

    // Recalculate positions
    await recalcFundPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    // Client-side handles page refresh

    return NextResponse.json({
      ok: true,
      nav,
      units,
      fee,
      confirmDate,
      name: navData.name,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "BACKFILL_FAILED", error: e instanceof Error ? e.message : "补填失败" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const fundCode = String(body.fundCode ?? "").trim();
    const date = String(body.date ?? "").trim();
    const nav = parseFloat(String(body.nav ?? ""));
    if (!fundCode || !date || !Number.isFinite(nav) || nav <= 0) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMETERS", error: "缺少参数" }, { status: 400 });
    }
    await setFundNav(fundCode, new Date(date+"T00:00:00Z"), nav);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "SAVE_FAILED", error: e instanceof Error ? e.message : "保存失败" }, { status: 500 });
  }
}
