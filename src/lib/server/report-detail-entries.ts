import type { DetailEntry } from "@/components/DetailViewClient";
import { prisma } from "@/lib/db/prisma";
import { formatDateLocal, toNumber } from "@/lib/date-utils";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import type { HouseholdContext } from "@/lib/server/household-scope";

export async function loadReportDetailEntries(
  ctx: HouseholdContext,
  entryIds: string[],
): Promise<DetailEntry[]> {
  const uniqueEntryIds = [...new Set(entryIds)].filter(Boolean);
  if (uniqueEntryIds.length === 0) return [];

  const records = await prisma.txRecord.findMany({
    where: {
      ...ctx.hidFilter,
      deletedAt: null,
      id: { in: uniqueEntryIds },
    },
    include: {
      EntryTag: { include: { Tag: true } },
      Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
      ...entryBusinessLinkSummaryInclude,
      account: { include: { Institution: { select: { name: true } } } },
      toAccount: { include: { Institution: { select: { name: true } } } },
    },
  });

  const detailEntryById = new Map<string, DetailEntry>(records.map((record) => [record.id, {
    id: record.id,
    date: formatDateLocal(record.date),
    postedAt: record.postedAt ? formatDateLocal(record.postedAt) : null,
    createdAt: record.createdAt.toISOString(),
    dayOrder: record.dayOrder,
    // Redemption principal is a transfer between investment and cash accounts;
    // only the realized result belongs in income/expense detail.
    amount: record.type === "investment" && (record.fundSubtype === "redeem" || record.fundSubtype === "switch_out")
      ? 0
      : toNumber(record.amount),
    currency: record.currency ?? "CNY",
    runningBalance: null,
    type: record.type,
    categoryId: record.categoryId,
    categoryName: record.categoryName,
    accountId: record.accountId,
    accountName: record.account?.name ?? record.accountName,
    accountKind: record.account?.kind ?? null,
    accountDebtDirection: record.account?.debtDirection ?? null,
    accountInstitutionName: record.account?.Institution?.name ?? "",
    counterpartyInstitutionId: record.counterpartyInstitutionId,
    counterpartyInstitutionName: record.counterpartyInstitutionName,
    toAccountId: record.toAccountId,
    toAccountName: record.toAccount?.name ?? record.toAccountName,
    toAccountKind: record.toAccount?.kind ?? null,
    toAccountDebtDirection: record.toAccount?.debtDirection ?? null,
    toAccountInstitutionName: record.toAccount?.Institution?.name ?? "",
    note: record.note,
    toNote: record.toNote,
    fundSubtype: record.fundSubtype,
    fundCode: record.fundCode,
    fundName: record.fundName,
    wealthProductId: record.wealthProductId,
    insuranceProductId: record.insuranceProductId,
    insuranceAction: record.insuranceAction,
    insuranceProductName: record.insuranceProductName,
    metalTypeId: record.metalTypeId,
    metalTypeName: record.metalTypeName,
    metalUnitId: record.metalUnitId,
    metalUnitName: record.metalUnitName,
    metalQuantity: record.metalQuantity == null ? null : toNumber(record.metalQuantity),
    metalUnitPrice: record.metalUnitPrice == null ? null : toNumber(record.metalUnitPrice),
    metalFee: record.metalFee == null ? null : toNumber(record.metalFee),
    source: record.source,
    fundProductType: record.fundProductType,
    fundUnits: record.fundUnits == null ? null : toNumber(record.fundUnits),
    fundNav: record.fundNav == null ? null : toNumber(record.fundNav),
    realizedProfit: record.realizedProfit == null
      ? (record.fundSubtype === "redeem" || record.fundSubtype === "switch_out"
        ? (record.depositInterest == null ? null : toNumber(record.depositInterest))
        : null)
      : toNumber(record.realizedProfit),
    depositAnnualRate: record.depositAnnualRate == null ? null : toNumber(record.depositAnnualRate),
    depositInterest: record.depositInterest == null ? null : toNumber(record.depositInterest),
    depositSourceEntryId: record.depositSourceEntryId,
    fundSourceEntryId: record.fundSourceEntryId,
    fundFee: record.fundFee == null ? null : toNumber(record.fundFee),
    fundConfirmDate: record.fundConfirmDate ? formatDateLocal(record.fundConfirmDate) : null,
    fundArrivalDate: record.fundArrivalDate ? formatDateLocal(record.fundArrivalDate) : null,
    fundArrivalAmount: record.fundArrivalAmount == null ? null : toNumber(record.fundArrivalAmount),
    ...buildEntryBusinessLinkSummary(record),
    attachments: (record.Attachment || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "",
      mimeType: attachment.mimeType ?? null,
      url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
    })),
    entryTags: record.EntryTag.map((entryTag) => ({
      tagId: entryTag.tagId,
      Tag: entryTag.Tag ? { name: entryTag.Tag.name, color: entryTag.Tag.color ?? "#3B82F6" } : null,
    })),
  }]));

  return uniqueEntryIds.flatMap((entryId) => {
    const entry = detailEntryById.get(entryId);
    return entry ? [entry] : [];
  });
}
