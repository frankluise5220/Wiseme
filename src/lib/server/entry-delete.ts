import { Prisma, type TxRecord } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { chunk, IN_CHUNK_SIZE } from "@/lib/server/prisma-in-chunks";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcPropertyAssetsFromTransactions } from "@/lib/property/transactions";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";
import { recalcWealthPositions } from "@/lib/wealth-position";
import { isAdmin } from "@/lib/server/auth";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import {
  listEntryBusinessDeleteImpacts,
  mergeEntryBusinessLinkMetadata,
  upsertLegacyCombinedEntryBusinessLink,
} from "@/lib/server/entry-business-link";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";

export type EntryDeleteLinkedAction = "deleteBusiness" | "keepBusiness";

type EntryDeleteOptions = {
  linkedAction?: EntryDeleteLinkedAction;
};

function collectInvestmentRecalcTargets(
  txRecord: Pick<TxRecord, "accountId" | "toAccountId" | "type" | "fundProductType" | "fundSubtype" | "metalTypeId">,
  targets: {
    accountsToRecalcBalance: Set<string>;
    fundAccountsToRecalc: Map<string, string[]>;
    metalAccountsToRecalc: Set<string>;
    stockAccountsToRecalc: Set<string>;
    wealthAccountsToRecalc: Set<string>;
    propertyAssetIdsToRecalc?: Set<string>;
  },
) {
  if (txRecord.accountId) targets.accountsToRecalcBalance.add(txRecord.accountId);
  if (txRecord.toAccountId) targets.accountsToRecalcBalance.add(txRecord.toAccountId);

  const isRedeemLike = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
  const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId ?? txRecord.accountId;
  if ((txRecord.metalTypeId || txRecord.fundProductType === "metal") && investmentAccId) {
    targets.metalAccountsToRecalc.add(investmentAccId);
    return;
  }
  if (txRecord.fundProductType === "wealth" && investmentAccId) {
    targets.wealthAccountsToRecalc.add(investmentAccId);
    return;
  }
  if (txRecord.fundProductType === "stock" && investmentAccId) {
    targets.stockAccountsToRecalc.add(investmentAccId);
    return;
  }
}

function businessAccountSnapshotOf(txRecord: TxRecord) {
  const isReceiptLike =
    txRecord.fundSubtype === "redeem" ||
    txRecord.fundSubtype === "switch_out" ||
    txRecord.fundSubtype === "dividend_cash" ||
    txRecord.source === "regular_invest_refund";
  const id = isReceiptLike ? txRecord.accountId : txRecord.toAccountId ?? txRecord.accountId;
  const name = isReceiptLike ? txRecord.accountName : txRecord.toAccountName ?? txRecord.accountName;
  return { id, name };
}

type InvestmentRecalcTargets = {
  accountsToRecalcBalance: Set<string>;
  fundAccountsToRecalc: Map<string, string[]>;
  metalAccountsToRecalc: Set<string>;
  stockAccountsToRecalc: Set<string>;
  wealthAccountsToRecalc: Set<string>;
  propertyAssetIdsToRecalc: Set<string>;
};

type IndependentBusinessDeleteResult = {
  deletedCount: number;
  deletedEntryIds: string[];
  removedEntryIds: string[];
  touchedInvestment: boolean;
};

export type EntryDeleteResult = {
  deletedCount: number;
  keptBusinessCount: number;
  deletedEntryIds: string[];
  removedEntryIds: string[];
  accountIds: string[];
};

function addOptionalAccountId(targets: InvestmentRecalcTargets, accountId: string | null | undefined) {
  if (accountId) targets.accountsToRecalcBalance.add(accountId);
}

function addFundRecalcTarget(targets: InvestmentRecalcTargets, accountId: string, fundCode: string) {
  const codes = targets.fundAccountsToRecalc.get(accountId) ?? [];
  if (!codes.includes(fundCode)) codes.push(fundCode);
  targets.fundAccountsToRecalc.set(accountId, codes);
}

