import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  getFundNavDateOffsets,
  getFundProfiles,
  ensureFundCompanyInstitution,
  fundTradingCalendarForProfile,
  getFundProfile,
  normalizeFundTradingCalendar,
  refreshFundProfile,
  syncFundCompanyInstitution,
  updateFundProfile,
} from "@/lib/fund/fundProfile";
import { TRADING_CALENDARS, type TradingCalendarValue } from "@/lib/fund/trading-calendar";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * Fund-level NAV date offset configuration.
 *
 * GET /api/v1/fund/profile?fundCode=110000[&syncInstitution=0]
 * GET /api/v1/fund/profile?list=1[&includeProfiles=1]
 * PATCH /api/v1/fund/profile
 * PATCH body: { fundCode: string, fundName?, fundCompany?, custodian?, manager?, navDateOffset?: 0 | 1, tradingCalendar? }
 * POST /api/v1/fund/profile
 * POST body: { fundCode: string, syncInstitution?: boolean }
 *
 * navDateOffset is the stable fund-level offset used by the daily investment
 * profit report: 0 means report-date NAV minus previous NAV, and 1 means the
 * previous trading-day NAV minus the NAV before it. External profile refreshes
 * must not overwrite this setting. tradingCalendar is the fund-level NAV
 * calendar used to decide which dates can legitimately have an external NAV.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const { searchParams } = new URL(req.url);
    const fundCode = searchParams.get("fundCode")?.trim();
    const list = searchParams.get("list") === "1";
    const includeProfiles = searchParams.get("includeProfiles") === "1";
    const syncInstitution = searchParams.get("syncInstitution") !== "0";
    if (!fundCode && !list) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "fundCode or list=1 is required." }, { status: 400 });
    }
    if (fundCode && !/^\d{6}$/.test(fundCode)) {
      return NextResponse.json({ ok: false, code: "INVALID_FUND_CODE", error: "fundCode must be a six-digit fund code." }, { status: 400 });
    }
    const householdCodes = await fundCodesInHousehold(ctx.householdId);
    if (fundCode && !householdCodes.includes(fundCode)) {
      return NextResponse.json({ ok: false, code: "FUND_NOT_FOUND", error: "Fund is not available in the current household." }, { status: 404 });
    }
    const codes = fundCode ? [fundCode] : householdCodes;
    const [offsets, profiles] = await Promise.all([
      getFundNavDateOffsets(codes),
      getFundProfiles(codes),
    ]);
    const profileByCode = new Map(profiles.map((profile) => [profile.fundCode, profile]));
    if (fundCode) {
      let profile = profileByCode.get(fundCode) ?? null;
      if (!profile) profile = await getFundProfile(fundCode);
      if (profile && syncInstitution) await syncFundCompanyInstitution(profile, { householdId: ctx.householdId });
      return NextResponse.json({
        ok: true,
        fundCode,
        profile: profile
          ? { ...profile, tradingCalendar: fundTradingCalendarForProfile(profile) }
          : { fundCode, navDateOffset: offsets.get(fundCode) ?? 0, tradingCalendar: "cn_fund" },
      });
    }
    const sortedCodes = [...codes].sort();
    const rows = sortedCodes.map((code) => {
      const profile = profileByCode.get(code);
      return {
        fundCode: code,
        navDateOffset: offsets.get(code) ?? 0,
        tradingCalendar: fundTradingCalendarForProfile(profile),
      };
    });
    if (!includeProfiles) return NextResponse.json({ ok: true, rows });
    return NextResponse.json({
      ok: true,
      rows,
      profiles: profiles.map((profile) => ({ ...profile, tradingCalendar: fundTradingCalendarForProfile(profile) })),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Failed to fetch fund profiles." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json() as {
      fundCode?: unknown;
      fundName?: unknown;
      fundCompany?: unknown;
      custodian?: unknown;
      manager?: unknown;
      navDateOffset?: unknown;
      tradingCalendar?: unknown;
    };
    const fundCode = typeof body.fundCode === "string" ? body.fundCode.trim() : "";
    const offset = body.navDateOffset;
    if (!/^\d{6}$/.test(fundCode)) {
      return NextResponse.json({ ok: false, code: "INVALID_FUND_CODE", error: "fundCode must be a six-digit fund code." }, { status: 400 });
    }
    if (offset !== undefined && offset !== 0 && offset !== 1) {
      return NextResponse.json({ ok: false, code: "INVALID_NAV_DATE_OFFSET", error: "navDateOffset must be 0 or 1." }, { status: 400 });
    }
    let tradingCalendar: TradingCalendarValue | null | undefined;
    if (body.tradingCalendar !== undefined) {
      if (body.tradingCalendar === null || body.tradingCalendar === "") {
        tradingCalendar = null;
      } else if (typeof body.tradingCalendar === "string" && TRADING_CALENDARS.includes(body.tradingCalendar as TradingCalendarValue)) {
        tradingCalendar = normalizeFundTradingCalendar(body.tradingCalendar, "cn_fund");
      } else {
        return NextResponse.json({ ok: false, code: "INVALID_TRADING_CALENDAR", error: "tradingCalendar is invalid." }, { status: 400 });
      }
    }
    const fundCodes = await fundCodesInHousehold(ctx.householdId);
    if (!fundCodes.includes(fundCode)) {
      return NextResponse.json({ ok: false, code: "FUND_NOT_FOUND", error: "Fund is not available in the current household." }, { status: 404 });
    }
    const parseText = (value: unknown, field: string) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      if (typeof value !== "string") throw new Error(`${field} must be a string or null.`);
      const trimmed = value.trim();
      return trimmed || null;
    };
    const profile = await updateFundProfile(fundCode, {
      fundName: parseText(body.fundName, "fundName"),
      fundCompany: parseText(body.fundCompany, "fundCompany"),
      custodian: parseText(body.custodian, "custodian"),
      manager: parseText(body.manager, "manager"),
      navDateOffset: offset as 0 | 1 | undefined,
      tradingCalendar,
    });
    await ensureFundCompanyInstitution(ctx.householdId, profile.fundCompany);
    return NextResponse.json({ ok: true, profile });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "Failed to update fund profile." },
      { status: 500 },
    );
  }
}


