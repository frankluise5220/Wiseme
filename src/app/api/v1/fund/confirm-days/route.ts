import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getFundConfirmRule, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * Fund confirm-day rules (T+N for buy confirmation and fund arrival).
 *
 * GET /api/v1/fund/confirm-days
 * Query params:
 * - accountId: required. Investment account id.
 * - fundCode: optional. When present, returns the single rule for that fund
 *   (with account defaults as fallback).
 * - list: "1". When present (and no fundCode), returns the full rule table for
 *   the account: every fund seen in transactions plus every stored rule, with
 *   fund name, days, arrivalDays, redeemCostDays and effectiveDate.
 *
 * GET responses:
 * - single: { ok, days, redeemCostDays, arrivalDays }
 * - list: { ok, rows: [{ fundCode, fundName, days, arrivalDays, redeemCostDays, effectiveDate }] }
 * `days` and `arrivalDays` are trading-day counts from the application date.
 * `arrivalDays` drives the cash-arrival date directly and must skip weekends and fund holidays.
 *
 * POST /api/v1/fund/confirm-days
 * Body: { accountId, rows: [{ fundCode, days?, arrivalDays?, redeemCostDays?, effectiveDate? }] }
 * Saves rows as a batch (upsert per account+fundCode).
 * When `applyAccounts` is provided (array of investment account ids sharing the
 * same institution), the same rule values are copied to those accounts for the
 * same fundCode.
 *
 * DELETE /api/v1/fund/confirm-days?accountId=...&fundCode=...
 * Deletes the single rule for the given accountId + fundCode pair.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();
  const listMode = searchParams.get("list") === "1";

  if (!accountId) {
    return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "accountId is required." }, { status: 400 });
  }

  try {
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...ctx.hidFilter },
      select: { id: true, defaultConfirmDays: true, defaultArrivalDays: true, institutionId: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    if (fundCode) {
      const record = await prisma.fundConfirmDays.findUnique({
        where: { accountId_fundCode: { accountId, fundCode } },
        select: { redeemCostDays: true, effectiveDate: true },
      });
      const rule = await getFundConfirmRule(accountId, fundCode, {
        days: account.defaultConfirmDays,
        arrivalDays: account.defaultArrivalDays,
      });
      return NextResponse.json({
        ok: true,
        days: rule.days,
        redeemCostDays: normalizeNonNegativeDays(record?.redeemCostDays, 1),
        arrivalDays: rule.arrivalDays,
        effectiveDate: record?.effectiveDate ? record.effectiveDate.toISOString().slice(0, 10) : null,
      });
    }

    if (listMode) {
      // Every fund code seen in transactions for this account, plus any stored rule.
      const [txCodes, storedRules] = await Promise.all([
        prisma.fundTransaction.findMany({
          where: { fundAccountId: accountId, deletedAt: null, fundCode: { not: undefined } },
          select: { fundCode: true, fundName: true, confirmDate: true },
          orderBy: [{ fundCode: "asc" }, { confirmDate: "desc" }, { createdAt: "desc" }],
          take: 20000,
        }),
        prisma.fundConfirmDays.findMany({
          where: { accountId },
          select: { fundCode: true, days: true, arrivalDays: true, redeemCostDays: true, effectiveDate: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
        }),
      ]);
      const fundNameByCode = new Map<string, string>();
      for (const row of txCodes) {
        if (row.fundCode && row.fundName && !fundNameByCode.has(row.fundCode)) {
          fundNameByCode.set(row.fundCode, row.fundName);
        }
      }
      const ruleByCode = new Map<string, (typeof storedRules)[number]>();
      for (const rule of storedRules) {
        if (!ruleByCode.has(rule.fundCode)) ruleByCode.set(rule.fundCode, rule);
      }
      const codeSet = new Set<string>([...fundNameByCode.keys(), ...ruleByCode.keys()]);
      const rows = Array.from(codeSet).sort().map((code) => {
        const rule = ruleByCode.get(code);
        return {
          fundCode: code,
          fundName: fundNameByCode.get(code) ?? null,
          days: rule ? normalizeNonNegativeDays(rule.days, 0) : normalizeNonNegativeDays(account.defaultConfirmDays, 0),
          arrivalDays: rule ? normalizeNonNegativeDays(rule.arrivalDays, 2) : normalizeNonNegativeDays(account.defaultArrivalDays, 2),
          redeemCostDays: rule ? normalizeNonNegativeDays(rule.redeemCostDays, 1) : 1,
          effectiveDate: rule?.effectiveDate ? rule.effectiveDate.toISOString().slice(0, 10) : null,
        };
      });
      return NextResponse.json({ ok: true, rows });
    }

    return NextResponse.json({
      ok: true,
      days: normalizeNonNegativeDays(account.defaultConfirmDays, 0),
      redeemCostDays: 1,
      arrivalDays: normalizeNonNegativeDays(account.defaultArrivalDays, 2),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "Failed to fetch confirm days." },
      { status: 500 }
    );
  }
}