async function collectFundTransactionRecalcTargetsByEntryIds(
  householdId: string,
  entryIds: string[],
  targets: InvestmentRecalcTargets,
) {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) return;
  // The OR contains 4 `{ in: ids }` clauses (including nested `some` relations),
  // so large batches exceed SQLite's parameter limit. Query in chunks.
  const fundTargets: { fundAccountId: string; fundCode: string }[] = [];
  for (const part of chunk(ids, IN_CHUNK_SIZE)) {
    const rows = await prisma.fundTransaction.findMany({
      where: {
        householdId,
        OR: [
          { id: { in: part } },
          { cashEntryId: { in: part } },
          { cashFlows: { some: { txRecordId: { in: part } } } },
          { EntryBusinessLink: { some: { cashEntryId: { in: part } } } },
        ],
      },
      select: { fundAccountId: true, fundCode: true },
    });
    fundTargets.push(...rows);
  }
  for (const row of fundTargets) {
    addFundRecalcTarget(targets, row.fundAccountId, row.fundCode);
  }
}

async function softDeleteIndependentBusinessRecordsByIds(
  ctx: HouseholdContext,
  entryIds: string[],
  targets: InvestmentRecalcTargets,
): Promise<IndependentBusinessDeleteResult> {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  const result: IndependentBusinessDeleteResult = {
    deletedCount: 0,
    deletedEntryIds: [],
    removedEntryIds: [],
    touchedInvestment: false,
  };
  if (ids.length === 0) return result;

  const deletedAt = new Date();
  const pushRemovedIds = (businessId: string, cashEntryId?: string | null) => {
    result.deletedEntryIds.push(businessId);
    result.removedEntryIds.push(businessId);
    if (cashEntryId) result.removedEntryIds.push(cashEntryId);
  };

  const fundRows = await prisma.fundTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, fundAccountId: true, cashAccountId: true, fundCode: true },
  });
  for (const row of fundRows) {
    const updated = await prisma.fundTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.fundAccountId);
    addOptionalAccountId(targets, row.cashAccountId);
    addFundRecalcTarget(targets, row.fundAccountId, row.fundCode);
  }

  const insuranceRows = await prisma.insuranceTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of insuranceRows) {
    const updated = await prisma.insuranceTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
    targets.wealthAccountsToRecalc.add(row.accountId);
  }

  const wealthRows = await prisma.wealthTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of wealthRows) {
    const updated = await prisma.wealthTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
  }

  const depositRows = await prisma.depositTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of depositRows) {
    const updated = await prisma.depositTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
  }

  const metalRows = await prisma.preciousMetalTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of metalRows) {
    const updated = await prisma.preciousMetalTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
    targets.metalAccountsToRecalc.add(row.accountId);
  }

  const stockRows = await prisma.stockTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, stockAccountId: true, cashAccountId: true },
  });
  for (const row of stockRows) {
    const updated = await prisma.stockTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.stockAccountId);
    addOptionalAccountId(targets, row.cashAccountId);
    targets.stockAccountsToRecalc.add(row.stockAccountId);
  }

  const propertyRows = await prisma.propertyTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true, propertyAssetId: true },
  });
  for (const row of propertyRows) {
    const updated = await prisma.propertyTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
    targets.propertyAssetIdsToRecalc.add(row.propertyAssetId);
  }

  const independentBusinessIds = result.deletedEntryIds;
  const removedCashEntryIds = result.removedEntryIds.filter((id) => !independentBusinessIds.includes(id));

  // One updateMany used to combine 8 business-side `in` clauses with 1 cash-side
  // `in` clause, exceeding SQLite's parameter limit for large batches. Split
  // them into separate chunked passes. Setting the same deletedAt is idempotent,
  // so any cross-chunk overlap costs nothing.
  const businessLinkWhere = (ids: string[]): Prisma.EntryBusinessLinkWhereInput => ({
    householdId: ctx.householdId,
    deletedAt: null,
    OR: [
      { businessEntryId: { in: ids } },
      { fundTransactionId: { in: ids } },
      { insuranceTransactionId: { in: ids } },
      { wealthTransactionId: { in: ids } },
      { depositTransactionId: { in: ids } },
      { preciousMetalTransactionId: { in: ids } },
      { stockTransactionId: { in: ids } },
      { propertyTransactionId: { in: ids } },
    ],
  });
  for (const part of chunk(independentBusinessIds, IN_CHUNK_SIZE)) {
    await prisma.entryBusinessLink.updateMany({ where: businessLinkWhere(part), data: { deletedAt } });
  }
  for (const part of chunk(removedCashEntryIds, IN_CHUNK_SIZE)) {
    await prisma.entryBusinessLink.updateMany({
      where: { householdId: ctx.householdId, deletedAt: null, cashEntryId: { in: part } },
      data: { deletedAt },
    });
  }

  result.deletedEntryIds = Array.from(new Set(result.deletedEntryIds));
  result.removedEntryIds = Array.from(new Set(result.removedEntryIds));
  return result;
}

