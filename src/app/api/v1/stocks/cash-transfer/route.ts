import { TransactionType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { resolveSameCurrencyTransfer } from "@/lib/currency";
import { prisma } from "@/lib/db/prisma";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { ensureBrokerageCashAccountForStockAccount } from "@/lib/server/brokerage-cash-account";
import { findRecentManualTransactionDuplicate } from "@/lib/server/transaction-dedupe";
import { statementMonthForTransfer } from "@/lib/transaction-semantics";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function parseDateOnly(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseAmount(value: unknown) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function normalizeAccountName(value: unknown) {
  return String(value ?? "").trim();
}

async function assertStockAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: "investment", investProductType: "stock" },
    select: { id: true, householdId: true, groupId: true, institutionId: true, name: true, currency: true },
  });
  if (!account) throw new Error("Stock account not found");
  return account;
}

async function resolveBankAccount(householdId: string, name: string) {
  if (!name) return null;
  return prisma.account.findFirst({
    where: {
      householdId,
      isPlaceholder: { not: true },
      OR: [
        { id: name },
        { name },
      ],
    },
    select: { id: true, name: true, kind: true, currency: true, billingDay: true },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * POST /api/v1/stocks/cash-transfer
 * Creates a bank-securities transfer for a stock account.
 * Positive amount transfers from the bank account into the brokerage cash account;
 * negative amount transfers from the brokerage cash account back to the bank account.
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_BODY", error: "Invalid request body" }, { status: 400, headers: corsHeaders() });

    const stockAccountId = String(body.stockAccountId ?? body.accountId ?? "").trim();
    const bankAccountName = normalizeAccountName(body.bankAccount ?? body.bankAccountName ?? body.fromAccountName ?? body.toAccountName);
    const tradeDate = parseDateOnly(body.tradeDate ?? body.date);
    const amount = parseAmount(body.amount ?? body.grossAmount ?? body.netAmount);
    const amountAbs = Math.abs(amount);
    const note = String(body.note ?? "").trim();

    if (!stockAccountId) return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_REQUIRED", error: "Stock account is required" }, { status: 400, headers: corsHeaders() });
    if (!tradeDate) return NextResponse.json({ ok: false, code: "INVALID_TRANSFER_DATE", error: "Transfer date is invalid" }, { status: 400, headers: corsHeaders() });
    if (!amountAbs) return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "Transfer amount is invalid" }, { status: 400, headers: corsHeaders() });
    if (!bankAccountName) return NextResponse.json({ ok: false, code: "BANK_ACCOUNT_REQUIRED", error: "Bank account is required for bank-securities transfer" }, { status: 400, headers: corsHeaders() });

    const stockAccount = await assertStockAccount(stockAccountId, householdId);
    const brokerageCashAccount = await ensureBrokerageCashAccountForStockAccount(prisma, stockAccount);
    if (!brokerageCashAccount) return NextResponse.json({ ok: false, code: "BROKERAGE_CASH_ACCOUNT_UNDETERMINED", error: "Cannot determine brokerage cash account for this stock account" }, { status: 400, headers: corsHeaders() });

    const bankAccount = await resolveBankAccount(householdId, bankAccountName);
    if (!bankAccount) return NextResponse.json({ ok: false, code: "BANK_ACCOUNT_NOT_FOUND", error: "Bank account was not found" }, { status: 400, headers: corsHeaders() });
    if (bankAccount.id === brokerageCashAccount.id) return NextResponse.json({ ok: false, code: "SAME_TRANSFER_ACCOUNTS", error: "Bank account and brokerage cash account cannot be the same" }, { status: 400, headers: corsHeaders() });

    const transferIn = amount > 0;
    const fromAccount = transferIn ? bankAccount : brokerageCashAccount;
    const toAccount = transferIn ? brokerageCashAccount : bankAccount;
    const currency = resolveSameCurrencyTransfer(fromAccount, toAccount);
    const transferAmount = -amountAbs;
    const statementMonth = statementMonthForTransfer(tradeDate, fromAccount, toAccount);

    const created = await prisma.$transaction(async (tx) => {
      const duplicate = await findRecentManualTransactionDuplicate(tx, {
        householdId,
        type: TransactionType.transfer,
        date: tradeDate,
        accountId: fromAccount.id,
        toAccountId: toAccount.id,
        amount: transferAmount,
        categoryId: null,
        note,
        source: "manual",
      });
      if (duplicate) return duplicate;
      return tx.txRecord.create({
        data: {
          householdId,
          accountId: fromAccount.id,
          accountName: fromAccount.name,
          toAccountId: toAccount.id,
          toAccountName: toAccount.name,
          amount: transferAmount,
          type: TransactionType.transfer,
          date: tradeDate,
          note: note || null,
          toNote: note || null,
          currency,
          statementMonth,
          source: "stock_cash_transfer_import",
        },
      });
    });

    await Promise.all([
      recalcAndSaveAccountBalance(fromAccount.id).catch(() => undefined),
      recalcAndSaveAccountBalance(toAccount.id).catch(() => undefined),
    ]);

    return NextResponse.json({ ok: true, data: { transaction: created } }, { headers: corsHeaders() });
  } catch (error) {
    console.error("POST /api/v1/stocks/cash-transfer error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "Internal error" }, { status: 500, headers: corsHeaders() });
  }
}
