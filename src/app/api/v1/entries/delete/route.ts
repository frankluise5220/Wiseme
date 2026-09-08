import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { softDeleteEntriesByIds, type EntryDeleteLinkedAction } from "@/lib/server/entry-delete";
import { listEntryBusinessDeleteImpacts } from "@/lib/server/entry-business-link";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";

/**
 * Delete / restore transaction records.
 *
 * Delete:
 *   POST { entryIds: string[], checkOnly?: boolean, linkedAction?: "deleteBusiness" | "keepBusiness" }
 *   entryIds must be TxRecord.id
 *   Ordinary entries are soft-deleted.
 *   With checkOnly=true, only reports whether linked business exists without deleting.
 *   If entries link to business details (insurance/fund/wealth/deposit/precious metal) and linkedAction is not passed,
 *   returns { ok:false, needConfirm:true, impacts } for the client to prompt the user.
 *   linkedAction="deleteBusiness" deletes the linked business details too;
 *   linkedAction="keepBusiness" removes only the cash-flow entries and keeps the business details.
 *
 * Restore (undo soft delete):
 *   POST { action: "restore", transactionIds: string[] }
 *   transactionIds must be TxRecord.id
 *
 * Response: { ok: true, message } or { ok: false, error }
 */
export async function POST(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    const { householdId } = ctx;
    const body = await req.json().catch(() => null);
    const action: string | undefined = body?.action;

    if (action === "restore") {
      const transactionIds: string[] | undefined = body?.transactionIds;
      if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
        return NextResponse.json({ ok: false, code: "MISSING_TRANSACTION_IDS", error: "缺少 transactionIds" }, { status: 400 });
      }
      const requestedRecords = await prisma.txRecord.findMany({
        where: { id: { in: transactionIds }, OR: [{ householdId }, { householdId: null }] },
        select: { creditCardInstallmentPlanId: true },
      });
      const res = await prisma.txRecord.updateMany({
        where: { id: { in: transactionIds } },
        data: { deletedAt: null },
      });
      const restoredInstallmentPlans = await prisma.creditCardInstallmentPlan.findMany({
        where: {
          householdId,
          OR: [
            { sourceEntryId: { in: transactionIds } },
            {
              id: {
                in: requestedRecords
                  .map((record) => record.creditCardInstallmentPlanId)
                  .filter((id): id is string => !!id),
              },
            },
          ],
        },
        select: { id: true },
      });
      if (restoredInstallmentPlans.length > 0) {
        const planIds = restoredInstallmentPlans.map((plan) => plan.id);
        await prisma.$transaction([
          prisma.creditCardInstallmentPlan.updateMany({
            where: { id: { in: planIds }, householdId },
            data: { status: "active" },
          }),
          prisma.txRecord.updateMany({
            where: { creditCardInstallmentPlanId: { in: planIds }, householdId },
            data: { deletedAt: null },
          }),
        ]);
      }
      // Collect accounts involved in the restored records and recalculate balances
      const restoredRecords = await prisma.txRecord.findMany({
        where: { id: { in: transactionIds } },
        select: { accountId: true, toAccountId: true, type: true, fundProductType: true, fundSubtype: true, fundCode: true, metalTypeId: true },
      });
      await syncFundTransactionsFromTxRecords(transactionIds).catch(logger.catchLog("同步基金业务单失败", "route.ts"));
      for (const id of transactionIds) {
        await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id }).catch(
          logger.catchLog("同步独立业务单失败", "route.ts"),
        );
      }
      const accountsToRecalc = new Set<string>();
      const fundAccountsToRecalc = new Map<string, string[]>();
      const metalAccountsToRecalc = new Set<string>();
      let touchedInvestment = false;
      for (const r of restoredRecords) {
        if (r.accountId) accountsToRecalc.add(r.accountId);
        if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
        if (r.type === "investment" || r.fundProductType) touchedInvestment = true;
        const isRedeemLike = r.fundSubtype === "redeem" || r.fundSubtype === "switch_out";
        const investmentAccId = isRedeemLike ? r.accountId : r.toAccountId ?? r.accountId;
        if ((r.metalTypeId || r.fundProductType === "metal") && investmentAccId) {
          metalAccountsToRecalc.add(investmentAccId);
        } else if (r.fundCode && r.fundProductType && investmentAccId) {
          const codes = fundAccountsToRecalc.get(investmentAccId) ?? [];
          if (!codes.includes(r.fundCode)) codes.push(r.fundCode);
          fundAccountsToRecalc.set(investmentAccId, codes);
        }
      }
      for (const [acctId, codes] of fundAccountsToRecalc) {
        await recalcFundPositions(acctId, codes).catch(logger.catchLog("操作失败", "route.ts"));
      }
      for (const acctId of metalAccountsToRecalc) {
        await recalcPreciousMetalPositions(acctId).catch(logger.catchLog("操作失败", "route.ts"));
      }
      for (const acctId of accountsToRecalc) {
        await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
      }
      await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalc).catch(
        logger.catchLog("信用卡账单缓存失效失败", "route.ts"),
      );
      if (touchedInvestment) revalidateAfterInvestChange();
      else revalidateAfterTxChange();
      // Client-side will handle page refresh
      return NextResponse.json({ ok: true, count: res.count, accountIds: Array.from(accountsToRecalc), message: `已恢复 ${res.count} 条记录` });
    }

    const entryIds: string[] = body?.entryIds;
    const linkedAction = body?.linkedAction === "deleteBusiness" || body?.linkedAction === "keepBusiness"
      ? body.linkedAction as EntryDeleteLinkedAction
      : undefined;
    const checkOnly = body?.checkOnly === true;

    if (!entryIds || !Array.isArray(entryIds) || entryIds.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_ENTRY_IDS", error: "缺少 entryIds" }, { status: 400 });
    }
    const impacts = await listEntryBusinessDeleteImpacts(ctx, entryIds);
    if (checkOnly) {
      return NextResponse.json({
        ok: true,
        message: impacts.length > 0 ? "存在关联业务，请选择删除范围" : "可以删除",
        needConfirm: impacts.length > 0,
        impacts,
      });
    }
    if (!linkedAction && impacts.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "DELETE_CONFLICT",
          needConfirm: true,
          error: "这些资金交易关联了业务明细，请确认删除方式",
          impacts,
        },
        { status: 409 },
      );
    }

    const effectiveEntryIds = linkedAction === "deleteBusiness"
      ? Array.from(new Set([
          ...entryIds,
          ...impacts.map((impact) => impact.entryId).filter(Boolean),
          ...impacts.map((impact) => impact.businessEntryId).filter(Boolean),
        ]))
      : entryIds;

    const { deletedCount, keptBusinessCount, deletedEntryIds, removedEntryIds, accountIds } = await softDeleteEntriesByIds(ctx, effectiveEntryIds, undefined, { linkedAction });

    if (deletedCount === 0 && keptBusinessCount === 0) {
      return NextResponse.json(
        { ok: false, code: "RECORDS_NOT_FOUND", error: `未找到匹配的记录 (IDs: ${entryIds.slice(0, 3).join(", ")}${entryIds.length > 3 ? "..." : ""})` },
        { status: 404 }
      );
    }

    // Client-side updates visible rows and derived numbers through finance change events.
    return NextResponse.json({
      ok: true,
      message: keptBusinessCount > 0
        ? `已移除 ${keptBusinessCount} 条资金流水并保留业务明细${deletedCount > 0 ? `，另删除 ${deletedCount} 条记录` : ""}`
        : `已删除 ${deletedCount} 条记录`,
      deletedCount,
      keptBusinessCount,
      deletedEntryIds,
      removedEntryIds,
      accountIds,
    });
  } catch (e) {
    console.error("[delete] Error:", e);
    return NextResponse.json(
      { ok: false, code: "DELETE_FAILED", error: e instanceof Error ? e.message : "删除失败" },
      { status: 500 }
    );
  }
}
