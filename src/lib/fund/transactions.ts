import { FundCashFlowKind, FundProductType, FundSubtype, Prisma, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { entryBusinessTypeLabel, upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import { regularInvestRefundNote } from "@/lib/fund/regular-invest-display";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { getCashFlowDate } from "@/lib/cash-flow-date";
import { ENTRY_ORIGIN_MANUAL, isRegularInvestRefundEntry, TRANSACTION_SOURCE_REGULAR_INVEST_REFUND } from "@/lib/transaction-semantics";
import { getFundProfileNameMap, normalizeFundDisplayName } from "@/lib/fund/fundProfile";

type Tx = Prisma.TransactionClient;

export type FundCashFlowInput = {
  kind: FundCashFlowKind;
  date: Date;
  accountId: string;
  accountName?: string | null;
  amount: number;
  currency?: string | null;
  source?: string | null;
  entryOrigin?: string | null;
  note?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  regularInvestPlanId?: string | null;
};

export type CreateFundTransactionWithCashFlowsParams = {
  householdId: string;
  fundAccountId: string;
  cashAccountId?: string | null;
  fundCode: string;
  fundName?: string | null;
  fundProductType?: FundProductType | string | null;
  fundSubtype: FundSubtype | string;
  source?: string | null;
  entryOrigin?: string | null;
  applyDate: Date;
  confirmDate?: Date | null;
  arrivalDate?: Date | null;
  grossAmount: number;
  refundAmount?: number | null;
  arrivalAmount?: number | null;
  fee?: number | Prisma.Decimal | null;
  nav?: number | Prisma.Decimal | null;
  units?: number | Prisma.Decimal | null;
  realizedProfit?: number | Prisma.Decimal | null;
  regularInvestPlanId?: string | null;
  note?: string | null;
  cashFlows?: FundCashFlowInput[];
};

export async function detachFundTransactionCashFlow(
  client: Tx,
  params: {
    householdId: string;
    fundTransactionId: string;
    cashEntryId?: string | null;
    source?: string | null;
  },
) {
  const existingFlows = await client.fundTransactionCashFlow.findMany({
    where: { fundTransactionId: params.fundTransactionId },
    select: { txRecordId: true },
  });
  const linkedCashEntryIds = Array.from(new Set([
    params.cashEntryId ?? null,
    ...existingFlows.map((flow) => flow.txRecordId),
  ].filter((id): id is string => !!id)));

  await client.fundTransactionCashFlow.deleteMany({
    where: { fundTransactionId: params.fundTransactionId },
  });

  if (linkedCashEntryIds.length > 0) {
    await client.entryBusinessLink.updateMany({
      where: {
        householdId: params.householdId,
        fundTransactionId: params.fundTransactionId,
        cashEntryId: { in: linkedCashEntryIds },
      },
      data: { deletedAt: new Date() },
    });
    const secondaryCashEntryIds = linkedCashEntryIds.filter((id) => id !== params.cashEntryId);
    if (secondaryCashEntryIds.length > 0) {
      await client.txRecord.updateMany({
        where: {
          householdId: params.householdId,
          id: { in: secondaryCashEntryIds },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
    }
  }

  await client.fundTransaction.update({
    where: { id: params.fundTransactionId },
    data: {
      cashAccountId: null,
      cashEntryId: null,
    },
  });

  await upsertEntryBusinessCashFlowLink(client, {
    householdId: params.householdId,
    cashEntryId: null,
    fundTransactionId: params.fundTransactionId,
    businessType: "fund",
    cashFlowDirection: "none",
    source: params.source,
    note: "Linked fund transaction without cash flow",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
    },
  });
}

function normalizeFundProductType(value: FundProductType | string | null | undefined): FundProductType {
  return value === FundProductType.money || value === "money" || value === "money_fund" ? FundProductType.money : FundProductType.fund;
}

function normalizeFundSubtype(value: FundSubtype | string): FundSubtype {
  return Object.values(FundSubtype).includes(value as FundSubtype) ? (value as FundSubtype) : FundSubtype.buy;
}

function isRefundRow(row: { fundSubtype?: string | null; source?: string | null }) {
  return isRegularInvestRefundEntry(row);
}

function isCashReceiptSubtype(subtype: string | null | undefined) {
  return subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out || subtype === FundSubtype.dividend_cash;
}

function fundAccountIdOf(row: { fundSubtype?: string | null; accountId: string; toAccountId?: string | null }) {
  return isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
    ? row.accountId
    : row.toAccountId ?? row.accountId;
}

function cashAccountIdOf(row: { fundSubtype?: string | null; accountId: string; toAccountId?: string | null }) {
  return isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
    ? row.toAccountId ?? null
    : row.accountId;
}

function cashFlowKindOf(row: { fundSubtype?: string | null; source?: string | null }) {
  if (isRefundRow(row)) return FundCashFlowKind.refund_in;
  if (row.fundSubtype === FundSubtype.buy || row.fundSubtype === FundSubtype.buy_failed) return FundCashFlowKind.buy_out;
  if (row.fundSubtype === FundSubtype.redeem || row.fundSubtype === FundSubtype.switch_out) return FundCashFlowKind.redeem_in;
  if (row.fundSubtype === FundSubtype.dividend_cash) return FundCashFlowKind.dividend_in;
  if (row.fundSubtype === FundSubtype.dividend_reinvest) return FundCashFlowKind.dividend_reinvest_internal;
  if (row.fundSubtype === FundSubtype.switch_in) return FundCashFlowKind.switch_in;
  return FundCashFlowKind.other;
}

export function getFundCashFlowDate(params: {
  kind: FundCashFlowKind;
  applyDate: Date;
  arrivalDate?: Date | null;
  requestedDate?: Date | null;
}) {
  const direction = fundCashFlowDirectionForKind(params.kind);
  return getCashFlowDate({
    direction,
    operationDate: params.applyDate,
    settlementDate: params.kind === FundCashFlowKind.refund_in
      ? params.requestedDate ?? params.arrivalDate
      : params.arrivalDate,
    fallbackDate: params.requestedDate,
  });
}

export function signedFundAmount(ft: {
  fundSubtype: string;
  source?: string | null;
  grossAmount: unknown;
  arrivalAmount?: unknown;
}) {
  const gross = Math.abs(toNumber(ft.grossAmount));
  if (ft.fundSubtype === FundSubtype.buy_failed) {
    return ft.source === TRANSACTION_SOURCE_REGULAR_INVEST_REFUND ? -gross : gross;
  }
  if (ft.fundSubtype === FundSubtype.buy || ft.fundSubtype === FundSubtype.switch_in) return gross;
  return Math.abs(toNumber(ft.arrivalAmount ?? ft.grossAmount));
}

export async function createFundTransactionWithCashFlows(
  client: Tx | typeof prisma,
  params: CreateFundTransactionWithCashFlowsParams,
) {
  const fundCode = params.fundCode.trim();
  if (!params.householdId || !params.fundAccountId || !fundCode) {
    throw new Error("缺少基金交易必要字段");
  }

  const cashFlows = (params.cashFlows ?? []).filter((flow) => (
    flow.accountId && Number.isFinite(flow.amount) && flow.amount !== 0
  ));
  const createdCashEntries: Array<{ entry: Awaited<ReturnType<Tx["txRecord"]["create"]>>; flow: FundCashFlowInput }> = [];

  const resolvedFundName = await resolveFundDisplayNameForCashFlow(client, {
    fundCode,
    storedName: params.fundName ?? null,
  });

  for (const flow of cashFlows) {
    const flowDate = getFundCashFlowDate({
      kind: flow.kind,
      applyDate: params.applyDate,
      arrivalDate: params.arrivalDate,
      requestedDate: flow.date,
    });
    const categoryName = flow.categoryName ?? getInvestmentCategoryName({
      fundProductType: params.fundProductType,
      fundSubtype: params.fundSubtype,
      source: flow.source ?? params.source,
    });
    const category = flow.categoryId || !categoryName
      ? null
      : await resolveCategorySnapshot(client, params.householdId, { categoryName, type: "investment" });
    const entry = await client.txRecord.create({
      data: {
        householdId: params.householdId,
        type: TransactionType.investment,
        date: flowDate,
        accountId: flow.accountId,
        accountName: flow.accountName ?? "",
        toAccountId: null,
        toAccountName: null,
        amount: flow.amount,
        currency: flow.currency ?? "CNY",
        source: flow.source ?? params.source ?? "manual",
        entryOrigin: flow.entryOrigin ?? params.entryOrigin ?? ENTRY_ORIGIN_MANUAL,
        categoryId: flow.categoryId ?? category?.id ?? null,
        categoryName: flow.categoryName ?? category?.name ?? categoryName ?? null,
        fundCode,
        fundName: resolvedFundName,
        fundProductType: normalizeFundProductType(params.fundProductType),
        fundSubtype: normalizeFundSubtype(params.fundSubtype),
        regularInvestPlanId: flow.regularInvestPlanId ?? params.regularInvestPlanId ?? null,
        note: flow.note ?? params.note ?? undefined,
      },
    });
    createdCashEntries.push({ entry, flow });
  }

  const primaryCashEntry = createdCashEntries[0]?.entry ?? null;
  const refundAmount = params.refundAmount ?? cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  const fundTransaction = await client.fundTransaction.create({
    data: {
      householdId: params.householdId,
      fundAccountId: params.fundAccountId,
      cashAccountId: primaryCashEntry?.accountId ?? null,
      cashEntryId: primaryCashEntry?.id ?? null,
      fundCode,
      fundName: resolvedFundName,
      fundProductType: normalizeFundProductType(params.fundProductType),
      fundSubtype: normalizeFundSubtype(params.fundSubtype),
      source: params.source ?? "manual",
      entryOrigin: params.entryOrigin ?? ENTRY_ORIGIN_MANUAL,
      applyDate: params.applyDate,
      confirmDate: params.confirmDate ?? null,
      arrivalDate: params.arrivalDate ?? null,
      grossAmount: Math.abs(toNumber(params.grossAmount)),
      refundAmount: Math.max(0, Math.abs(toNumber(refundAmount ?? 0))),
      arrivalAmount: params.arrivalAmount == null ? null : Math.abs(toNumber(params.arrivalAmount)),
      fee: params.fee ?? null,
      nav: params.nav ?? null,
      units: params.units ?? null,
      realizedProfit: params.realizedProfit ?? null,
      regularInvestPlanId: params.regularInvestPlanId ?? null,
      note: params.note ?? null,
    },
  });

  for (const { entry, flow } of createdCashEntries) {
    await client.fundTransactionCashFlow.create({
      data: {
        id: `${flow.kind === FundCashFlowKind.refund_in ? "cfr" : "cff"}_${entry.id}`,
        fundTransactionId: fundTransaction.id,
        txRecordId: entry.id,
        kind: flow.kind,
        amount: Math.abs(toNumber(flow.amount)),
        flowDate: entry.date,
        accountId: flow.accountId,
      },
    });
    await upsertEntryBusinessCashFlowLink(client, {
      householdId: params.householdId,
      cashEntryId: entry.id,
      fundTransactionId: fundTransaction.id,
      businessType: "fund",
      cashFlowDirection: flow.amount < 0 ? "outflow" : flow.amount > 0 ? "inflow" : "none",
      source: flow.source ?? params.source,
      note: "Linked cash flow to fund transaction",
      metadata: {
        splitRecord: true,
        independentBusinessTransaction: true,
      },
    });
  }

  if (createdCashEntries.length === 0) {
    await upsertEntryBusinessCashFlowLink(client, {
      householdId: params.householdId,
      cashEntryId: null,
      fundTransactionId: fundTransaction.id,
      businessType: "fund",
      cashFlowDirection: "none",
      source: params.source,
      note: "Linked fund transaction without cash flow",
      metadata: {
        splitRecord: true,
        independentBusinessTransaction: true,
      },
    });
  }

  return {
    fundTransaction,
    cashEntries: createdCashEntries.map(({ entry }) => entry),
    cashEntry: primaryCashEntry,
  };
}

export async function findFundTransactionForEntryId(
  client: Tx | typeof prisma,
  params: { id: string; householdId?: string | null; syncLegacy?: boolean },
) {
  const id = params.id?.trim();
  if (!id) return null;
  const householdWhere = params.householdId ? { householdId: params.householdId } : {};

  const findCurrent = async () => {
    const direct = await client.fundTransaction.findFirst({
      where: { id, ...householdWhere },
    });
    if (direct) return direct;

    const byCashEntry = await client.fundTransaction.findFirst({
      where: { cashEntryId: id, ...householdWhere },
    });
    if (byCashEntry) return byCashEntry;

    const link = await client.entryBusinessLink.findFirst({
      where: {
        deletedAt: null,
        ...householdWhere,
        OR: [
          { cashEntryId: id },
          { businessEntryId: id },
          { fundTransactionId: id },
        ],
      },
      select: { fundTransactionId: true },
    });
    if (!link?.fundTransactionId) return null;
    return client.fundTransaction.findFirst({
      where: { id: link.fundTransactionId, ...householdWhere },
    });
  };

  const current = await findCurrent();
  if (current || params.syncLegacy === false) return current;

  const legacy = await client.txRecord.findFirst({
    where: {
      id,
      fundCode: { not: null },
      ...householdWhere,
    },
    select: { id: true },
  });
  if (!legacy) return null;

  await syncFundTransactionsFromTxRecords([id], client);
  return findCurrent();
}

export async function upsertFundTransactionRefundCashFlow(
  client: Tx | typeof prisma,
  params: {
    householdId: string;
    fundTransactionId: string;
    linkedRefundEntryId?: string | null;
    refundDate: Date;
    refundAmount: number;
    fundAccountId: string;
    fundAccountName?: string | null;
    cashAccountId: string;
    cashAccountName?: string | null;
    fundCode: string;
    fundName?: string | null;
    fundProductType?: string | null;
    currency?: string | null;
    source?: string | null;
    note?: string | null;
  },
) {
  const refundAmount = Math.max(0, Math.abs(toNumber(params.refundAmount)));
  if (!params.householdId || !params.fundTransactionId || !params.cashAccountId || refundAmount <= 0) return null;

  const fundTransaction = await client.fundTransaction.findFirst({
    where: { id: params.fundTransactionId, householdId: params.householdId },
    select: {
      fundCode: true,
      fundName: true,
      fundProductType: true,
    },
  });
  if (!fundTransaction?.fundCode) return null;
  const fundCode = fundTransaction.fundCode;
  const fundName = normalizeFundDisplayName(fundCode, fundTransaction.fundName) ?? fundCode;

  const directCashEntry = params.linkedRefundEntryId
    ? await client.txRecord.findFirst({
        where: { id: params.linkedRefundEntryId, householdId: params.householdId },
      })
    : null;
  const existingFlow = directCashEntry
    ? null
    : await client.fundTransactionCashFlow.findFirst({
        where: { fundTransactionId: params.fundTransactionId, kind: FundCashFlowKind.refund_in },
        orderBy: [{ createdAt: "asc" }],
      });
  const existingCashEntry = directCashEntry ?? (existingFlow?.txRecordId
    ? await client.txRecord.findFirst({
        where: { id: existingFlow.txRecordId, householdId: params.householdId },
      })
    : null);

  const cashEntryData = {
    date: params.refundDate,
    type: TransactionType.investment,
    accountId: params.cashAccountId,
    accountName: params.cashAccountName ?? "",
    toAccountId: null,
    toAccountName: null,
    amount: refundAmount,
    currency: params.currency ?? "CNY",
    source: params.source ?? "regular_invest_refund",
    note: params.note ?? undefined,
    fundCode,
    fundName,
    fundProductType: fundTransaction?.fundProductType ?? null,
    fundSubtype: FundSubtype.buy_failed,
    fundUnits: null,
    fundNav: null,
    fundFee: null,
    fundConfirmDate: null,
    fundArrivalDate: null,
    fundArrivalAmount: null,
    fundSourceEntryId: null,
    deletedAt: null,
  };

  const cashEntry = existingCashEntry
    ? await client.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
    : await client.txRecord.create({
        data: {
          ...cashEntryData,
          householdId: params.householdId,
        },
      });

  await client.fundTransactionCashFlow.deleteMany({
    where: {
      fundTransactionId: params.fundTransactionId,
      kind: FundCashFlowKind.refund_in,
      txRecordId: { not: cashEntry.id },
    },
  });
  await client.fundTransactionCashFlow.upsert({
    where: { id: `cfr_${cashEntry.id}` },
    create: {
      id: `cfr_${cashEntry.id}`,
      fundTransactionId: params.fundTransactionId,
      txRecordId: cashEntry.id,
      kind: FundCashFlowKind.refund_in,
      amount: refundAmount,
      flowDate: params.refundDate,
      accountId: params.cashAccountId,
    },
    update: {
      fundTransactionId: params.fundTransactionId,
      amount: refundAmount,
      flowDate: params.refundDate,
      accountId: params.cashAccountId,
    },
  });
  await client.fundTransaction.update({
    where: { id: params.fundTransactionId },
    data: { refundAmount, arrivalDate: params.refundDate },
  });
  await upsertEntryBusinessCashFlowLink(client, {
    householdId: params.householdId,
    cashEntryId: cashEntry.id,
    fundTransactionId: params.fundTransactionId,
    businessType: "fund",
    cashFlowDirection: "inflow",
    source: params.source ?? "regular_invest_refund",
    note: "Linked refund cash flow to fund transaction",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
    },
  });

  return cashEntry;
}

export function fundCashFlowDirectionForKind(kind: FundCashFlowKind): "outflow" | "inflow" | "internal" | "none" {
  if (kind === FundCashFlowKind.buy_out || kind === FundCashFlowKind.switch_in) return "outflow";
  if (kind === FundCashFlowKind.refund_in || kind === FundCashFlowKind.redeem_in || kind === FundCashFlowKind.dividend_in || kind === FundCashFlowKind.switch_out) return "inflow";
  if (kind === FundCashFlowKind.dividend_reinvest_internal) return "internal";
  return "none";
}

export async function ensureFundTransactionCashFlowLinks(
  client: Tx | typeof prisma,
  fundTransactionIds: string[],
) {
  const ids = Array.from(new Set(fundTransactionIds.filter(Boolean)));
  if (!ids.length) return 0;

  const rows = await client.fundTransaction.findMany({
    where: { id: { in: ids }, deletedAt: null },
    include: { cashFlows: true },
  });

  let count = 0;
  for (const row of rows) {
    if (row.cashFlows.length === 0) {
      if (row.cashEntryId) {
        const displayFundName = normalizeFundDisplayName(row.fundCode, row.fundName) ?? row.fundName ?? row.fundCode;
        await client.txRecord.update({
          where: { id: row.cashEntryId },
          data: {
            fundCode: row.fundCode,
            fundName: displayFundName,
            fundProductType: row.fundProductType,
            fundSubtype: row.fundSubtype,
          },
        }).catch(() => undefined);
      }
      await upsertEntryBusinessCashFlowLink(client, {
        householdId: row.householdId,
        cashEntryId: row.cashEntryId,
        fundTransactionId: row.id,
        businessType: "fund",
        cashFlowDirection: "none",
        source: row.source,
        note: "Linked fund transaction without cash flow",
        metadata: {
          splitRecord: true,
          independentBusinessTransaction: true,
        },
      });
      count += 1;
      continue;
    }

    for (const flow of row.cashFlows) {
      const displayFundName = normalizeFundDisplayName(row.fundCode, row.fundName) ?? row.fundName ?? row.fundCode;
      const isRefund = flow.kind === FundCashFlowKind.refund_in;
      await upsertEntryBusinessCashFlowLink(client, {
        householdId: row.householdId,
        cashEntryId: flow.txRecordId,
        fundTransactionId: row.id,
        businessType: "fund",
        cashFlowDirection: fundCashFlowDirectionForKind(flow.kind),
        source: row.source,
        note: "Linked cash flow to fund transaction",
        metadata: {
          splitRecord: true,
          independentBusinessTransaction: true,
        },
      });
      await client.txRecord.update({
        where: { id: flow.txRecordId },
        data: {
          fundCode: row.fundCode,
          fundName: displayFundName,
          fundProductType: row.fundProductType,
          fundSubtype: isRefund ? FundSubtype.buy_failed : row.fundSubtype,
        },
      }).catch(() => undefined);
      count += 1;
    }
  }
  return count;
}

export async function syncFundTransactionsFromTxRecords(entryIds: string[], client: Tx | typeof prisma = prisma) {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (!ids.length) return;

  const linkedFundRows = await client.fundTransaction.findMany({
    where: {
      deletedAt: null,
      OR: [
        { cashEntryId: { in: ids } },
        { cashFlows: { some: { txRecordId: { in: ids } } } },
        { EntryBusinessLink: { some: { deletedAt: null, cashEntryId: { in: ids } } } },
      ],
    },
    select: {
      id: true,
      cashEntryId: true,
      cashFlows: { select: { txRecordId: true } },
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { cashEntryId: true },
      },
    },
  });
  if (linkedFundRows.length > 0) {
    await ensureFundTransactionCashFlowLinks(client, linkedFundRows.map((row) => row.id));
  }
  const linkedEntryIds = new Set(
    linkedFundRows.flatMap((row) => [
      row.cashEntryId,
      ...row.cashFlows.map((flow) => flow.txRecordId),
      ...row.EntryBusinessLink.map((link) => link.cashEntryId),
    ].filter((id): id is string => !!id)),
  );
  const legacyIds = ids.filter((id) => !linkedEntryIds.has(id));
  if (!legacyIds.length) return;

  const seedRows = await client.txRecord.findMany({
    where: { id: { in: legacyIds }, fundCode: { not: null } },
  });
  const mainIds = new Set<string>();
  for (const row of seedRows) {
    if (isRefundRow(row)) {
      if (row.fundSourceEntryId) mainIds.add(row.fundSourceEntryId);
    } else {
      mainIds.add(row.id);
    }
  }
  if (!mainIds.size) return;

  const mainRows = await client.txRecord.findMany({
    where: { id: { in: Array.from(mainIds) }, fundCode: { not: null } },
  });

  for (const main of mainRows) {
    if (!main.householdId || !main.fundCode || isRefundRow(main)) continue;
    const fundAccountId = fundAccountIdOf(main);
    if (!fundAccountId) continue;
    const fundSubtype = main.fundSubtype ?? (toNumber(main.amount) < 0 ? FundSubtype.buy : FundSubtype.redeem);
    const linkedCashRows = await client.$queryRaw<any[]>(Prisma.sql`
      SELECT cash.*
      FROM "entry_business_links" link
      JOIN "transactions" cash ON cash."id" = link."cashEntryId"
      WHERE link."businessEntryId" = ${main.id}
        AND link."cashEntryId" IS NOT NULL
        AND link."deletedAt" IS NULL
        AND cash."deletedAt" IS NULL
      ORDER BY cash."date" ASC, cash."createdAt" ASC
    `);
    const primaryCashRow = linkedCashRows[0] ?? null;
    const projectedCashAccountId = cashAccountIdOf(main);
    const legacyCombinedCashRow = primaryCashRow?.id === main.id;
    const primaryCashFlowAccountId = legacyCombinedCashRow
      ? projectedCashAccountId
      : primaryCashRow?.accountId ?? projectedCashAccountId;
    const cashAccountId = primaryCashFlowAccountId;

    const ft = await client.fundTransaction.upsert({
      where: { cashEntryId: main.id },
      create: {
        id: main.id,
        householdId: main.householdId,
        fundAccountId,
        cashAccountId,
        cashEntryId: main.id,
        fundCode: main.fundCode,
        fundName: main.fundName,
        fundProductType: main.fundProductType ?? "fund",
        fundSubtype,
        source: main.source,
        applyDate: main.date,
        confirmDate: main.fundConfirmDate,
        arrivalDate: main.fundArrivalDate,
        grossAmount: Math.abs(toNumber(main.amount)),
        arrivalAmount: main.fundArrivalAmount,
        fee: main.fundFee,
        nav: main.fundNav,
        units: main.fundUnits,
        realizedProfit: main.realizedProfit,
        regularInvestPlanId: main.regularInvestPlanId,
        note: main.note,
        deletedAt: main.deletedAt,
      },
      update: {
        householdId: main.householdId,
        fundAccountId,
        cashAccountId,
        fundCode: main.fundCode,
        fundName: main.fundName,
        fundProductType: main.fundProductType ?? "fund",
        fundSubtype,
        source: main.source,
        applyDate: main.date,
        confirmDate: main.fundConfirmDate,
        arrivalDate: main.fundArrivalDate,
        grossAmount: Math.abs(toNumber(main.amount)),
        arrivalAmount: main.fundArrivalAmount,
        fee: main.fundFee,
        nav: main.fundNav,
        units: main.fundUnits,
        realizedProfit: main.realizedProfit,
        regularInvestPlanId: main.regularInvestPlanId,
        note: main.note,
        deletedAt: main.deletedAt,
      },
    });

    await upsertEntryBusinessCashFlowLink(client, {
      householdId: main.householdId,
      cashEntryId: primaryCashRow?.id ?? main.id,
      businessEntryId: main.id,
      fundTransactionId: ft.id,
      businessType: "fund",
      cashFlowDirection: toNumber(primaryCashRow?.amount ?? main.amount) < 0 ? "outflow" : "inflow",
      source: main.source,
      note: "Linked cash flow to fund transaction",
      metadata: {
        splitRecord: !!primaryCashRow,
        independentBusinessTransaction: true,
      },
    });

    const fallbackRefundDateFilters = [main.fundArrivalDate, main.fundConfirmDate, main.date]
      .filter((date): date is Date => !!date)
      .flatMap((date) => [{ date }, { fundConfirmDate: date }, { fundArrivalDate: date }]);
    const refunds = await client.txRecord.findMany({
      where: {
        fundSubtype: FundSubtype.buy_failed,
        source: "regular_invest_refund",
        deletedAt: null,
        OR: [
          { fundSourceEntryId: main.id },
          ...(main.fundSubtype === FundSubtype.buy_failed && fallbackRefundDateFilters.length > 0
            ? [{
                fundSourceEntryId: null,
                householdId: main.householdId,
                fundCode: main.fundCode,
                accountId: fundAccountId,
                toAccountId: cashAccountId,
                ...(main.regularInvestPlanId ? { regularInvestPlanId: main.regularInvestPlanId } : {}),
                OR: fallbackRefundDateFilters,
              }]
            : []),
        ],
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });
    const unlinkedRefundIds = refunds
      .filter((row) => !row.fundSourceEntryId)
      .map((row) => row.id);
    if (unlinkedRefundIds.length > 0) {
      await client.txRecord.updateMany({
        where: { id: { in: unlinkedRefundIds }, fundSourceEntryId: null },
        data: { fundSourceEntryId: main.id },
      });
    }
    const cashRows = linkedCashRows.length > 0 ? [...linkedCashRows, ...refunds] : [main, ...refunds];

    await client.fundTransactionCashFlow.deleteMany({ where: { fundTransactionId: ft.id } });
    if (cashRows.length) {
      await createManySkipDuplicatesCompat(
        client.fundTransactionCashFlow,
        cashRows.map((row) => ({
          id: `${isRefundRow(row) ? "cfr" : "cff"}_${row.id}`,
          fundTransactionId: ft.id,
          txRecordId: row.id,
          kind: row.id === primaryCashRow?.id ? cashFlowKindOf(main) : cashFlowKindOf(row),
          amount: Math.abs(toNumber(row.fundArrivalAmount ?? row.amount)),
          flowDate: isCashReceiptSubtype(row.fundSubtype ?? main.fundSubtype) || isRefundRow(row)
            ? row.fundArrivalDate ?? row.date
            : row.date,
          accountId: row.id === primaryCashRow?.id
            ? primaryCashFlowAccountId
            : isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
            ? row.toAccountId
            : row.accountId,
        })),
      );
    }

    for (const row of cashRows) {
      const categoryName = getInvestmentCategoryName({
        fundProductType: row.fundProductType ?? main.fundProductType,
        fundSubtype: row.fundSubtype ?? main.fundSubtype,
        source: row.source ?? main.source,
      });
      const category = categoryName
        ? await resolveCategorySnapshot(client, main.householdId, { categoryName, type: "investment" })
        : null;
      await client.txRecord.update({
        where: { id: row.id },
        data: {
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? categoryName ?? null,
        },
      }).catch(() => undefined);
    }

    const refundAmount = refunds.reduce((sum, row) => sum + Math.abs(toNumber(row.fundArrivalAmount ?? row.amount)), 0);
    const lastRefundDate = refunds.reduce<Date | null>((latest, row) => {
      const date = row.fundArrivalDate ?? row.date;
      return !latest || date > latest ? date : latest;
    }, null);
    await client.fundTransaction.update({
      where: { id: ft.id },
      data: {
        refundAmount,
        arrivalDate: lastRefundDate ?? main.fundArrivalDate,
      },
    });
  }
}

export async function loadFundTransactionEntryLike(params: {
  accountId: string;
  householdId: string;
  fundCode?: string;
  entryScope?: "account" | "fund";
}) {
  const rows = await prisma.fundTransaction.findMany({
    where: {
      householdId: params.householdId,
      fundAccountId: params.accountId,
      deletedAt: null,
      ...(params.entryScope === "account" ? {} : { fundCode: params.fundCode || undefined }),
    },
    include: {
      cashFlows: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ applyDate: "desc" }, { createdAt: "desc" }],
  });

  const allCashEntryIds = Array.from(new Set(rows.flatMap((row) => [
    row.cashEntryId,
    ...row.cashFlows.filter((flow) => flow.kind === FundCashFlowKind.refund_in).map((flow) => flow.txRecordId),
  ]).filter((id): id is string => Boolean(id))));
  const entryTagRows = allCashEntryIds.length > 0
    ? await prisma.txRecord.findMany({
        where: { id: { in: allCashEntryIds } },
        select: {
          id: true,
          EntryTag: {
            select: { tagId: true, Tag: { select: { name: true, color: true } } },
          },
        },
      })
    : [];
  const entryTagsById = new Map(entryTagRows.map((row) => [row.id, row.EntryTag]));

  const fundNameByCode = await getFundProfileNameMap(rows.map((row) => row.fundCode));
  const entries: any[] = [];
  for (const row of rows) {
    const displayFundName = fundNameByCode.get(row.fundCode) ?? normalizeFundDisplayName(row.fundCode, row.fundName) ?? row.fundName;
    const mainFlow = row.cashFlows.find((flow) => flow.txRecordId === row.cashEntryId) ?? row.cashFlows[0];
    const validBusinessLinks = row.EntryBusinessLink.filter((link) => (
      !!link.cashEntryId && !!link.CashEntry && link.CashEntry.deletedAt == null
    ));
    const businessLinkLabels = Array.from(new Set(validBusinessLinks.map((link) => entryBusinessTypeLabel(link.businessType))));
    entries.push({
      id: row.cashEntryId ?? row.id,
      fundTransactionId: row.id,
      entryTags: row.cashEntryId ? entryTagsById.get(row.cashEntryId) ?? [] : [],
      date: row.applyDate,
      createdAt: row.createdAt,
      amount: signedFundAmount(row),
      accountId: isCashReceiptSubtype(row.fundSubtype) ? row.fundAccountId : row.cashAccountId,
      accountName: null,
      toAccountId: isCashReceiptSubtype(row.fundSubtype) ? row.cashAccountId : row.fundAccountId,
      toAccountName: null,
      fundCode: row.fundCode,
      fundName: displayFundName,
      fundProductType: row.fundProductType,
      fundSubtype: row.fundSubtype,
      source: row.source,
      fundUnits: row.units,
      fundNav: row.nav,
      fundFee: row.fee,
      fundConfirmDate: row.confirmDate,
      fundArrivalDate: row.arrivalDate,
      fundArrivalAmount: row.arrivalAmount,
      refundAmount: row.refundAmount,
      fundSourceEntryId: null,
      regularInvestPlanId: row.regularInvestPlanId,
      realizedProfit: row.realizedProfit,
      note: row.note,
      cashFlowId: mainFlow?.id ?? null,
      businessLinkCount: validBusinessLinks.length,
      businessLinkLabels,
    });

    for (const flow of row.cashFlows) {
      if (flow.kind !== FundCashFlowKind.refund_in) continue;
      entries.push({
        id: flow.txRecordId,
        fundTransactionId: row.id,
        entryTags: entryTagsById.get(flow.txRecordId) ?? [],
        date: row.applyDate,
        createdAt: flow.createdAt,
        amount: -Math.abs(toNumber(flow.amount)),
        accountId: row.fundAccountId,
        accountName: null,
        toAccountId: flow.accountId ?? row.cashAccountId,
        toAccountName: null,
        fundCode: row.fundCode,
        fundName: displayFundName,
        fundProductType: row.fundProductType,
        fundSubtype: FundSubtype.buy_failed,
        source: "regular_invest_refund",
        fundUnits: null,
        fundNav: null,
        fundFee: null,
        fundConfirmDate: row.applyDate,
        fundArrivalDate: flow.flowDate,
        fundArrivalAmount: flow.amount,
        fundSourceEntryId: row.cashEntryId ?? row.id,
        regularInvestPlanId: row.regularInvestPlanId,
        realizedProfit: null,
        note: regularInvestRefundNote(row.fundCode, displayFundName, toNumber(flow.amount), row.applyDate),
        fundCashFlowOnly: true,
        businessLinkCount: validBusinessLinks.length,
        businessLinkLabels,
      });
    }
  }
  return entries;
}
async function resolveFundDisplayNameForCashFlow(
  client: Tx | typeof prisma,
  params: { fundCode: string; storedName: string | null },
) {
  const direct = normalizeFundDisplayName(params.fundCode, params.storedName);
  if (direct) return direct;
  if (!/^\d{6}$/.test(params.fundCode)) return null;
  try {
    const profile = await client.fundProfile?.findUnique({ where: { fundCode: params.fundCode } });
    if (!profile) return null;
    return normalizeFundDisplayName(profile.fundCode, profile.fundName);
  } catch {
    return null;
  }
}
