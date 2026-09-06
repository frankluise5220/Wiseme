import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { CURRENCY_OPTIONS } from "@/lib/currency";

export const runtime = "nodejs";

/**
 * GET /api/v1/currencies
 * Returns the merged list of built-in currencies and user-approved currencies.
 * Response: { ok: true, currencies: [{ code, nameZh, nameEn, countryZh, countryEn, source }] }
 * source: "system" | "approved"
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const withSystem = searchParams.get("includeSystem") !== "false";

  try {
    const approved = await prisma.approvedCurrency.findMany({
      orderBy: { nameZh: "asc" },
    });

    const currencies = approved.map((c) => ({
      code: c.code,
      nameZh: c.nameZh,
      nameEn: c.nameEn,
      countryZh: c.countryZh ?? null,
      countryEn: c.countryEn ?? null,
      source: "approved" as const,
    }));

    if (withSystem) {
      const systemCurrencies = CURRENCY_OPTIONS.map((opt) => ({
        code: opt.value,
        nameZh: "", // resolved at runtime via i18n
        nameEn: "",
        countryZh: null,
        countryEn: null,
        source: "system" as const,
      }));
      return NextResponse.json({ ok: true, currencies: systemCurrencies, approvedCurrencies: currencies });
    }

    return NextResponse.json({ ok: true, currencies, approvedCurrencies: currencies });
  } catch {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Failed to fetch currencies" }, { status: 500 });
  }
}
