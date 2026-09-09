/**
 * API: GET /api/v1/onboarding/status
 *
 * Returns first-use setup progress for the current ledger.
 *
 * Response:
 * {
 *   ok: true,
 *   data: {
 *     householdId: string;
 *     householdName: string;
 *     defaultOwnerName: string | null;
 *     familyMemberCount: number;
 *     accountCount: number;
 *     cashLikeAccountCount: number;
 *     defaultMoneyAccountId: string | null;
 *     defaultMoneyAccountLabel: string | null;
 *     cashAccountCount: number;
 *     debitAccountCount: number;
 *     creditAccountCount: number;
 *     investmentAccountCount: number;
 *     insuranceAccountCount: number;
 *     settlementAccountCount: number;
 *     initializationEntryCount: number;
 *     transactionCount: number;      // non-initialization, non-deleted entries
 *     fundHoldingCount: number;
 *     regularInvestPlanCount: number;
 *     shouldShowGuide: boolean;
 *   }
 * }
 *
 * Error response: { ok: false, error }
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { BALANCE_INITIALIZATION_SOURCE } from "@/lib/balance-reconcile";

const CASH_LIKE_KINDS = ["cash", "bank_debit", "ewallet"] as const;
const DEFAULT_MONEY_ACCOUNT_KIND_ORDER = new Map<string, number>([
  ["cash", 0],
  ["bank_debit", 1],
  ["ewallet", 2],
]);

export async function GET() {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
  const accountLabelFields = await getServerAccountLabelFields();
    const [household, defaultOwner, familyMemberCount, accounts] = await Promise.all([
      prisma.household.findUnique({ where: { id: householdId }, select: { name: true } }),
      prisma.accountGroup.findFirst({
        where: { householdId },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { name: true },
      }),
      prisma.institution.count({ where: { ...hidFilter, type: "family_member" } }),
      prisma.account.findMany({
        where: {
          ...hidFilter,
          isActive: true,
          isPlaceholder: false,
        },
        select: {
          id: true,
          name: true,
          kind: true,
          numberMasked: true,
          groupId: true,
          investProductType: true,
          Institution: { select: { name: true, shortName: true } },
          AccountGroup: { select: { id: true, name: true } },
        },
        orderBy: [
          { createdAt: "asc" },
          { name: "asc" },
        ],
      }),
    ]);
    const cashLikeAccounts = accounts.filter((account) => CASH_LIKE_KINDS.includes(account.kind as typeof CASH_LIKE_KINDS[number]));
    const defaultMoneyAccount = [...cashLikeAccounts].sort((a, b) => {
      const orderA = DEFAULT_MONEY_ACCOUNT_KIND_ORDER.get(a.kind) ?? 99;
      const orderB = DEFAULT_MONEY_ACCOUNT_KIND_ORDER.get(b.kind) ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name, "zh-CN");
    })[0] ?? null;
    const defaultMoneyAccountDisplay = defaultMoneyAccount
      ? buildAccountDisplayOption(defaultMoneyAccount, undefined, { fields: accountLabelFields })
      : null;
    const investmentAccountIds = accounts
      .filter((account) => account.kind === "investment")
      .map((account) => account.id);

    const [
      initializationEntryCount,
      transactionCount,
      regularInvestPlanCount,
    ] = await prisma.$transaction([
      prisma.txRecord.count({
        where: {
          ...hidFilter,
          deletedAt: null,
          source: BALANCE_INITIALIZATION_SOURCE,
        },
      }),
      prisma.txRecord.count({
        where: {
          ...hidFilter,
          deletedAt: null,
          OR: [
            { source: null },
            { source: { not: BALANCE_INITIALIZATION_SOURCE } },
          ],
        },
      }),
      prisma.regularInvestPlan.count({
        where: { householdId },
      }),
    ]);
    const fundHoldingCount = investmentAccountIds.length > 0
      ? await prisma.fundHolding.count({
          where: {
            accountId: { in: investmentAccountIds },
            units: { gt: 0 },
          },
        })
      : 0;

    const hasAnyUserData =
      initializationEntryCount > 0 ||
      transactionCount > 0 ||
      fundHoldingCount > 0 ||
      regularInvestPlanCount > 0;

    return NextResponse.json({
      ok: true,
      data: {
        householdId,
        householdName: household?.name ?? "",
        defaultOwnerName: defaultOwner?.name ?? null,
        familyMemberCount,
        accountCount: accounts.length,
        cashLikeAccountCount: cashLikeAccounts.length,
        defaultMoneyAccountId: defaultMoneyAccount?.id ?? null,
        defaultMoneyAccountLabel: defaultMoneyAccountDisplay?.fullLabel || defaultMoneyAccountDisplay?.label || defaultMoneyAccount?.name || null,
        cashAccountCount: accounts.filter((account) => account.kind === "cash").length,
        debitAccountCount: accounts.filter((account) => account.kind === "bank_debit").length,
        creditAccountCount: accounts.filter((account) => account.kind === "bank_credit").length,
        investmentAccountCount: investmentAccountIds.length,
        insuranceAccountCount: accounts.filter((account) => account.kind === "insurance").length,
        settlementAccountCount: accounts.filter((account) => account.kind === "loan" || account.kind === "settlement").length,
        initializationEntryCount,
        transactionCount,
        fundHoldingCount,
        regularInvestPlanCount,
        shouldShowGuide: !hasAnyUserData,
      },
    });
  } catch (error) {
    // Do not return raw error details to the client (may leak DB/schema details); log them server-side
    console.error("GET /api/v1/onboarding/status error:", error);
    return NextResponse.json(
      { ok: false, error: "无法获取首次使用状态" },
      { status: 500 },
    );
  }
}
