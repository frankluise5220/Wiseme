import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { isWealthHoldingCleared, resetWealthHoldingBucket } from "@/lib/invest-balance";
import { entryBusinessTypeLabel } from "@/lib/server/entry-business-link";
import { optionalPrismaFindMany } from "@/lib/server/optional-prisma-delegate";
import { calculateWealthCashDividendProfit, calculateWealthPositionsFromEntries, inferWealthUnitNav } from "@/lib/wealth-position";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";

function ymd(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function linkSummary(rows: Array<{
  businessType: string;
  cashEntryId?: string | null;
  CashEntry?: { id: string; deletedAt?: Date | null } | null;
}>) {
  const validRows = rows.filter((row) => {
    if (!("cashEntryId" in row)) return true;
    if (!row.cashEntryId) return false;
    return !!row.CashEntry && row.CashEntry.deletedAt == null;
  });
  return {
    businessLinkCount: validRows.length,
    businessLinkLabels: Array.from(new Set(validRows.map((row) => entryBusinessTypeLabel(row.businessType)))),
  };
}

function isCashInAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.redeem || action === FundSubtype.switch_out || action === FundSubtype.dividend_cash;
}

function accountLabel(account?: { name?: string | null; Institution?: { shortName?: string | null; name?: string | null } | null } | null) {
  if (!account) return "";
  return [account.Institution?.shortName || account.Institution?.name || "", account.name || ""].filter(Boolean).join(" · ");
}

