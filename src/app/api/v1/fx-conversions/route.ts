import { NextRequest, NextResponse } from "next/server";
import { AccountKind, Prisma, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const FX_CONVERSION_SOURCE = "fx_conversion";
const FX_CONVERSION_CATEGORY = "购汇";
const BASE_CASH_CURRENCY = "CNY";

function parseDateOnlyUtc(value: unknown) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

function parsePositiveAmount(value: unknown) {
  const amount = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function isFxAllowedAccountKind(kind: AccountKind) {
  return kind !== AccountKind.bank_credit && kind !== AccountKind.loan && kind !== AccountKind.settlement;
}

function isForeignCurrency(currency: string) {
  return normalizeCurrency(currency) !== BASE_CASH_CURRENCY;
}

function currencyAccountName(currency: string) {
  const labels: Record<string, string> = {
    CNY: "人民币账户",
    USD: "美元账户",
    JPY: "日元账户",
    HKD: "港币账户",
    EUR: "欧元账户",
    GBP: "英镑账户",
  };
  return labels[currency] ?? `${currency}账户`;
}

function serializeConversion(conversion: {
  id: string;
  date: Date;
  fromEntryId: string;
  toEntryId: string;
  fromAccountId: string;
  toAccountId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: unknown;
  toAmount: unknown;
  exchangeRate: unknown;
  feeAmount: unknown | null;
  note: string | null;
}) {
  return {
    id: conversion.id,
    date: conversion.date.toISOString().slice(0, 10),
    fromEntryId: conversion.fromEntryId,
    toEntryId: conversion.toEntryId,
    fromAccountId: conversion.fromAccountId,
    toAccountId: conversion.toAccountId,
    fromCurrency: conversion.fromCurrency,
    toCurrency: conversion.toCurrency,
    fromAmount: Number(conversion.fromAmount),
    toAmount: Number(conversion.toAmount),
    exchangeRate: Number(conversion.exchangeRate),
    feeAmount: conversion.feeAmount == null ? null : Number(conversion.feeAmount),
    note: conversion.note,
  };
}

type FxWriter = typeof prisma | Prisma.TransactionClient;

async function resolveFxAccounts(tx: FxWriter, {
  householdId,
  fromAccountId,
  toAccountId,
  requestedToCurrency,
}: {
  householdId: string;
  fromAccountId: string;
  toAccountId: string;
  requestedToCurrency: string;
}) {
  const fromAccount = await tx.account.findUnique({
    where: { id: fromAccountId },
    select: {
      id: true,
      name: true,
      kind: true,
      currency: true,
      householdId: true,
      groupId: true,
      institutionId: true,
      userId: true,
    },
  });
  if (!fromAccount) throw new Error("换出账户不存在");
  if (fromAccount.householdId !== householdId) throw new Error("换出账户不属于当前账簿");
  if (fromAccount.kind !== AccountKind.bank_debit) throw new Error("换出账户只能选择借记卡");
  const fromCurrency = normalizeCurrency(fromAccount.currency);

  let toAccount = toAccountId
    ? await tx.account.findUnique({
        where: { id: toAccountId },
        select: { id: true, name: true, kind: true, currency: true, householdId: true },
      })
    : null;
  if (toAccount) {
    if (toAccount.householdId !== householdId) throw new Error("换入账户不属于当前账簿");
    if (!isFxAllowedAccountKind(toAccount.kind)) throw new Error("信用卡和往来款账户暂不支持直接换汇");
    if (!isForeignCurrency(toAccount.currency)) throw new Error("换入账户只能选择外币账户");
  } else {
    const toCurrencyInput = requestedToCurrency;
    if (!toCurrencyInput) throw new Error("请选择换入币种");
    if (!isForeignCurrency(toCurrencyInput)) throw new Error("换入币种只能选择外币");
    if (fromCurrency === toCurrencyInput) throw new Error("同币种账户请使用普通转账，不需要换汇交易");
    const targetName = currencyAccountName(toCurrencyInput);
    const existing = await tx.account.findFirst({
      where: {
        householdId,
        kind: fromAccount.kind,
        groupId: fromAccount.groupId,
        institutionId: fromAccount.institutionId,
        currency: toCurrencyInput,
        isPlaceholder: { not: true },
      },
      select: { id: true, name: true, kind: true, currency: true, householdId: true, isActive: true },
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    });
    if (existing) {
      toAccount = existing.isActive
        ? existing
        : await tx.account.update({
            where: { id: existing.id },
            data: { isActive: true },
            select: { id: true, name: true, kind: true, currency: true, householdId: true },
          });
    } else {
      toAccount = await tx.account.create({
        data: {
          name: targetName,
          kind: fromAccount.kind,
          currency: toCurrencyInput,
          householdId,
          groupId: fromAccount.groupId,
          institutionId: fromAccount.institutionId,
          userId: fromAccount.userId,
          isActive: true,
        },
        select: { id: true, name: true, kind: true, currency: true, householdId: true },
      });
    }
  }
  if (!toAccount) throw new Error("换入账户不存在，且无法自动创建");
  const toCurrency = normalizeCurrency(toAccount.currency);
  if (fromCurrency === toCurrency) throw new Error("同币种账户请使用普通转账，不需要换汇交易");
  return { fromAccount, toAccount, fromCurrency, toCurrency };
}

/**
 * POST /api/v1/fx-conversions
 *
 * Creates a cross-currency conversion as two single-sided cash-flow TxRecord rows
 * linked by FxConversion. Ordinary transfer remains same-currency only.
 *
 * Body:
 * - date: YYYY-MM-DD
 * - fromAccountId: source debit-card account, debited in fromAccount.currency
 * - toAccountId?: target account, credited in toAccount.currency. When omitted, server auto-resolves/creates one from toCurrency.
 * - toCurrency?: required when toAccountId is omitted
 * - fromAmount: positive amount paid from source account; include bank fees here if cash actually leaves the source account
 * - toAmount: positive amount received by target account
 * - exchangeRate?: target currency per 1 source currency; computed from toAmount / fromAmount when omitted
 * - feeAmount?: optional memo-only fee amount in source currency, not additionally deducted from balance
 * - note?: string
 *
 * Response:
 * - { ok: true, conversion, entries: { fromEntry, toEntry } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const date = parseDateOnlyUtc(body.date);
    const fromAccountId = String(body.fromAccountId ?? "").trim();
    const toAccountId = String(body.toAccountId ?? "").trim();
    const requestedToCurrency = String(body.toCurrency ?? "").trim()
      ? normalizeCurrency(body.toCurrency)
      : "";
    const fromAmount = parsePositiveAmount(body.fromAmount);
    const toAmount = parsePositiveAmount(body.toAmount);
    const explicitRate = parsePositiveAmount(body.exchangeRate);
    const feeAmount = body.feeAmount == null || body.feeAmount === "" ? null : parsePositiveAmount(body.feeAmount);
    const note = String(body.note ?? "").trim() || null;

    if (!date) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "换汇日期不正确" }, { status: 400 });
    if (!fromAccountId) return NextResponse.json({ ok: false, code: "MISSING_FROM_ACCOUNT", error: "请选择换出账户" }, { status: 400 });
    if (fromAccountId === toAccountId) return NextResponse.json({ ok: false, code: "SAME_ACCOUNT_NOT_ALLOWED", error: "换出账户和换入账户不能相同" }, { status: 400 });
    if (fromAmount == null || toAmount == null) return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "换出金额和换入金额必须大于 0" }, { status: 400 });
    if (body.feeAmount != null && body.feeAmount !== "" && feeAmount == null) {
      return NextResponse.json({ ok: false, code: "INVALID_FEE_AMOUNT", error: "手续费必须大于 0，或留空" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const { fromAccount, toAccount, fromCurrency, toCurrency } = await resolveFxAccounts(tx, {
        householdId,
        fromAccountId,
        toAccountId,
        requestedToCurrency,
      });
      const exchangeRate = explicitRate ?? toAmount / fromAmount;
      if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error("汇率不正确");
      const noteText = note ?? `换汇：${fromCurrency} -> ${toCurrency}`;

      const fromEntry = await tx.txRecord.create({
        data: {
          householdId,
          date,
          type: TransactionType.transfer,
          amount: -fromAmount,
          accountId: fromAccount.id,
          accountName: fromAccount.name,
          toAccountId: toAccount.id,
          toAccountName: toAccount.name,
          categoryName: FX_CONVERSION_CATEGORY,
          currency: fromCurrency,
          source: FX_CONVERSION_SOURCE,
          note: noteText,
        },
      });
      const toEntry = await tx.txRecord.create({
        data: {
          householdId,
          date,
          type: TransactionType.transfer,
          amount: toAmount,
          accountId: toAccount.id,
          accountName: toAccount.name,
          toAccountId: fromAccount.id,
          toAccountName: fromAccount.name,
          categoryName: FX_CONVERSION_CATEGORY,
          currency: toCurrency,
          source: FX_CONVERSION_SOURCE,
          note: noteText,
        },
      });
      const conversion = await tx.fxConversion.create({
        data: {
          householdId,
          date,
          fromEntryId: fromEntry.id,
          toEntryId: toEntry.id,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          fromCurrency,
          toCurrency,
          fromAmount,
          toAmount,
          exchangeRate,
          feeAmount,
          note,
        },
      });
      return { conversion, fromEntry, toEntry };
    });

    await Promise.all([
      recalcAndSaveAccountBalance(result.conversion.fromAccountId),
      recalcAndSaveAccountBalance(result.conversion.toAccountId),
    ]);
    revalidateAfterTxChange();

    return NextResponse.json({
      ok: true,
      conversion: serializeConversion(result.conversion),
      entries: {
        fromEntry: { id: result.fromEntry.id },
        toEntry: { id: result.toEntry.id },
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "CONVERSION_FAILED", error: error instanceof Error ? error.message : "换汇失败" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const url = new URL(req.url);
    const entryId = String(url.searchParams.get("entryId") ?? "").trim();
    const id = String(url.searchParams.get("id") ?? "").trim();
    if (!entryId && !id) return NextResponse.json({ ok: false, code: "MISSING_CONVERSION_ID", error: "缺少换汇记录 ID" }, { status: 400 });

    const conversion = await prisma.fxConversion.findFirst({
      where: {
        householdId,
        ...(id ? { id } : { OR: [{ fromEntryId: entryId }, { toEntryId: entryId }] }),
      },
    });
    if (!conversion) return NextResponse.json({ ok: false, code: "CONVERSION_NOT_FOUND", error: "未找到换汇记录" }, { status: 404 });
    return NextResponse.json({ ok: true, conversion: serializeConversion(conversion) });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "读取换汇记录失败" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const entryId = String(body.entryId ?? "").trim();
    const conversionId = String(body.id ?? "").trim();
    const date = parseDateOnlyUtc(body.date);
    const fromAccountId = String(body.fromAccountId ?? "").trim();
    const toAccountId = String(body.toAccountId ?? "").trim();
    const requestedToCurrency = String(body.toCurrency ?? "").trim()
      ? normalizeCurrency(body.toCurrency)
      : "";
    const fromAmount = parsePositiveAmount(body.fromAmount);
    const toAmount = parsePositiveAmount(body.toAmount);
    const explicitRate = parsePositiveAmount(body.exchangeRate);
    const feeAmount = body.feeAmount == null || body.feeAmount === "" ? null : parsePositiveAmount(body.feeAmount);
    const note = String(body.note ?? "").trim() || null;

    if (!entryId && !conversionId) return NextResponse.json({ ok: false, code: "MISSING_CONVERSION_ID", error: "缺少换汇记录 ID" }, { status: 400 });
    if (!date) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "换汇日期不正确" }, { status: 400 });
    if (!fromAccountId) return NextResponse.json({ ok: false, code: "MISSING_FROM_ACCOUNT", error: "请选择换出账户" }, { status: 400 });
    if (fromAccountId === toAccountId) return NextResponse.json({ ok: false, code: "SAME_ACCOUNT_NOT_ALLOWED", error: "换出账户和换入账户不能相同" }, { status: 400 });
    if (fromAmount == null || toAmount == null) return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "换出金额和换入金额必须大于 0" }, { status: 400 });
    if (body.feeAmount != null && body.feeAmount !== "" && feeAmount == null) {
      return NextResponse.json({ ok: false, code: "INVALID_FEE_AMOUNT", error: "手续费必须大于 0，或留空" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.fxConversion.findFirst({
        where: {
          householdId,
          ...(conversionId ? { id: conversionId } : { OR: [{ fromEntryId: entryId }, { toEntryId: entryId }] }),
        },
      });
      if (!current) throw new Error("未找到换汇记录");
      const previousAccountIds = [current.fromAccountId, current.toAccountId];
      const { fromAccount, toAccount, fromCurrency, toCurrency } = await resolveFxAccounts(tx, {
        householdId,
        fromAccountId,
        toAccountId,
        requestedToCurrency,
      });
      const exchangeRate = explicitRate ?? toAmount / fromAmount;
      if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error("汇率不正确");
      const noteText = note ?? `换汇：${fromCurrency} -> ${toCurrency}`;

      const fromEntry = await tx.txRecord.update({
        where: { id: current.fromEntryId },
        data: {
          date,
          type: TransactionType.transfer,
          amount: -fromAmount,
          accountId: fromAccount.id,
          accountName: fromAccount.name,
          toAccountId: toAccount.id,
          toAccountName: toAccount.name,
          categoryId: null,
          categoryName: FX_CONVERSION_CATEGORY,
          currency: fromCurrency,
          source: FX_CONVERSION_SOURCE,
          note: noteText,
        },
      });
      const toEntry = await tx.txRecord.update({
        where: { id: current.toEntryId },
        data: {
          date,
          type: TransactionType.transfer,
          amount: toAmount,
          accountId: toAccount.id,
          accountName: toAccount.name,
          toAccountId: fromAccount.id,
          toAccountName: fromAccount.name,
          categoryId: null,
          categoryName: FX_CONVERSION_CATEGORY,
          currency: toCurrency,
          source: FX_CONVERSION_SOURCE,
          note: noteText,
        },
      });
      const conversion = await tx.fxConversion.update({
        where: { id: current.id },
        data: {
          date,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          fromCurrency,
          toCurrency,
          fromAmount,
          toAmount,
          exchangeRate,
          feeAmount,
          note,
        },
      });
      return { conversion, fromEntry, toEntry, recalcAccountIds: Array.from(new Set([...previousAccountIds, fromAccount.id, toAccount.id])) };
    });

    await Promise.all(result.recalcAccountIds.map((id) => recalcAndSaveAccountBalance(id)));
    revalidateAfterTxChange();

    return NextResponse.json({
      ok: true,
      conversion: serializeConversion(result.conversion),
      entries: {
        fromEntry: { id: result.fromEntry.id },
        toEntry: { id: result.toEntry.id },
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "SAVE_FAILED", error: error instanceof Error ? error.message : "保存换汇记录失败" }, { status: 500 });
  }
}
