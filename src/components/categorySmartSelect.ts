import type { SmartSelectOption, SmartSelectProps } from "@/components/SmartSelect";
import { systemCategoryLabel } from "@/lib/system-category-labels";

export type CategorySource = {
  id: string;
  name?: string;
  label?: string;
  type: string;
  parentId?: string | null;
  sortOrder?: number;
  isSystem?: boolean;
};

export type CategorySmartSelectOption = SmartSelectOption & {
  categoryType?: string;
  sourceName?: string;
};

type SingleSelectBehavior = Extract<SmartSelectProps, { mode: "single" }>["behavior"];

export const CATEGORY_SMART_SELECT_BEHAVIOR = {
  hierarchy: true,
  search: true,
  initialCollapsedAll: true,
  accordionGroups: true,
  selectableGroups: true,
  groupSelectOnDoubleClick: false,
  minDropdownWidth: 252,
  fitContent: true,
  dropdownMaxHeight: 520,
  density: "micro",
  expandedGroupColumns: 4,
  resizableDropdown: true,
} satisfies SingleSelectBehavior;

export function compareCategoryOrder(a: CategorySource, b: CategorySource) {
  const aSystem = a.isSystem === true ? 1 : 0;
  const bSystem = b.isSystem === true ? 1 : 0;
  if (aSystem !== bSystem) return aSystem - bSystem;
  const aSortOrder = typeof a.sortOrder === "number" ? a.sortOrder : Number.POSITIVE_INFINITY;
  const bSortOrder = typeof b.sortOrder === "number" ? b.sortOrder : Number.POSITIVE_INFINITY;
  if (aSortOrder !== bSortOrder) return aSortOrder - bSortOrder;
  const nameOrder = (a.name ?? a.label ?? "").localeCompare(b.name ?? b.label ?? "", "zh-Hans-CN");
  return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
}

export function sortCategorySources<T extends CategorySource>(categories: T[]) {
  return [...categories].sort(compareCategoryOrder);
}

/**
 * Flattened category tree for a single category type (e.g. all expense
 * categories). Categories with children become collapsible groups, and every
 * real category stays selectable.
 */
export function buildCategoryTreeOptions(
  categories: CategorySource[],
  t: (key: string) => string,
): CategorySmartSelectOption[] {
  const childrenByParentId = new Map<string | null, CategorySource[]>();
  for (const category of categories) {
    const key = category.parentId ?? null;
    const list = childrenByParentId.get(key) ?? [];
    list.push(category);
    childrenByParentId.set(key, list);
  }
  for (const [parentId, list] of childrenByParentId) {
    childrenByParentId.set(parentId, sortCategorySources(list));
  }

  const options: CategorySmartSelectOption[] = [];
  const indent = "\u3000";

  function walk(parentId: string | null, level: number, parentOptionId?: string) {
    for (const child of childrenByParentId.get(parentId) ?? []) {
      const rawLabel = child.label ?? child.name ?? "";
      const rawShortName = rawLabel.includes(".") ? rawLabel.split(".").pop() ?? rawLabel : rawLabel;
      const shortName = systemCategoryLabel(rawShortName, t);
      const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
      options.push({
        id: child.id,
        label: `${indent.repeat(level)}${shortName}`,
        parentId: parentOptionId,
        isGroup: hasChildren,
        sourceName: rawLabel,
      });
      if (hasChildren) walk(child.id, level + 1, child.id);
    }
  }

  walk(null, 0);
  return options;
}

/** Indented parent picker used by the compact "new category" form. */
export function buildCategoryParentOptions(
  categories: CategorySource[],
  t: (key: string) => string,
  type: string,
) {
  const childrenByParentId = new Map<string | null, CategorySource[]>();
  for (const category of categories) {
    const key = category.parentId ?? null;
    const list = childrenByParentId.get(key) ?? [];
    list.push(category);
    childrenByParentId.set(key, list);
  }
  for (const [parentId, list] of childrenByParentId) {
    childrenByParentId.set(parentId, sortCategorySources(list));
  }

  const options: Array<{ id: string; name: string; label: string; type: string; depth: number; parentId?: string; isGroup?: boolean }> = [];

  function walk(parentId: string | null, depth: number, pathPrefix: string) {
    for (const child of childrenByParentId.get(parentId) ?? []) {
      const rawLabel = child.label ?? child.name ?? "";
      const rawShortName = rawLabel.includes(".") ? rawLabel.split(".").pop() ?? rawLabel : rawLabel;
      const shortName = systemCategoryLabel(rawShortName, t);
      const fullLabel = pathPrefix ? `${pathPrefix}.${shortName}` : shortName;
      options.push({
        id: child.id,
        name: shortName,
        label: fullLabel,
        type,
        depth,
        parentId: child.parentId ?? undefined,
        isGroup: (childrenByParentId.get(child.id) ?? []).length > 0,
      });
      walk(child.id, depth + 1, fullLabel);
    }
  }

  walk(null, 0, "");
  return options;
}

export function buildCategorySmartSelectOptions({
  categories,
  types,
  typeLabels,
  typeHeaderPrefix,
  includeTypeHeaders,
  t,
}: {
  categories: CategorySource[];
  types: string[];
  typeLabels: Record<string, string>;
  typeHeaderPrefix: string;
  includeTypeHeaders: boolean;
  t: (key: string) => string;
}): CategorySmartSelectOption[] {
  const options: CategorySmartSelectOption[] = [];
  const indent = "\u3000";

  for (const type of types) {
    const typedCategories = categories.filter((category) => category.type === type);
    if (typedCategories.length === 0) continue;

    const headerId = `${typeHeaderPrefix}:${type}`;
    if (includeTypeHeaders) {
      options.push({
        id: headerId,
        label: typeLabels[type] ?? type,
        isHeader: true,
        categoryType: type,
      });
    }

    const childrenByParentId = new Map<string | null, CategorySource[]>();
    for (const category of typedCategories) {
      const key = category.parentId ?? null;
      const list = childrenByParentId.get(key) ?? [];
      list.push(category);
      childrenByParentId.set(key, list);
    }
    for (const [parentId, list] of childrenByParentId) {
      childrenByParentId.set(parentId, sortCategorySources(list));
    }

    function walk(parentId: string | null, level: number, parentOptionId?: string) {
      const children = childrenByParentId.get(parentId) ?? [];
      for (const child of children) {
        const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
        options.push({
          id: child.id,
          label: `${indent.repeat(level)}${systemCategoryLabel(child.name ?? child.label ?? "", t)}`,
          subLabel: includeTypeHeaders ? typeLabels[type] ?? type : undefined,
          parentId: parentOptionId,
          isGroup: hasChildren,
          categoryType: type,
          sourceName: child.name ?? child.label ?? "",
        });
        if (hasChildren) walk(child.id, level + 1, child.id);
      }
    }

    walk(null, 0, includeTypeHeaders ? headerId : undefined);
  }

  return options;
}