export async function loadInsuranceTransactionDetailLike(params: {
  householdId: string;
  accountId: string;
}) {
  const rows = await prisma.insuranceTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      deletedAt: null,
    },
    include: {
      CashAccount: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      Account: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      InsuranceProduct: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const action = row.action || "premium";
    const isRefund = action === "refund";
    const amount = Math.abs(toNumber(row.amount));
    const cashAccountName = row.CashAccount?.name ?? "";
    const businessAccountName = row.Account?.name ?? "";
    return {
      id: row.cashEntryId ?? row.id,
      cashEntryId: row.cashEntryId,
      businessTransactionId: row.id,
      date: ymd(row.tradeDate),
      postedAt: ymd(row.postedAt),
      createdAt: iso(row.createdAt),
      fundArrivalDate: ymd(row.arrivalDate),
      amount: isRefund ? amount : -amount,
      type: "investment",
      source: "insurance",
      accountId: isRefund ? row.accountId : row.cashAccountId,
      accountName: isRefund ? businessAccountName : cashAccountName,
      accountInstitutionName: isRefund ? row.Account.Institution?.shortName ?? row.Account.Institution?.name ?? "" : row.CashAccount?.Institution?.shortName ?? row.CashAccount?.Institution?.name ?? "",
      toAccountId: isRefund ? row.cashAccountId : row.accountId,
      toAccountName: isRefund ? cashAccountName : businessAccountName,
      toAccountInstitutionName: isRefund ? row.CashAccount?.Institution?.shortName ?? row.CashAccount?.Institution?.name ?? "" : row.Account.Institution?.shortName ?? row.Account.Institution?.name ?? "",
      fundSubtype: isRefund ? FundSubtype.redeem : FundSubtype.buy,
      fundProductType: null,
      fundName: row.InsuranceProduct?.name ?? "",
      insuranceProductName: row.InsuranceProduct?.name ?? "",
      insuranceProductId: row.insuranceProductId,
      insuranceAction: action,
      note: row.note,
      fundFee: row.fee == null ? null : toNumber(row.fee),
      realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
      coverageAmount: row.InsuranceProduct?.coverageAmount == null ? null : toNumber(row.InsuranceProduct.coverageAmount),
      paymentTermYears: row.InsuranceProduct?.paymentTermYears == null ? null : toNumber(row.InsuranceProduct.paymentTermYears),
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}

export async function loadDepositTransactionDetailLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.depositTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      CashAccount: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const principal = Math.abs(toNumber(row.principalAmount));
    const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
    return {
      id: row.cashEntryId ?? row.id,
      cashEntryId: row.cashEntryId,
      businessTransactionId: row.id,
      date: ymd(row.tradeDate),
      createdAt: iso(row.createdAt),
      deletedAt: iso(row.deletedAt),
      type: "investment",
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? arrivalAmount ?? principal : -principal,
      fundCode: null,
      fundName: row.productName ?? "",
      fundProductType: "deposit",
      fundSubtype: row.action,
      fundNav: row.annualRate == null ? null : toNumber(row.annualRate),
      fundConfirmDate: null,
      fundArrivalDate: ymd(row.arrivalDate ?? row.maturityDate),
      fundArrivalAmount: row.arrivalAmount,
      depositAnnualRate: row.annualRate,
      depositInterest: row.interest,
      depositSourceEntryId: row.sourceDepositTransactionId,
      source: row.source,
      note: row.note,
      cashAccountLabel: accountLabel(row.CashAccount),
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}

export async function loadWealthTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.wealthTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: true,
      CashAccount: true,
      WealthProduct: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  const profitByTransactionId = new Map<string, number>();
  const rowsByAccountId = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByAccountId.get(row.accountId) ?? [];
    list.push(row);
    rowsByAccountId.set(row.accountId, list);
  }
  for (const accountRows of rowsByAccountId.values()) {
    const fundUnitsDecimals = normalizeFundUnitsDecimals(accountRows[0]?.Account?.fundUnitsDecimals, 2);
    const calc = calculateWealthPositionsFromEntries(
      accountRows.map((row) => ({
        id: row.id,
        cashEntryId: row.cashEntryId,
        productKey: `${row.accountId}:${row.wealthProductId ?? row.productName ?? `wealth:${row.id}`}`,
        action: row.action,
        tradeDate: row.tradeDate,
        createdAt: row.createdAt,
        grossAmount: row.grossAmount,
        arrivalAmount: row.arrivalAmount,
        units: row.units,
        nav: row.nav,
        interest: row.interest,
        fee: row.fee,
      })),
      fundUnitsDecimals,
    );
    for (const [entryId, profit] of calc.realizedProfitByTransactionId) {
      profitByTransactionId.set(entryId, profit);
    }
  }
  const unitBuckets = new Map<string, { principal: number; units: number; cycleHasUnits: boolean }>();
  const remainingUnitsByTransactionId = new Map<string, number | null>();
  for (const row of rows) {
    const isCashIn = isCashInAction(row.action);
    const isDividend = row.action === FundSubtype.dividend_cash;
    const key = `${row.accountId}:${row.wealthProductId ?? row.productName ?? `wealth:${row.id}`}`;
    const bucket = unitBuckets.get(key) ?? { principal: 0, units: 0, cycleHasUnits: false };
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const units = row.units == null ? null : Math.abs(toNumber(row.units));

    if (!isDividend) {
      if (isCashIn) {
        bucket.principal -= grossAmount;
        if (units != null) {
          bucket.cycleHasUnits = true;
          bucket.units -= units;
        }
        if (isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)) {
          resetWealthHoldingBucket(bucket);
        }
      } else {
        bucket.principal += grossAmount;
        if (units != null) {
          bucket.cycleHasUnits = true;
          bucket.units += units;
        }
      }
    }

    unitBuckets.set(key, bucket);
    remainingUnitsByTransactionId.set(row.id, bucket.cycleHasUnits ? Number(Math.max(0, bucket.units).toFixed(6)) : null);
  }


  const cashEntryIds = Array.from(
    new Set(rows.map((row) => row.cashEntryId).filter((id): id is string => Boolean(id))),
  );
  const linkedCashEntries = cashEntryIds.length === 0
    ? []
    : await prisma.txRecord.findMany({
        where: { id: { in: cashEntryIds }, deletedAt: null },
        select: {
          id: true,
          date: true,
          EntryTag: {
            select: { tagId: true, Tag: { select: { name: true, color: true } } },
          },
        },
      });
  const cashDateById = new Map(linkedCashEntries.map((entry) => [entry.id, entry.date]));
  const entryTagsById = new Map(linkedCashEntries.map((entry) => [entry.id, entry.EntryTag]));

  const projectedRows = rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const isDividend = row.action === FundSubtype.dividend_cash;
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
    const displayNav = inferWealthUnitNav({
      nav: row.nav,
      grossAmount: grossAmount,
      arrivalAmount: arrivalAmount,
      units: row.units,
    });
    const profit = profitByTransactionId.get(row.id)
      ?? (isDividend
        ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
        : row.realizedProfit == null
          ? (toNumber(row.interest) - toNumber(row.fee))
          : toNumber(row.realizedProfit));
    return {
      id: row.cashEntryId ?? row.id,
      cashEntryId: row.cashEntryId,
      businessTransactionId: row.id,
      entryTags: row.cashEntryId ? entryTagsById.get(row.cashEntryId) ?? [] : [],
      date: row.tradeDate,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? arrivalAmount ?? grossAmount : -grossAmount,
      wealthPrincipalAmount: grossAmount,
      fundCode: null,
      fundName: row.WealthProduct?.name ?? row.productName ?? "",
      fundProductType: "wealth",
      fundSubtype: row.action,
      fundUnits: row.units == null ? null : toNumber(row.units),
      wealthRemainingUnits: remainingUnitsByTransactionId.get(row.id) ?? null,
      fundNav: displayNav == null ? null : displayNav,
      fundArrivalAmount: row.arrivalAmount,
      fundArrivalDate: ymd(
        row.arrivalDate ?? (row.cashEntryId ? cashDateById.get(row.cashEntryId) : null),
      ),
      depositAnnualRate: row.annualRate ?? row.WealthProduct?.annualRate ?? null,
      depositInterest: row.interest,
      realizedProfit: isCashIn ? profit : null,
      wealthProductId: row.wealthProductId,
      WealthProduct: row.WealthProduct,
      source: row.source,
      note: row.note,
      ...linkSummary(row.EntryBusinessLink),
    };
  });

  return projectedRows.sort((a, b) => {
    const dateDiff = new Date(a.date as any).getTime() - new Date(b.date as any).getTime();
    if (dateDiff !== 0) return dateDiff;
    return new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime();
  });
}

