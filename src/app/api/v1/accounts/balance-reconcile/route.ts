/**
 * POST /api/v1/accounts/balance-reconcile
 *
 * Body: { accountId: string; actualBalance: number; date?: string; entryId?: string }
 * Response: { ok: true, entryId, previousBalance, actualBalance, difference }
 *
 * Creates a balance anchor TxRecord for cash, debit-card, e-wallet, or loan accounts. It works like a
 * credit-card bill override: when ordered balance calculation reaches this record,
 * the running balance is set to actualBalance, then later records continue from it.
 */
import { NextResponse } from "next/server";
import { AccountKind, TransactionType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  encodeBalanceReconcileTarget,
  getBalanceReconcileTarget,
} from "@/lib/balance-reconcile";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const BodySchema = z.object({
  accountId: z.string().min(1),
  entryId: z.string().optional(),
  actualBalance: z.number().finite(),
  date: z.string().optional(),
});

function parseDateOnly(value?: string) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
}

function money(value: number) {
  return Number(value.toFixed(2));
}

const RECONCILABLE_ACCOUNT_KINDS: AccountKind[] = [
  AccountKind.cash,
  AccountKind.bank_debit,
  AccountKind.ewallet,
  AccountKind.settlement,
  AccountKind.loan,
];

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "VALIDATION_FAILED", error: "参数格式不正确" }, { status: 400 });
  }

  const { hidFilter } = await getHouseholdScope();
  const account = await prisma.account.findFirst({
    where: {
      id: parsed.data.accountId,
      kind: { in: RECONCILABLE_ACCOUNT_KINDS },
      isPlaceholder: { not: true },
      ...hidFilter,
    },
    select: {
      id: true,
      name: true,
      kind: true,
      balance: true,
      investProductType: true,
      billingDay: true,
    },
  });
  if (!account) {
    return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_RECONCILABLE", error: "只支持对现金、借记卡、电子零钱、往来款账户校准余额" }, { status: 404 });
  }

  const balanceMap = await computeAccountDisplayBalances([account], hidFilter);
  const previousBalance = money(balanceMap.get(account.id) ?? toNumber(account.balance));
  const actualBalance = money(parsed.data.actualBalance);
  const difference = money(actualBalance - previousBalance);

  if (Math.abs(difference) < 0.005) {
    // Still create an anchor: the point of reconciliation is to lock this node,
    // even if today's calculated balance happens to match before old records change.
  }

  const anchorData = (source: string | null | undefined) => ({
    householdId: hidFilter.householdId,
    type: TransactionType.income,
    date: parseDateOnly(parsed.data.date),
    amount: 0,
    accountId: account.id,
    accountName: account.name,
    categoryName: source === BALANCE_INITIALIZATION_SOURCE ? "初始余额" : "余额校准",
    note: null,
    toNote: encodeBalanceReconcileTarget(actualBalance),
  });

  const existing = parsed.data.entryId
    ? await prisma.txRecord.findFirst({
        where: {
          id: parsed.data.entryId,
          householdId: hidFilter.householdId,
          accountId: account.id,
          source: { in: [BALANCE_RECONCILE_SOURCE, BALANCE_INITIALIZATION_SOURCE] },
          deletedAt: null,
        },
        select: { id: true, source: true, toNote: true },
      })
    : null;

  if (parsed.data.entryId && (!existing || getBalanceReconcileTarget(existing) == null)) {
    return NextResponse.json({ ok: false, code: "RECONCILE_ENTRY_NOT_FOUND", error: "校准记录不存在" }, { status: 404 });
  }

  const saved = existing
    ? await prisma.txRecord.update({ where: { id: existing.id }, data: anchorData(existing.source), select: { id: true } })
    : await prisma.txRecord.create({
        data: {
          ...anchorData(BALANCE_RECONCILE_SOURCE),
          source: BALANCE_RECONCILE_SOURCE,
        },
        select: { id: true },
      });

  await recalcAndSaveAccountBalance(account.id);
  revalidateAfterTxChange();

  return NextResponse.json({
    ok: true,
    entryId: saved.id,
    previousBalance,
    actualBalance,
    difference,
  });
}
