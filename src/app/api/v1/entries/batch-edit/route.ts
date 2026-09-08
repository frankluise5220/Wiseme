import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

function parsePrompt(prompt: string) {
  let dateFrom = "";
  let dateTo = "";
  let amountMin: number | undefined;
  let amountMax: number | undefined;

  // Date range: "2025-01 to 2025-03" or Chinese year/month phrasing
  const rangeMatch = prompt.match(/(\d{4}-\d{2}|\d{4}\s*年\s*\d{1,2}\s*月)\s*[到至\-]\s*(\d{4}-\d{2}|\d{4}\s*年\s*\d{1,2}\s*月)/);
  if (rangeMatch) {
    const fromP = rangeMatch[1].match(/(\d{4}).*?(\d{1,2})/);
    const toP = rangeMatch[2].match(/(\d{4}).*?(\d{1,2})/);
    if (fromP) dateFrom = `${fromP[1]}-${fromP[2].padStart(2, "0")}`;
    if (toP) dateTo = `${toP[1]}-${toP[2].padStart(2, "0")}`;
  } else {
    const months: string[] = [];
    const yearMonth = prompt.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/g) || prompt.match(/\d{4}-\d{2}/g) || [];
    for (const m of yearMonth) {
      const parts = m.match(/(\d{4}).*?(\d{1,2})/) || m.match(/(\d{4})-(\d{2})/);
      if (parts) months.push(`${parts[1]}-${parts[2].padStart(2, "0")}`);
    }
    if (months.length >= 2) { dateFrom = months[0]; dateTo = months[months.length - 1]; }
    else if (months.length === 1) dateFrom = months[0];
  }

  // Amount: e.g. "amount under 500" or "amount over 100"
  const amtLt = prompt.match(/金额\s*(小于|低于|不超过|<=?)\s*(\d+)/);
  const amtGt = prompt.match(/金额\s*(大于|高于|大于等于|不低于|>=?)\s*(\d+)/);
  if (amtLt) amountMax = parseInt(amtLt[2]);
  if (amtGt) amountMin = parseInt(amtGt[2]);

  // Fund code change: e.g. "change to 004011" or "change fund to 014982"
  const changeFund = prompt.match(/(?:改成|改成\s*基金|基金\s*改成|基金代码\s*改成?)\s*(\d{6})/);
  const newFundCode = changeFund?.[1] || null;

  return { dateFrom, dateTo, amountMin, amountMax, newFundCode };
}

/**
 * POST /api/v1/entries/batch-edit
 *
 * Body: { prompt: string, accountId?: string, fundCode?: string, apply?: boolean }
 *
 * Without apply: returns preview with matching records
 * With apply=true: applies the changes
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;
    const body = await req.json();
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return NextResponse.json({ ok: false, code: "MISSING_PROMPT", error: "请输入修改指令" }, { status: 400 });

    const accountId = String(body.accountId ?? "").trim();
    const fundCodeFilter = String(body.fundCode ?? "").trim();
    const apply = body.apply === true;

    const { dateFrom, dateTo, amountMin, amountMax, newFundCode } = parsePrompt(prompt);

    // Build filter against independent fund transactions. TxRecord is cash-flow only.
    const where: any = { deletedAt: null, ...hidFilter };
    if (accountId) where.OR = [{ fundAccountId: accountId }, { cashAccountId: accountId }];
    if (fundCodeFilter) where.fundCode = fundCodeFilter;
    if (dateFrom) where.applyDate = { ...(where.applyDate || {}), gte: new Date(`${dateFrom}-01T00:00:00.000Z`) };
    if (dateTo) {
      const end = new Date(`${dateTo}-01T00:00:00.000Z`);
      end.setUTCMonth(end.getUTCMonth() + 1);
      where.applyDate = { ...(where.applyDate || {}), lt: end };
    }
    if (amountMin !== undefined || amountMax !== undefined) {
      where.grossAmount = {
        ...(amountMin !== undefined ? { gte: amountMin } : {}),
        ...(amountMax !== undefined ? { lte: amountMax } : {}),
      };
    }

    if (!apply) {
      // Preview mode
      const preview = await prisma.fundTransaction.findMany({
        where,
        select: { id: true, applyDate: true, grossAmount: true, fundCode: true, fundName: true, fundSubtype: true, note: true, fundAccountId: true, cashAccountId: true },
        orderBy: { applyDate: "asc" },
        take: 200,
      });

      return NextResponse.json({
        ok: true,
        preview: {
          count: preview.length,
          samples: preview.slice(0, 10).map(e => ({
            id: e.id, date: e.applyDate.toISOString().slice(0, 10),
            amount: Number(e.grossAmount), fundCode: e.fundCode, fundName: e.fundName,
            subtype: e.fundSubtype, note: e.note,
          })),
          changes: newFundCode ? { fundCode: newFundCode } : null,
          parsed: { dateFrom, dateTo, amountMin, amountMax, newFundCode },
        },
      });
    }

    // Apply mode
    if (!newFundCode) {
      return NextResponse.json({ ok: false, code: "UNSUPPORTED_OPERATION", error: "当前只支持批量修改基金代码" }, { status: 400 });
    }

    const records = await prisma.fundTransaction.findMany({
      where,
      select: { id: true, fundAccountId: true, fundCode: true },
    });

    if (records.length === 0) {
      return NextResponse.json({ ok: false, code: "RECORD_NOT_FOUND", error: "没有匹配的记录" }, { status: 404 });
    }

    const name = await prisma.fundNavCache.findFirst({
      where: { fundCode: newFundCode },
      orderBy: { navDate: "desc" },
      select: { name: true },
    });
    await prisma.fundTransaction.updateMany({
      where: { id: { in: records.map(e => e.id) } },
      data: { fundCode: newFundCode, fundName: name?.name ?? newFundCode },
    });

    const recalcMap = new Map<string, Set<string>>();
    for (const record of records) {
      const codes = recalcMap.get(record.fundAccountId) ?? new Set<string>();
      codes.add(record.fundCode);
      codes.add(newFundCode);
      recalcMap.set(record.fundAccountId, codes);
    }
    for (const [fundAccountId, codes] of recalcMap.entries()) {
      await recalcFundPositions(fundAccountId, Array.from(codes)).catch(() => {});
    }
    revalidateAfterInvestChange();

    return NextResponse.json({ ok: true, updatedCount: records.length });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}