type ConfirmDayRowInput = {
  fundCode?: string;
  days?: number;
  arrivalDays?: number;
  redeemCostDays?: number;
  effectiveDate?: string | null;
};

function parseRowInput(row: ConfirmDayRowInput) {
  const fundCode = String(row.fundCode ?? "").trim();
  const hasEffectiveDate = Object.prototype.hasOwnProperty.call(row, "effectiveDate");
  return {
    fundCode,
    days: typeof row.days === "number" ? normalizeNonNegativeDays(row.days, 0) : undefined,
    arrivalDays: typeof row.arrivalDays === "number" ? normalizeNonNegativeDays(row.arrivalDays, 2) : undefined,
    redeemCostDays: typeof row.redeemCostDays === "number" ? normalizeNonNegativeDays(row.redeemCostDays, 1) : undefined,
    effectiveDate: hasEffectiveDate
      ? typeof row.effectiveDate === "string" && row.effectiveDate.trim()
        ? row.effectiveDate.trim()
        : null
      : undefined,
  };
}

async function upsertRule(accountId: string, input: ReturnType<typeof parseRowInput>) {
  const existing = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode: input.fundCode } },
  });
  const data: Record<string, string | number | Date | null> = {};
  if (input.days !== undefined) data.days = input.days;
  if (input.arrivalDays !== undefined) data.arrivalDays = input.arrivalDays;
  if (input.redeemCostDays !== undefined) data.redeemCostDays = input.redeemCostDays;
  if (input.effectiveDate !== undefined) {
    data.effectiveDate = input.effectiveDate ? new Date(`${input.effectiveDate}T00:00:00.000Z`) : null;
  }
  if (existing) {
    if (Object.keys(data).length > 0) {
      await prisma.fundConfirmDays.update({ where: { id: existing.id }, data });
    }
  } else {
    await prisma.fundConfirmDays.create({
      data: {
        accountId,
        fundCode: input.fundCode,
        days: input.days ?? 0,
        arrivalDays: input.arrivalDays ?? 2,
        redeemCostDays: input.redeemCostDays ?? 1,
        ...(input.effectiveDate ? { effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`) } : {}),
      },
    });
  }
}

async function deleteRule(accountId: string, fundCode: string) {
  const existing = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
    select: { id: true },
  });
  if (!existing) {
    return null;
  }
  await prisma.fundConfirmDays.delete({ where: { id: existing.id } });
  return existing.id;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: string;
      rows?: ConfirmDayRowInput[];
      applyAccounts?: string[];
      institutionId?: string;
      fundCode?: string;
      days?: number;
      arrivalDays?: number;
      redeemCostDays?: number;
      effectiveDate?: string | null;
    } | null;
    if (!body?.accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "accountId is required." }, { status: 400 });
    }
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: body.accountId, ...ctx.hidFilter },
      select: { id: true, householdId: true, institutionId: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    const rows = Array.isArray(body.rows) && body.rows.length > 0
      ? body.rows
      : body.fundCode
        ? [{
            fundCode: body.fundCode,
            days: body.days,
            arrivalDays: body.arrivalDays,
            redeemCostDays: body.redeemCostDays,
            effectiveDate: body.effectiveDate,
          }]
        : [];
    for (const raw of rows) {
      const input = parseRowInput(raw);
      if (!input.fundCode) continue;
      await upsertRule(body.accountId, input);
    }

    // Copy the same fund rules to other accounts (same institution), usually
    // triggered from the "apply to institution funds" picker.
    const applyAccounts = Array.isArray(body.applyAccounts) ? body.applyAccounts.filter(Boolean) : [];
    if (applyAccounts.length > 0 && rows.length > 0) {
      const validTargets = await prisma.account.findMany({
        where: {
          ...ctx.hidFilter,
          id: { in: applyAccounts },
          kind: "investment",
        },
        select: { id: true },
      });
      const targetIds = new Set(validTargets.map((target) => target.id));
      for (const raw of rows) {
        const input = parseRowInput(raw);
        if (!input.fundCode) continue;
        for (const targetId of targetIds) {
          if (targetId === body.accountId) continue;
          await upsertRule(targetId, input);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "SAVE_FAILED", error: e instanceof Error ? e.message : "Failed to save confirm days." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId")?.trim();
    const fundCode = searchParams.get("fundCode")?.trim();
    if (!accountId || !fundCode) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "accountId and fundCode are required." }, { status: 400 });
    }
    const ctx = await getHouseholdScope();
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }
    const deletedId = await deleteRule(accountId, fundCode);
    if (!deletedId) {
      return NextResponse.json({ ok: false, code: "RULE_NOT_FOUND", error: "Confirm day rule not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "DELETE_FAILED", error: e instanceof Error ? e.message : "Failed to delete confirm day rule." },
      { status: 500 }
    );
  }
}
