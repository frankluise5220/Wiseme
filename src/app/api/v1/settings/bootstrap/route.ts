import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadCommonData } from "@/lib/server/cached-data";
import { buildAccountDisplayOption, type AccountLabelField } from "@/lib/account-display";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import {
  countAccountsByCounterparty,
  countAccountsByInstitution,
  INSURANCE_PRODUCT_LINK_SELECT,
  withAccountCounts,
} from "@/lib/server/entity-account-counts";

export const runtime = "nodejs";

function normalizeReturnedAccountKind<T extends { kind: AccountKind; investProductType?: string | null }>(account: T): T {
  if (account.kind === AccountKind.investment && account.investProductType === "deposit") {
    return { ...account, kind: AccountKind.deposit };
  }
  return account;
}

function withAccountDisplayFields<T extends {
  id: string;
  name: string;
  kind: AccountKind;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
}>(account: T, fields?: AccountLabelField[] | null) {
  const normalized = normalizeReturnedAccountKind(account);
  const display = buildAccountDisplayOption(normalized, undefined, { fields });
  return {
    ...normalized,
    label: display.selectorLabel || display.label,
    // Table cells render `listLabel`, which follows the configured display
    // fields (owner and account kind included).
    listLabel: display.listLabel,
    selectorLabel: display.selectorLabel,
    selectorCoreLabel: display.selectorCoreLabel,
    fullLabel: display.fullLabel,
    hoverTitle: display.hoverTitle,
    displaySubLabel: display.subLabel,
  };
}

/**
 * GET /api/v1/settings/bootstrap
 * Loads common base data for the settings area, shared with the system settings page cache.
 *
 * Returns: { ok, baseCurrency, accounts, groups, institutions, counterparties, users, categories, tags }
 */
export async function GET() {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
    const accountLabelFields = await getServerAccountLabelFields();
    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);
    const [{ accounts, groups, institutions, counterparties, categories, tags }, users, baseCurrency, insuranceProductLinks] = await Promise.all([
      loadCommonData(hidFilter),
      prisma.user.findMany({
        where: hidFilter,
        orderBy: { name: "asc" },
        // Return display fields only; never leak passwordHash
        select: { id: true, name: true, email: true, role: true, isSystem: true, householdId: true, createdAt: true },
      }),
      getHouseholdBaseCurrency(householdId),
      // Insurance product → account links, needed for the family member / insurer account counts.
      prisma.insuranceProduct.findMany({ where: hidFilter, select: INSURANCE_PRODUCT_LINK_SELECT }),
    ]);

    return NextResponse.json({
      ok: true,
      baseCurrency,
      accounts: accounts.map((account) => withAccountDisplayFields(account, accountLabelFields)),
      groups,
      // Related-account counts shown next to institution / family member / counterparty names.
      institutions: withAccountCounts(institutions, countAccountsByInstitution(accounts, insuranceProductLinks, institutions)),
      counterparties: withAccountCounts(counterparties, countAccountsByCounterparty(accounts, counterparties)),
      users,
      categories,
      tags,
    });
  } catch (error) {
    console.error("GET /api/v1/settings/bootstrap error:", error);
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: "查询失败" }, { status: 500 });
  }
}
