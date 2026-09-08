/**
 * POST /api/v1/fund/units-reconcile
 *
 * Creates a fund-side units reconciliation transaction without a cash flow.
 * Body: { accountId, fundCode, date, actualUnits, fundName?, note? }
 * Success: { ok: true, data: { entryId?, currentUnits, actualUnits, deltaUnits, noChange } }
 * Busy before any transaction callback starts: HTTP 503,
 * { ok: false, code: "FUND_UNITS_RECONCILE_BUSY", error }.
 * Waits up to 10 seconds per start attempt, with one retry only before the callback starts.
 * Other failures: HTTP 500, { ok: false, code: "FUND_UNITS_RECONCILE_FAILED", error }.
 */
import { NextRequest, NextResponse } from "next/server";
import { FundSubtype, Prisma } from "@prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { createFundTransactionWithCashFlows } from "@/lib/fund/transactions";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import {
  ENTRY_ORIGIN_MANUAL,
  TRANSACTION_SOURCE_FUND_UNITS_RECONCILE,
} from "@/lib/transaction-semantics";
import { toNumber } from "@/lib/date-utils";
import { logger } from "@/lib/logger";

class ReconciliationBusyError extends Error {}

async function withReconciliationTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return await prisma.$transaction((tx) => {
        started = true;
        return work(tx);
      }, { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      // A P2028 can also mean expiry or a commit failure. Never replay a callback that ran.
      const startTimedOut = !started && error instanceof Error &&
        "code" in error && error.code === "P2028" &&
        error.message.includes("Unable to start a transaction in the given time");
      if (!startTimedOut) throw error;
      if (attempt === 1) throw new ReconciliationBusyError("Database is busy; fund units reconciliation was not saved", { cause: error });
      logger.warn("Retrying fund units reconciliation after transaction start timeout", "fund-units-reconcile", error);
      await delay(100);
    }
  }
}

function parseBusinessDate(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUnits(value: unknown) {
  const numberValue = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function usefulFundName(value: unknown, fundCode: string) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name !== fundCode ? name : null;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    const fundCode = typeof body.fundCode === "string" ? body.fundCode.trim() : "";
    const date = parseBusinessDate(body.date);
    const actualUnitsInput = parseUnits(body.actualUnits);
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    if (!fundCode) {
      return NextResponse.json({ ok: false, code: "FUND_CODE_REQUIRED", error: "fundCode is required" }, { status: 400 });
    }
    if (!date) {
      return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
    if (actualUnitsInput == null) {
      return NextResponse.json({ ok: false, code: "INVALID_UNITS", error: "actualUnits must be a non-negative number" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, ...ctx.hidFilter },
      select: {
        id: true,
        kind: true,
        investProductType: true,
        fundUnitsDecimals: true,
      },
    });
    if (!account || account.kind !== "investment") {
      return NextResponse.json({ ok: false, code: "FUND_ACCOUNT_NOT_FOUND", error: "fund account not found" }, { status: 404 });
    }
    if (["wealth", "deposit", "metal", "stock", "property"].includes(account.investProductType ?? "")) {
      return NextResponse.json({ ok: false, code: "UNSUPPORTED_ACCOUNT_TYPE", error: "account does not support fund units reconciliation" }, { status: 400 });
    }

    const fundUnitsDecimals = normalizeFundUnitsDecimals(account.fundUnitsDecimals, 2);
    // Source transactions and target units -> delta -> reconciliation and holding.
    // Read again after acquiring the transaction so waiting requests cannot reuse a stale delta.
    const result = await withReconciliationTransaction(async (tx) => {
      await recalcFundPositions(accountId, [fundCode], tx);

      const holding = await tx.fundHolding.findUnique({
        where: { accountId_fundCode: { accountId, fundCode } },
        select: { units: true, fundName: true },
      });
      const currentUnits = roundFundUnits(toNumber(holding?.units ?? 0), fundUnitsDecimals);
      const actualUnits = roundFundUnits(actualUnitsInput, fundUnitsDecimals);
      const deltaUnits = roundFundUnits(actualUnits - currentUnits, fundUnitsDecimals);

      if (deltaUnits === 0) {
        return {
          entryId: null,
          currentUnits,
          actualUnits,
          deltaUnits,
          noChange: true,
        };
      }

      const latestNameRows = await Promise.all([
        tx.fundNavCache.findFirst({
          where: { fundCode },
          orderBy: { navDate: "desc" },
          select: { name: true },
        }),
        tx.fundTransaction.findFirst({
          where: { fundAccountId: accountId, fundCode, deletedAt: null },
          orderBy: [{ applyDate: "desc" }, { createdAt: "desc" }],
          select: { fundName: true },
        }),
      ]);
      const fundName =
        usefulFundName(body.fundName, fundCode) ??
        usefulFundName(holding?.fundName, fundCode) ??
        usefulFundName(latestNameRows[0]?.name, fundCode) ??
        usefulFundName(latestNameRows[1]?.fundName, fundCode);
      const isIncrease = deltaUnits > 0;
      const absoluteDelta = Math.abs(deltaUnits);

      const created = await createFundTransactionWithCashFlows(tx, {
        householdId: ctx.householdId,
        fundAccountId: accountId,
        cashAccountId: null,
        fundCode,
        fundName,
        fundProductType: account.investProductType === "money" ? "money" : "fund",
        fundSubtype: isIncrease ? FundSubtype.buy : FundSubtype.redeem,
        source: TRANSACTION_SOURCE_FUND_UNITS_RECONCILE,
        entryOrigin: ENTRY_ORIGIN_MANUAL,
        applyDate: date,
        confirmDate: date,
        arrivalDate: null,
        grossAmount: 0,
        arrivalAmount: isIncrease ? null : 0,
        fee: null,
        nav: null,
        units: absoluteDelta,
        realizedProfit: isIncrease ? null : 0,
        note,
        cashFlows: [],
      });

      await recalcFundPositions(accountId, [fundCode], tx);

      return {
        entryId: created.fundTransaction.id,
        currentUnits,
        actualUnits,
        deltaUnits,
        noChange: false,
      };
    });
    if (!result.noChange) {
      await recalcAndSaveAccountBalance(accountId);
      revalidateAfterInvestChange();
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof ReconciliationBusyError) {
      logger.warn("Fund units reconciliation could not start", "fund-units-reconcile", error.cause);
      return NextResponse.json({
        ok: false,
        code: "FUND_UNITS_RECONCILE_BUSY",
        error: error.message,
      }, { status: 503, headers: { "Retry-After": "2" } });
    }
    logger.error("Fund units reconciliation failed", "fund-units-reconcile", error);
    return NextResponse.json({
      ok: false,
      code: "FUND_UNITS_RECONCILE_FAILED",
      error: "Fund units reconciliation failed",
    }, { status: 500 });
  }
}
