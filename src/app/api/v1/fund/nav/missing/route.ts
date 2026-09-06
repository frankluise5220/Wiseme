import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { isTradingClosedDate } from "@/lib/date-utils";
import { fundTradingCalendarForProfile, getFundProfiles } from "@/lib/fund/fundProfile";
import { refreshFundNavCacheRanges, type FundNavCacheRangeRequest } from "@/lib/fund/navCache";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

/**
 * POST /api/v1/fund/nav/missing
 *
 * Backfills historical NAV cache entries for fund codes already held in the
 * current household. Mainly used by the investment income report when a held
 * fund is missing a trading-day NAV.
 *
 * Body:
 *   { items: [{ fundCode, date, accountId? }] }
 *   or { ranges: [{ fundCode, startDate, endDate }] }
 *
 * Success:
 *   { ok: true, requested, rangeCount, fundCount, fetched, written, failed, ranges, skippedClosed }
 */
type MissingNavItem = {
  fundCode?: unknown;
  date?: unknown;
  accountId?: unknown;
};

type MissingNavRange = {
  fundCode?: unknown;
  startDate?: unknown;
  endDate?: unknown;
};

type NormalizedMissingNavRequest = FundNavCacheRangeRequest & {
  accountId?: string;
};

function cleanYmd(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function cleanFundCode(value: unknown) {
  return String(value ?? "").trim().replace(/\D/g, "").slice(0, 12);
}

function cleanOptionalId(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 128) : undefined;
}

function utcDate(dateStr: string) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function requestKey(item: Pick<FundNavCacheRangeRequest, "fundCode" | "startDate">) {
  return `${item.fundCode}|${item.startDate}`;
}

function normalizeRequests(body: { items?: MissingNavItem[]; ranges?: MissingNavRange[] }) {
  const requests: NormalizedMissingNavRequest[] = [];
  for (const item of Array.isArray(body.items) ? body.items : []) {
    const fundCode = cleanFundCode(item.fundCode);
    const date = cleanYmd(item.date);
    if (fundCode && date) requests.push({ fundCode, startDate: date, endDate: date, accountId: cleanOptionalId(item.accountId) });
  }
  for (const range of Array.isArray(body.ranges) ? body.ranges : []) {
    const fundCode = cleanFundCode(range.fundCode);
    const startDate = cleanYmd(range.startDate);
    const endDate = cleanYmd(range.endDate);
    if (fundCode && startDate && endDate) requests.push({ fundCode, startDate, endDate });
  }
  return requests.slice(0, 1000);
}

function isExactRequest(request: FundNavCacheRangeRequest) {
  return request.startDate === request.endDate;
}

async function filterClosedExactRequests(requests: NormalizedMissingNavRequest[], accountWhereScope: object) {
  const exactRequests = requests.filter(isExactRequest);
  if (exactRequests.length === 0) return { requests, skippedClosed: 0 };

  const accountIds = Array.from(new Set(exactRequests.map((item) => item.accountId).filter(Boolean) as string[]));
  const fundCodes = Array.from(new Set(exactRequests.map((item) => item.fundCode)));
  const [accounts, profiles] = await Promise.all([
    accountIds.length
      ? prisma.account.findMany({
          where: { ...accountWhereScope, id: { in: accountIds } },
          select: { id: true, tradingCalendar: true },
        })
      : [],
    getFundProfiles(fundCodes),
  ]);
  const accountCalendarById = new Map<string, string>(
    accounts.map((account): [string, string] => [account.id, account.tradingCalendar ?? "cn_fund"]),
  );
  const profileCalendarByCode = new Map<string, string>(
    profiles.map((profile): [string, string] => [profile.fundCode, fundTradingCalendarForProfile(profile)]),
  );
  let skippedClosed = 0;
  const filtered = requests.filter((request) => {
    if (!isExactRequest(request)) return true;
    const profileCalendar = profileCalendarByCode.get(request.fundCode);
    const accountCalendar = request.accountId ? accountCalendarById.get(request.accountId) : null;
    const calendar = profileCalendar && profileCalendar !== "cn_fund"
      ? profileCalendar
      : (accountCalendar ?? "cn_fund");
    if (!isTradingClosedDate(request.startDate, calendar)) return true;
    skippedClosed++;
    return false;
  });
  return { requests: filtered, skippedClosed };
}

