import { Prisma } from "@prisma/client";

import { formatDateUtc, subtractTradingDaysUtc } from "@/lib/date-utils";
import { queryFundProfile, queryFundIdentity } from "@/lib/fund/queryApi";
import { normalizeTradingCalendar, type TradingCalendarValue } from "@/lib/fund/trading-calendar";

/**
 * Fund profile (fund company / custodian / manager) persistence.
 *
 * A fund's profile is a fund-level attribute keyed by fundCode, shared across
 * all accounts and households that hold the same fund. It is stored once per
 * fund code (upsert), so repeated NAV fetches do not duplicate rows.
 */

export type FundProfileRecord = {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number;
  tradingCalendar: TradingCalendarValue | null;
};

export type FundNavDateOffset = 0 | 1;

export type FundProfileUpdate = {
  fundName?: string | null;
  fundCompany?: string | null;
  custodian?: string | null;
  manager?: string | null;
  navDateOffset?: FundNavDateOffset;
  tradingCalendar?: TradingCalendarValue | null;
};

export type FundProfileContext = {
  householdId?: string | null;
};

type FundProfileSqlRow = {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number | bigint | null;
  tradingCalendar: string | null;
};

function normalizeNavDateOffset(value: unknown) {
  const n = Number(value ?? 0);
  return n === 1 ? 1 : 0;
}

function appLocalDateHour(now: Date) {
  const appLocal = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    date: formatDateUtc(appLocal),
    hour: appLocal.getUTCHours(),
  };
}

/** Return the trading calendar used by the fund's latest NAV publication. */
export function fundTradingCalendarForName(name: string | null | undefined) {
  const value = String(name ?? "");
  if (/\u6052\u751F|\u9999\u6E2F|\u6E2F\u80A1|H\u80A1|Hang\s*Seng|Hong\s*Kong/i.test(value)) return "hk_fund";
  if (/\u65E5\u672C|Nikkei|TOPIX|Japan/i.test(value)) return "jp_fund";
  return /QDII|\u6807\u666E|\u7EB3\u65AF\u8FBE\u514B|\u7EB3\u6307|\u9053\u743C\u65AF|\u7F8E\u56FD|\u5168\u7403|S&P|NASDAQ|Dow\s*Jones|United\s*States|USA|US/i.test(value)
    ? "us_fund"
    : "cn_fund";
}

export function normalizeFundTradingCalendar(raw: unknown, fallback?: TradingCalendarValue | null) {
  const value = String(raw ?? "").trim();
  if (!value) return fallback ?? null;
  return normalizeTradingCalendar(value, fallback ?? "cn_fund");
}

export function fundTradingCalendarForProfile(
  profile: Pick<FundProfileRecord, "fundName" | "tradingCalendar"> | null | undefined,
  fallback: TradingCalendarValue = "cn_fund",
) {
  return profile?.tradingCalendar ?? fundTradingCalendarForName(profile?.fundName) ?? fallback;
}

export function fundNavTargetDateForOffset(params: {
  referenceDate: Date | string;
  navDateOffset?: number | null;
  tradingCalendar?: string | null;
  now?: Date;
}) {
  const referenceDate = params.referenceDate instanceof Date
    ? formatDateUtc(params.referenceDate)
    : String(params.referenceDate ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
    throw new Error("referenceDate must be a YYYY-MM-DD date.");
  }
  const nowLocal = appLocalDateHour(params.now ?? new Date());
  const beforePublicationCutoff = referenceDate === nowLocal.date && nowLocal.hour < 19 ? 1 : 0;
  return subtractTradingDaysUtc(
    referenceDate,
    normalizeNavDateOffset(params.navDateOffset) + beforePublicationCutoff,
    params.tradingCalendar ?? "cn_fund",
  );
}