async function detachLegacyCombinedBusinessEntry(txRecord: TxRecord) {
  const businessAccount = businessAccountSnapshotOf(txRecord);
  if (!businessAccount.id) return false;

  await prisma.txRecord.update({
    where: { id: txRecord.id },
    data: {
      accountId: businessAccount.id,
      accountName: businessAccount.name || txRecord.accountName,
      toAccountId: null,
      toAccountName: null,
    },
  });
  const links = await prisma.entryBusinessLink.findMany({
    where: { cashEntryId: txRecord.id, businessEntryId: txRecord.id, deletedAt: null },
    select: { id: true, metadata: true },
  });
  for (const link of links) {
    await prisma.entryBusinessLink.update({
      where: { id: link.id },
      data: {
        cashEntryId: null,
        note: "Cash side detached; business detail kept",
        metadata: mergeEntryBusinessLinkMetadata(link.metadata, { cashDetached: true }),
      },
    });
  }
  return true;
}

async function detachCashSideBusinessLinks(txRecord: TxRecord) {
  const links = await prisma.entryBusinessLink.findMany({
    where: { cashEntryId: txRecord.id, deletedAt: null },
    select: { id: true, businessEntryId: true, metadata: true },
  });
  const detachedLinks = links.filter((link) => link.businessEntryId !== txRecord.id);
  for (const link of detachedLinks) {
    await prisma.entryBusinessLink.update({
      where: { id: link.id },
      data: {
        cashEntryId: null,
        note: "Cash side detached; business detail kept",
        metadata: mergeEntryBusinessLinkMetadata(link.metadata, {
          cashDetached: true,
          detachedCashEntryId: txRecord.id,
        }),
      },
    });
  }
  return detachedLinks.length > 0;
}

async function detachBusinessSideBusinessLinks(txRecord: TxRecord) {
  const links = await prisma.entryBusinessLink.findMany({
    where: { businessEntryId: txRecord.id, deletedAt: null },
    select: { id: true, cashEntryId: true, metadata: true },
  });
  const detachedLinks = links.filter((link) => link.cashEntryId !== txRecord.id);
  for (const link of detachedLinks) {
    await prisma.entryBusinessLink.update({
      where: { id: link.id },
      data: {
        businessEntryId: null,
        fundTransactionId: null,
        insuranceTransactionId: null,
        wealthTransactionId: null,
        depositTransactionId: null,
        preciousMetalTransactionId: null,
        stockTransactionId: null,
        propertyTransactionId: null,
        note: "Business side detached; cash detail kept",
        metadata: mergeEntryBusinessLinkMetadata(link.metadata, {
          businessDetached: true,
          detachedBusinessEntryId: txRecord.id,
        }),
      },
    });
  }
  return detachedLinks.length > 0;
}

