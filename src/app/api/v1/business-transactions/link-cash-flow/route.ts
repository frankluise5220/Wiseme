/**
 * API: /api/v1/business-transactions/link-cash-flow
 *
 * POST
 *   Body: { businessType: "wealth" | "deposit" | "insurance" | "metal" | "fund" | "stock" | "property", businessTransactionId: string }
 *
 * Creates or restores the cash-side TxRecord for an independent business
 * transaction, then writes the EntryBusinessLink. A highlighted link icon means
 * this cash-side record exists and is not soft-deleted.
 */
import { NextResponse } from "next/server";
import { FundCashFlowKind, FundSubtype, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { buildWealthCashFlowNote } from "@/lib/wealth-cash-note";
import { recalcWealthPositions } from "@/lib/wealth-position";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { ensureStockTransactionCashFlow } from "@/lib/stock/cashFlow";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";
import { ensurePropertyTransactionCashFlow } from "@/lib/property/cashFlow";
import { getCashFlowDate } from "@/lib/cash-flow-date";

export const runtime = "nodejs";

function isWealthCashInAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.redeem || action === FundSubtype.switch_out || action === FundSubtype.dividend_cash;
}

function cashFlowDirection(amount: number) {
  return amount < 0 ? "outflow" : amount > 0 ? "inflow" : "none";
}