export function latestFundNavTargetDateForOffset(params: {
  navDateOffset?: number | null;
  tradingCalendar?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  return fundNavTargetDateForOffset({
    referenceDate: appLocalDateHour(now).date,
    navDateOffset: params.navDateOffset,
    tradingCalendar: params.tradingCalendar,
    now,
  });
}


function hasFetchedFundProfileData(profile: FundProfileRecord | null) {
  const displayName = profile ? normalizeFundDisplayName(profile.fundCode, profile.fundName) : null;
  return Boolean(
    displayName ||
    profile?.fundCompany?.trim() ||
    profile?.custodian?.trim() ||
    profile?.manager?.trim(),
  );
}

function toFundProfileRecord(row: FundProfileSqlRow): FundProfileRecord {
  return {
    fundCode: row.fundCode,
    fundName: row.fundName,
    fundCompany: row.fundCompany,
    custodian: row.custodian,
    manager: row.manager,
    navDateOffset: normalizeNavDateOffset(row.navDateOffset),
    tradingCalendar: normalizeFundTradingCalendar(row.tradingCalendar),
  };
}

async function getPrismaClient() {
  const { prisma } = await import("@/lib/db/prisma");
  return prisma;
}

/**
 * Ensure a recognized fund company is available as a household institution.
 * FundProfile is shared by fund code, while Institution is household-scoped.
 */
export async function ensureFundCompanyInstitution(
  householdId: string | null | undefined,
  fundCompany: string | null | undefined,
) {
  const name = String(fundCompany ?? "").trim();
  if (!householdId || !name) return null;

  const prisma = await getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.institution.findFirst({
      where: {
        householdId,
        OR: [{ name }, { shortName: name }],
      },
      orderBy: { name: "asc" },
    });
    if (existing) {
      if (existing.type === "fund_company") return existing;
      return tx.institution.update({ where: { id: existing.id }, data: { type: "fund_company" } });
    }

    return tx.institution.create({
      data: {
        name,
        type: "fund_company",
        householdId,
      },
    });
  });
}

export async function syncFundCompanyInstitution(
  profile: FundProfileRecord,
  context?: FundProfileContext,
) {
  if (!context?.householdId || !profile.fundCompany) return;
  try {
    await ensureFundCompanyInstitution(context.householdId, profile.fundCompany);
  } catch (error) {
    console.warn("Failed to sync recognized fund company institution", {
      householdId: context.householdId,
      fundCode: profile.fundCode,
      fundCompany: profile.fundCompany,
      error,
    });
  }
}

let fundProfileTradingCalendarColumn: Promise<boolean> | null = null;

function isSqliteRuntime() {
  const url = String(process.env.DATABASE_URL ?? "");
  return url === ":memory:" || url.startsWith("file:");
}

async function hasFundProfileTradingCalendarColumn() {
  fundProfileTradingCalendarColumn ??= getPrismaClient().then(async (prisma) => {
    if (isSqliteRuntime()) {
      const rows = await prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
        PRAGMA table_info("FundProfile")
      `);
      return rows.some((row) => row.name === "tradingCalendar");
    }

    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'FundProfile'
          AND column_name = 'tradingCalendar'
      ) AS "exists"
    `);
    return Boolean(rows[0]?.exists);
  });
  return fundProfileTradingCalendarColumn;
}

function fundProfileSelectSql(hasTradingCalendar: boolean) {
  return Prisma.sql`
    SELECT
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      ${hasTradingCalendar ? Prisma.sql`"tradingCalendar"` : Prisma.sql`NULL AS "tradingCalendar"`}
    FROM "FundProfile"
  `;
}

