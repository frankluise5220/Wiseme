import { NextRequest, NextResponse } from "next/server";
import { normalizeCurrency } from "@/lib/currency";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getConversionRate, getHouseholdBaseCurrency, setFxRate } from "@/lib/server/fx-rates";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function parseCurrencyList(value: string | null) {
  return Array.from(new Set(
    String(value ?? "")
      .split(",")
      .map((item) => normalizeCurrency(item))
      .filter(Boolean),
  ));
}

function parsePositiveRate(value: unknown) {
  const rate = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * GET /api/v1/fx-rates
 *
 * Query:
 * - from?: comma-separated source currencies. Omit to use enabled account currencies.
 * - to?: target display currency. Defaults to current household baseCurrency.
 * - refresh=1: force-fetch latest rates from the external provider and cache them.
 *   When not forcing refresh, cached FxRate rows are preferred; when absent,
 *   local FxConversion history can provide the latest recorded conversion rate.
 *
 * Response: { ok:true, baseCurrency, rates:[{ fromCurrency, toCurrency, rate, rateDate, source, missing }] }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const search = req.nextUrl.searchParams;
    const baseCurrency = normalizeCurrency(search.get("to") || await getHouseholdBaseCurrency(householdId));
    const forceRefresh = search.get("refresh") === "1" || search.get("refresh") === "true";
    let sourceCurrencies = parseCurrencyList(search.get("from"));
    if (sourceCurrencies.length === 0) {
      const rows = await prisma.account.findMany({
        where: { householdId, isPlaceholder: { not: true }, isActive: true },
        select: { currency: true },
      });
      sourceCurrencies = Array.from(new Set(rows.map((row) => normalizeCurrency(row.currency))));
    }

    const rates = await Promise.all(sourceCurrencies.map((fromCurrency) =>
      getConversionRate({ householdId, fromCurrency, toCurrency: baseCurrency, forceRefresh }),
    ));
    return NextResponse.json({ ok: true, baseCurrency, rates });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "汇率查询失败" }, { status: 500 });
  }
}

/**
 * POST /api/v1/fx-rates
 *
 * Body:
 * - { baseCurrency } updates current household display currency.
 * - { fromCurrency, toCurrency?, rate, rateDate?, source? } saves a manual rate.
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const baseCurrencyInput = String(body.baseCurrency ?? "").trim();
    const fromCurrencyInput = String(body.fromCurrency ?? "").trim();
    const rateInput = body.rate;

    let baseCurrency: string | null = null;
    if (baseCurrencyInput) {
      baseCurrency = normalizeCurrency(baseCurrencyInput);
      await prisma.household.update({ where: { id: householdId }, data: { baseCurrency } });
    }

    let rateRow: Awaited<ReturnType<typeof setFxRate>> | null = null;
    if (fromCurrencyInput || rateInput !== undefined) {
      const rate = parsePositiveRate(rateInput);
      if (!fromCurrencyInput || !rate) {
        return NextResponse.json({ ok: false, code: "INVALID_MANUAL_RATE", error: "手工汇率需要填写源币种和正数汇率" }, { status: 400 });
      }
      const targetCurrency = normalizeCurrency(body.toCurrency ?? baseCurrency ?? await getHouseholdBaseCurrency(householdId));
      const fromCurrency = normalizeCurrency(fromCurrencyInput);
      if (fromCurrency === targetCurrency) {
        return NextResponse.json({ ok: false, code: "SAME_CURRENCY_NOT_ALLOWED", error: "同币种不需要手工汇率" }, { status: 400 });
      }
      rateRow = await setFxRate({
        householdId,
        fromCurrency,
        toCurrency: targetCurrency,
        rate,
        rateDate: String(body.rateDate ?? "").trim() || null,
        source: String(body.source ?? "").trim() || "manual",
      });
    }

    revalidateAfterSettingsChange();
    return NextResponse.json({
      ok: true,
      baseCurrency: baseCurrency ?? await getHouseholdBaseCurrency(householdId),
      rate: rateRow ? {
        fromCurrency: rateRow.baseCurrency,
        toCurrency: rateRow.quoteCurrency,
        rate: Number(rateRow.rate),
        rateDate: rateRow.rateDate.toISOString().slice(0, 10),
        source: rateRow.source,
      } : null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "SAVE_FAILED", error: error instanceof Error ? error.message : "汇率保存失败" }, { status: 500 });
  }
}