function fundCashFlowKind(action: FundSubtype | string | null | undefined) {
  if (action === FundSubtype.buy || action === FundSubtype.buy_failed) return FundCashFlowKind.buy_out;
  if (action === FundSubtype.redeem || action === FundSubtype.switch_out) return FundCashFlowKind.redeem_in;
  if (action === FundSubtype.dividend_cash) return FundCashFlowKind.dividend_in;
  if (action === FundSubtype.dividend_reinvest) return FundCashFlowKind.dividend_reinvest_internal;
  if (action === FundSubtype.switch_in) return FundCashFlowKind.switch_in;
  return FundCashFlowKind.other;
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const businessType = String(body?.businessType ?? "").trim();
    const businessTransactionId = String(body?.businessTransactionId ?? "").trim();

    if (!["wealth", "deposit", "insurance", "metal", "fund", "stock", "property"].includes(businessType)) {
      return NextResponse.json({ ok: false, code: "UNSUPPORTED_BUSINESS_TYPE", error: "不支持的业务交易类型" }, { status: 400 });
    }
    if (!businessTransactionId) {
      return NextResponse.json({ ok: false, code: "MISSING_BUSINESS_TRANSACTION_ID", error: "缺少 businessTransactionId" }, { status: 400 });
    }

    const touchedAccountIds = new Set<string>();
    const stockAccountsToRecalc = new Set<string>();
    const result = await prisma.$transaction(async (tx) => {
      if (businessType === "wealth") {
        const row = await tx.wealthTransaction.findFirst({
          where: { id: businessTransactionId, householdId, deletedAt: null },
          include: {
            Account: true,
            CashAccount: true,
            WealthProduct: true,
          },
        });
        if (!row) throw new Error("理财交易记录不存在");
        if (!row.cashAccountId || !row.CashAccount) throw new Error("这条理财记录缺少资金账户，无法自动建立资金侧记录");

        const action = row.action;
        const isCashIn = isWealthCashInAction(action);
        const grossAmount = Math.abs(toNumber(row.grossAmount));
        const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
        const cashAmount = isCashIn ? (arrivalAmount ?? grossAmount) : grossAmount;
        if (!cashAmount) throw new Error("这条理财记录金额不正确，无法建立资金侧记录");

        const categoryName = getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: action });
        const category = categoryName
          ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: "investment" })
          : null;
        const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
        const cashDate = getCashFlowDate({
          direction: isCashIn ? "inflow" : "outflow",
          operationDate: row.tradeDate,
          settlementDate: row.arrivalDate,
        });
        const cashNote = buildWealthCashFlowNote({
          action,
          productName: row.WealthProduct?.name ?? row.productName,
          units: row.units == null ? null : toNumber(row.units),
          userNote: row.note,
        });

        const cashEntryData = {
          householdId,
          date: cashDate,
          type: TransactionType.investment,
          accountId: isCashIn ? row.accountId : row.cashAccountId,
          accountName: isCashIn ? row.Account.name : row.CashAccount.name,
          toAccountId: isCashIn ? row.cashAccountId : row.accountId,
          toAccountName: isCashIn ? row.CashAccount.name : row.Account.name,
          amount: signedCashAmount,
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? categoryName ?? null,
          currency: row.CashAccount.currency ?? row.Account.currency ?? "CNY",
          source: row.source ?? "manual",
          note: cashNote,
          fundCode: null,
          fundProductType: null,
          fundSubtype: null,
          fundName: null,
          wealthProductId: null,
          fundUnits: null,
          fundNav: null,
          fundFee: null,
          fundConfirmDate: null,
          fundArrivalDate: null,
          fundArrivalAmount: null,
          depositAnnualRate: null,
          depositInterest: null,
          realizedProfit: null,
          deletedAt: null,
        };

        const existingCashEntry = row.cashEntryId
          ? await tx.txRecord.findUnique({ where: { id: row.cashEntryId } })
          : null;
        const cashEntry = existingCashEntry
          ? await tx.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
          : await tx.txRecord.create({ data: cashEntryData });

        await tx.wealthTransaction.update({
          where: { id: row.id },
          data: {
            cashEntryId: cashEntry.id,
            cashAccountId: row.cashAccountId,
          },
        });

        await upsertEntryBusinessCashFlowLink(tx, {
          householdId,
          cashEntryId: cashEntry.id,
          businessEntryId: null,
          wealthTransactionId: row.id,
          businessType: "wealth",
          cashFlowDirection: cashFlowDirection(signedCashAmount),
          source: row.source ?? "manual",
          note: "Linked cash flow to wealth transaction",
          metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
        });

        touchedAccountIds.add(row.accountId);
        touchedAccountIds.add(row.cashAccountId);
        return { cashEntryId: cashEntry.id, businessTransactionId: row.id };
      }

      if (businessType === "deposit") {
        const row = await tx.depositTransaction.findFirst({
          where: { id: businessTransactionId, householdId, deletedAt: null },
          include: { Account: true, CashAccount: true },
        });
        if (!row) throw new Error("存款交易记录不存在");
        if (!row.cashAccountId || !row.CashAccount) throw new Error("这条存款记录缺少资金账户，无法自动建立资金侧记录");
        const isCashIn = isWealthCashInAction(row.action);
        const principal = Math.abs(toNumber(row.principalAmount));
        const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
        const cashAmount = isCashIn ? (arrivalAmount ?? principal) : principal;
        if (!cashAmount) throw new Error("这条存款记录金额不正确，无法建立资金侧记录");
        const categoryName = getInvestmentCategoryName({ fundProductType: "deposit", fundSubtype: row.action });
        const category = categoryName
          ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: "investment" })
          : null;
        const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
        const cashEntryData = {
          householdId,
          date: getCashFlowDate({
            direction: isCashIn ? "inflow" : "outflow",
            operationDate: row.tradeDate,
            settlementDate: row.arrivalDate,
          }),
          type: TransactionType.investment,
          accountId: isCashIn ? row.accountId : row.cashAccountId,
          accountName: isCashIn ? row.Account.name : row.CashAccount.name,
          toAccountId: isCashIn ? row.cashAccountId : row.accountId,
          toAccountName: isCashIn ? row.CashAccount.name : row.Account.name,
          amount: signedCashAmount,
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? categoryName ?? null,
          currency: row.CashAccount.currency ?? row.Account.currency ?? "CNY",
          source: row.source ?? "manual",
          note: row.note,
          fundCode: null,
          fundProductType: null,
          fundSubtype: null,
          fundName: null,
          wealthProductId: null,
          fundUnits: null,
          fundNav: null,
          fundFee: null,
          fundConfirmDate: null,
          fundArrivalDate: null,
          fundArrivalAmount: null,
          depositAnnualRate: null,
          depositInterest: null,
          realizedProfit: row.realizedProfit,
          deletedAt: null,
        };
        const existingCashEntry = row.cashEntryId
          ? await tx.txRecord.findUnique({ where: { id: row.cashEntryId } })
          : null;
        const cashEntry = existingCashEntry
          ? await tx.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
          : await tx.txRecord.create({ data: cashEntryData });
        await tx.depositTransaction.update({ where: { id: row.id }, data: { cashEntryId: cashEntry.id, cashAccountId: row.cashAccountId } });
        await upsertEntryBusinessCashFlowLink(tx, {
          householdId,
          cashEntryId: cashEntry.id,
          businessEntryId: null,
          depositTransactionId: row.id,
          businessType: "deposit",
          cashFlowDirection: cashFlowDirection(signedCashAmount),
          source: row.source ?? "manual",
          note: "Linked cash flow to deposit transaction",
          metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
        });
        touchedAccountIds.add(row.accountId);
        touchedAccountIds.add(row.cashAccountId);
        return { cashEntryId: cashEntry.id, businessTransactionId: row.id };
      }

      if (businessType === "insurance") {
        const row = await tx.insuranceTransaction.findFirst({
          where: { id: businessTransactionId, householdId, deletedAt: null },
          include: { Account: true, CashAccount: true, InsuranceProduct: true },
        });
        if (!row) throw new Error("保险交易记录不存在");
        if (!row.cashAccountId || !row.CashAccount) throw new Error("这条保险记录缺少资金账户，无法自动建立资金侧记录");
        const isCashIn = row.action === "refund";
        const cashAmount = Math.abs(toNumber(row.amount));
        if (!cashAmount) throw new Error("这条保险记录金额不正确，无法建立资金侧记录");
        const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
        const cashEntryData = {
          householdId,
          date: getCashFlowDate({
            direction: isCashIn ? "inflow" : "outflow",
            operationDate: row.tradeDate,
            settlementDate: row.arrivalDate,
          }),
          type: TransactionType.investment,
          accountId: isCashIn ? row.accountId : row.cashAccountId,
          accountName: isCashIn ? row.Account.name : row.CashAccount.name,
          toAccountId: isCashIn ? row.cashAccountId : row.accountId,
          toAccountName: isCashIn ? row.CashAccount.name : row.Account.name,
          amount: signedCashAmount,
          categoryId: null,
          categoryName: isCashIn ? "保险回款" : "保险缴费",
          currency: row.CashAccount.currency ?? row.Account.currency ?? "CNY",
          source: row.source ?? "manual",
          note: row.note ?? row.InsuranceProduct?.name ?? null,
          fundCode: null,
          fundProductType: null,
          fundSubtype: null,
          fundName: null,
          wealthProductId: null,
          insuranceProductId: null,
          insuranceAction: null,
          insuranceProductName: null,
          fundUnits: null,
          fundNav: null,
          fundFee: null,
          fundConfirmDate: null,
          fundArrivalDate: null,
          fundArrivalAmount: null,
          depositAnnualRate: null,
          depositInterest: null,
          realizedProfit: null,
          deletedAt: null,
        };
        const existingCashEntry = row.cashEntryId
          ? await tx.txRecord.findUnique({ where: { id: row.cashEntryId } })
          : null;
        const cashEntry = existingCashEntry
          ? await tx.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
          : await tx.txRecord.create({ data: cashEntryData });
        await tx.insuranceTransaction.update({ where: { id: row.id }, data: { cashEntryId: cashEntry.id, cashAccountId: row.cashAccountId } });
        await upsertEntryBusinessCashFlowLink(tx, {
          householdId,
          cashEntryId: cashEntry.id,
          businessEntryId: null,
          insuranceTransactionId: row.id,
          businessType: "insurance",
          cashFlowDirection: cashFlowDirection(signedCashAmount),
          source: row.source ?? "manual",
          note: "Linked cash flow to insurance transaction",
          metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
        });
        touchedAccountIds.add(row.accountId);
        touchedAccountIds.add(row.cashAccountId);
        return { cashEntryId: cashEntry.id, businessTransactionId: row.id };
      }

      if (businessType === "fund") {
        const row = await tx.fundTransaction.findFirst({
          where: { id: businessTransactionId, householdId, deletedAt: null },
          include: { Account: true, CashAccount: true },
        });
        if (!row) throw new Error("基金交易记录不存在");
        if (!row.cashAccountId || !row.CashAccount) throw new Error("这条基金记录缺少资金账户，无法自动建立资金侧记录");
        const isCashIn = isWealthCashInAction(row.fundSubtype);
        const grossAmount = Math.abs(toNumber(row.grossAmount));
        const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
        const cashAmount = isCashIn ? (arrivalAmount ?? grossAmount) : grossAmount;
        if (!cashAmount) throw new Error("这条基金记录金额不正确，无法建立资金侧记录");
        const categoryName = getInvestmentCategoryName({ fundProductType: row.fundProductType, fundSubtype: row.fundSubtype });
        const category = categoryName
          ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: "investment" })
          : null;
        const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
        const cashDate = getCashFlowDate({
          direction: isCashIn ? "inflow" : "outflow",
          operationDate: row.applyDate,
          settlementDate: row.arrivalDate,
        });
        const cashEntryData = {
          householdId,
          date: cashDate,
          type: TransactionType.investment,
          accountId: isCashIn ? row.fundAccountId : row.cashAccountId,
          accountName: isCashIn ? row.Account.name : row.CashAccount.name,
          toAccountId: isCashIn ? row.cashAccountId : row.fundAccountId,
          toAccountName: isCashIn ? row.CashAccount.name : row.Account.name,
          amount: signedCashAmount,
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? categoryName ?? null,
          currency: row.CashAccount.currency ?? row.Account.currency ?? "CNY",
          source: row.source ?? "manual",
          note: row.note,
          fundCode: row.fundCode,
          fundProductType: row.fundProductType,
          fundSubtype: row.fundSubtype,
          fundName: row.fundName,
          wealthProductId: null,
          fundUnits: row.units,
          fundNav: row.nav,
          fundFee: row.fee,
          fundConfirmDate: row.confirmDate,
          fundArrivalDate: row.arrivalDate,
          fundArrivalAmount: row.arrivalAmount,
          depositAnnualRate: null,
          depositInterest: null,
          realizedProfit: row.realizedProfit,
          deletedAt: null,
        };
        const existingCashEntry = row.cashEntryId
          ? await tx.txRecord.findUnique({ where: { id: row.cashEntryId } })
          : null;
        const cashEntry = existingCashEntry
          ? await tx.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
          : await tx.txRecord.create({ data: cashEntryData });
        await tx.fundTransaction.update({ where: { id: row.id }, data: { cashEntryId: cashEntry.id, cashAccountId: row.cashAccountId } });
        await tx.fundTransactionCashFlow.upsert({
          where: { txRecordId: cashEntry.id },
          create: {
            id: `cff_${cashEntry.id}`,
            fundTransactionId: row.id,
            txRecordId: cashEntry.id,
            kind: fundCashFlowKind(row.fundSubtype),
            amount: Math.abs(cashAmount),
            flowDate: cashDate,
            accountId: row.cashAccountId,
          },
          update: {
            fundTransactionId: row.id,
            kind: fundCashFlowKind(row.fundSubtype),
            amount: Math.abs(cashAmount),
            flowDate: cashDate,
            accountId: row.cashAccountId,
          },
        });
        await upsertEntryBusinessCashFlowLink(tx, {
          householdId,
          cashEntryId: cashEntry.id,
          businessEntryId: null,
          fundTransactionId: row.id,
          businessType: "fund",
          cashFlowDirection: cashFlowDirection(signedCashAmount),
          source: row.source ?? "manual",
          note: "Linked cash flow to fund transaction",
          metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
        });
        touchedAccountIds.add(row.fundAccountId);
        touchedAccountIds.add(row.cashAccountId);
        return { cashEntryId: cashEntry.id, businessTransactionId: row.id };
      }

      if (businessType === "stock") {
        const row = await tx.stockTransaction.findFirst({
          where: { id: businessTransactionId, householdId, deletedAt: null },
          include: { StockAccount: true, CashAccount: true },
        });
        if (!row) throw new Error("股票交易记录不存在");
        if (!row.cashAccountId || !row.CashAccount) throw new Error("这条股票记录缺少资金账户，无法自动建立资金侧记录");

        const link = await ensureStockTransactionCashFlow(tx, {
          householdId,
          row,
          stockAccount: row.StockAccount,
          cashAccount: row.CashAccount,
          metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
        });
        if (!link.cashEntryId) throw new Error("这条股票记录不是资金流交易，无法建立资金侧记录");

        touchedAccountIds.add(row.stockAccountId);
        touchedAccountIds.add(row.cashAccountId);
        stockAccountsToRecalc.add(row.stockAccountId);
        return { cashEntryId: link.cashEntryId, businessTransactionId: row.id, linkId: link.linkId };
      }

      if (businessType === "property") {
        const row = await tx.propertyTransaction.findFirst({
          where: { id: businessTransactionId, householdId, deletedAt: null },
          include: { Account: true, CashAccount: true, PropertyAsset: true },
        });
        if (!row) throw new Error("房产交易记录不存在");
        if (!row.cashAccountId || !row.CashAccount) throw new Error("这条房产记录缺少资金账户，无法自动建立资金侧记录");

        const link = await ensurePropertyTransactionCashFlow(tx, {
          householdId,
          row,
          propertyAccount: row.Account,
          cashAccount: row.CashAccount,
          metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
        });
        if (!link.cashEntryId) throw new Error("这条房产记录不是资金流交易，无法建立资金侧记录");

        touchedAccountIds.add(row.accountId);
        touchedAccountIds.add(row.cashAccountId);
        return { cashEntryId: link.cashEntryId, businessTransactionId: row.id, linkId: link.linkId };
      }

      const row = await tx.preciousMetalTransaction.findFirst({
        where: { id: businessTransactionId, householdId, deletedAt: null },
        include: { Account: true, CashAccount: true },
      });
      if (!row) throw new Error("贵金属交易记录不存在");
      if (!row.cashAccountId || !row.CashAccount) throw new Error("这条贵金属记录缺少资金账户，无法自动建立资金侧记录");
      const isCashIn = isWealthCashInAction(row.action);
      const cashAmount = Math.abs(toNumber(row.amount));
      if (!cashAmount) throw new Error("这条贵金属记录金额不正确，无法建立资金侧记录");
      const categoryName = getInvestmentCategoryName({ fundProductType: "metal", fundSubtype: row.action });
      const category = categoryName
        ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: "investment" })
        : null;
      const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
      const cashEntryData = {
        householdId,
        date: row.tradeDate,
        type: TransactionType.investment,
        accountId: isCashIn ? row.accountId : row.cashAccountId,
        accountName: isCashIn ? row.Account.name : row.CashAccount.name,
        toAccountId: isCashIn ? row.cashAccountId : row.accountId,
        toAccountName: isCashIn ? row.CashAccount.name : row.Account.name,
        amount: signedCashAmount,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? categoryName ?? null,
        currency: row.CashAccount.currency ?? row.Account.currency ?? "CNY",
        source: row.source ?? "manual",
        note: row.note,
        fundCode: null,
        fundProductType: null,
        fundSubtype: null,
        fundName: null,
        wealthProductId: null,
        metalTypeId: null,
        metalTypeName: null,
        metalUnitId: null,
        metalUnitName: null,
        metalQuantity: null,
        metalUnitPrice: null,
        metalFee: null,
        fundUnits: null,
        fundNav: null,
        fundFee: null,
        fundConfirmDate: null,
        fundArrivalDate: null,
        fundArrivalAmount: null,
        depositAnnualRate: null,
        depositInterest: null,
        realizedProfit: null,
        deletedAt: null,
      };
      const existingCashEntry = row.cashEntryId
        ? await tx.txRecord.findUnique({ where: { id: row.cashEntryId } })
        : null;
      const cashEntry = existingCashEntry
        ? await tx.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
        : await tx.txRecord.create({ data: cashEntryData });
      await tx.preciousMetalTransaction.update({ where: { id: row.id }, data: { cashEntryId: cashEntry.id, cashAccountId: row.cashAccountId } });
      await upsertEntryBusinessCashFlowLink(tx, {
        householdId,
        cashEntryId: cashEntry.id,
        businessEntryId: null,
        preciousMetalTransactionId: row.id,
        businessType: "metal",
        cashFlowDirection: cashFlowDirection(signedCashAmount),
        source: row.source ?? "manual",
        note: "Linked cash flow to precious metal transaction",
        metadata: { splitRecord: true, independentBusinessTransaction: true, repairedBy: "link-cash-flow" },
      });
      touchedAccountIds.add(row.accountId);
      touchedAccountIds.add(row.cashAccountId);
      return { cashEntryId: cashEntry.id, businessTransactionId: row.id };
    });

    for (const id of stockAccountsToRecalc) {
      await recalcStockPositions(id).catch(() => undefined);
    }
    for (const id of touchedAccountIds) {
      await recalcWealthPositions(id).catch(() => undefined);
      await recalcAndSaveAccountBalance(id).catch(() => undefined);
    }
    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => undefined);
    revalidateAfterInvestChange();

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "LINK_CASH_FLOW_FAILED", error: error instanceof Error ? error.message : "建立关联失败" },
      { status: 500 },
    );
  }
}
