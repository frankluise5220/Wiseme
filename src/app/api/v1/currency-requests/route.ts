import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { canWrite, isAdmin } from "@/lib/server/auth";
import { CURRENCY_OPTIONS } from "@/lib/currency";

export const runtime = "nodejs";

/**
 * POST /api/v1/currency-requests
 * Creates an immediately usable user-added currency.
 * Body: { code, nameZh, nameEn, countryZh }
 * Response: { ok: true, code: string, currency } | { ok: false, code: string, error?: string }
 */
export async function POST(req: NextRequest) {
  const { user } = await getHouseholdScope();
  if (!user) return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  if (!canWrite(user)) return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });

  let body: { code?: unknown; nameZh?: unknown; nameEn?: unknown; countryZh?: unknown; countryEn?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_BODY" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code || !/^[A-Z]{2,10}$/.test(code)) {
    return NextResponse.json({ ok: false, code: "INVALID_CODE" }, { status: 400 });
  }

  // Cannot request a system built-in currency
  if (CURRENCY_OPTIONS.some((c) => c.value === code)) {
    return NextResponse.json({ ok: false, code: "SYSTEM_CURRENCY" }, { status: 409 });
  }

  // Check for duplicate: approved already exists OR a pending/approved request already exists
  const existingApproved = await prisma.approvedCurrency.findUnique({ where: { code } });
  if (existingApproved) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_REQUEST" }, { status: 409 });
  }

  const existingRequest = await prisma.customCurrencyRequest.findFirst({
    where: { code, status: { in: ["pending", "approved"] } },
  });
  if (existingRequest) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_REQUEST" }, { status: 409 });
  }

  const nameZh = typeof body.nameZh === "string" ? body.nameZh.trim() : "";
  const nameEn = typeof body.nameEn === "string" ? body.nameEn.trim() : "";
  const countryZh = typeof body.countryZh === "string" ? body.countryZh.trim() : "";
  if (!nameZh || !nameEn || !countryZh) {
    return NextResponse.json({ ok: false, code: "MISSING_CURRENCY_FIELDS" }, { status: 400 });
  }

  try {
    const currency = await prisma.approvedCurrency.create({
      data: {
        code,
        nameZh,
        nameEn,
        countryZh,
        createdBy: user.id,
      },
    });
    return NextResponse.json({
      ok: true,
      code,
      currency: {
        code: currency.code,
        nameZh: currency.nameZh,
        nameEn: currency.nameEn,
        countryZh: currency.countryZh,
        countryEn: currency.countryEn,
        source: "approved",
      },
    }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return NextResponse.json({ ok: false, code: "DUPLICATE_REQUEST" }, { status: 409 });
    }
    console.error("[currency-requests POST]", err);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR" }, { status: 500 });
  }
}

/**
 * GET /api/v1/currency-requests
 * Returns all pending requests for the current user/household (admin sees all).
 */
export async function GET() {
  const { householdId, user } = await getHouseholdScope();
  if (!user) return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });

  const where = {
    status: "pending" as const,
    ...(isAdmin(user) ? {} : {
      OR: [
        { requesterId: user.id },
        { householdId },
      ],
    }),
  };

  const requests = await prisma.customCurrencyRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ ok: true, requests });
}
