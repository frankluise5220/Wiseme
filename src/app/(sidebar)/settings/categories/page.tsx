import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { categoryOrderBy } from "@/lib/category-order";
import SettingsCategoriesClient from "./client";

export default async function SettingsCategoriesPage() {
  const { householdId, hidFilter } = await getHouseholdScope();
  await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);
  const categories = await prisma.category.findMany({
    where: { ...hidFilter },
    orderBy: categoryOrderBy(),
    select: { id: true, name: true, type: true, parentId: true, sortOrder: true, isSystem: true },
  });

  return <SettingsCategoriesClient categories={categories} initialLoaded />;
}
