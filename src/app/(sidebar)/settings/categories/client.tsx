"use client";

import { useEffect, useState, useRef, type DragEvent } from "react";
import { ArrowRight, ChevronRight, ChevronDown, GripVertical, Plus, Save, X } from "lucide-react";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { BasicDataImportExport } from "@/components/settings/BasicDataImportExport";
import { SettingsActionButton, SettingsPageHeader } from "@/components/settings/SettingsPageScaffold";
import { fetchSettingsCategories, getCachedSettingsCategories, notifySettingsDataChanged, setSettingsCategories } from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";
import { systemCategoryLabel } from "@/lib/system-category-labels";

type I18nT = (key: string, params?: Record<string, string | number>) => string;

type Category = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
  isSystem: boolean;
};

/** Display label for a category main type, localized through the i18n catalog. */
const typeLabel = (t: I18nT, type: string) =>
  type === "expense" ? t("transaction.type.expense")
  : type === "income" ? t("transaction.type.income")
  : type === "advance" ? t("txForm.advance")
  : type === "transfer" ? t("transaction.type.transfer")
  : type === "investment" ? t("transaction.type.investment")
  : type;

/**
 * System root category name per main type, as stored in the database (user
 * data). Used only to match the system root category by its stored name.
 */
const SYSTEM_ROOT_NAME_BY_TYPE: Record<string, string> = {
  expense: "\u652f\u51fa",
  income: "\u6536\u5165",
  advance: "\u4ee3\u4ed8",
  transfer: "\u8f6c\u8d26",
  investment: "\u6295\u8d44",
};

const typeSystemRootName = (type: string) => SYSTEM_ROOT_NAME_BY_TYPE[type] ?? type;

const typeColor = (type: string) =>
  type === "expense" ? "text-red-600" : type === "income" ? "text-emerald-600" : type === "advance" ? "text-amber-600" : "text-blue-600";

const TYPE_ORDER = ["expense", "income", "advance", "transfer", "investment"] as const;

