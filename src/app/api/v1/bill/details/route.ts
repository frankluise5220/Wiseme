/**
 * API: /api/v1/bill/details
 *
 * GET ?accountId=&billMonth=YYYY-MM|all
 *
 * Returns credit-card bill detail rows for lightweight client-side month
 * switching. This endpoint only loads detail rows and cycle metadata; it does
 * not rebuild the bill summary list.
 */
import { NextResponse } from "next/server";
import { AccountKind, TransactionType, type Prisma } from "@prisma/client";
import type { DetailEntry } from "@/components/DetailViewClient";
import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, formatDateLocal, toNumber } from "@/lib/date-utils";
import { creditBillDateRangeWhere, cycleForStatementMonth } from "@/lib/credit/billing";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const CREDIT_BILL_DETAIL_TAKE = 500;

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toDateOnlyLocalOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? formatDateLocal(date) : null;
}

function toYmdOrNull(value: unknown) {
  return toDateOnlyLocalOrNull(value) ?? "";
}

function mdUtcDots(date: Date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}.${day}`;
}

function isSettlementDebtAccount(account?: { kind?: AccountKind | null; counterpartyId?: string | null } | null) {
  return account?.kind === AccountKind.settlement || (account?.kind === AccountKind.loan && !!account.counterpartyId);
}

function mapDetailEntry(
  entry: Prisma.TxRecordGetPayload<{
    include: {
      EntryTag: { include: { Tag: true } };
      Attachment: { select: { id: true; name: true; mimeType: true; url: true } };
      EntryBusinessLinkCash: typeof entryBusinessLinkSummaryInclude.EntryBusinessLinkCash;
      EntryBusinessLinkBusiness: typeof entryBusinessLinkSummaryInclude.EntryBusinessLinkBusiness;
      account: { include: { Institution: { select: { name: true; shortName: true } }; AccountGroup: { select: { name: true } } } };
      toAccount: { include: { Institution: { select: { name: true; shortName: true } }; AccountGroup: { select: { name: true } } } };
    };
  }>,
  billAccountIdSet: Set<string>,
): DetailEntry {
  return {
    id: entry.id,
    date: toYmdOrNull(entry.date),
    postedAt: toDateOnlyLocalOrNull(entry.postedAt),
    createdAt: toIsoOrNull(entry.createdAt),
    dayOrder: entry.dayOrder ?? 0,
    amount: toNumber(
      entry.type === TransactionType.transfer && billAccountIdSet.has(entry.toAccountId ?? "")
        ? Math.abs(toNumber(entry.amount))
        : entry.amount,
    ),
    runningBalance: null,
    type: entry.type,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    accountId: entry.accountId,
    accountName: entry.accountName,
    accountKind: entry.account?.kind ?? null,
    accountDebtDirection: entry.account?.debtDirection ?? null,
    accountIsSettlementDebt: isSettlementDebtAccount(entry.account),
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? null,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? null,
    toAccountId: entry.toAccountId,
    toAccountName: entry.toAccountName,
    toAccountKind: entry.toAccount?.kind ?? null,
    toAccountDebtDirection: entry.toAccount?.debtDirection ?? null,
    toAccountIsSettlementDebt: isSettlementDebtAccount(entry.toAccount),
    toNote: entry.toNote,
    note: entry.note,
    fundSubtype: entry.fundSubtype,
    fundCode: entry.fundCode,
    fundName: entry.fundName,
    wealthProductId: entry.wealthProductId ?? null,
    source: entry.source,
    insuranceProductId: entry.insuranceProductId ?? null,
    debtPrincipalAmount: entry.debtPrincipalAmount != null ? toNumber(entry.debtPrincipalAmount) : null,
    debtInterestAmount: entry.debtInterestAmount != null ? toNumber(entry.debtInterestAmount) : null,
    debtFeeAmount: entry.debtFeeAmount != null ? toNumber(entry.debtFeeAmount) : null,
    depositAnnualRate: entry.depositAnnualRate != null ? toNumber(entry.depositAnnualRate) : null,
    depositInterest: entry.depositInterest != null ? toNumber(entry.depositInterest) : null,
    fundProductType: entry.fundProductType,
    metalTypeId: entry.metalTypeId ?? null,
    metalTypeName: entry.metalTypeName ?? null,
    metalUnitId: entry.metalUnitId ?? null,
    metalUnitName: entry.metalUnitName ?? null,
    metalQuantity: entry.metalQuantity != null ? toNumber(entry.metalQuantity) : null,
    metalUnitPrice: entry.metalUnitPrice != null ? toNumber(entry.metalUnitPrice) : null,
    metalFee: entry.metalFee != null ? toNumber(entry.metalFee) : null,
    fundUnits: entry.fundUnits != null ? toNumber(entry.fundUnits) : null,
    fundNav: entry.fundNav != null ? toNumber(entry.fundNav) : null,
    fundFee: entry.fundFee != null ? toNumber(entry.fundFee) : null,
    fundConfirmDate: toIsoOrNull(entry.fundConfirmDate),
    fundArrivalDate: toIsoOrNull(entry.fundArrivalDate),
    fundArrivalAmount: entry.fundArrivalAmount != null ? toNumber(entry.fundArrivalAmount) : null,
    ...buildEntryBusinessLinkSummary(entry),
    attachments: (entry.Attachment || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "",
      mimeType: attachment.mimeType ?? null,
      url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
    })),
    entryTags: (entry.EntryTag || []).map((entryTag) => ({
      tagId: entryTag.tagId,
      Tag: entryTag.Tag ? { name: entryTag.Tag.name, color: entryTag.Tag.color ?? "" } : null,
    })),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = (url.searchParams.get("accountId") ?? "").trim();
  const billMonth = (url.searchParams.get("billMonth") ?? "all").trim() || "all";
  const showAllDetails = billMonth === "all";

  if (!accountId) {
    return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "Missing accountId." }, { status: 400 });
  }
  if (!showAllDetails && !/^\d{4}-\d{2}$/.test(billMonth)) {
    return NextResponse.json({ ok: false, code: "INVALID_BILL_MONTH", error: "billMonth must be YYYY-MM or all." }, { status: 400 });
  }

  try {
    const { householdId } = await getHouseholdScope();
    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit },
      select: {
        id: true,
        householdId: true,
        institutionId: true,
        kind: true,
        billingDay: true,
        repaymentDay: true,
        repaymentOffsetDays: true,
        creditBillMode: true,
      },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "Credit account not found." }, { status: 404 });
    }

    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const billAccountIdSet = new Set(billAccountIds);
    const storageAccountId = billAccountIds[0] ?? account.id;
    const billScope: Prisma.TxRecordWhereInput = {
      OR: [
        { accountId: { in: billAccountIds } },
        { toAccountId: { in: billAccountIds } },
      ],
    };

    const cycle = showAllDetails
      ? null
      : await (async () => {
          const persisted = await prisma.creditCardCycle.findUnique({
            where: {
              accountId_statementMonth: {
                accountId: storageAccountId,
                statementMonth: billMonth,
              },
            },
            select: {
              periodStart: true,
              periodEnd: true,
              dueDate: true,
              isCurrentCycle: true,
            },
          });
          if (persisted) {
            return {
              statementMonth: billMonth,
              start: persisted.periodStart,
              end: persisted.periodEnd,
              due: persisted.dueDate,
              isCurrentCycle: persisted.isCurrentCycle,
            };
          }
          if (!account.billingDay) return null;
          const computed = cycleForStatementMonth(
            billMonth,
            account.billingDay,
            account.repaymentDay ?? null,
            new Date(),
            account.repaymentOffsetDays,
          );
          return computed
            ? {
                statementMonth: billMonth,
                start: computed.start,
                end: computed.end,
                due: computed.due,
                isCurrentCycle: computed.isCurrentCycle,
              }
            : null;
        })();

    if (!showAllDetails && !cycle) {
      return NextResponse.json({ ok: false, code: "BILL_CYCLE_NOT_FOUND", error: "Bill cycle not found." }, { status: 404 });
    }

    const dateScope: Prisma.TxRecordWhereInput[] = cycle
      ? [creditBillDateRangeWhere(cycle.start, addDaysUtc(cycle.end, 1))]
      : [];
    const where: Prisma.TxRecordWhereInput = {
      householdId,
      type: { in: [TransactionType.expense, TransactionType.income, TransactionType.transfer, TransactionType.investment] },
      deletedAt: null,
      AND: [billScope, ...dateScope],
    };

    const [totalCount, rows] = await Promise.all([
      prisma.txRecord.count({ where }),
      prisma.txRecord.findMany({
        where,
        include: {
          EntryTag: { include: { Tag: true } },
          Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
          ...entryBusinessLinkSummaryInclude,
          account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: CREDIT_BILL_DETAIL_TAKE,
      }),
    ]);

    const details = rows.map((row) => mapDetailEntry(row, billAccountIdSet));

    return NextResponse.json({
      ok: true,
      data: {
        accountId,
        billMonth,
        showAllDetails,
        totalCount,
        entries: details,
        cycle: cycle
          ? {
              statementMonth: cycle.statementMonth,
              periodStart: formatDateLocal(cycle.start),
              periodEnd: formatDateLocal(cycle.end),
              dueDate: cycle.due ? formatDateLocal(cycle.due) : null,
              periodLabel: `${mdUtcDots(cycle.start)} ~ ${mdUtcDots(cycle.end)}`,
              isCurrentCycle: cycle.isCurrentCycle,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("GET /api/v1/bill/details error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Internal server error." }, { status: 500 });
  }
}
