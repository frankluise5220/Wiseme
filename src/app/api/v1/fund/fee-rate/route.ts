import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getFundFeeRate, getFundFeeRateByDate, replaceFundFeeRates, setFundFeeRateByDate, type FundFeeRateReplacementRow, type FundFeeRateType } from "@/lib/fund/feeRate";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * Fund fee rates (buy / redeem, percent).
 *
 * GET /api/v1/fund/fee-rate
 * Query params:
 * - accountId: required.
 * - fundCode: required for single lookup (with optional feeType, effectiveDate).
 * - list: "1". When present (and no fundCode), returns the full fee-rate table
 *   for the account: every fund seen in transactions plus every stored rate,
 *   with buyRate / redeemRate per fund (latest by effectiveDate).
 *
 * GET responses:
 * - single: { ok, rate, feeType }
 * - list: { ok, rows: [{ fundCode, fundName, buyRate, redeemRate, buyEffectiveDate, redeemEffectiveDate }] }
 *
 * POST /api/v1/fund/fee-rate
 * Body: { accountId, replace?: true, fundCode?, rows?: [{ fundCode, feeType, rate, effectiveDate? }] }
 * With replace=true, rows replace either the account's fee rates or the single fundCode scope.
 * Also keeps the legacy single body shape: { accountId, fundCode, rate, feeType, effectiveDate? }.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();
  const feeType = parseFeeType(searchParams.get("feeType"));
  const effectiveDateRaw = searchParams.get("effectiveDate")?.trim();
  const listMode = searchParams.get("list") === "1";

  if (!accountId) {
    return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "accountId is required." }, { status: 400 });
  }

  try {
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    if (fundCode) {
      const effectiveDate = effectiveDateRaw ? utcDate(effectiveDateRaw) : null;
      const rate = effectiveDate
        ? await getFundFeeRateByDate(accountId, fundCode, effectiveDate, feeType)
        : await getFundFeeRate(accountId, fundCode, feeType);
      return NextResponse.json({ ok: true, rate, feeType });
    }

    if (listMode) {
      const [txCodes, rateRecords] = await Promise.all([
        prisma.fundTransaction.findMany({
          where: { fundAccountId: accountId, deletedAt: null, fundCode: { not: undefined } },
          select: { fundCode: true, fundName: true, confirmDate: true },
          orderBy: [{ fundCode: "asc" }, { confirmDate: "desc" }, { createdAt: "desc" }],
          take: 20000,
        }),
        prisma.fundFeeRate.findMany({
          where: { accountId },
          select: { fundCode: true, feeType: true, rate: true, effectiveDate: true },
          orderBy: [{ fundCode: "asc" }, { effectiveDate: "desc" }],
          take: 50000,
        }),
      ]);
      const fundNameByCode = new Map<string, string>();
      for (const row of txCodes) {
        if (row.fundCode && row.fundName && !fundNameByCode.has(row.fundCode)) {
          fundNameByCode.set(row.fundCode, row.fundName);
        }
      }
      // Every stored fee-rate record (a fund can have multiple historical
      // rates keyed by effectiveDate), plus a placeholder row for funds that
      // only appear in transactions without any stored rate yet. Buy and
      // redeem records on the same date are returned as two columns.
      const codeSet = new Set<string>([...fundNameByCode.keys(), ...new Set(rateRecords.map((r) => r.fundCode))]);
      const rows: Array<{
        fundCode: string;
        fundName: string | null;
        buyRate: number | null;
        redeemRate: number | null;
        buyEffectiveDate: string | null;
        redeemEffectiveDate: string | null;
        effectiveDate: string | null;
        placeholder: boolean;
      }> = [];
      for (const code of Array.from(codeSet).sort()) {
        const fundName = fundNameByCode.get(code) ?? null;
        const records = rateRecords.filter((r) => r.fundCode === code);
        if (records.length === 0) {
          rows.push({
            fundCode: code,
            fundName,
            buyRate: null,
            redeemRate: null,
            buyEffectiveDate: null,
            redeemEffectiveDate: null,
            effectiveDate: null,
            placeholder: true,
          });
        } else {
          const rowsByDate = new Map<string, {
            buyRate: number | null;
            redeemRate: number | null;
            buyEffectiveDate: string | null;
            redeemEffectiveDate: string | null;
          }>();
          for (const record of records) {
            const effectiveDate = record.effectiveDate.toISOString().slice(0, 10);
            const current = rowsByDate.get(effectiveDate) ?? {
              buyRate: null,
              redeemRate: null,
              buyEffectiveDate: null,
              redeemEffectiveDate: null,
            };
            if (record.feeType === "redeem") {
              current.redeemRate = Number(record.rate);
              current.redeemEffectiveDate = effectiveDate;
            } else {
              current.buyRate = Number(record.rate);
              current.buyEffectiveDate = effectiveDate;
            }
            rowsByDate.set(effectiveDate, current);
          }
          for (const [effectiveDate, grouped] of rowsByDate) {
            rows.push({
              fundCode: code,
              fundName,
              ...grouped,
              effectiveDate,
              placeholder: false,
            });
          }
        }
      }
      return NextResponse.json({ ok: true, rows });
    }

    return NextResponse.json({ ok: true, rate: 0, feeType });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "Failed to fetch fee rates." },
      { status: 500 }
    );
  }
}

