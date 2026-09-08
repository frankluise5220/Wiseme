import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import type { HouseholdContext } from "@/lib/server/household-scope";

export type InsuranceOverviewCategoryKey = "critical_illness" | "medical" | "accident" | "life_annuity" | "other";

export type InsuranceOverviewCategoryRow = {
  key: InsuranceOverviewCategoryKey;
  label: string;
  premium: number;
  coverage: number;
  productCount: number;
};

export type InsuranceOverviewPersonRow = {
  insuredPersonKey: string;
  insuredPersonId: string | null;
  insuredPersonName: string;
  premium: number;
  coverage: number;
  productCount: number;
  categories: InsuranceOverviewCategoryRow[];
};

export type InsuranceOverviewSummary = {
  productCount: number;
  insuredPersonCount: number;
  totalPremium: number;
  totalCoverage: number;
  categoryRows: InsuranceOverviewCategoryRow[];
  personRows: InsuranceOverviewPersonRow[];
};

type InsuranceOverviewProduct = {
  id: string;
  productType: string | null;
  coverageAmount: unknown;
  insuredPersonId: string | null;
  insuredUserId: string | null;
  InsuredPerson: { id: string; name: string | null } | null;
  InsuredUser: { id: string; name: string | null } | null;
};

const CATEGORY_ORDER: ReadonlyArray<InsuranceOverviewCategoryKey> = ["critical_illness", "medical", "accident", "life_annuity", "other"];
const OVERVIEW_COLUMN_KEYS: ReadonlySet<InsuranceOverviewCategoryKey> = new Set(["critical_illness", "medical", "accident", "life_annuity"]);

function classifyInsuranceProductType(productType: string | null): InsuranceOverviewCategoryRow["key"] {
  switch (productType) {
    case "critical_illness":
      return "critical_illness";
    case "medical":
      return "medical";
    case "accident":
      return "accident";
    case "annuity":
    case "term_life":
    case "whole_life":
      return "life_annuity";
    default:
      return "other";
  }
}

function categoryLabel(key: InsuranceOverviewCategoryKey) {
  switch (key) {
    case "critical_illness":
      return "重疾";
    case "medical":
      return "医疗";
    case "accident":
      return "意外";
    case "life_annuity":
      return "寿险/年金";
    case "other":
      return "其他";
  }
}

function personKey(product: InsuranceOverviewProduct, personName: string) {
  const rawId = String(product.insuredPersonId ?? product.insuredUserId ?? "").trim();
  return rawId || `name:${personName}`;
}

function personLabel(product: InsuranceOverviewProduct) {
  return (
    product.InsuredPerson?.name?.trim() ||
    product.InsuredUser?.name?.trim() ||
    "未指定被保人"
  );
}

export async function computeInsuranceOverviewSummary(
  ctx: HouseholdContext,
): Promise<InsuranceOverviewSummary> {
  const { hidFilter } = ctx;
  const products = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    select: {
      id: true,
      productType: true,
      coverageAmount: true,
      insuredPersonId: true,
      insuredUserId: true,
      InsuredPerson: { select: { id: true, name: true } },
      InsuredUser: { select: { id: true, name: true } },
    },
  });

  if (products.length === 0) {
    return {
      productCount: 0,
      insuredPersonCount: 0,
      totalPremium: 0,
      totalCoverage: 0,
      categoryRows: CATEGORY_ORDER.map((key) => ({
        key,
        label: categoryLabel(key),
        premium: 0,
        coverage: 0,
        productCount: 0,
      })),
      personRows: [],
    };
  }

  const productIds = products.map((product) => product.id);
  const entries = await prisma.insuranceTransaction.findMany({
    where: {
      ...hidFilter,
      deletedAt: null,
      insuranceProductId: { in: productIds },
    },
    select: {
      insuranceProductId: true,
      amount: true,
      action: true,
    },
  });

  const entryPremiumByProductId = new Map<string, number>();
  for (const entry of entries) {
    const productId = String(entry.insuranceProductId ?? "").trim();
    if (!productId) continue;
    const premium = entry.action === "refund" ? 0 : Math.abs(toNumber(entry.amount));
    entryPremiumByProductId.set(productId, (entryPremiumByProductId.get(productId) ?? 0) + premium);
  }

  const categoryByKey = new Map<InsuranceOverviewCategoryKey, InsuranceOverviewCategoryRow>(
    CATEGORY_ORDER.map((key) => [
      key,
      {
        key,
        label: categoryLabel(key),
        premium: 0,
        coverage: 0,
        productCount: 0,
      },
    ]),
  );
  const personByKey = new Map<string, InsuranceOverviewPersonRow>();

  for (const product of products) {
    const premium = entryPremiumByProductId.get(product.id) ?? 0;
    const coverage = toNumber(product.coverageAmount);
    const categoryKey = classifyInsuranceProductType(product.productType);
    const category = categoryByKey.get(categoryKey);
    if (category) {
      category.premium += premium;
      category.coverage += coverage;
      category.productCount += 1;
    }

    const insuredPersonName = personLabel(product);
    const key = personKey(product, insuredPersonName);
    const current = personByKey.get(key) ?? {
      insuredPersonKey: key,
      insuredPersonId: String(product.insuredPersonId ?? product.insuredUserId ?? "").trim() || null,
      insuredPersonName,
      premium: 0,
      coverage: 0,
      productCount: 0,
      categories: CATEGORY_ORDER.map((categoryKeyItem) => ({
        key: categoryKeyItem,
        label: categoryLabel(categoryKeyItem),
        premium: 0,
        coverage: 0,
        productCount: 0,
      })),
    };

    current.premium += premium;
    current.coverage += coverage;
    current.productCount += 1;
    const personCategory = current.categories.find((item) => item.key === categoryKey);
    if (personCategory) {
      personCategory.premium += premium;
      personCategory.coverage += coverage;
      personCategory.productCount += 1;
    }
    personByKey.set(key, current);
  }

  const categoryRows = CATEGORY_ORDER.flatMap((key) => {
    const row = categoryByKey.get(key);
    if (!row) return [];
    if (OVERVIEW_COLUMN_KEYS.has(key)) return [row];
    return row.productCount > 0 || row.premium > 0 || row.coverage > 0 ? [row] : [];
  });
  const personRows = Array.from(personByKey.values())
    .sort((a, b) => b.premium - a.premium || b.coverage - a.coverage || a.insuredPersonName.localeCompare(b.insuredPersonName, "zh-CN"));

  return {
    productCount: products.length,
    insuredPersonCount: personRows.length,
    totalPremium: personRows.reduce((sum, row) => sum + row.premium, 0),
    totalCoverage: personRows.reduce((sum, row) => sum + row.coverage, 0),
    categoryRows,
    personRows,
  };
}
