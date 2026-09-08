import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db/prisma";
import { createDefaultCategoriesForHousehold } from "@/lib/default-categories";
import { createDefaultInstitutionsForHousehold } from "@/lib/default-institutions";
import { getDefaultTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import { getCurrentUser, isAdmin, type CurrentUser } from "@/lib/server/auth";

export type HouseholdContext = {
  householdId: string;
  hidFilter: { householdId: string };
  user: CurrentUser | null;
};

export function belongsToHousehold(record: { householdId?: string | null } | null | undefined, ctx: HouseholdContext): boolean {
  return !!record && record.householdId === ctx.householdId;
}

export function assertBelongsToHousehold(record: { householdId?: string | null } | null | undefined, ctx: HouseholdContext, label = "record") {
  if (!record) return { ok: false as const, error: `${label} not found`, status: 404 };
  if (!belongsToHousehold(record, ctx)) return { ok: false as const, error: `${label} does not belong to the current household`, status: 403 };
  return { ok: true as const };
}

/**
 * Read householdId from the cookie and verify access against the current user:
 * - a verified user session is required; anonymous requests must use an
 *   explicit public/setup route instead of receiving a default household
 * - admin: any householdId present in the cookie is accepted; otherwise fall back to the first household in the DB
 * - regular user: only the household matching the user's own householdId is accessible
 * If the DB has no Household at all, a default household is auto-created
 * (with default account groups, accounts, and categories).
 * Returns HouseholdContext; householdId is always a string and hidFilter is always non-empty.
 */
export async function getHouseholdScope(): Promise<HouseholdContext> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Authentication required.");
  }
  const cookieStore = await cookies();
  const raw = cookieStore.get("householdId")?.value;

  // admin: any householdId present in the cookie is accepted
  if (isAdmin(user)) {
    if (raw) {
      const h = await prisma.household.findUnique({ where: { id: raw }, select: { id: true } });
      if (h) return { householdId: h.id, hidFilter: { householdId: h.id }, user };
    }
    const first = await prisma.household.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    if (first) return { householdId: first.id, hidFilter: { householdId: first.id }, user };
    return ensureHouseholdForUser(user);
  }

  // regular user: only the household matching the user's own householdId is accessible
  if (user?.householdId) {
    // use the cookie when it matches the user's householdId
    if (raw === user.householdId) {
      const h = await prisma.household.findUnique({ where: { id: raw }, select: { id: true } });
      if (h) return { householdId: h.id, hidFilter: { householdId: h.id }, user };
    }
    // fall back to the user's householdId
    const h = await prisma.household.findUnique({ where: { id: user.householdId }, select: { id: true } });
    if (h) return { householdId: h.id, hidFilter: { householdId: h.id }, user };
  }

  // regular user without a householdId → assign an existing household
  return ensureHouseholdForUser(user);
}

async function ensureHouseholdForUser(user: CurrentUser | null): Promise<HouseholdContext> {
  // regular user without a householdId → check for an existing household first, assign if present
  const existing = await prisma.household.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
  if (existing) {
    if (user && !user.householdId) {
      await prisma.user.update({ where: { id: user.id }, data: { householdId: existing.id } });
    }
    return { householdId: existing.id, hidFilter: { householdId: existing.id }, user };
  }

  // DB is completely empty → create the initial household
  const household = await prisma.household.create({ data: { name: "默认" } });

  const defaultOwner = await prisma.accountGroup.create({
    data: { name: user?.name?.trim() || "admin", householdId: household.id, sortOrder: 0 },
  });

  const defaultAccounts: { name: string; kind: string; groupId: string; investProductType?: string }[] = [
    { name: "现金钱包", kind: "cash", groupId: defaultOwner.id },
    { name: "银行储蓄", kind: "bank_debit", groupId: defaultOwner.id },
    { name: "投资账户", kind: "investment", groupId: defaultOwner.id, investProductType: "fund" },
  ];
  for (const a of defaultAccounts) {
    await prisma.account.create({
      data: {
        name: a.name,
        kind: a.kind as any,
        groupId: a.groupId,
        investProductType: a.investProductType as any,
        tradingCalendar: getDefaultTradingCalendarForAccount(a.kind, a.investProductType) as any,
        householdId: household.id,
        isActive: true,
        currency: "CNY",
      },
    });
  }

  await createDefaultCategoriesForHousehold(prisma, household.id);
  await createDefaultInstitutionsForHousehold(prisma, household.id);

  if (user && !user.householdId) {
    await prisma.user.update({ where: { id: user.id }, data: { householdId: household.id } });
  }

  return { householdId: household.id, hidFilter: { householdId: household.id }, user };
}

/** Request-level cached version: runs once per HTTP request, removing duplicate calls from page.tsx + Sidebar.tsx */
export const getCachedHouseholdScope = cache(getHouseholdScope);
