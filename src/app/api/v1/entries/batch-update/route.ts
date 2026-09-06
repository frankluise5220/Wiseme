import { NextRequest, NextResponse } from "next/server";
import { AccountKind, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { evaluateArithmeticExpression } from "@/lib/arithmetic-expression";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundFeeRateByDate, setFundFeeRateByDate } from "@/lib/fund/feeRate";
import { findFundTransactionForEntryId, syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { allocateBuyFailedRefunds, calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { CREDIT_CARD_REPAYMENT_CATEGORY_NAME, isCreditCardRepaymentTransfer } from "@/lib/transaction-semantics";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { upsertStatementCategoryRuleFromSavedRecord } from "@/lib/statement/category-rules";
import { replaceEntryTags, resolveWritableTagIds } from "@/lib/server/entry-tags";
import { creditBillEffectiveDate } from "@/lib/credit/billing";
import { addTradingDaysUtc, toStatementMonth } from "@/lib/date-utils";

/**
 * Batch-updates transaction records.
 *
 * POST {
 *   updates: Array<{
 *     id: string;              // TxRecord.id
 *     date?: string;           // YYYY-MM-DD
 *     postedAt?: string;       // YYYY-MM-DD, pass empty string to clear
 *     type?: "expense" | "income" | "transfer" | "investment";
 *     amount?: string | number;// amount (absolute value), keeps the original record direction
 *     inflow?: string | number;// inflow amount, becomes a positive inflow from the current account view
 *     outflow?: string | number;// outflow amount, becomes a negative outflow from the current account view
 *     account?: string;        // source account Account.id
 *     viewAccount?: string;    // account on the current detail-view side; for credit bills this may be accountId or toAccountId
 *     toAccount?: string;      // destination account Account.id
 *     categoryId?: string;     // income/expense category Category.id, pass empty string to clear
 *     institution?: string;    // counterparty institution name/short name, pass empty string to clear
 *     tagId?: string;           // readable Tag.id, pass empty string to clear all tags
 *     remark?: string;         // note, pass empty string to clear
 *     fundConfirmDate?: string;// confirm date YYYY-MM-DD or T+N offset, pass empty string to clear
 *     fundArrivalDate?: string;// arrival date YYYY-MM-DD or T+N offset, pass empty string to clear
 *     fundFee?: string | number;// fund fee amount, pass empty string to clear
 *     feeRate?: string | number;// fund fee rate percentage, e.g. 0.15
 *     cashAccountId?: string;  // cash account Account.id (lands on accountId/toAccountId by fundSubtype)
 *     fundAccountId?: string;  // fund account Account.id (lands on accountId/toAccountId by fundSubtype)
 *     accountName?: string;    // legacy call compat: source account name
 *   }>;
 *   contextAccountId?: string; // current detail page account. Used when batch-editing the counterparty to preserve income/expense fund direction.
 *   contextAccountIds?: string[]; // current detail page account scope. Multi-account views such as combined credit card bills use it to tell which side is current.
 * }
 *   Response: { ok: true, updatedCount, changed, notFoundIds? }
 *   If none of the IDs match any record, returns { ok: false, error }
 */
type BatchUpdateItem = {
  id: string;
  date?: string;
  postedAt?: string;
  type?: string;
  amount?: string | number;
  inflow?: string | number;
  outflow?: string | number;
  account?: string;
  viewAccount?: string;
  toAccount?: string;
  categoryId?: string;
  institution?: string;
  tagId?: string;
  remark?: string;
  fundConfirmDate?: string;
  fundArrivalDate?: string;
  fundFee?: string | number;
  feeRate?: string | number;
  cashAccountId?: string;
  fundAccountId?: string;
  accountName?: string;
};

const validTypes = new Set<string>(Object.values(TransactionType));

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseAmountUpdate(raw: string, baseAmountAbs: number) {
  const normalized = raw.replace(/[,，￥¥%％\s]/g, "");
  if (!normalized) return null;
  if (!/^[\d.+\-*/()]+$/.test(normalized)) return null;

  let expr = normalized;
  if (/^[+\-*/]/.test(expr)) expr = `${baseAmountAbs}${expr}`;

  const computed = evaluateArithmeticExpression(expr);
  return typeof computed === "number" && Number.isFinite(computed) ? Math.abs(computed) : null;
}

function parseTradingDayOffsetUpdate(raw: string) {
  const normalized = raw.replace(/[,，￥¥%％\s]/g, "");
  if (!normalized) return null;
  if (!/^[\d.+\-*/()]+$/.test(normalized)) return null;

  const computed = evaluateArithmeticExpression(normalized);
  if (typeof computed !== "number" || !Number.isFinite(computed)) return null;
  if (computed < 0 || !Number.isInteger(computed)) return null;
  return computed;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;
    const body = await req.json();
    const updates: BatchUpdateItem[] = body.updates;
    const contextAccountId = String(body.contextAccountId ?? "").trim() || null;
    const contextAccountIds = Array.isArray(body.contextAccountIds)
      ? Array.from(new Set(body.contextAccountIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean)))
      : [];
    const contextAccountIdSet = new Set(contextAccountIds.length > 0 ? contextAccountIds : (contextAccountId ? [contextAccountId] : []));

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ ok: false, code: "BATCH_EMPTY", error: "没有更新数据" }, { status: 400 });
    }

    const ids = Array.from(new Set(updates.map((u) => String(u.id ?? "").trim()).filter(Boolean)));
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, code: "INVALID_RECORD_IDS", error: "没有有效记录ID" }, { status: 400 });
    }

    const existingRecords = await prisma.txRecord.findMany({
      where: { id: { in: ids }, deletedAt: null, ...hidFilter },
      select: {
        id: true,
        date: true,
        postedAt: true,
        type: true,
        amount: true,
        fundSubtype: true,
        source: true,
        accountId: true,
        accountName: true,
        account: { select: { id: true, name: true, kind: true, investProductType: true, billingDay: true, tradingCalendar: true } },
        toAccountId: true,
        toAccountName: true,
        toAccount: { select: { id: true, name: true, kind: true, investProductType: true, billingDay: true, tradingCalendar: true } },
        categoryId: true,
        categoryName: true,
        note: true,
        EntryTag: { select: { tagId: true, Tag: { select: { name: true } } } },
        counterpartyInstitutionName: true,
        paymentChannelName: true,
        fundCode: true,
        fundProductType: true,
        fundUnits: true,
        fundNav: true,
        fundFee: true,
        fundArrivalAmount: true,
        fundSourceEntryId: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
      },
    });
    type ExistingRecord = (typeof existingRecords)[number];
    const existingMap = new Map<string, ExistingRecord>(existingRecords.map((record) => [record.id, record]));
    let notFoundIds = ids.filter((id) => !existingMap.has(id));
    const updateById = new Map(updates.map((item) => [String(item.id ?? "").trim(), item]));
    const directFundUpdateIds = notFoundIds.filter((id) => {
      const item = updateById.get(id);
      return item?.fundFee !== undefined
        || item?.feeRate !== undefined
        || item?.cashAccountId !== undefined
        || item?.fundAccountId !== undefined;
    });
    const directFundTransactions = directFundUpdateIds.length > 0
      ? await prisma.fundTransaction.findMany({
          where: { id: { in: directFundUpdateIds }, deletedAt: null, householdId: ctx.householdId },
          include: {
            Account: { select: { id: true, name: true, kind: true, investProductType: true, billingDay: true, tradingCalendar: true } },
            CashAccount: { select: { id: true, name: true, kind: true, investProductType: true, billingDay: true, tradingCalendar: true } },
          },
        })
      : [];
    for (const row of directFundTransactions) {
      const cashReceiptLike = row.fundSubtype === "redeem" || row.fundSubtype === "switch_out" || row.fundSubtype === "dividend_cash";
      existingMap.set(row.id, {
        id: row.id,
        date: row.applyDate,
        postedAt: null,
        type: TransactionType.investment,
        amount: cashReceiptLike
          ? Number(row.arrivalAmount ?? row.grossAmount ?? 0)
          : -Math.abs(Number(row.grossAmount ?? 0)),
        fundSubtype: row.fundSubtype,
        source: row.source,
        accountId: cashReceiptLike ? row.fundAccountId : (row.cashAccountId ?? row.fundAccountId),
        accountName: cashReceiptLike ? row.Account.name : (row.CashAccount?.name ?? row.Account.name),
        account: cashReceiptLike ? row.Account : (row.CashAccount ?? row.Account),
        toAccountId: cashReceiptLike ? row.cashAccountId : row.fundAccountId,
        toAccountName: cashReceiptLike ? (row.CashAccount?.name ?? null) : row.Account.name,
        toAccount: cashReceiptLike ? row.CashAccount : row.Account,
        categoryId: null,
        categoryName: null,
        note: row.note,
        EntryTag: [],
        counterpartyInstitutionName: null,
        paymentChannelName: null,
        fundCode: row.fundCode,
        fundProductType: row.fundProductType,
        fundUnits: row.units,
        fundNav: row.nav,
        fundFee: row.fee,
        fundArrivalAmount: row.arrivalAmount,
        fundSourceEntryId: null,
        fundConfirmDate: row.confirmDate,
        fundArrivalDate: row.arrivalDate,
      } as unknown as ExistingRecord);
    }
    if (directFundTransactions.length > 0) {
      const directIds = new Set(directFundTransactions.map((row) => row.id));
      notFoundIds = notFoundIds.filter((id) => !directIds.has(id));
    }
    const undo = await prepareEntryUndo(prisma, ctx.householdId, existingRecords.map((record) => record.id));

    const accountIds = Array.from(new Set(updates.flatMap((item) => [item.account, item.viewAccount, item.toAccount, item.cashAccountId, item.fundAccountId].map((id) => String(id ?? "").trim()).filter(Boolean))));
    const accounts = accountIds.length > 0
      ? await prisma.account.findMany({ where: { id: { in: accountIds }, isActive: true, ...hidFilter }, select: { id: true, name: true, kind: true, investProductType: true, billingDay: true, tradingCalendar: true } })
      : [];
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const existingAccountById = new Map(
      existingRecords.flatMap((record) => [record.account, record.toAccount].filter((account): account is NonNullable<typeof record.account> => !!account).map((account) => [account.id, account] as const)),
    );
    const resolveAccountMeta = (accountId: string | null | undefined) => {
      const id = String(accountId ?? "").trim();
      return id ? accountById.get(id) ?? existingAccountById.get(id) ?? null : null;
    };
    const categoryIds = Array.from(new Set(updates.map((item) => String(item.categoryId ?? "").trim()).filter(Boolean)));
    const categories = categoryIds.length > 0
      ? await prisma.category.findMany({ where: { id: { in: categoryIds }, ...hidFilter }, select: { id: true, name: true } })
      : [];
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const tagIds = Array.from(new Set(updates.map((item) => String(item.tagId ?? "").trim()).filter(Boolean)));
    const writableTagIds = await resolveWritableTagIds(prisma, ctx.householdId, tagIds);
    if (writableTagIds.length !== tagIds.length) {
      const invalidTagId = tagIds.find((id) => !writableTagIds.includes(id));
      return NextResponse.json(
        { ok: false, code: "TAG_NOT_FOUND", error: `Tag not found or not readable: ${invalidTagId ?? ""}` },
        { status: 400 },
      );
    }
    const tags = writableTagIds.length > 0
      ? await prisma.tag.findMany({ where: { id: { in: writableTagIds } }, select: { id: true, name: true } })
      : [];
    const tagById = new Map(tags.map((tag) => [tag.id, tag]));
    const institutionNames = Array.from(new Set(updates.map((item) => String(item.institution ?? "").trim()).filter(Boolean)));
    const institutions = institutionNames.length > 0
      ? await prisma.institution.findMany({
          where: {
            householdId: ctx.householdId,
            OR: [
              { name: { in: institutionNames } },
              { shortName: { in: institutionNames } },
            ],
          },
          select: { id: true, name: true, shortName: true },
        })
      : [];
    const institutionByName = new Map<string, (typeof institutions)[number]>();
    for (const institution of institutions) {
      institutionByName.set(institution.name, institution);
      if (institution.shortName) institutionByName.set(institution.shortName, institution);
    }
    const repaymentCategory = await resolveCreditCardRepaymentCategory(prisma, ctx.householdId);

    let updatedCount = 0;
    const changed: Array<{ id: string; date: string; oldValue: string; newValue: string; field: string }> = [];
    const touchedRecordIds = new Set<string>();
    const balanceAccountIds = new Set<string>();
    const amountTouchedIds = new Set<string>();
    const fundFeeTouchedIds = new Set<string>();
    const feeRateTouchedIds = new Set<string>();
    const fundPositionRecalcRequests = new Map<string, Set<string>>();
    const addFundPositionRecalcRequest = (accountId: string | null | undefined, fundCode: string | null | undefined) => {
      const acct = String(accountId ?? "").trim();
      const code = String(fundCode ?? "").trim();
      if (!acct || !code) return;
      if (!fundPositionRecalcRequests.has(acct)) fundPositionRecalcRequests.set(acct, new Set());
      fundPositionRecalcRequests.get(acct)!.add(code);
    };

    for (const item of updates) {
      const id = String(item.id ?? "").trim();
      const existing = existingMap.get(id);
      if (!existing) continue;

      const data: Record<string, unknown> = {};
      const tagUpdateRequested = item.tagId !== undefined;
      let skipAutoRepaymentCategory = false;
      if (existing.accountId) balanceAccountIds.add(existing.accountId);
      if (existing.toAccountId) balanceAccountIds.add(existing.toAccountId);

      if (item.date !== undefined) {
        const dateValue = String(item.date).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "日期格式必须是 YYYY-MM-DD" }, { status: 400 });
        data.date = new Date(`${dateValue}T00:00:00.000Z`);
        changed.push({ id, date: ymd(existing.date), oldValue: ymd(existing.date), newValue: dateValue, field: "date" });
      }

      if (item.postedAt !== undefined) {
        const postedAtValue = String(item.postedAt).trim();
        if (postedAtValue && !/^\d{4}-\d{2}-\d{2}$/.test(postedAtValue)) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "入账日期格式必须是 YYYY-MM-DD" }, { status: 400 });
        data.postedAt = postedAtValue ? new Date(`${postedAtValue}T00:00:00.000Z`) : null;
        changed.push({ id, date: ymd(existing.date), oldValue: existing.postedAt ? ymd(existing.postedAt) : "", newValue: postedAtValue, field: "postedAt" });
      }

      if (item.type !== undefined) {
        const typeValue = String(item.type).trim();
        if (!validTypes.has(typeValue)) return NextResponse.json({ ok: false, code: "INVALID_TRANSACTION_TYPE", error: `交易类型不正确：${typeValue}` }, { status: 400 });
        data.type = typeValue;
        changed.push({ id, date: ymd(existing.date), oldValue: existing.type, newValue: typeValue, field: "type" });
      }

      if (item.account !== undefined) {
        const accountId = String(item.account).trim();
        const account = accountById.get(accountId);
        if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: `来源账户不存在：${accountId}` }, { status: 400 });
        data.accountId = account.id;
        data.accountName = account.name;
        balanceAccountIds.add(account.id);
        changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: account.name, field: "account" });
      } else if (item.accountName) {
        const accountName = String(item.accountName).trim();
        const account = await prisma.account.findFirst({ where: { name: accountName, isActive: true, ...hidFilter }, select: { id: true, name: true } });
        if (account) data.accountId = account.id;
        data.accountName = account?.name ?? accountName;
        if (account?.id) balanceAccountIds.add(account.id);
        changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: account?.name ?? accountName, field: "account" });
      }

      if (item.viewAccount !== undefined) {
        const viewAccountId = String(item.viewAccount).trim();
        const account = accountById.get(viewAccountId);
        if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: `Account not found: ${viewAccountId}` }, { status: 400 });

        const sourceInScope = !!existing.accountId && contextAccountIdSet.has(existing.accountId);
        const targetInScope = !!existing.toAccountId && contextAccountIdSet.has(existing.toAccountId);
        const updateTargetSide = targetInScope && (!sourceInScope || existing.toAccountId === contextAccountId);
        const finalTypeForViewAccount = String(data.type ?? existing.type);

        if (updateTargetSide) {
          const otherAccountId = typeof data.accountId === "string" ? data.accountId : existing.accountId;
          if (finalTypeForViewAccount === TransactionType.transfer && otherAccountId && account.id === otherAccountId) {
            return NextResponse.json({ ok: false, code: "SAME_ACCOUNT_NOT_ALLOWED", error: "Account and counter account cannot be the same" }, { status: 400 });
          }
          data.toAccountId = account.id;
          data.toAccountName = account.name;
          changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: account.name, field: "account" });
        } else {
          const otherAccountId = typeof data.toAccountId === "string" ? data.toAccountId : existing.toAccountId;
          if (finalTypeForViewAccount === TransactionType.transfer && otherAccountId && account.id === otherAccountId) {
            return NextResponse.json({ ok: false, code: "SAME_ACCOUNT_NOT_ALLOWED", error: "Account and counter account cannot be the same" }, { status: 400 });
          }
          data.accountId = account.id;
          data.accountName = account.name;
          changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: account.name, field: "account" });
        }
        balanceAccountIds.add(account.id);
      }

      if (item.toAccount !== undefined) {
        const toAccountId = String(item.toAccount).trim();
        const account = accountById.get(toAccountId);
        if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: `去向账户不存在：${toAccountId}` }, { status: 400 });
        const finalTypeForAccountSide = String(data.type ?? existing.type);
        const amountN = Number(existing.amount);
        const amountAbs = Number.isFinite(amountN) ? Math.abs(amountN) : null;
        const contextIsSource = !!existing.accountId && contextAccountIdSet.has(existing.accountId);
        const contextIsTarget = !!existing.toAccountId && contextAccountIdSet.has(existing.toAccountId);
        const currentAccountId = contextIsTarget
          ? existing.toAccountId
          : contextIsSource
            ? existing.accountId
            : existing.accountId;
        const currentAccountName = contextIsTarget
          ? existing.toAccountName
          : contextIsSource
            ? existing.accountName
            : existing.accountName;
        const originalCurrentSideWasInflow =
          existing.type === TransactionType.income ||
          (Number.isFinite(amountN) && amountN > 0);
        const keepCurrentAccountAsTransferTarget =
          finalTypeForAccountSide === TransactionType.transfer &&
          item.account === undefined &&
          (contextIsTarget || originalCurrentSideWasInflow);

        if (finalTypeForAccountSide === TransactionType.transfer && item.account === undefined && keepCurrentAccountAsTransferTarget) {
          if (!currentAccountId) return NextResponse.json({ ok: false, code: "TRANSFER_NEEDS_CURRENT_ACCOUNT", error: "转账需要保留当前账户" }, { status: 400 });
          if (account.id === currentAccountId) return NextResponse.json({ ok: false, code: "SAME_ACCOUNT_NOT_ALLOWED", error: "对向账户不能和当前账户相同" }, { status: 400 });
          data.accountId = account.id;
          data.accountName = account.name;
          data.toAccountId = currentAccountId;
          data.toAccountName = currentAccountName ?? null;
          if (amountAbs != null) data.amount = -amountAbs;
          balanceAccountIds.add(currentAccountId);
          skipAutoRepaymentCategory = originalCurrentSideWasInflow;
          changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: account.name, field: "toAccount" });
        } else {
          if (finalTypeForAccountSide === TransactionType.transfer && currentAccountId && account.id === currentAccountId) {
            return NextResponse.json({ ok: false, code: "SAME_ACCOUNT_NOT_ALLOWED", error: "对向账户不能和当前账户相同" }, { status: 400 });
          }
          data.toAccountId = account.id;
          data.toAccountName = account.name;
          if (finalTypeForAccountSide === TransactionType.transfer && amountAbs != null) data.amount = -amountAbs;
          changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: account.name, field: "toAccount" });
        }
        balanceAccountIds.add(account.id);
      }

      if (item.categoryId !== undefined) {
        const categoryId = String(item.categoryId).trim();
        if (!categoryId) {
          data.categoryId = null;
          data.categoryName = null;
          changed.push({ id, date: ymd(existing.date), oldValue: existing.categoryName ?? "-", newValue: "", field: "categoryId" });
        } else {
          const category = categoryById.get(categoryId);
          if (!category) return NextResponse.json({ ok: false, code: "CATEGORY_NOT_FOUND", error: `分类不存在：${categoryId}` }, { status: 400 });
          data.categoryId = category.id;
          data.categoryName = category.name;
          changed.push({ id, date: ymd(existing.date), oldValue: existing.categoryName ?? "-", newValue: category.name, field: "categoryId" });
        }
      }

      if (item.institution !== undefined) {
        const institutionName = String(item.institution).trim();
        const institution = institutionName ? institutionByName.get(institutionName) ?? null : null;
        data.counterpartyInstitutionId = institution?.id ?? null;
        data.counterpartyInstitutionName = institution?.name ?? (institutionName || null);
        changed.push({
          id,
          date: ymd(existing.date),
          oldValue: existing.counterpartyInstitutionName ?? "",
          newValue: institution?.name ?? institutionName,
          field: "institution",
        });
      }

      if (tagUpdateRequested) {
        const tagId = String(item.tagId ?? "").trim();
        const tag = tagId ? tagById.get(tagId) : null;
        const oldValue = existing.EntryTag
          .map((entryTag) => entryTag.Tag.name.trim())
          .filter(Boolean)
          .join("、");
        changed.push({
          id,
          date: ymd(existing.date),
          oldValue,
          newValue: tag?.name ?? "",
          field: "tagId",
        });
      }

      if (item.remark !== undefined) {
        const remark = String(item.remark);
        data.note = remark || null;
        changed.push({ id, date: ymd(existing.date), oldValue: existing.note ?? "", newValue: remark, field: "remark" });
      }


      if (item.cashAccountId !== undefined || item.fundAccountId !== undefined) {
        const isRedeemLike = existing.fundSubtype === "redeem" || existing.fundSubtype === "dividend_cash" || existing.fundSubtype === "switch_out";
        const isCashOnToSide = isRedeemLike || (existing.fundSubtype === "buy_failed" && existing.source === "regular_invest_refund");

        const cashAccountId = item.cashAccountId !== undefined ? String(item.cashAccountId).trim() : "";
        const fundAccountId = item.fundAccountId !== undefined ? String(item.fundAccountId).trim() : "";

        if (cashAccountId) {
          const cashAcc = accountById.get(cashAccountId);
          if (!cashAcc) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: `资金账户不存在：${cashAccountId}` }, { status: 400 });
          if (isCashOnToSide) {
            data.toAccountId = cashAcc.id;
            data.toAccountName = cashAcc.name;
            balanceAccountIds.add(cashAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: cashAcc.name, field: "cashAccount" });
          } else {
            data.accountId = cashAcc.id;
            data.accountName = cashAcc.name;
            balanceAccountIds.add(cashAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: cashAcc.name, field: "cashAccount" });
          }
        }

        if (fundAccountId) {
          const fundAcc = accountById.get(fundAccountId);
          if (!fundAcc) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: `基金账户不存在：${fundAccountId}` }, { status: 400 });
          if (isCashOnToSide) {
            data.accountId = fundAcc.id;
            data.accountName = fundAcc.name;
            balanceAccountIds.add(fundAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.accountName ?? "-", newValue: fundAcc.name, field: "fundAccount" });
          } else {
            data.toAccountId = fundAcc.id;
            data.toAccountName = fundAcc.name;
            balanceAccountIds.add(fundAcc.id);
            changed.push({ id, date: ymd(existing.date), oldValue: existing.toAccountName ?? "-", newValue: fundAcc.name, field: "fundAccount" });
          }
        }
      }

      const amountField = item.inflow !== undefined
        ? "inflow"
        : item.outflow !== undefined
          ? "outflow"
          : item.amount !== undefined
            ? "amount"
            : null;
      if (amountField) {
        const rawValue = amountField === "inflow"
          ? item.inflow
          : amountField === "outflow"
            ? item.outflow
            : item.amount;
        const raw = typeof rawValue === "number" ? String(rawValue) : String(rawValue ?? "");
        const v = raw.trim();
        const oldN = Number(existing.amount);
        const contextIsSource = !!existing.accountId && contextAccountIdSet.has(existing.accountId);
        const contextIsTarget = !!existing.toAccountId && contextAccountIdSet.has(existing.toAccountId);
        const effectiveOldN = contextIsTarget ? Math.abs(oldN) : oldN;
        const baseAmount = amountField === "inflow"
          ? Math.max(effectiveOldN, 0)
          : amountField === "outflow"
            ? Math.max(-effectiveOldN, 0)
            : Math.abs(oldN);
        const absNew = parseAmountUpdate(v, baseAmount);
        if (absNew == null) return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "金额必须是数字或运算式，如 100、*2、+10、-5、/2" }, { status: 400 });
        const finalTypeForAmount = String(data.type ?? existing.type);
        if (amountField === "amount") {
          const signed = finalTypeForAmount === TransactionType.transfer
            ? -absNew
            : oldN < 0 ? -absNew : absNew;
          data.amount = signed;
        } else if (finalTypeForAmount === TransactionType.transfer) {
          const wantsInflow = amountField === "inflow";
          const sourceAccountId = existing.accountId;
          const targetAccountId = existing.toAccountId;
          if (wantsInflow && contextIsSource && !contextIsTarget && sourceAccountId && targetAccountId) {
            data.accountId = targetAccountId;
            data.accountName = existing.toAccountName ?? null;
            data.toAccountId = sourceAccountId;
            data.toAccountName = existing.accountName ?? null;
            balanceAccountIds.add(sourceAccountId);
            balanceAccountIds.add(targetAccountId);
          } else if (!wantsInflow && contextIsTarget && !contextIsSource && sourceAccountId && targetAccountId) {
            data.accountId = targetAccountId;
            data.accountName = existing.toAccountName ?? null;
            data.toAccountId = sourceAccountId;
            data.toAccountName = existing.accountName ?? null;
            balanceAccountIds.add(sourceAccountId);
            balanceAccountIds.add(targetAccountId);
          }
          data.amount = -absNew;
        } else {
          const wantsInflow = amountField === "inflow";
          if (finalTypeForAmount === TransactionType.income || finalTypeForAmount === TransactionType.expense) {
            data.type = wantsInflow ? TransactionType.income : TransactionType.expense;
          }
          data.amount = wantsInflow ? absNew : -absNew;
        }
        changed.push({ id, date: ymd(existing.date), oldValue: String(baseAmount), newValue: String(absNew), field: amountField });
        amountTouchedIds.add(id);
      }

      if ((data.type ?? existing.type) === TransactionType.investment) {
        const finalAccountId = typeof data.accountId === "string" ? data.accountId : existing.accountId;
        const finalToAccountId = typeof data.toAccountId === "string" ? data.toAccountId : existing.toAccountId;
        const finalAccount = resolveAccountMeta(finalAccountId);
        const finalToAccount = resolveAccountMeta(finalToAccountId);
        const investmentAccount = finalToAccount?.kind === "investment"
          ? finalToAccount
          : finalAccount?.kind === "investment"
            ? finalAccount
            : null;
        if (investmentAccount) {
          data.fundProductType = investmentAccount.investProductType ?? existing.toAccount?.investProductType ?? existing.account?.investProductType ?? "fund";
          data.fundSubtype = existing.fundSubtype ?? (finalToAccount?.id === investmentAccount.id ? "buy" : "redeem");
          data.categoryId = null;
          data.categoryName = null;
        }
      }

      const finalType = String(data.type ?? existing.type);
      const finalAccountId = typeof data.accountId === "string" ? data.accountId : existing.accountId;
      const finalToAccountId = typeof data.toAccountId === "string" ? data.toAccountId : existing.toAccountId;
      const finalAccount = resolveAccountMeta(finalAccountId);
      const finalToAccount = resolveAccountMeta(finalToAccountId);
      const needsFundSync = item.fundConfirmDate !== undefined
        || item.fundArrivalDate !== undefined
        || item.fundFee !== undefined
        || item.feeRate !== undefined
        || item.cashAccountId !== undefined
        || item.fundAccountId !== undefined;
      const linkedFundTransaction = needsFundSync
        ? await findFundTransactionForEntryId(prisma, { id, householdId: ctx.householdId, syncLegacy: false }).catch(() => null)
        : null;
      const currentFundCode = String(linkedFundTransaction?.fundCode ?? existing.fundCode ?? "").trim();
      const currentProductType = String(linkedFundTransaction?.fundProductType ?? existing.fundProductType ?? "");
      const currentSubtype = String(linkedFundTransaction?.fundSubtype ?? existing.fundSubtype ?? "");
      const dateCashReceiptLike = currentSubtype === "redeem" || currentSubtype === "switch_out" || currentSubtype === "dividend_cash";
      const fundAccountIdForDateRule = linkedFundTransaction?.fundAccountId ?? (dateCashReceiptLike ? finalAccountId : finalToAccountId);
      const fundTradingCalendar = resolveAccountMeta(fundAccountIdForDateRule)?.tradingCalendar ?? "cn_fund";
      if (item.fundConfirmDate !== undefined) {
        let value = String(item.fundConfirmDate).trim();
        if (value) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            data.fundConfirmDate = new Date(`${value}T00:00:00.000Z`);
          } else {
            const offset = parseTradingDayOffsetUpdate(value);
            if (offset == null) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "Fund confirm date must be YYYY-MM-DD or a non-negative T+N offset" }, { status: 400 });
            const nextYmd = addTradingDaysUtc(ymd(data.date instanceof Date ? data.date : existing.date), offset, fundTradingCalendar);
            data.fundConfirmDate = new Date(`${nextYmd}T00:00:00.000Z`);
            value = nextYmd;
          }
        } else {
          data.fundConfirmDate = null;
        }
        changed.push({ id, date: ymd(existing.date), oldValue: existing.fundConfirmDate ? ymd(existing.fundConfirmDate) : "", newValue: value, field: "fundConfirmDate" });
      }

      if (item.fundArrivalDate !== undefined) {
        let value = String(item.fundArrivalDate).trim();
        if (value) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            data.fundArrivalDate = new Date(`${value}T00:00:00.000Z`);
          } else {
            const offset = parseTradingDayOffsetUpdate(value);
            if (offset == null) return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "Fund arrival date must be YYYY-MM-DD or a non-negative T+N offset" }, { status: 400 });
            const nextYmd = addTradingDaysUtc(ymd(data.date instanceof Date ? data.date : existing.date), offset, fundTradingCalendar);
            data.fundArrivalDate = new Date(`${nextYmd}T00:00:00.000Z`);
            value = nextYmd;
          }
        } else {
          data.fundArrivalDate = null;
        }
        changed.push({ id, date: ymd(existing.date), oldValue: existing.fundArrivalDate ? ymd(existing.fundArrivalDate) : "", newValue: value, field: "fundArrivalDate" });
      }

      if (item.fundFee !== undefined || item.feeRate !== undefined || item.cashAccountId !== undefined || item.fundAccountId !== undefined) {
        const hasFeeUpdate = item.fundFee !== undefined || item.feeRate !== undefined;
        const feeSupported = !hasFeeUpdate || (
          finalType === TransactionType.investment
          && currentFundCode
          && currentProductType !== "metal"
          && currentProductType !== "wealth"
          && currentSubtype !== "dividend_cash"
          && currentSubtype !== "dividend_reinvest"
        );
        if (!feeSupported) {
          return NextResponse.json({ ok: false, code: "FUND_FEE_NOT_SUPPORTED", error: "Selected record does not support fund fee updates" }, { status: 400 });
        }

        const cashReceiptLike = currentSubtype === "redeem" || currentSubtype === "switch_out";
        const fundAccountId = linkedFundTransaction?.fundAccountId ?? (cashReceiptLike ? finalAccountId : finalToAccountId);
        if (!fundAccountId) {
          return NextResponse.json({ ok: false, code: "FUND_ACCOUNT_REQUIRED", error: "Fund account is required for fee updates" }, { status: 400 });
        }
        const feeType = cashReceiptLike ? "redeem" : "buy";
        const feeEffectiveDate = data.fundConfirmDate instanceof Date
          ? data.fundConfirmDate
          : linkedFundTransaction?.confirmDate ?? existing.fundConfirmDate ?? (data.date instanceof Date ? data.date : existing.date);

        let requestedFee: number | null | undefined;
        let requestedFeeRate: number | null = null;
        if (hasFeeUpdate && item.feeRate !== undefined) {
          const raw = typeof item.feeRate === "number" ? String(item.feeRate) : String(item.feeRate ?? "").trim();
          const baseRate = await getFundFeeRateByDate(fundAccountId, currentFundCode, feeEffectiveDate, feeType);
          const parsed = raw ? parseAmountUpdate(raw, Math.max(0, baseRate)) : 0;
          if (parsed == null) return NextResponse.json({ ok: false, code: "INVALID_FEE_RATE", error: "Fee rate must be a non-negative number or expression" }, { status: 400 });
          requestedFeeRate = parsed;
          await setFundFeeRateByDate(fundAccountId, currentFundCode, parsed, feeEffectiveDate, feeType);
          feeRateTouchedIds.add(id);
          changed.push({ id, date: ymd(existing.date), oldValue: String(baseRate), newValue: String(parsed), field: "feeRate" });
        }

        if (hasFeeUpdate && item.fundFee !== undefined) {
          const raw = typeof item.fundFee === "number" ? String(item.fundFee) : String(item.fundFee ?? "").trim();
          if (!raw) {
            requestedFee = null;
          } else {
            const baseFee = Math.max(0, Number(linkedFundTransaction?.fee ?? existing.fundFee ?? 0));
            const parsed = parseAmountUpdate(raw, baseFee);
            if (parsed == null) return NextResponse.json({ ok: false, code: "INVALID_FUND_FEE", error: "Fund fee must be a non-negative number or expression" }, { status: 400 });
            requestedFee = parsed;
          }
          fundFeeTouchedIds.add(id);
          changed.push({ id, date: ymd(existing.date), oldValue: String(Number(linkedFundTransaction?.fee ?? existing.fundFee ?? 0)), newValue: requestedFee == null ? "" : String(requestedFee), field: "fundFee" });
        }

        if (linkedFundTransaction) {
          const nav = Number(linkedFundTransaction.nav ?? 0);
          const units = Number(linkedFundTransaction.units ?? 0);
          const grossAmount = Math.max(0, Number(linkedFundTransaction.grossAmount ?? 0));
          const refundAmount = Math.max(0, Number(linkedFundTransaction.refundAmount ?? 0));
          const feeBaseAmount = cashReceiptLike && nav > 0 && units > 0 ? nav * units : Math.max(0, grossAmount - refundAmount);
          const finalFee = requestedFee !== undefined
            ? requestedFee
            : requestedFeeRate != null && feeBaseAmount > 0
              ? Number((feeBaseAmount * requestedFeeRate / 100).toFixed(2))
              : undefined;
          const fundTransactionData: Record<string, unknown> = {};
          if (item.cashAccountId !== undefined || item.fundAccountId !== undefined) {
            const nextCashAccountId = item.cashAccountId !== undefined ? String(item.cashAccountId).trim() : "";
            const nextFundAccountId = item.fundAccountId !== undefined ? String(item.fundAccountId).trim() : "";
            if (nextCashAccountId) fundTransactionData.cashAccountId = nextCashAccountId;
            if (nextFundAccountId) fundTransactionData.fundAccountId = nextFundAccountId;
          }
          if (finalFee !== undefined) {
            const feeValue = finalFee != null && finalFee > 0 ? finalFee : null;
            fundTransactionData.fee = feeValue;
            data.fundFee = feeValue;
          }
          if (!cashReceiptLike && finalFee !== undefined && nav > 0) {
            const fundUnitsDecimals = await getAccountFundUnitsDecimals(fundAccountId);
            const nextUnits = calculateConfirmedBuyUnits({
              grossAmount,
              refundAmount,
              fee: finalFee ?? 0,
              nav,
              roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
            });
            if (nextUnits != null) {
              fundTransactionData.units = nextUnits;
              data.fundUnits = nextUnits;
            }
          }
          if (cashReceiptLike && finalFee !== undefined && nav > 0 && units > 0) {
            const nextArrivalAmount = Math.max(0, nav * units - (finalFee ?? 0));
            const arrivalAmount = Number(nextArrivalAmount.toFixed(2));
            fundTransactionData.arrivalAmount = arrivalAmount;
            data.fundArrivalAmount = arrivalAmount;
            data.amount = arrivalAmount;
          }
          if (Object.keys(fundTransactionData).length > 0) {
            await prisma.fundTransaction.update({ where: { id: linkedFundTransaction.id }, data: fundTransactionData });
          }
          addFundPositionRecalcRequest(fundAccountId, currentFundCode);
        } else if (requestedFee !== undefined) {
          data.fundFee = requestedFee != null && requestedFee > 0 ? requestedFee : null;
        }
      }

      if (finalType === TransactionType.expense || finalType === TransactionType.income) {
        const finalDate = data.date instanceof Date ? data.date : existing.date;
        const finalPostedAt = Object.prototype.hasOwnProperty.call(data, "postedAt")
          ? (data.postedAt as Date | null)
          : existing.postedAt;
        data.statementMonth =
          finalAccount && (finalAccount.kind === AccountKind.bank_credit || finalAccount.kind === AccountKind.loan) && finalAccount.billingDay
            ? toStatementMonth(creditBillEffectiveDate({ type: finalType, date: finalDate, postedAt: finalPostedAt }) ?? finalDate, finalAccount.billingDay)
            : null;
      }
      if (!skipAutoRepaymentCategory && isCreditCardRepaymentTransfer({
        type: finalType,
        accountKind: finalAccount?.kind,
        toAccountKind: finalToAccount?.kind,
      })) {
        data.categoryId = repaymentCategory?.id ?? null;
        data.categoryName = repaymentCategory?.name ?? CREDIT_CARD_REPAYMENT_CATEGORY_NAME;
      } else if (skipAutoRepaymentCategory) {
        data.categoryId = null;
        data.categoryName = null;
      } else if (
        existing.categoryName === CREDIT_CARD_REPAYMENT_CATEGORY_NAME &&
        (item.type !== undefined || item.account !== undefined || item.toAccount !== undefined)
      ) {
        data.categoryId = null;
        data.categoryName = null;
      }

      const hasRecordDataUpdate = Object.keys(data).length > 0;
      if (!hasRecordDataUpdate && !tagUpdateRequested && item.fundFee === undefined && item.feeRate === undefined) continue;

      const result = hasRecordDataUpdate
        ? await prisma.txRecord.updateMany({
            where: { id, deletedAt: null, ...hidFilter },
            data,
          })
        : { count: 1 };
      if (result.count > 0) {
        if (tagUpdateRequested) {
          const tagId = String(item.tagId ?? "").trim();
          await replaceEntryTags({
            tx: prisma,
            entryId: id,
            householdId: ctx.householdId,
            tagIds: tagId ? [tagId] : [],
          });
        }
        updatedCount += result.count;
        touchedRecordIds.add(id);
        const learnedCategoryId = typeof data.categoryId === "string" ? data.categoryId : "";
        const learnedCategoryName = typeof data.categoryName === "string" ? data.categoryName : "";
        if (item.categoryId !== undefined && learnedCategoryId && learnedCategoryName && (finalType === "income" || finalType === "expense")) {
          await upsertStatementCategoryRuleFromSavedRecord(prisma, {
            householdId: ctx.householdId,
            type: finalType,
            categoryId: learnedCategoryId,
            categoryName: learnedCategoryName,
            counterpartyInstitutionName: existing.counterpartyInstitutionName,
            paymentChannelName: existing.paymentChannelName,
            note: typeof data.note === "string" ? data.note : existing.note,
          }, "user_category_edit");
        }
      }
    }

    if (updatedCount === 0) {
      return NextResponse.json(
        { ok: false, code: "RECORDS_NOT_FOUND", error: `未找到匹配的记录 (IDs: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? "..." : ""})` },
        { status: 404 }
      );
    }

    if (touchedRecordIds.size > 0) {
      const touched = await prisma.txRecord.findMany({
        where: { id: { in: Array.from(touchedRecordIds) }, deletedAt: null, ...hidFilter },
        select: {
          id: true,
          date: true,
          type: true,
          fundCode: true,
          fundSubtype: true,
          source: true,
          amount: true,
          fundNav: true,
          fundUnits: true,
          fundFee: true,
          fundArrivalAmount: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          fundSourceEntryId: true,
          createdAt: true,
          accountId: true,
          toAccountId: true,
          fundProductType: true,
          metalTypeId: true,
        },
      });

      const fundCodesByInvestAcc = new Map<string, Set<string>>(
        Array.from(fundPositionRecalcRequests.entries()).map(([acctId, codes]) => [acctId, new Set(codes)]),
      );
      const metalAccountsToRecalc = new Set<string>();

      for (const r of touched) {
        if (r.accountId) balanceAccountIds.add(r.accountId);
        if (r.toAccountId) balanceAccountIds.add(r.toAccountId);

        const isRedeemOrRefund = r.fundSubtype === "redeem" || r.fundSubtype === "switch_out" || r.fundSubtype === "dividend_cash"
          || (r.fundSubtype === "buy_failed" && r.source === "regular_invest_refund");
        const investAccId = isRedeemOrRefund ? r.accountId : r.toAccountId;
        if (r.type !== "investment") continue;
        if ((r.metalTypeId || r.fundProductType === "metal") && investAccId) {
          metalAccountsToRecalc.add(investAccId);
          continue;
        }
        if (!r.fundCode) continue;
        if (investAccId) {
          if (!fundCodesByInvestAcc.has(investAccId)) fundCodesByInvestAcc.set(investAccId, new Set());
          fundCodesByInvestAcc.get(investAccId)!.add(r.fundCode);
        }

        const shouldRefreshBuyFee = (amountTouchedIds.has(r.id) || feeRateTouchedIds.has(r.id) || fundFeeTouchedIds.has(r.id))
          && r.fundSubtype === "buy"
          && r.fundNav != null
          && Number(r.fundNav) > 0;
        if (shouldRefreshBuyFee) {
          const investIdForFee = r.toAccountId;
          if (!investIdForFee) continue;
          const feeEffectiveDate = r.fundConfirmDate ?? r.date;
          const feeRateRaw = await getFundFeeRateByDate(investIdForFee, r.fundCode, feeEffectiveDate, "buy");
          const feeRate = feeRateRaw / 100;
          const amountAbs = Math.abs(Number(r.amount));
          const related = await prisma.txRecord.findMany({
            where: {
              deletedAt: null,
              fundCode: r.fundCode,
              OR: [
                { id: r.id },
                { fundSourceEntryId: r.id },
                {
                  fundSubtype: "buy_failed",
                  source: "regular_invest_refund",
                  accountId: investIdForFee,
                },
              ],
            },
            select: {
              id: true,
              date: true,
              createdAt: true,
              fundConfirmDate: true,
              fundArrivalDate: true,
              accountId: true,
              toAccountId: true,
              fundCode: true,
              fundSubtype: true,
              source: true,
              amount: true,
              fundSourceEntryId: true,
            },
          });
          const { refundAmountByBuyId } = allocateBuyFailedRefunds(related.map((entry) => ({
            id: entry.id,
            date: entry.date,
            createdAt: entry.createdAt,
            fundConfirmDate: entry.fundConfirmDate,
            fundArrivalDate: entry.fundArrivalDate,
            accountId: entry.accountId,
            toAccountId: entry.toAccountId,
            fundCode: entry.fundCode,
            fundSubtype: entry.fundSubtype,
            source: entry.source,
            amount: Number(entry.amount),
            fundSourceEntryId: entry.fundSourceEntryId,
          })));
          const refundAmount = refundAmountByBuyId.get(r.id) ?? 0;
          const confirmedAmount = Math.max(0, amountAbs - refundAmount);
          const fee = fundFeeTouchedIds.has(r.id)
            ? Math.max(0, Number(r.fundFee ?? 0))
            : Number((confirmedAmount * feeRate).toFixed(2));
          const nav = Number(r.fundNav);
          const fundUnitsDecimals = await getAccountFundUnitsDecimals(investIdForFee);
          const units = calculateConfirmedBuyUnits({
            grossAmount: amountAbs,
            refundAmount,
            fee,
            nav,
            roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
          });
          await prisma.txRecord.update({
            where: { id: r.id },
            data: { fundFee: fee, ...(units != null ? { fundUnits: units } : {}) },
          });
        }

        const shouldRefreshRedeemFee = (feeRateTouchedIds.has(r.id) || fundFeeTouchedIds.has(r.id))
          && (r.fundSubtype === "redeem" || r.fundSubtype === "switch_out")
          && r.fundNav != null
          && r.fundUnits != null
          && Number(r.fundNav) > 0
          && Number(r.fundUnits) > 0;
        if (shouldRefreshRedeemFee) {
          const investIdForFee = r.accountId;
          if (!investIdForFee) continue;
          const nav = Number(r.fundNav);
          const units = Number(r.fundUnits);
          const grossAmount = nav * units;
          const fee = fundFeeTouchedIds.has(r.id)
            ? Math.max(0, Number(r.fundFee ?? 0))
            : Number((grossAmount * (await getFundFeeRateByDate(investIdForFee, r.fundCode, r.fundConfirmDate ?? r.createdAt, "redeem")) / 100).toFixed(2));
          const arrivalAmount = Number(Math.max(0, grossAmount - fee).toFixed(2));
          await prisma.txRecord.update({
            where: { id: r.id },
            data: { fundFee: fee, fundArrivalAmount: arrivalAmount, amount: arrivalAmount },
          });
          if (r.accountId) balanceAccountIds.add(r.accountId);
          if (r.toAccountId) balanceAccountIds.add(r.toAccountId);
        }
      }

      for (const acctId of balanceAccountIds) {
        await recalcAndSaveAccountBalance(acctId).catch(() => {});
      }
      await invalidateCreditCardCycleCacheForAccountIds(balanceAccountIds).catch(() => {});

      for (const [acctId, codes] of fundCodesByInvestAcc.entries()) {
        await recalcFundPositions(acctId, Array.from(codes)).catch(() => {});
      }
      for (const acctId of metalAccountsToRecalc) {
        await recalcPreciousMetalPositions(acctId).catch(() => {});
      }
      for (const id of touchedRecordIds) {
        await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id }).catch(() => {});
      }
      await syncFundTransactionsFromTxRecords(Array.from(touchedRecordIds), prisma).catch(() => {});
    }

    await saveEntryUndo(
      prisma,
      ctx,
      undo,
      updatedCount > 1 ? "batch_edit" : "edit",
      updatedCount > 1 ? `批量编辑 ${updatedCount} 条明细` : "编辑明细",
    );

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      updatedCount,
      changed,
      notFoundIds: notFoundIds.length > 0 ? notFoundIds : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "更新失败";
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: msg }, { status: 500 });
  }
}