/**
 * Fetch and persist fund-level profile metadata from the configured external
 * fund data source without changing account-level T+N or fee rules.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json() as { fundCode?: unknown; syncInstitution?: unknown };
    const fundCode = typeof body.fundCode === "string" ? body.fundCode.trim() : "";
    const syncInstitution = body.syncInstitution !== false;
    if (!/^\d{6}$/.test(fundCode)) {
      return NextResponse.json({ ok: false, code: "INVALID_FUND_CODE", error: "fundCode must be a six-digit fund code." }, { status: 400 });
    }
    const householdCodes = await fundCodesInHousehold(ctx.householdId);
    if (!householdCodes.includes(fundCode)) {
      return NextResponse.json({ ok: false, code: "FUND_NOT_FOUND", error: "Fund is not available in the current household." }, { status: 404 });
    }
    const profile = await refreshFundProfile(fundCode, syncInstitution ? { householdId: ctx.householdId } : undefined);
    if (!profile) {
      return NextResponse.json({ ok: false, code: "PROFILE_FETCH_FAILED", error: "Failed to fetch fund profile from the external source." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, profile });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "PROFILE_FETCH_FAILED", error: error instanceof Error ? error.message : "Failed to fetch fund profile." },
      { status: 500 },
    );
  }
}

async function fundCodesInHousehold(householdId: string) {
  const [businessRows, legacyRows] = await Promise.all([
    prisma.fundTransaction.findMany({
      where: { householdId, deletedAt: null },
      select: { fundCode: true },
      distinct: ["fundCode"],
    }),
    prisma.txRecord.findMany({
      where: { householdId, deletedAt: null, fundCode: { not: null } },
      select: { fundCode: true },
      distinct: ["fundCode"],
    }),
  ]);
  return Array.from(new Set([...businessRows, ...legacyRows].map((row) => row.fundCode).filter((code): code is string => !!code && /^\d{6}$/.test(code))));
}