export default function SettingsCategoriesClient({
  categories: initialCategories,
  initialLoaded = false,
}: {
  categories: Category[];
  initialLoaded?: boolean;
}) {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<string>("expense");
  const [editingName, setEditingName] = useState("");
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [inlineEditingName, setInlineEditingName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [inlineSavingId, setInlineSavingId] = useState<string | null>(null);
  const [movingParent, setMovingParent] = useState(false);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pendingMoveParentValue, setPendingMoveParentValue] = useState("__root");
  const [editError, setEditError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialLoaded) {
      setSettingsCategories(initialCategories);
      return;
    }
    const cached = getCachedSettingsCategories();
    if (cached) setCategories(cached as Category[]);
    void refreshCategories();
  }, [initialCategories, initialLoaded]);

  async function refreshCategories(options?: { force?: boolean }) {
    const next = await fetchSettingsCategories(options).catch(() => null);
    if (next) setCategories(next as Category[]);
  }

  useEffect(() => {
    const category = selectedId ? categories.find(c => c.id === selectedId) : null;
    const typeSystemRoot = category
      ? categories.find(c => c.parentId === null && c.type === category.type && c.isSystem && c.name === typeSystemRootName(category.type)) ?? null
      : null;
    setPendingMoveParentValue(category
      ? ((category.parentId ?? null) === (typeSystemRoot?.id ?? null) ? `__root:${category.type}` : category.parentId ?? `__root:${category.type}`)
      : "__root");
  }, [categories, selectedId]);

  const roots = sortCategories(categories.filter(c => c.parentId === null));
  const childrenMap = new Map<string, Category[]>();
  for (const c of categories) {
    if (c.parentId) {
      const list = childrenMap.get(c.parentId) || [];
      list.push(c);
      childrenMap.set(c.parentId, list);
    }
  }
  function getChildren(id: string) { return sortCategories(childrenMap.get(id) || []); }

  function sortCategories(items: Category[]) {
    return [...items].sort((a, b) =>
      Number(a.isSystem) - Number(b.isSystem)
      || a.sortOrder - b.sortOrder
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id)
    );
  }

  function getDescendantIds(id: string) {
    const ids = new Set<string>();
    function walk(parentId: string) {
      for (const child of getChildren(parentId)) {
        ids.add(child.id);
        walk(child.id);
      }
    }
    walk(id);
    return ids;
  }

  function getCategoryPath(category: Category) {
    const path: Category[] = [];
    let cur: Category | undefined = category;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? (categories.find(c => c.id === cur!.parentId) ?? undefined) : undefined;
    }
    return path;
  }

  function allCategoryNamesExcept(id?: string) {
    return categories
      .filter(c => c.id !== id)
      .map(c => c.name);
  }

  function hasDuplicateCategoryName(name: string, exceptId?: string) {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return allCategoryNamesExcept(exceptId).some(existing => existing.trim() === trimmed);
  }

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function select(id: string) {
    const category = categories.find(c => c.id === id);
    setSelectedId(id);
    setAddingUnder(null);
    setEditingName(category?.name ?? "");
    const typeSystemRoot = category
      ? categories.find(c => c.parentId === null && c.type === category.type && c.isSystem && c.name === typeSystemRootName(category.type)) ?? null
      : null;
    setPendingMoveParentValue(category
      ? ((category.parentId ?? null) === (typeSystemRoot?.id ?? null) ? `__root:${category.type}` : category.parentId ?? `__root:${category.type}`)
      : "__root");
    setEditError("");
  }

  function openAdd(parentId: string | null, type?: string) {
    setAddingUnder(parentId);
    if (type) setAddingType(type);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  /** Handle entity creation from EntityCreateForm */
  function handleCategoryCreated(id: string, name: string) {
    // We need to construct the full category object. The API returns it, but
    // EntityCreateForm only passes id/name/extra. We reconstruct from the form context.
    const parent = addingUnder && addingUnder !== "__root__"
      ? categories.find(c => c.id === addingUnder)
      : null;
    const created: Category = {
      id,
      name,
      type: parent?.type ?? addingType,
      parentId: addingUnder === "__root__" ? null : addingUnder || null,
      sortOrder: Math.max(
        -1,
        ...categories
          .filter(c => c.type === (parent?.type ?? addingType) && (c.parentId ?? null) === (addingUnder === "__root__" ? null : addingUnder || null))
          .map(c => c.sortOrder),
      ) + 1,
      isSystem: false,
    };
    setCategories(prev => {
      const next = [...prev, created];
      setSettingsCategories(next);
      return next;
    });
    void notifySettingsDataChanged({ scope: "categories", reason: "category:create", prefetch: true });
    if (addingUnder && addingUnder !== "__root__") {
      setExpanded(prev => new Set([...prev, addingUnder]));
    }
    setAddingUnder(null);
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch("/api/v1/settings/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "category", id }),
      });
      const data = await res.json();
      if (data.ok) {
        setCategories(prev => {
          const next = prev.filter(c => c.id !== id);
          setSettingsCategories(next);
          return next;
        });
        void notifySettingsDataChanged({ scope: "categories", reason: "category:delete", prefetch: true });
        if (selectedId === id) setSelectedId(null);
        setExpanded(prev => { const next = new Set(prev); next.delete(id); return next; });
      } else {
        window.alert(data.error || t("settingsDelete.deleteFailed"));
      }
    } catch { window.alert(t("settingsDelete.deleteFailed")); }
  }

  async function renameCategory(id: string, name: string) {
    const nextName = name.trim();
    const target = categories.find(c => c.id === id);
    if (!target) return false;
    if (target.isSystem) {
      setEditError(t("settings.categories.client.cannotRenameSystem"));
      return false;
    }
    if (!nextName) {
      setEditError(t("settings.categories.client.nameRequired"));
      return false;
    }
    if (nextName === target.name) return true;
    if (hasDuplicateCategoryName(nextName, id)) {
      setEditError(t("settings.categories.client.nameExists"));
      return false;
    }

    setEditError("");
    try {
      const res = await fetch("/api/v1/category", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: nextName }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setEditError(data.error ?? t("settings.categories.client.renameFailed"));
        return false;
      }
      setCategories(prev => {
        const next = prev.map(c => c.id === id ? { ...c, name: data.category.name } : c);
        setSettingsCategories(next);
        return next;
      });
      void notifySettingsDataChanged({ scope: "categories", reason: "category:rename", prefetch: true });
      if (selectedId === id) setEditingName(data.category.name);
      return true;
    } catch {
      setEditError(t("settings.categories.client.renameFailed"));
      return false;
    }
  }

  async function moveCategory(id: string, parentId: string | null) {
    const target = categories.find(c => c.id === id);
    if (!target) return false;
    if (target.isSystem) {
      setEditError(t("settings.categories.client.cannotMoveSystem"));
      return false;
    }
    if ((target.parentId ?? null) === parentId) return true;

    setEditError("");
    setMovingParent(true);
    try {
      const res = await fetch("/api/v1/category", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, parentId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setEditError(data.error ?? t("settings.categories.client.moveFailed"));
        return false;
      }
      setCategories(prev => {
        const next = prev.map(c => c.id === id ? {
          ...c,
          parentId: data.category.parentId ?? null,
          type: data.category.type,
          sortOrder: data.category.sortOrder,
        } : c);
        setSettingsCategories(next);
        return next;
      });
      void notifySettingsDataChanged({ scope: "categories", reason: "category:move", prefetch: true });
      if (parentId) {
        setExpanded(prev => new Set([...prev, parentId]));
      }
      return true;
    } catch {
      setEditError(t("settings.categories.client.moveFailed"));
      return false;
    } finally {
      setMovingParent(false);
    }
  }

  async function persistCategoryOrder(category: Category, orderedIds: string[]) {
    if (category.isSystem || reorderingId) return;
    setEditError("");
    setReorderingId(category.id);
    try {
      const res = await fetch("/api/v1/category", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: category.id, orderedIds }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setEditError(data.error ?? t("settings.categories.client.reorderFailed"));
        return;
      }
      setCategories(prev => {
        const orderById = new Map(orderedIds.map((id, position) => [id, position]));
        const next = prev.map(item => {
          const sortOrder = orderById.get(item.id);
          return sortOrder === undefined ? item : { ...item, sortOrder };
        });
        setSettingsCategories(next);
        return next;
      });
      void notifySettingsDataChanged({ scope: "categories", reason: "category:reorder", prefetch: true });
    } catch {
      setEditError(t("settings.categories.client.reorderFailed"));
    } finally {
      setReorderingId(null);
    }
  }

  function getSiblingCategories(category: Category) {
    return sortCategories(
      categories.filter(c =>
        c.type === category.type
        && (c.parentId ?? null) === (category.parentId ?? null)
      ),
    );
  }

  async function reorderCategoryTo(category: Category, targetId: string) {
    if (category.isSystem || reorderingId || category.id === targetId) return;
    const siblings = getSiblingCategories(category);
    const movable = siblings.filter(item => !item.isSystem);
    const sourceIndex = movable.findIndex(item => item.id === category.id);
    const targetIndex = movable.findIndex(item => item.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const nextMovable = [...movable];
    const [moved] = nextMovable.splice(sourceIndex, 1);
    nextMovable.splice(targetIndex, 0, moved!);
    let movableIndex = 0;
    const orderedIds = siblings.map(item => {
      if (item.isSystem) return item.id;
      const next = nextMovable[movableIndex];
      movableIndex += 1;
      return next!.id;
    });
    await persistCategoryOrder(category, orderedIds);
  }

  function handleCategoryDragStart(event: DragEvent<HTMLDivElement>, category: Category) {
    if (category.isSystem || reorderingId) {
      event.preventDefault();
      return;
    }
    setDraggingId(category.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", category.id);
  }

  function handleCategoryDragOver(event: DragEvent<HTMLDivElement>, category: Category) {
    if (!draggingId || category.isSystem || category.id === draggingId) return;
    const source = categories.find(item => item.id === draggingId);
    if (!source || source.type !== category.type || (source.parentId ?? null) !== (category.parentId ?? null)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverId(category.id);
  }

  function handleCategoryDrop(event: DragEvent<HTMLDivElement>, category: Category) {
    event.preventDefault();
    const sourceId = draggingId || event.dataTransfer.getData("text/plain");
    const source = categories.find(item => item.id === sourceId);
    setDraggingId(null);
    setDragOverId(null);
    if (source) void reorderCategoryTo(source, category.id);
  }

  function handleCategoryDragEnd() {
    setDraggingId(null);
    setDragOverId(null);
  }

  async function handleRename() {
    if (!selectedCategory) return;
    setSavingEdit(true);
    try {
      await renameCategory(selectedCategory.id, editingName);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleMoveSelectedCategory() {
    if (!selectedCategory || selectedCategory.isSystem || movingParent) return;
    const nextParentId = pendingMoveParentValue === moveRootOptionId ? moveRootActualParentId : pendingMoveParentValue;
    await moveCategory(selectedCategory.id, nextParentId);
  }

  function startInlineEdit(category: Category) {
    if (category.isSystem) return;
    setInlineEditingId(category.id);
    setInlineEditingName(category.name);
    setEditError("");
  }

  async function saveInlineEdit(id: string) {
    setInlineSavingId(id);
    try {
      const ok = await renameCategory(id, inlineEditingName);
      if (ok) {
        setInlineEditingId(null);
        setInlineEditingName("");
      }
    } finally {
      setInlineSavingId(null);
    }
  }

  /** Build parent category options for EntityCreateForm — all categories with hierarchy. */
  const parentCategoryOptions = (() => {
    const byParentId = new Map<string | null, Category[]>();
    for (const c of categories) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }
    const opts: Array<{ id: string; name: string; label: string; type: string; depth: number; parentId?: string; isGroup?: boolean }> = [];
    function walk(pid: string | null, depth: number) {
      const children = sortCategories(byParentId.get(pid) ?? []);
      for (const child of children) {
        opts.push({
          id: child.id,
          name: child.name,
          label: `${typeLabel(t, child.type)} — ${child.isSystem ? systemCategoryLabel(child.name, t) : child.name}`,
          type: child.type,
          depth,
          parentId: child.parentId ?? undefined,
          isGroup: (byParentId.get(child.id) ?? []).length > 0,
        });
        walk(child.id, depth + 1);
      }
    }
    walk(null, 0);
    return opts;
  })();

  function renderCategory(cat: Category, depth: number) {
    const children = getChildren(cat.id);
    const isExpanded = expanded.has(cat.id);
    const isSelected = selectedId === cat.id;
    const hasChildren = children.length > 0;

    return (
      <div key={cat.id}>
        <div
          onClick={() => select(cat.id)}
          draggable={!cat.isSystem}
          onDragStart={(event) => handleCategoryDragStart(event, cat)}
          onDragOver={(event) => handleCategoryDragOver(event, cat)}
          onDrop={(event) => handleCategoryDrop(event, cat)}
          onDragEnd={handleCategoryDragEnd}
          className={`flex items-center gap-1 py-1 px-2 rounded cursor-pointer group ${
            isSelected ? "bg-blue-50" : dragOverId === cat.id ? "bg-blue-50 ring-1 ring-inset ring-blue-300" : "hover:bg-slate-50"
          } ${draggingId === cat.id ? "opacity-50" : ""} ${cat.isSystem ? "" : "cursor-grab active:cursor-grabbing"}`}
          style={{ paddingLeft: `${12 + depth * 18}px` }}>
          <button onClick={(e) => { e.stopPropagation(); toggleExpand(cat.id); }}
            className="w-4 h-4 flex items-center justify-center shrink-0 text-slate-400 hover:text-slate-600">
            {hasChildren ? (isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : <span className="w-3" />}
          </button>
          {inlineEditingId === cat.id ? (
            <input
              value={inlineEditingName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setInlineEditingName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void saveInlineEdit(cat.id);
                if (e.key === "Escape") {
                  setInlineEditingId(null);
                  setInlineEditingName("");
                }
              }}
              autoFocus
              className="h-7 min-w-0 flex-1 rounded-md border border-blue-200 bg-white px-2 text-sm outline-none focus:border-blue-400"
            />
          ) : (
            <span className={`text-sm flex-1 truncate ${isSelected ? "text-blue-700 font-medium" : "text-slate-700"}`}>{cat.isSystem ? systemCategoryLabel(cat.name, t) : cat.name}</span>
          )}
          {!cat.isSystem && (
            <span title={t("settings.categories.client.dragToReorder")} aria-hidden="true">
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300" />
            </span>
          )}
          {cat.isSystem && <span className="text-[10px] text-slate-400 shrink-0">{t("settings.users.status.system")}</span>}
          {hasChildren && !isExpanded && <span className="text-[10px] text-slate-400 shrink-0">{children.length}</span>}
          {inlineEditingId === cat.id ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); void saveInlineEdit(cat.id); }}
                disabled={inlineSavingId === cat.id}
                className="h-5 w-5 flex items-center justify-center rounded hover:bg-blue-100 text-blue-600 disabled:opacity-50 shrink-0" title={t("common.save")}>
                <Save className="w-3 h-3" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); setInlineEditingId(null); setInlineEditingName(""); }}
                className="h-5 w-5 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 shrink-0" title={t("common.cancel")}>
                <X className="w-3 h-3" />
              </button>
            </>
          ) : !cat.isSystem ? (
            <SettingsActionButton
              label={t("settings.categories.client.rename")}
              variant="edit"
              size="sm"
              onClick={(e) => { e.stopPropagation(); startInlineEdit(cat); }}
              className="opacity-0 group-hover:opacity-100"
            />
          ) : (
            <span className="h-5 w-5 shrink-0" />
          )}
          <SettingsActionButton
            label={t("settings.categories.client.addSubcategory")}
            variant="add"
            size="sm"
            icon={<Plus className="w-3 h-3" />}
            onClick={(e) => { e.stopPropagation(); openAdd(cat.id); }}
            className="opacity-0 group-hover:opacity-100"
          />
          {!cat.isSystem && (
            <SettingsActionButton
              label={t("settings.categories.client.deleteCategory")}
              variant="delete"
              size="sm"
              onClick={(e) => { e.stopPropagation(); handleDelete(cat.id); }}
              className="opacity-0 group-hover:opacity-100"
            />
          )}
        </div>
        {isExpanded && addingUnder === cat.id && (
          <div style={{ paddingLeft: `${12 + (depth + 1) * 18}px` }}>
            <EntityCreateForm
              mode="full" layout="inline" entityType="category"
              defaultParentId={cat.id}
              defaultType={cat.type}
              parentCategories={parentCategoryOptions}
              onCreated={handleCategoryCreated}
              existingNames={allCategoryNamesExcept()}
              hiddenFields={["parentId"]}
            />
          </div>
        )}
        {isExpanded && children.map(child => renderCategory(child, depth + 1))}
      </div>
    );
  }

  const selectedCategory = selectedId ? categories.find(c => c.id === selectedId) : null;
  const selectedChildren = selectedId ? getChildren(selectedId) : [];
  const selectedPath = selectedCategory ? getCategoryPath(selectedCategory).map(c => c.name) : [];
  const moveExcluded = (() => {
    const excluded = new Set<string>();
    if (!selectedCategory) return excluded;
    for (const id of getDescendantIds(selectedCategory.id)) excluded.add(id);
    excluded.add(selectedCategory.id);
    return excluded;
  })();
  const moveRootOptionId = selectedCategory ? `__root:${selectedCategory.type}` : "__root";
  const selectedTypeSystemRoot = selectedCategory
    ? roots.find(root => root.type === selectedCategory.type && root.isSystem && root.name === typeSystemRootName(selectedCategory.type)) ?? null
    : null;
  const moveRootActualParentId = selectedTypeSystemRoot?.id ?? null;
  const moveTargetOptions: SmartSelectOption[] = selectedCategory ? (() => {
    const selectedType = selectedCategory.type;
    const topLevelOptionLabel = t("settings.categories.client.moveToTopOption", { type: typeLabel(t, selectedType) });
    const options: SmartSelectOption[] = [{
      id: moveRootOptionId,
      label: topLevelOptionLabel,
      subLabel: t("settings.categories.client.moveToTopSub"),
      isGroup: true,
      title: t("settings.categories.client.moveToTitle", { target: topLevelOptionLabel }),
    }];
    const topLevelCandidates = selectedTypeSystemRoot
      ? getChildren(selectedTypeSystemRoot.id)
      : roots.filter(c => c.type === selectedType);

    function pushCategoryOptions(parentId: string, candidates: Category[]) {
      for (const cat of candidates) {
        if (cat.type !== selectedType || moveExcluded.has(cat.id)) continue;
        const availableChildren = getChildren(cat.id).filter(child => child.type === selectedType && !moveExcluded.has(child.id));
        const pathLabel = getCategoryPath(cat).map(item => item.name).join(" 〉");
        options.push({
          id: cat.id,
          label: cat.name,
          subLabel: pathLabel,
          title: t("settings.categories.client.moveToTitle", { target: pathLabel }),
          parentId,
          isGroup: availableChildren.length > 0,
        });
        pushCategoryOptions(cat.id, availableChildren);
      }
    }

    pushCategoryOptions(moveRootOptionId, topLevelCandidates);
    return options;
  })() : [];
  const currentMoveParentValue = selectedCategory
    ? ((selectedCategory.parentId ?? null) === moveRootActualParentId ? moveRootOptionId : selectedCategory.parentId ?? moveRootOptionId)
    : "__root";
  const moveParentValue = selectedCategory
    ? (pendingMoveParentValue === "__root" ? currentMoveParentValue : pendingMoveParentValue)
    : "__root";
  const selectedParentName = selectedCategory?.parentId
    ? categories.find(c => c.id === selectedCategory.parentId)?.name ?? t("entityForm.parentCategoryLabel")
    : selectedCategory
      ? typeLabel(t, selectedCategory.type)
      : "";
  const selectedMoveTargetLabel = moveTargetOptions.find(option => option.id === moveParentValue)?.label
    ?? selectedParentName
    ?? "";
  const currentMoveTargetLabel = moveTargetOptions.find(option => option.id === currentMoveParentValue)?.label
    ?? selectedParentName
    ?? "";
  const hasPendingMoveTarget = !!selectedCategory && moveParentValue !== currentMoveParentValue;

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.categories")}
        description={t("settings.categories.description")}
        count={categories.length}
        actions={<BasicDataImportExport onImported={() => void refreshCategories({ force: true })} />}
      />

      <div className="flex min-h-[32rem]" style={{ height: "calc(100vh - 13rem)" }}>
        {/* Left: category tree */}
        <div className="w-64 flex flex-col shrink-0 border-r border-slate-200 bg-white">
          <div className="px-4 py-3 border-b border-slate-200 shrink-0">
            <div className="text-sm font-semibold text-slate-800">{t("settings.categories")}</div>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {TYPE_ORDER.map(type => {
              const typeKey = `type:${type}`;
              const typeRoots = roots.filter(c => c.type === type);
              const systemTypeRoot = typeRoots.find(root => root.isSystem && root.name === typeSystemRootName(type));
              const visibleRoots = systemTypeRoot ? getChildren(systemTypeRoot.id) : typeRoots;
              const addParentId = systemTypeRoot?.id ?? "__root__";
              const isExpanded = expanded.has(typeKey);

              return (
                <div key={type} className="mb-0.5">
                  <div
                    onClick={() => {
                      if (visibleRoots.length > 0 || systemTypeRoot) toggleExpand(typeKey);
                      else openAdd(addParentId, type);
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-slate-50 rounded">
                    {visibleRoots.length > 0 || systemTypeRoot ? (
                      isExpanded ? <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                    ) : <span className="w-3" />}
                    <span className={`text-xs font-semibold ${typeColor(type)} flex-1`}>{typeLabel(t, type)}</span>
                    <span className="text-[10px] text-slate-400">{visibleRoots.length}</span>
                    <SettingsActionButton
                      label={t("settings.categories.client.createTopLevel")}
                      variant="add"
                      size="sm"
                      icon={<Plus className="w-3 h-3" />}
                      onClick={(e) => { e.stopPropagation(); openAdd(addParentId, type); }}
                    />
                  </div>

                  {addingUnder === addParentId && addingType === type && (
                    <div className="px-3 py-1">
                      <EntityCreateForm
                        mode="full" layout="inline" entityType="category"
                        defaultParentId={systemTypeRoot?.id}
                        defaultType={type}
                        parentCategories={parentCategoryOptions}
                        extraFields={{ type }}
                        hiddenFields={["type", "parentId"]}
                        onCreated={handleCategoryCreated}
                        existingNames={allCategoryNamesExcept()}
                      />
                    </div>
                  )}

                  {isExpanded && visibleRoots.map(root => renderCategory(root, 1))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: details */}
        <div className="flex-1 bg-slate-50 p-6 min-w-0">
        {selectedCategory ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <div className="text-sm font-semibold text-slate-800">{t("settings.categories.client.detailTitle")}</div>
              </div>
              <div className="p-4">
                <div className="text-xs text-slate-500 mb-3">{t("settings.categories.client.path", { path: selectedPath.join(" 〉") })}</div>
                <div>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-[12rem] w-full sm:w-48 xl:w-56">
                      <span className="form-label mb-1 block">{t("settings.categories.client.name")}</span>
                      <input
                        value={editingName}
                        disabled={selectedCategory.isSystem}
                        onChange={(e) => {
                          setEditingName(e.target.value);
                          setEditError("");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename();
                        }}
                        className="form-input disabled:bg-slate-50 disabled:text-slate-400"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={handleRename}
                      disabled={selectedCategory.isSystem || savingEdit || !editingName.trim() || editingName.trim() === selectedCategory.name}
                      className="primary-button h-9 shrink-0 gap-1.5 disabled:opacity-50"
                    >
                      <Save className="h-3.5 w-3.5" />
                      {t("common.save")}
                    </button>
                    <div className="hidden h-9 shrink-0 items-center sm:flex">
                      <ArrowRight className="h-4 w-4 text-blue-500" aria-hidden="true" />
                    </div>
                    <div className="min-w-[16rem] w-full sm:w-72 xl:w-80">
                      <span className="form-label mb-1 block">{t("settings.categories.client.moveToLabel")}</span>
                      <div
                        className={
                          selectedCategory.isSystem || movingParent ? "pointer-events-none opacity-60" : ""
                        }
                        title={t("settings.categories.client.currentParent", { name: selectedParentName })}
                      >
                        <SmartSelect
                          mode="single"
                          value={moveParentValue}
                          onChange={setPendingMoveParentValue}
                          options={moveTargetOptions}
                          placeholder={t("settings.categories.client.movePlaceholder")}
                          searchable
                          behavior={{
                            hierarchy: true,
                            search: true,
                            initialCollapsedAll: true,
                            accordionGroups: true,
                            selectableGroups: true,
                            groupSelectOnDoubleClick: false,
                            expandOnGroupSelect: true,
                            minDropdownWidth: 420,
                            dropdownMaxHeight: 360,
                            density: "compact",
                            expandedGroupColumns: 3,
                          }}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleMoveSelectedCategory}
                      disabled={selectedCategory.isSystem || movingParent || !hasPendingMoveTarget}
                      className="primary-button h-9 shrink-0 px-3 disabled:opacity-50"
                    >
                      {movingParent ? t("settings.categories.client.moving") : t("settings.categories.client.move")}
                    </button>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    {selectedCategory.isSystem
                      ? t("settings.categories.client.systemNote")
                      : hasPendingMoveTarget
                        ? t("settings.categories.client.movePending", { target: selectedMoveTargetLabel })
                        : t("settings.categories.client.moveHint", { target: currentMoveTargetLabel })}
                  </div>
                </div>
                {editError && <div className="mt-2 text-xs text-red-600">{editError}</div>}
                <div className="flex items-center gap-2 mt-3">
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    selectedCategory.type === "expense" ? "bg-red-50 text-red-600" :
                    selectedCategory.type === "income" ? "bg-emerald-50 text-emerald-600" :
                    selectedCategory.type === "advance" ? "bg-amber-50 text-amber-600" :
                    "bg-blue-50 text-blue-600"}`}>
                    {typeLabel(t, selectedCategory.type)}
                  </span>
                  {selectedCategory.isSystem && <span className="text-xs text-slate-400">{t("settings.categories.client.systemBuiltin")}</span>}
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">{t("settings.categories.client.addChildUnder", { name: selectedCategory.name })}</div>
              </div>
              <div className="p-4">
                <EntityCreateForm
                  mode="full" layout="card" entityType="category"
                  defaultParentId={selectedId ?? undefined}
                  defaultType={selectedCategory.type}
                  parentCategories={parentCategoryOptions}
                  hiddenFields={["parentId"]}
                  onCreated={(id, name) => {
                    const created: Category = {
                      id,
                      name,
                      type: selectedCategory.type,
                      parentId: selectedId,
                      sortOrder: Math.max(
                        -1,
                        ...selectedChildren.map(child => child.sortOrder),
                      ) + 1,
                      isSystem: false,
                    };
                    setCategories(prev => {
                      const next = [...prev, created];
                      setSettingsCategories(next);
                      return next;
                    });
                    void notifySettingsDataChanged({ scope: "categories", reason: "category:create-child", prefetch: true });
                    setExpanded(prev => new Set([...prev, selectedId!]));
                  }}
                  existingNames={allCategoryNamesExcept()}
                />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">
                  {t("settings.categories.client.childCategoriesOf", { name: selectedCategory.name })}
                  <span className="ml-1 text-xs text-slate-400">{t("settings.categories.client.countSuffix", { count: selectedChildren.length })}</span>
                </div>
              </div>
              <div className="p-4">
                {selectedChildren.length === 0 ? (
                  <div className="text-xs text-slate-400 py-4 text-center">{t("settings.categories.client.noChildren")}</div>
                ) : (
                  <div className="space-y-0.5">
                    {selectedChildren.map(child => (
                      <div
                        key={child.id}
                        onClick={() => select(child.id)}
                        draggable={!child.isSystem}
                        onDragStart={(event) => handleCategoryDragStart(event, child)}
                        onDragOver={(event) => handleCategoryDragOver(event, child)}
                        onDrop={(event) => handleCategoryDrop(event, child)}
                        onDragEnd={handleCategoryDragEnd}
                        className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded cursor-pointer ${
                          selectedId === child.id ? "bg-blue-50" : dragOverId === child.id ? "bg-blue-50 ring-1 ring-inset ring-blue-300" : "hover:bg-slate-50"
                        } ${draggingId === child.id ? "opacity-50" : ""} ${child.isSystem ? "" : "cursor-grab active:cursor-grabbing"}`}
                      >
                        {inlineEditingId === child.id ? (
                          <input
                            value={inlineEditingName}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setInlineEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") void saveInlineEdit(child.id);
                              if (e.key === "Escape") {
                                setInlineEditingId(null);
                                setInlineEditingName("");
                              }
                            }}
                            autoFocus
                            className="form-input h-8 min-w-0 flex-1"
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{child.isSystem ? systemCategoryLabel(child.name, t) : child.name}</span>
                        )}
                        <div className="flex items-center gap-1">
                          {!child.isSystem && (
                            <span title={t("settings.categories.client.dragToReorder")} aria-hidden="true">
                              <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                            </span>
                          )}
                          {child.isSystem && <span className="text-[10px] text-slate-400">{t("settings.users.status.system")}</span>}
                          {inlineEditingId === child.id ? (
                            <>
                              <button onClick={(e) => { e.stopPropagation(); void saveInlineEdit(child.id); }}
                                disabled={inlineSavingId === child.id}
                                className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-50 text-blue-600 disabled:opacity-50"
                                title={t("common.save")}>
                                <Save className="w-3 h-3" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setInlineEditingId(null); setInlineEditingName(""); }}
                                className="h-6 w-6 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                                title={t("common.cancel")}>
                                <X className="w-3 h-3" />
                              </button>
                            </>
                          ) : !child.isSystem ? (
                            <SettingsActionButton
                              label={t("settings.categories.client.rename")}
                              variant="edit"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); startInlineEdit(child); }}
                            />
                          ) : (
                            <span className="h-6 w-6" />
                          )}
                          {!child.isSystem && (
                            <SettingsActionButton
                              label={t("settings.categories.client.deleteCategory")}
                              variant="delete"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); handleDelete(child.id); }}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-slate-400">
            {t("settings.categories.client.selectCategoryHint")}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
