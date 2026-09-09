/**
 * API: /api/v1/bill/billing-day-rules
 *
 * Manages the per-credit-card billing-day history (CreditCardBillingDay).
 * All mutations are applied to every credit-card account of the same
 * institution bill group (mirrors recordCreditCardBillingDayChange) and
 * invalidate the persisted credit-card cycle cache so the bill view
 * recomputes from the new rules.
 *
 * POST   { accountId, effectiveDate: "YYYY-MM-DD", billingDay: 1-31 }
 *        Upsert one rule (create, or overwrite the billing day of an
 *        existing effective date).
 * PUT    { accountId, originalEffectiveDate, effectiveDate, billingDay }
 *        Move/change a rule atomically. Rejects when the target date is
 *        already taken by another rule.
 * DELETE { accountId, effectiveDate }
 *        Remove one rule. Deleting the last rule falls back to the
 *        account's current billing day.
 *
 * Every response returns `{ ok: true, data: { rules } }` with the refreshed
 * rule list (deduped by effectiveDate, ascending).
 */
import { AccountKind, type Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function parseDateOnly(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseBillingDay(value: unknown): number | null {
  const day = Math.trunc(Number(value));
  return Number.isFinite(day) && day >= 1 && day <= 31 ? day : null;
}

async function resolveBillGroup(householdId: string, accountId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: AccountKind.bank_credit },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      kind: true,
      creditBillMode: true,
      billingDay: true,
      repaymentDay: true,
      billingDayTxPeriod: true,
    },
  });
  if (!account) return null;
  const billAccountIds = await getCreditBillAccountIds(prisma, account);
  return { account, billAccountIds };
}

type RuleRow = { effectiveDate: Date; billingDay: number; updatedAt: Date };

function dedupeRules(rows: RuleRow[]) {
  const byDate = new Map<string, RuleRow>();
  for (const row of rows) {
    const key = row.effectiveDate.toISOString().slice(0, 10);
    const existing = byDate.get(key);
    if (!existing || row.updatedAt > existing.updatedAt) byDate.set(key, row);
  }
  return Array.from(byDate.values())
    .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime())
    .map((row) => ({
      effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
      billingDay: row.billingDay,
      isInitial: row.effectiveDate.getTime() === new Date(Date.UTC(1900, 0, 1)).getTime(),
    }));
}

async function listRules(accountId: string, billAccountIds: string[]): Promise<{ rules: ReturnType<typeof dedupeRules> }> {
  const rows = await prisma.creditCardBillingDay.findMany({
    where: { accountId: { in: billAccountIds.length > 0 ? billAccountIds : [accountId] } },
    select: { effectiveDate: true, billingDay: true, updatedAt: true },
    orderBy: { effectiveDate: "asc" },
  });
  return { rules: dedupeRules(rows) };
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const billingDay = parseBillingDay(body?.billingDay);
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    if (!effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期格式不正确" }, { status: 400 });
    if (!billingDay) return NextResponse.json({ ok: false, code: "INVALID_BILLING_DAY", error: "账单日应为 1-31 的整数" }, { status: 400 });

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    for (const id of group.billAccountIds) {
      await prisma.creditCardBillingDay.upsert({
        where: { accountId_effectiveDate: { accountId: id, effectiveDate } },
        create: { accountId: id, effectiveDate, billingDay },
        update: { billingDay },
      });
    }
    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("POST /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "保存账单日记录失败" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    const originalEffectiveDate = parseDateOnly(body?.originalEffectiveDate);
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const billingDay = parseBillingDay(body?.billingDay);
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    if (!originalEffectiveDate || !effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期格式不正确" }, { status: 400 });
    if (!billingDay) return NextResponse.json({ ok: false, code: "INVALID_BILLING_DAY", error: "账单日应为 1-31 的整数" }, { status: 400 });

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    const moving = originalEffectiveDate.getTime() !== effectiveDate.getTime();
    if (moving) {
      const target = await prisma.creditCardBillingDay.findFirst({
        where: { accountId: group.billAccountIds[0] ?? accountId, effectiveDate },
        select: { id: true },
      });
      if (target) {
        return NextResponse.json({ ok: false, code: "EFFECTIVE_DATE_CONFLICT", error: "该生效日期已存在账单日记录，请直接编辑那一条" }, { status: 409 });
      }
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (moving) {
        await tx.creditCardBillingDay.deleteMany({
          where: { accountId: { in: group.billAccountIds }, effectiveDate: originalEffectiveDate },
        });
      }
      for (const id of group.billAccountIds) {
        await tx.creditCardBillingDay.upsert({
          where: { accountId_effectiveDate: { accountId: id, effectiveDate } },
          create: { accountId: id, effectiveDate, billingDay },
          update: { billingDay },
        });
      }
    });
    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("PUT /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "更新账单日记录失败" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户" }, { status: 400 });
    if (!effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期格式不正确" }, { status: 400 });

    const group = await resolveBillGroup(householdId, accountId);
    if (!group) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });

    await prisma.creditCardBillingDay.deleteMany({
      where: { accountId: { in: group.billAccountIds }, effectiveDate },
    });
    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds, { deleteManualCycles: false });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, data: await listRules(accountId, group.billAccountIds) });
  } catch (error) {
    console.error("DELETE /api/v1/bill/billing-day-rules error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : "删除账单日记录失败" }, { status: 500 });
  }
}
