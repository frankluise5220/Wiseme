import { NextRequest, NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

/**
 * PUT /api/v1/wealth-products/nav
 * Adds (appends/updates) the manual NAV (unit value) of a bank wealth product,
 * used to display the real-time market value and floating P&L of wealth holdings.
 *
 * Body:
 * - accountId: string — the wealth investment account the holding belongs to
 * - wealthProductId?: string — wealth product master id (preferred)
 * - productName?: string — product name fallback when wealthProductId is absent
 * - date: string (YYYY-MM-DD) — NAV effective date
 * - nav: number — unit value, must be > 0
 *
 * Response:
 * - { ok: true, data: { nav, date } }
 * - { ok: false, code, error } on failure
 *
 * The stored manual NAV is read by computePositionDisplay / computeInvestBalances,
 * so positions and the investments summary reflect the entered NAV immediately
 * after the caches are revalidated.
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    const wealthProductId = String(body.wealthProductId ?? "").trim() || null;
    const productName = String(body.productName ?? "").trim() || null;
    const date = String(body.date ?? "").trim();
    const nav = Number(String(body.nav ?? "").trim());

    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
    if (!Number.isFinite(nav) || nav <= 0) {
      return NextResponse.json({ ok: false, code: "INVALID_NAV", error: "nav must be a positive number" }, { status: 400 });
    }
    if (!wealthProductId && !productName) {
      return NextResponse.json({ ok: false, code: "PRODUCT_IDENTIFIER_REQUIRED", error: "wealthProductId or productName is required" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.investment, investProductType: "wealth" },
      select: { id: true, institutionId: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "WEALTH_ACCOUNT_NOT_FOUND", error: "wealth account not found" }, { status: 404 });
    }

    const product = wealthProductId
      ? await prisma.wealthProduct.findFirst({
          where: { id: wealthProductId, householdId },
          select: { id: true },
        })
      : await prisma.wealthProduct.findFirst({
          where: { householdId, institutionId: account.institutionId ?? null, name: productName ?? "" },
          select: { id: true },
        });
    if (!product) {
      return NextResponse.json({ ok: false, code: "WEALTH_PRODUCT_NOT_FOUND", error: "wealth product not found" }, { status: 404 });
    }

    const [y, m, d] = date.split("-").map(Number);
    const navDate = new Date(Date.UTC(y, m - 1, d));

    await prisma.wealthProduct.update({
      where: { id: product.id },
      data: { manualNav: nav, manualNavDate: navDate },
    });

    // Invalidate the investments summary and position caches so the new NAV
    // shows up in the holdings table and the investments page.
    revalidateAfterInvestChange();

    return NextResponse.json({ ok: true, data: { nav, date } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "SAVE_FAILED", error: error instanceof Error ? error.message : "failed to save NAV" },
      { status: 500 },
    );
  }
}