export async function softDeleteEntriesByIds(
  ctx: HouseholdContext,
  entryIds: string[],
  label?: string,
  options: EntryDeleteOptions = {},
): Promise<EntryDeleteResult> {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) {
    return { deletedCount: 0, keptBusinessCount: 0, deletedEntryIds: [], removedEntryIds: [], accountIds: [] };
  }

  const undo = await prepareEntryUndo(prisma, ctx.householdId, ids);
  let deletedCount = 0;
  let keptBusinessCount = 0;
  const deletedEntryIds: string[] = [];
  const removedEntryIds: string[] = [];
  const fundAccountsToRecalc = new Map<string, string[]>();
  const metalAccountsToRecalc = new Set<string>();
  const stockAccountsToRecalc = new Set<string>();
  const wealthAccountsToRecalc = new Set<string>();
  const propertyAssetIdsToRecalc = new Set<string>();
  const accountsToRecalcBalance = new Set<string>();
  const changedFundEntryIds: string[] = [];
  const processedInstallmentPlanIds = new Set<string>();
  let touchedInvestment = false;

  for (const entryId of ids) {
    const txRecord = await prisma.txRecord.findUnique({ where: { id: entryId } });
    if (!txRecord) continue;
    if (txRecord.deletedAt) continue;
    if (!isAdmin(ctx.user) && txRecord.householdId && txRecord.householdId !== ctx.householdId) continue;
    await upsertLegacyCombinedEntryBusinessLink(prisma, txRecord).catch(
      logger.catchLog("同步交易业务关联失败", "entry-delete.ts"),
    );
    const keepBusinessImpacts = options.linkedAction === "keepBusiness"
      ? await listEntryBusinessDeleteImpacts(ctx, [txRecord.id]).catch(() => [])
      : [];
    const hasLegacyCombinedBusiness = keepBusinessImpacts.some((impact) => impact.legacyCombinedRecord);
    if (hasLegacyCombinedBusiness) {
      if (await detachLegacyCombinedBusinessEntry(txRecord)) {
        keptBusinessCount++;
        removedEntryIds.push(txRecord.id);
        changedFundEntryIds.push(txRecord.id);
        if (txRecord.type === "investment" || txRecord.fundProductType) touchedInvestment = true;
        collectInvestmentRecalcTargets(txRecord, {
          accountsToRecalcBalance,
          fundAccountsToRecalc,
          metalAccountsToRecalc,
          stockAccountsToRecalc,
          wealthAccountsToRecalc,
          propertyAssetIdsToRecalc,
        });
        const businessAccount = businessAccountSnapshotOf(txRecord);
        if (businessAccount.id) accountsToRecalcBalance.add(businessAccount.id);
        continue;
      }
    }
    if (options.linkedAction === "keepBusiness" && keepBusinessImpacts.length > 0) {
      const selectedAsBusiness = keepBusinessImpacts.some((impact) => impact.selectedSide === "business");
      if (selectedAsBusiness) await detachBusinessSideBusinessLinks(txRecord);
      else await detachCashSideBusinessLinks(txRecord);
    }

    const installmentPlan = await prisma.creditCardInstallmentPlan.findFirst({
      where: {
        householdId: ctx.householdId,
        OR: [
          { sourceEntryId: txRecord.id },
          ...(txRecord.creditCardInstallmentPlanId ? [{ id: txRecord.creditCardInstallmentPlanId }] : []),
        ],
      },
      select: { id: true, accountId: true },
    });

    let deletedWithInstallmentPlan = false;
    if (installmentPlan && !processedInstallmentPlanIds.has(installmentPlan.id)) {
      processedInstallmentPlanIds.add(installmentPlan.id);
      const deletedAt = new Date();
      const relatedRecords = await prisma.txRecord.findMany({
        where: {
          householdId: ctx.householdId,
          creditCardInstallmentPlanId: installmentPlan.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      const related = await prisma.txRecord.updateMany({
        where: {
          householdId: ctx.householdId,
          creditCardInstallmentPlanId: installmentPlan.id,
          deletedAt: null,
        },
        data: { deletedAt },
      });
      await prisma.creditCardInstallmentPlan.update({
        where: { id: installmentPlan.id },
        data: { status: "cancelled" },
      });
      for (const record of relatedRecords) {
        deletedEntryIds.push(record.id);
        removedEntryIds.push(record.id);
      }
      accountsToRecalcBalance.add(installmentPlan.accountId);
      deletedCount += related.count;
      deletedWithInstallmentPlan = txRecord.creditCardInstallmentPlanId === installmentPlan.id;
    }

    if (!deletedWithInstallmentPlan) {
      await prisma.txRecord.update({
        where: { id: txRecord.id },
        data: { deletedAt: new Date() },
      });
      deletedCount++;
      deletedEntryIds.push(txRecord.id);
      removedEntryIds.push(txRecord.id);
    }

    changedFundEntryIds.push(txRecord.id);
    if (txRecord.type === "investment" || txRecord.fundProductType) touchedInvestment = true;
    collectInvestmentRecalcTargets(txRecord, {
      accountsToRecalcBalance,
      fundAccountsToRecalc,
      metalAccountsToRecalc,
      stockAccountsToRecalc,
      wealthAccountsToRecalc,
      propertyAssetIdsToRecalc,
    });

  }

  if (options.linkedAction !== "keepBusiness") {
    const independentDelete = await softDeleteIndependentBusinessRecordsByIds(ctx, ids, {
      accountsToRecalcBalance,
      fundAccountsToRecalc,
      metalAccountsToRecalc,
      stockAccountsToRecalc,
      wealthAccountsToRecalc,
      propertyAssetIdsToRecalc,
    });
    deletedCount += independentDelete.deletedCount;
    deletedEntryIds.push(...independentDelete.deletedEntryIds);
    removedEntryIds.push(...independentDelete.removedEntryIds);
    if (independentDelete.touchedInvestment) touchedInvestment = true;
  }

  if (changedFundEntryIds.length > 0) {
    await syncFundTransactionsFromTxRecords(changedFundEntryIds).catch(logger.catchLog("同步基金业务单失败", "entry-delete.ts"));
    for (const id of changedFundEntryIds) {
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id }).catch(
        logger.catchLog("同步独立业务单失败", "entry-delete.ts"),
      );
    }
  }
  await collectFundTransactionRecalcTargetsByEntryIds(
    ctx.householdId,
    [...changedFundEntryIds, ...deletedEntryIds, ...removedEntryIds],
    {
      accountsToRecalcBalance,
      fundAccountsToRecalc,
      metalAccountsToRecalc,
      stockAccountsToRecalc,
      wealthAccountsToRecalc,
      propertyAssetIdsToRecalc,
    },
  ).catch(logger.catchLog("收集基金重算目标失败", "entry-delete.ts"));
  for (const [accountId, fundCodes] of fundAccountsToRecalc) {
    await recalcFundPositions(accountId, fundCodes).catch(logger.catchLog("操作失败", "entry-delete.ts"));
  }
  for (const accountId of metalAccountsToRecalc) {
    await recalcPreciousMetalPositions(accountId).catch(logger.catchLog("操作失败", "entry-delete.ts"));
  }
  for (const accountId of stockAccountsToRecalc) {
    await recalcStockPositions(accountId).catch(logger.catchLog("股票持仓重算失败", "entry-delete.ts"));
  }
  for (const accountId of wealthAccountsToRecalc) {
    await recalcWealthPositions(accountId).catch(logger.catchLog("理财持仓收益重算失败", "entry-delete.ts"));
  }
  await recalcPropertyAssetsFromTransactions(prisma, {
    householdId: ctx.householdId,
    propertyAssetIds: Array.from(propertyAssetIdsToRecalc),
  }).catch(logger.catchLog("房产资产重算失败", "entry-delete.ts"));
  for (const accountId of accountsToRecalcBalance) {
    await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "entry-delete.ts"));
  }
  await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalcBalance).catch(
    logger.catchLog("信用卡账单缓存失效失败", "entry-delete.ts"),
  );

  if (deletedCount > 0) {
    await saveEntryUndo(
      prisma,
      ctx,
      undo,
      deletedCount > 1 ? "batch_delete" : "delete",
      label ?? (deletedCount > 1 ? `批量删除 ${deletedCount} 条明细` : "删除明细"),
    );
    if (touchedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();
  } else if (keptBusinessCount > 0) {
    await saveEntryUndo(
      prisma,
      ctx,
      undo,
      keptBusinessCount > 1 ? "batch_delete" : "delete",
      label ?? (keptBusinessCount > 1 ? `移除 ${keptBusinessCount} 条资金流水并保留业务明细` : "移除资金流水并保留业务明细"),
    );
    if (touchedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();
  }

  return {
    deletedCount,
    keptBusinessCount,
    deletedEntryIds: Array.from(new Set(deletedEntryIds)),
    removedEntryIds: Array.from(new Set(removedEntryIds)),
    accountIds: Array.from(accountsToRecalcBalance),
  };
}
