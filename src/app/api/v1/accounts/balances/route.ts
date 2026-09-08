/**
 * API: GET /api/v1/accounts/balances
 *
 * Returns account balances in batch.
 * Used by SidebarClient for partial refresh.
 *
 * Query params:
 *   ids (required) - comma-separated account ID list
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { toNumber } from "@/lib/date-utils";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idsRaw = (url.searchParams.get("ids") ?? "").trim();
  if (!idsRaw) {
    return NextResponse.json({ ok: false, code: "MISSING_IDS", error: "缺少 ids 参数" }, { status: 400 });
  }

  const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, code: "INVALID_IDS", error: "ids 参数无效" }, { status: 400 });
  }

  try {
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;

    const accounts = await prisma.account.findMany({
      where: {
        id: { in: ids },
        ...hidFilter,
      },
      select: {
        id: true,
        balance: true,
        kind: true,
        investProductType: true,
        billingDay: true,
      },
    });

    const [investBalByAccountId, displayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId, debtDisplaySummary] = await Promise.all([
      computeInvestBalances(ctx),
      computeAccountDisplayBalances(
        accounts
          .filter((account) => !isPureInvestmentAccount(account))
          .map((account) => ({
            id: account.id,
            kind: account.kind,
            investProductType: account.investProductType,
            billingDay: account.billingDay,
          })),
        hidFilter,
      ),
      prisma.creditCardCycle.findMany({
        where: {
          accountId: { in: accounts.filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay).map((account) => account.id) },
          isCurrentCycle: true,
        },
        select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
      }),
      computeInsuranceAccountDisplayBalances(
        accounts.filter((account) => account.kind === AccountKind.insurance).map((account) => account.id),
        hidFilter,
      ),
      computeDebtDisplaySummary(ctx),
    ]);
    const currentCreditBalanceByAccountId = new Map(
      currentCreditCycles.map((cycle) => [
        cycle.accountId,
        creditCardDisplayBalanceFromCurrentCycle(cycle),
      ]),
    );

    const data = accounts.map((a) => ({
      id: a.id,
      balance: isPureInvestmentAccount(a)
        ? investBalByAccountId.get(a.id)?.marketValue ?? 0
        : a.kind === AccountKind.insurance
          ? insuranceDisplayBalanceByAccountId.get(a.id) ?? 0
          : a.kind === AccountKind.bank_credit && a.billingDay
            ? currentCreditBalanceByAccountId.get(a.id) ?? toNumber(a.balance)
          : (a.kind === AccountKind.loan || a.kind === AccountKind.settlement)
            ? debtDisplaySummary.balanceByAccountId.get(a.id) ?? displayBalanceByAccountId.get(a.id) ?? toNumber(a.balance)
            : displayBalanceByAccountId.get(a.id) ?? toNumber(a.balance),
      kind: a.kind,
    }));

    return NextResponse.json({ ok: true, data });
  } catch (err) {
    console.error("GET /api/v1/accounts/balances error:", err);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "服务器错误" }, { status: 500 });
  }
}