export async function loadPreciousMetalTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.preciousMetalTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: true,
      CashAccount: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  const metalCashEntryIds = Array.from(new Set(rows.map((row) => row.cashEntryId).filter((id): id is string => Boolean(id))));
  const metalCashEntries = metalCashEntryIds.length === 0
    ? []
    : await prisma.txRecord.findMany({
        where: { id: { in: metalCashEntryIds }, deletedAt: null },
        select: {
          id: true,
          EntryTag: {
            select: { tagId: true, Tag: { select: { name: true, color: true } } },
          },
        },
      });
  const entryTagsById = new Map(metalCashEntries.map((entry) => [entry.id, entry.EntryTag]));

  return rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const amount = Math.abs(toNumber(row.amount));
    return {
      id: row.cashEntryId ?? row.id,
      cashEntryId: row.cashEntryId,
      businessTransactionId: row.id,
      entryTags: row.cashEntryId ? entryTagsById.get(row.cashEntryId) ?? [] : [],
      date: row.tradeDate,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? amount : -amount,
      fundCode: row.metalTypeId,
      fundName: row.metalTypeName,
      fundProductType: "metal",
      fundSubtype: row.action,
      source: row.source,
      note: row.note,
      realizedProfit: row.realizedProfit,
      metalTypeId: row.metalTypeId,
      metalTypeName: row.metalTypeName,
      metalUnitId: row.metalUnitId,
      metalUnitName: row.metalUnitName,
      metalQuantity: row.quantity,
      metalUnitPrice: row.unitPrice,
      metalFee: row.fee,
      fundFee: row.fee,
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}