type FeeRateRowInput = {
  fundCode?: string;
  feeType?: string;
  rate?: number;
  effectiveDate?: string | null;
  // Legacy per-fund shape (single latest buy/redeem).
  buyRate?: number;
  redeemRate?: number;
  buyEffectiveDate?: string | null;
  redeemEffectiveDate?: string | null;
};

function normalizeRate(value: number | null | undefined) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

async function upsertFeeRate(accountId: string, fundCode: string, feeType: FundFeeRateType, rate: number, effectiveDate?: string) {
  const date = effectiveDate ? utcDate(effectiveDate) : new Date();
  await setFundFeeRateByDate(accountId, fundCode, rate, date, feeType);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: string;
      replace?: boolean;
      rows?: FeeRateRowInput[];
      fundCode?: string;
      rate?: number;
      feeType?: string;
      effectiveDate?: string;
    } | null;
    if (!body?.accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "accountId is required." }, { status: 400 });
    }
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: body.accountId, ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    // Legacy single-row body shape.
    if (typeof body.fundCode === "string" && body.fundCode && typeof body.rate === "number") {
      const feeType = parseFeeType(body.feeType);
      await upsertFeeRate(body.accountId, body.fundCode, feeType, body.rate, body.effectiveDate);
      return NextResponse.json({ ok: true, feeType });
    }

    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (body.replace) {
      const scopeFundCode = typeof body.fundCode === "string" && body.fundCode.trim() ? body.fundCode.trim() : undefined;
      const replacementRows = normalizeReplacementRows(rows, scopeFundCode);
      await replaceFundFeeRates(body.accountId, replacementRows, scopeFundCode);
      return NextResponse.json({ ok: true });
    }

    for (const raw of rows) {
      const fundCode = String(raw.fundCode ?? "").trim();
      if (!fundCode) continue;
      // New record-oriented shape: one row per (feeType, effectiveDate).
      if (typeof raw.feeType === "string" && typeof raw.rate === "number") {
        const rate = normalizeRate(raw.rate);
        if (rate == null) continue;
        await upsertFeeRate(body.accountId, fundCode, parseFeeType(raw.feeType), rate, raw.effectiveDate ?? undefined);
        continue;
      }
      // Legacy per-fund shape.
      const buyRate = normalizeRate(raw.buyRate);
      const redeemRate = normalizeRate(raw.redeemRate);
      if (buyRate != null) {
        await upsertFeeRate(body.accountId, fundCode, "buy", buyRate, raw.buyEffectiveDate ?? undefined);
      }
      if (redeemRate != null) {
        await upsertFeeRate(body.accountId, fundCode, "redeem", redeemRate, raw.redeemEffectiveDate ?? undefined);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "SAVE_FAILED", error: e instanceof Error ? e.message : "Failed to save fee rates." },
      { status: 500 }
    );
  }
}

function normalizeReplacementRows(rows: FeeRateRowInput[], scopeFundCode?: string): FundFeeRateReplacementRow[] {
  const fallbackDate = todayUtcDate();
  const normalized: FundFeeRateReplacementRow[] = [];
  for (const raw of rows) {
    const fundCode = String(raw.fundCode ?? scopeFundCode ?? "").trim();
    const rate = normalizeRate(raw.rate);
    if (!fundCode || typeof raw.feeType !== "string" || rate == null) continue;
    normalized.push({
      fundCode,
      feeType: parseFeeType(raw.feeType),
      rate,
      effectiveDate: raw.effectiveDate ? utcDate(raw.effectiveDate) : fallbackDate,
    });
  }
  return normalized;
}

function parseFeeType(value: unknown): FundFeeRateType {
  return value === "redeem" ? "redeem" : "buy";
}

function todayUtcDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