async function readFundProfileRow(fundCode: string) {
  const prisma = await getPrismaClient();
  const selectSql = fundProfileSelectSql(await hasFundProfileTradingCalendarColumn());
  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    ${selectSql}
    WHERE "fundCode" = ${fundCode}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function writeFundProfile(params: {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number;
  tradingCalendar: TradingCalendarValue | null;
}) {
  const prisma = await getPrismaClient();
  if (!(await hasFundProfileTradingCalendarColumn())) {
    const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
      INSERT INTO "FundProfile" (
        "fundCode",
        "fundName",
        "fundCompany",
        "custodian",
        "manager",
        "navDateOffset",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${params.fundCode},
        ${params.fundName},
        ${params.fundCompany},
        ${params.custodian},
        ${params.manager},
        ${params.navDateOffset},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("fundCode") DO UPDATE SET
        "fundName" = EXCLUDED."fundName",
        "fundCompany" = EXCLUDED."fundCompany",
        "custodian" = EXCLUDED."custodian",
        "manager" = EXCLUDED."manager",
        "navDateOffset" = EXCLUDED."navDateOffset",
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING
        "fundCode",
        "fundName",
        "fundCompany",
        "custodian",
        "manager",
        "navDateOffset",
        NULL AS "tradingCalendar"
    `);
    return toFundProfileRecord(rows[0]!);
  }

  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    INSERT INTO "FundProfile" (
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "tradingCalendar",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${params.fundCode},
      ${params.fundName},
      ${params.fundCompany},
      ${params.custodian},
      ${params.manager},
      ${params.navDateOffset},
      ${params.tradingCalendar},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("fundCode") DO UPDATE SET
      "fundName" = EXCLUDED."fundName",
      "fundCompany" = EXCLUDED."fundCompany",
      "custodian" = EXCLUDED."custodian",
      "manager" = EXCLUDED."manager",
      "navDateOffset" = EXCLUDED."navDateOffset",
      "tradingCalendar" = EXCLUDED."tradingCalendar",
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "tradingCalendar"
  `);
  return toFundProfileRecord(rows[0]!);
}

/** Update editable fund-level metadata without changing account-level rules. */
export async function updateFundProfile(fundCode: string, update: FundProfileUpdate) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("fundCode must be a six-digit fund code.");
  if (update.navDateOffset !== undefined && update.navDateOffset !== 0 && update.navDateOffset !== 1) {
    throw new Error("navDateOffset must be 0 or 1.");
  }
  const current = await getFundProfile(code);
  const tradingCalendar = update.tradingCalendar !== undefined
    ? normalizeFundTradingCalendar(update.tradingCalendar)
    : current?.tradingCalendar ?? null;
  return writeFundProfile({
    fundCode: code,
    fundName: update.fundName !== undefined ? update.fundName : current?.fundName ?? null,
    fundCompany: update.fundCompany !== undefined ? update.fundCompany : current?.fundCompany ?? null,
    custodian: update.custodian !== undefined ? update.custodian : current?.custodian ?? null,
    manager: update.manager !== undefined ? update.manager : current?.manager ?? null,
    navDateOffset: update.navDateOffset ?? current?.navDateOffset ?? 0,
    tradingCalendar,
  });
}

async function upsertFetchedFundProfile(params: {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
}) {
  const prisma = await getPrismaClient();
  const tradingCalendar = fundTradingCalendarForName(params.fundName);
  if (!(await hasFundProfileTradingCalendarColumn())) {
    const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
      INSERT INTO "FundProfile" (
        "fundCode",
        "fundName",
        "fundCompany",
        "custodian",
        "manager",
        "navDateOffset",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${params.fundCode},
        ${params.fundName},
        ${params.fundCompany},
        ${params.custodian},
        ${params.manager},
        0,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("fundCode") DO UPDATE SET
        "fundName" = COALESCE(EXCLUDED."fundName", "FundProfile"."fundName"),
        "fundCompany" = COALESCE(EXCLUDED."fundCompany", "FundProfile"."fundCompany"),
        "custodian" = COALESCE(EXCLUDED."custodian", "FundProfile"."custodian"),
        "manager" = COALESCE(EXCLUDED."manager", "FundProfile"."manager"),
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING
        "fundCode",
        "fundName",
        "fundCompany",
        "custodian",
        "manager",
        "navDateOffset",
        NULL AS "tradingCalendar"
    `);
    return toFundProfileRecord(rows[0]!);
  }

  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    INSERT INTO "FundProfile" (
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "tradingCalendar",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${params.fundCode},
      ${params.fundName},
      ${params.fundCompany},
      ${params.custodian},
      ${params.manager},
      0,
      ${tradingCalendar},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("fundCode") DO UPDATE SET
      "fundName" = COALESCE(EXCLUDED."fundName", "FundProfile"."fundName"),
      "fundCompany" = COALESCE(EXCLUDED."fundCompany", "FundProfile"."fundCompany"),
      "custodian" = COALESCE(EXCLUDED."custodian", "FundProfile"."custodian"),
      "manager" = COALESCE(EXCLUDED."manager", "FundProfile"."manager"),
      "tradingCalendar" = COALESCE("FundProfile"."tradingCalendar", EXCLUDED."tradingCalendar"),
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "tradingCalendar"
  `);
  return toFundProfileRecord(rows[0]!);
}

/**
 * Read a fund's profile from the FundProfile table.
 */
export async function getFundProfile(fundCode: string): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  const row = await readFundProfileRow(code);
  return row ? toFundProfileRecord(row) : null;
}

/** Read fund-level profiles for multiple fund codes in one query. */
export async function getFundProfiles(fundCodes: Iterable<string>): Promise<FundProfileRecord[]> {
  const codes = Array.from(new Set(Array.from(fundCodes).map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code))));
  if (codes.length === 0) return [];
  const prisma = await getPrismaClient();
  const selectSql = fundProfileSelectSql(await hasFundProfileTradingCalendarColumn());
  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    ${selectSql}
    WHERE "fundCode" IN (${Prisma.join(codes)})
  `);
  return rows.map(toFundProfileRecord);
}

/** Return a usable display name unless the stored name is blank or just the code. */
export function normalizeFundDisplayName(fundCode: string, fundName: string | null | undefined) {
  const code = fundCode.trim();
  const name = String(fundName ?? "").trim();
  return name && name !== code ? name : null;
}

/** Read authoritative fund names from FundProfile for multiple codes. */
export async function getFundProfileNameMap(fundCodes: Iterable<string>): Promise<Map<string, string>> {
  const profiles = await getFundProfiles(fundCodes);
  const map = new Map<string, string>();
  for (const profile of profiles) {
    const name = normalizeFundDisplayName(profile.fundCode, profile.fundName);
    if (name) map.set(profile.fundCode, name);
  }
  return map;
}

/** Ensure that a valid fund code has a FundProfile row before external lookup. */
export async function ensureFundProfileRecord(fundCode: string): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  const existing = await getFundProfile(code);
  if (existing) return existing;

  const prisma = await getPrismaClient();
  if (!(await hasFundProfileTradingCalendarColumn())) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "FundProfile" (
        "fundCode",
        "fundName",
        "fundCompany",
        "custodian",
        "manager",
        "navDateOffset",
        "createdAt",
        "updatedAt"
      )
      VALUES (${code}, NULL, NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("fundCode") DO NOTHING
    `);
    return getFundProfile(code);
  }

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "FundProfile" (
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "tradingCalendar",
      "createdAt",
      "updatedAt"
    )
    VALUES (${code}, NULL, NULL, NULL, NULL, 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("fundCode") DO NOTHING
  `);
  return getFundProfile(code);
}

/**
 * Read the configured NAV date offsets for multiple fund codes in one query.
 */
export async function getFundNavDateOffsets(fundCodes: Iterable<string>) {
  const codes = Array.from(new Set(Array.from(fundCodes).map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code))));
  if (codes.length === 0) return new Map<string, number>();
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRaw<Array<{ fundCode: string; navDateOffset: number | bigint | null }>>(Prisma.sql`
    SELECT "fundCode", "navDateOffset"
    FROM "FundProfile"
    WHERE "fundCode" IN (${Prisma.join(codes)})
  `);
  return new Map(rows.map((row) => [row.fundCode, normalizeNavDateOffset(row.navDateOffset)]));
}

/**
 * Set a fund's NAV date offset used by investment profit statistics.
 */
export async function setFundNavDateOffset(fundCode: string, offset: number) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("fundCode must be a six-digit fund code.");
  if (offset !== 0 && offset !== 1) {
    throw new Error("navDateOffset must be 0 or 1.");
  }
  return updateFundProfile(code, { navDateOffset: normalizeNavDateOffset(offset) });
}

/**
 * Resolve a fund's display name by fund code.
 *
 * This is the single entry point for "fund code → fund name" lookups across
 * the app. Resolution order:
 *   1. FundProfile table (fund-level cache, includes fund company).
 *   2. Fund company / fund detail API (queryFundProfile), which also writes
 *      the profile back to FundProfile so later lookups hit the cache.
 *   3. Fall back to the lightweight identity API (queryFundIdentity) when the
 *      profile page yields no name.
 *
 * Returns the resolved name, or null when the code is invalid or unresolvable.
 */
export async function resolveFundName(
  fundCode: string,
  context?: FundProfileContext,
): Promise<string | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const cached = await ensureFundProfileRecord(code);
  if (cached) {
    await syncFundCompanyInstitution(cached, context);
    const cachedName = normalizeFundDisplayName(code, cached.fundName);
    if (cachedName) return cachedName;
  }

  const profile = await ensureFundProfile(code, context);
  if (profile?.fundName) return profile.fundName;

  const identity = await queryFundIdentity(code);
  if (identity?.name) return identity.name;

  return null;
}

/**
 * Ensure a fund's profile exists in the FundProfile table.
 *
 * - If the profile is already cached, return it without any network call.
 * - Otherwise fetch it from the fund overview page and upsert it.
 * - If the fetch fails, return null (callers should not treat this as fatal).
 */
export async function ensureFundProfile(
  fundCode: string,
  context?: FundProfileContext,
): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const cached = await getFundProfile(code);
  if (hasFetchedFundProfileData(cached)) {
    await syncFundCompanyInstitution(cached!, context);
    return cached;
  }

  await ensureFundProfileRecord(code);
  const fetched = await queryFundProfile(code);
  if (!fetched) return null;

  const profile = await upsertFetchedFundProfile({
    fundCode: code,
    fundName: fetched.name ?? null,
    fundCompany: fetched.fundCompany ?? null,
    custodian: fetched.custodian ?? null,
    manager: fetched.manager ?? null,
  });
  await syncFundCompanyInstitution(profile, context);
  return profile;
}

/**
 * Fetch a fund profile from the external source and merge the returned fields
 * into the fund-level profile cache without changing the configured NAV offset.
 */
export async function refreshFundProfile(
  fundCode: string,
  context?: FundProfileContext,
): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const fetched = await queryFundProfile(code);
  if (!fetched) return null;

  const profile = await upsertFetchedFundProfile({
    fundCode: code,
    fundName: fetched.name ?? null,
    fundCompany: fetched.fundCompany ?? null,
    custodian: fetched.custodian ?? null,
    manager: fetched.manager ?? null,
  });
  await syncFundCompanyInstitution(profile, context);
  return profile;
}