export async function loadPropertyTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await optionalPrismaFindMany<any>(
    prisma,
    "propertyTransaction",
    {
      where: {
        householdId: params.householdId,
        accountId: { in: accountIds },
        deletedAt: null,
      },
      include: {
        Account: { select: { name: true, currency: true } },
        CashAccount: { select: { name: true, currency: true } },
        PropertyAsset: { select: { name: true } },
        EntryBusinessLink: {
          where: { deletedAt: null },
          select: {
            businessType: true,
            cashEntryId: true,
            CashEntry: { select: { id: true, deletedAt: true } },
          },
        },
      },
      orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
    },
    { tableNames: ["property_transactions"] },
  );

  // Older property rows may have lost their direct cashEntryId while the
  // corresponding EntryBusinessLink still retains the cash-side reference.
  // Resolve both shapes so the detail table keeps the standard TxRecord data
  // (category, posted date, attachments, tags, and institution) available.
  const linkedCashEntryIdByPropertyId = new Map<string, string>();
  for (const row of rows) {
    if (row.cashEntryId) continue;
    const linkedCashEntryId = row.EntryBusinessLink.find((link: { cashEntryId?: string | null; CashEntry?: { id: string; deletedAt?: Date | null } | null }) =>
      Boolean(link.cashEntryId && link.CashEntry && link.CashEntry.deletedAt == null),
    )?.cashEntryId;
    if (linkedCashEntryId) linkedCashEntryIdByPropertyId.set(row.id, linkedCashEntryId);
  }
  const cashEntryIds = Array.from(new Set(rows.map((row) => row.cashEntryId ?? linkedCashEntryIdByPropertyId.get(row.id)).filter(Boolean)));
  const cashEntries = cashEntryIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          householdId: params.householdId,
          id: { in: cashEntryIds },
          deletedAt: null,
        },
        select: {
          id: true,
          type: true,
          categoryId: true,
          categoryName: true,
          postedAt: true,
          currency: true,
          counterpartyInstitutionId: true,
          counterpartyInstitutionName: true,
          Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
          EntryTag: {
            select: {
              tagId: true,
              Tag: {
                select: {
                  name: true,
                  color: true,
                },
              },
            },
          },
        },
      })
    : [];
  const cashEntryById = new Map(cashEntries.map((row) => [row.id, row]));

  return rows.map((row) => {
    const candidateCashEntryId = row.cashEntryId ?? linkedCashEntryIdByPropertyId.get(row.id) ?? null;
    const cashEntry = candidateCashEntryId ? cashEntryById.get(candidateCashEntryId) ?? null : null;
    const linkedCashEntryId = cashEntry?.id ?? null;
    const isCashIn = row.action === "sale";
    const amount = Math.abs(toNumber(row.amount));
    const fee = row.fee == null ? null : toNumber(row.fee);
    const tax = row.tax == null ? null : toNumber(row.tax);
    const type = cashEntry?.type === "income" || cashEntry?.type === "expense"
      ? cashEntry.type
      : isCashIn
        ? "income"
        : "expense";
    return {
      id: linkedCashEntryId ?? row.id,
      cashEntryId: linkedCashEntryId,
      businessTransactionId: row.id,
      date: ymd(row.tradeDate),
      postedAt: cashEntry?.postedAt ? ymd(cashEntry.postedAt) : ymd(row.tradeDate),
      createdAt: iso(row.createdAt),
      deletedAt: iso(row.deletedAt),
      accountId: row.cashAccountId ?? row.accountId,
      accountName: row.CashAccount?.name ?? row.Account.name,
      toAccountId: row.accountId,
      toAccountName: row.Account.name,
      currency: cashEntry?.currency ?? row.CashAccount?.currency ?? row.Account.currency ?? "CNY",
      amount: isCashIn ? amount : -amount,
      type,
      categoryId: cashEntry?.categoryId ?? null,
      categoryName: cashEntry?.categoryName ?? null,
      counterpartyInstitutionId: cashEntry?.counterpartyInstitutionId ?? null,
      counterpartyInstitutionName: cashEntry?.counterpartyInstitutionName ?? null,
      entryTags: cashEntry?.EntryTag ?? [],
      attachments: (cashEntry?.Attachment ?? []).map((attachment: { id: string; name: string | null; mimeType: string | null; url: string | null }) => ({
        id: attachment.id,
        name: attachment.name ?? "",
        mimeType: attachment.mimeType,
        url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
      })),
      fundCode: row.propertyAssetId,
      fundName: row.PropertyAsset?.name ?? "",
      fundProductType: "property",
      fundSubtype: row.action,
      fundFee: fee,
      realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
      propertyAssetId: row.propertyAssetId,
      propertyAction: row.action,
      propertySettlementDate: ymd(row.settlementDate),
      propertyTax: tax,
      source: row.source,
      note: row.note,
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}