async function resolveExactRequestStatus(requests: NormalizedMissingNavRequest[]) {
  const exactRequests = requests.filter((item) => item.startDate === item.endDate);
  if (exactRequests.length === 0) return { resolvedItems: [], unresolvedItems: [] };

  const requestByKey = new Map<string, NormalizedMissingNavRequest>();
  for (const request of exactRequests) {
    requestByKey.set(requestKey(request), request);
  }

  const datesByCode = new Map<string, Set<string>>();
  for (const request of requestByKey.values()) {
    const dates = datesByCode.get(request.fundCode) ?? new Set<string>();
    dates.add(request.startDate);
    datesByCode.set(request.fundCode, dates);
  }

  const cachedRows = await prisma.fundNavCache.findMany({
    where: {
      OR: Array.from(datesByCode.entries()).map(([fundCode, dates]) => ({
        fundCode,
        navDate: { in: Array.from(dates).map(utcDate) },
      })),
    },
    select: { fundCode: true, navDate: true },
  });

  const resolvedKeys = new Set(cachedRows.map((row) => `${row.fundCode}|${ymd(row.navDate)}`));
  const resolvedItems: MissingNavItem[] = [];
  const unresolvedItems: MissingNavItem[] = [];
  for (const request of requestByKey.values()) {
    const item = { fundCode: request.fundCode, date: request.startDate, accountId: request.accountId };
    if (resolvedKeys.has(requestKey(request))) resolvedItems.push(item);
    else unresolvedItems.push(item);
  }

  return { resolvedItems, unresolvedItems };
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const requests = normalizeRequests(body);
    if (requests.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_NAV_DATES", error: "Missing fund NAV dates." }, { status: 400 });
    }

    const requestedCodes = Array.from(new Set(requests.map((item) => item.fundCode)));
    const [txCodes, holdingCodes, fundTransactionCodes] = await Promise.all([
      prisma.txRecord.findMany({
        where: {
          ...ctx.hidFilter,
          deletedAt: null,
          type: TransactionType.investment,
          fundCode: { in: requestedCodes },
        },
        select: { fundCode: true },
        distinct: ["fundCode"],
      }),
      prisma.fundHolding.findMany({
        where: {
          fundCode: { in: requestedCodes },
          Account: { ...ctx.hidFilter },
        },
        select: { fundCode: true },
        distinct: ["fundCode"],
      }),
      prisma.fundTransaction.findMany({
        where: {
          householdId: ctx.householdId,
          deletedAt: null,
          fundCode: { in: requestedCodes },
        },
        select: { fundCode: true },
        distinct: ["fundCode"],
      }),
    ]);
    const allowedCodes = new Set(
      [...txCodes, ...holdingCodes, ...fundTransactionCodes]
        .map((row) => row.fundCode?.trim())
        .filter((code): code is string => Boolean(code)),
    );
    const allowedRequests = requests.filter((item) => allowedCodes.has(item.fundCode));
    if (allowedRequests.length === 0) {
      return NextResponse.json({ ok: false, code: "NO_ELIGIBLE_FUND_CODES", error: "No eligible fund codes in current ledger." }, { status: 403 });
    }

    const filtered = await filterClosedExactRequests(allowedRequests, ctx.hidFilter);
    if (filtered.requests.length === 0) {
      return NextResponse.json({
        ok: true,
        requested: allowedRequests.length,
        rangeCount: 0,
        fundCount: 0,
        fetched: 0,
        written: 0,
        failed: 0,
        ranges: [],
        resolvedItems: [],
        unresolvedItems: [],
        resolved: 0,
        unresolved: 0,
        skipped: requests.length - allowedRequests.length,
        skippedClosed: filtered.skippedClosed,
      });
    }

    const result = await refreshFundNavCacheRanges(filtered.requests);
    const exactStatus = await resolveExactRequestStatus(filtered.requests);
    console.info("[fund-nav-missing] refresh result", {
      requested: requests.length,
      allowed: allowedRequests.length,
      tradingDays: filtered.requests.length,
      rangeCount: result.rangeCount,
      fundCount: result.fundCount,
      fetched: result.fetched,
      written: result.written,
      failed: result.failed,
      resolved: exactStatus.resolvedItems.length,
      unresolved: exactStatus.unresolvedItems.length,
      skipped: requests.length - allowedRequests.length,
      skippedClosed: filtered.skippedClosed,
    });
    if (result.written > 0) {
      revalidateAfterInvestChange();
      revalidatePath("/reports");
    }

    return NextResponse.json({
      ok: true,
      ...result,
      requested: allowedRequests.length,
      ...exactStatus,
      resolved: exactStatus.resolvedItems.length,
      unresolved: exactStatus.unresolvedItems.length,
      skipped: requests.length - allowedRequests.length,
      skippedClosed: filtered.skippedClosed,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Failed to fetch missing NAVs." },
      { status: 500 },
    );
  }
}
