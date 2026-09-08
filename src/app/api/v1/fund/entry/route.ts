import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { ensureFundTransactionCashFlowLinks, findFundTransactionForEntryId, getFundCashFlowDate } from "@/lib/fund/transactions";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { resolveCategorySnapshot } from "@/lib/default-categories";

/**
 * Updates a fund transaction entry.
 * PUT /api/v1/fund/entry
 * Body: { id, date?, fundConfirmDate?, fundArrivalDate?, ...other fields }
 * id can be a FundTransaction.id or a linked cash-flow TxRecord.id; the server resolves it to the fund business transaction.
 *
 * Special logic:
 * - If apply date (date) is changed, confirm date (fundConfirmDate) and arrival date (fundArrivalDate) are auto-recomputed
 * - If confirm date (fundConfirmDate) is changed, arrival date (fundArrivalDate) is auto-recomputed
 * - If arrival date (fundArrivalDate) is given directly, no auto computation is performed
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const { id, date, fundConfirmDate, fundArrivalDate, autoCalcConfirmDate } = body;

    if (!id) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });
    }

    const entry = await findFundTransactionForEntryId(prisma, { id, householdId });

    if (!entry || entry.deletedAt) {
      return NextResponse.json({ ok: false, code: "FUND_ENTRY_NOT_FOUND", error: "基金交易记录不存在" }, { status: 404 });
    }

    const updateData: any = {};
    let nextApplyDate: Date | undefined;
    let nextArrivalDate: Date | null | undefined;

    // If the apply date was changed
    if (date) {
      nextApplyDate = new Date(date);
      updateData.applyDate = nextApplyDate;

      // Auto-compute the confirm date
      if (autoCalcConfirmDate !== false) {
        const confirmDays = await getFundConfirmDays(entry.fundAccountId, entry.fundCode);
        const dateStr = new Date(date).toISOString().slice(0, 10);
        const newConfirmDateStr = addWorkdaysUtc(dateStr, confirmDays);
        updateData.confirmDate = new Date(`${newConfirmDateStr}T00:00:00.000Z`);
      }
    }

    // Confirm date is provided by the frontend
    if (fundConfirmDate && !date) {
      updateData.confirmDate = new Date(fundConfirmDate);
    }

    // Arrival date is provided by the frontend (manually entered or derived from arrivalDays)
    if (fundArrivalDate) {
      nextArrivalDate = new Date(fundArrivalDate);
      updateData.arrivalDate = nextArrivalDate;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.fundTransaction.update({
        where: { id: entry.id },
        data: updateData,
      });

      const effectiveApplyDate = row.applyDate;
      const effectiveArrivalDate = row.arrivalDate;
      const categoryName = getInvestmentCategoryName({
        fundProductType: row.fundProductType,
        fundSubtype: row.fundSubtype,
        source: row.source,
      });
      const category = categoryName
        ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: "investment" })
        : null;
      const flows = await tx.fundTransactionCashFlow.findMany({
        where: { fundTransactionId: entry.id },
      });
      for (const flow of flows) {
        const flowDate = getFundCashFlowDate({
          kind: flow.kind,
          applyDate: effectiveApplyDate,
          arrivalDate: effectiveArrivalDate,
          requestedDate: flow.flowDate,
        });
        await tx.fundTransactionCashFlow.update({
          where: { id: flow.id },
          data: { flowDate },
        });
        await tx.txRecord.update({
          where: { id: flow.txRecordId },
          data: {
            date: flowDate,
            categoryId: category?.id ?? null,
            categoryName: category?.name ?? categoryName ?? null,
          },
        }).catch(() => undefined);
      }

      await ensureFundTransactionCashFlowLinks(tx, [entry.id]);
      return row;
    });

    await recalcFundPositions(entry.fundAccountId, [entry.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));

    // Refresh balances of affected accounts
    const accountsToRecalc = new Set<string>();
    if (entry.fundAccountId) accountsToRecalc.add(entry.fundAccountId);
    if (entry.cashAccountId) accountsToRecalc.add(entry.cashAccountId);
    if (updated.fundAccountId) accountsToRecalc.add(updated.fundAccountId);
    if (updated.cashAccountId) accountsToRecalc.add(updated.cashAccountId);
    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    revalidateAfterInvestChange();

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, entry: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: e instanceof Error ? e.message : "修改失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });
    }

    const entry = await findFundTransactionForEntryId(prisma, { id, householdId });

    if (!entry || entry.deletedAt) {
      return NextResponse.json({ ok: false, code: "FUND_ENTRY_NOT_FOUND", error: "基金交易记录不存在" }, { status: 404 });
    }

    const deletedAt = new Date();
    const flowRows = await prisma.fundTransactionCashFlow.findMany({
      where: { fundTransactionId: entry.id },
    });
    const cashEntryIds = Array.from(new Set([
      entry.cashEntryId,
      ...flowRows.map((flow) => flow.txRecordId),
    ].filter((value): value is string => Boolean(value))));

    await prisma.$transaction(async (tx) => {
      await tx.fundTransaction.update({
        where: { id: entry.id },
        data: { deletedAt },
      });
      if (cashEntryIds.length > 0) {
        await tx.txRecord.updateMany({
          where: { id: { in: cashEntryIds }, householdId },
          data: { deletedAt },
        });
      }
      await tx.entryBusinessLink.updateMany({
        where: { householdId, fundTransactionId: entry.id, deletedAt: null },
        data: { deletedAt },
      });
    });

    await recalcFundPositions(entry.fundAccountId, [entry.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));

    // Refresh balances of affected accounts
    const accountsToRecalc = new Set<string>();
    if (entry.fundAccountId) accountsToRecalc.add(entry.fundAccountId);
    if (entry.cashAccountId) accountsToRecalc.add(entry.cashAccountId);
    for (const flow of flowRows) {
      if (flow.accountId) accountsToRecalc.add(flow.accountId);
    }
    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    revalidateAfterInvestChange();

    // Client-side handles page refresh
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "DELETE_FAILED", error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}
