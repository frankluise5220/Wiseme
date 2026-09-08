"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Repeat,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";

export type SmartSelectOption = {
  /** Selectable option IDs should be real entity IDs. Use synthetic IDs only for non-selectable headers/groups. */
  id: string;
  label: string;
  subLabel?: string;
  title?: string;
  color?: string | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  currency?: string | null;
};

export type SmartSelectCycleAction = {
  onClick: () => void;
  label?: string;
  title?: string;
  ariaLabel?: string;
  icon?: ReactNode;
};

const SMART_SELECT_CREATED_EVENT = "mmh:smart-select:created";

function mergeSmartSelectOptions(base: SmartSelectOption[], extra: SmartSelectOption[]) {
  const merged = [...base];
  const seen = new Set(merged.map((option) => option.id));
  for (const option of extra) {
    if (!seen.has(option.id)) {
      merged.push(option);
      seen.add(option.id);
    }
  }
  return merged;
}

export function notifySmartSelectOptionCreated(option: SmartSelectOption) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SmartSelectOption>(SMART_SELECT_CREATED_EVENT, { detail: option }));
}

type SearchBehavior = boolean | "auto";
type HierarchyBehavior = boolean | "auto";
type SmartSelectDensity = "regular" | "compact" | "dense" | "micro";

type SmartSelectSharedBehavior = {
  search?: SearchBehavior;
  hierarchy?: HierarchyBehavior;
  collapsibleGroups?: boolean;
  initialCollapsedAll?: boolean;
  accordionGroups?: boolean;
  groupSelectOnDoubleClick?: boolean;
  expandOnGroupSelect?: boolean;
  selectableGroups?: boolean;
  clearable?: boolean;
  cycleSelectionWithArrowKeys?: boolean;
  headerExtra?: ReactNode;
  cycleAction?: SmartSelectCycleAction;
  minDropdownWidth?: number;
  /** Expand the dropdown to the smallest width that fits its option labels. */
  fitContent?: boolean;
  dropdownMaxHeight?: number;
  density?: SmartSelectDensity;
  expandedGroupColumns?: number;
  resizableDropdown?: boolean;
  autoOpen?: boolean;
  showGroupCounts?: boolean;
  onDropdownClose?: () => void;
};

type SmartSelectSingleBehavior = SmartSelectSharedBehavior & {
  create?: {
    type: "button";
    onClick: () => void;
    label?: string;
  };
};

type SmartSelectMultiBehavior = SmartSelectSharedBehavior & {
  create?: {
    type: "inline";
    onCreate: (name: string, color: string) => Promise<SmartSelectOption>;
    onCreated?: (tag: SmartSelectOption) => void;
    buttonLabel?: string;
  };
};

type SingleModeProps = {
  mode: "single";
  value: string;
  onChange: (id: string) => void;
  options: SmartSelectOption[];
  placeholder?: string;
  searchable?: boolean;
  onCreateClick?: () => void;
  createLabel?: string;
  headerExtra?: ReactNode;
  cycleAction?: SmartSelectCycleAction;
  onCycleOwnerFilter?: () => void;
  ownerFilterLabel?: string;
  behavior?: SmartSelectSingleBehavior;
};

type MultiModeProps = {
  mode: "multi";
  value: string[];
  onChange: (ids: string[]) => void;
  options: SmartSelectOption[];
  placeholder?: string;
  onInlineCreate?: (name: string, color: string) => Promise<SmartSelectOption>;
  onCreated?: (tag: SmartSelectOption) => void;
  behavior?: SmartSelectMultiBehavior;
};

export type SmartSelectProps = SingleModeProps | MultiModeProps;

const PRESET_COLORS = [
  "#7BA05B",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F43F5E",
  "#84CC16",
  "#6366F1",
  "#14B8A6",
  "#E11D48",
  "#0EA5E9",
];

function stripIndent(label: string) {
  return label.replace(/^[\u3000\s]+/, "");
}

function optionSearchText(option: SmartSelectOption) {
  return `${stripIndent(option.label)} ${option.subLabel ?? ""} ${option.title ?? ""}`.toLowerCase();
}

function hasHierarchy(options: SmartSelectOption[]) {
  return options.some((option) => option.isHeader || option.isGroup || option.parentId);
}

function resolveHierarchyBehavior(options: SmartSelectOption[], behavior?: HierarchyBehavior) {
  if (behavior === true) return true;
  if (behavior === false) return false;
  return hasHierarchy(options);
}

function resolveSearchBehavior(
  options: SmartSelectOption[],
  behavior: SearchBehavior | undefined,
  hierarchy: boolean,
) {
  if (behavior === true) return true;
  if (behavior === false) return false;
  if (hierarchy) return true;
  return options.length > 10;
}

function filterFlatOptions(options: SmartSelectOption[], search: string) {
  if (!search.trim()) return options;
  const q = search.trim().toLowerCase();
  return options.filter((option) => optionSearchText(option).includes(q));
}

function filterWithGroups(options: SmartSelectOption[], search: string) {
  if (!search.trim()) return options;
  const q = search.trim().toLowerCase();
  const optionById = new Map(options.map((option) => [option.id, option]));
  const matchedIds = new Set<string>();
  const keepIds = new Set<string>();

  for (const option of options) {
    if (option.isHeader) continue;
    if (optionSearchText(option).includes(q)) {
      matchedIds.add(option.id);
      keepIds.add(option.id);
    }
  }

  for (const id of matchedIds) {
    let current = optionById.get(id);
    while (current?.parentId) {
      keepIds.add(current.parentId);
      current = optionById.get(current.parentId);
    }
  }

  return options.filter((option) => keepIds.has(option.id));
}

function buildGroupChildCounts(options: SmartSelectOption[]) {
  const counts = new Map<string, number>();
  for (const option of options) {
    if (!option.parentId || option.isHeader) continue;
    counts.set(option.parentId, (counts.get(option.parentId) ?? 0) + 1);
  }
  return counts;
}

function initialCollapsedGroups(
  options: SmartSelectOption[],
  selectedValue: string,
  enabled: boolean,
  collapseAll = false,
) {
  const collapsed = new Set<string>();
  if (!enabled) return collapsed;

  for (const option of options) {
    if (option.isGroup || (collapseAll && option.isHeader)) collapsed.add(option.id);
  }

  if (!selectedValue) return collapsed;

  const optionById = new Map(options.map((option) => [option.id, option]));
  let current = optionById.get(selectedValue);
  while (current) {
    collapsed.delete(current.id);
    current = current.parentId ? optionById.get(current.parentId) : undefined;
  }
  return collapsed;
}

function hasCollapsedAncestor(
  option: SmartSelectOption,
  collapsedGroups: Set<string>,
  optionById: Map<string, SmartSelectOption>,
) {
  let parentId = option.parentId;
  while (parentId) {
    if (collapsedGroups.has(parentId)) return true;
    parentId = optionById.get(parentId)?.parentId;
  }
  return false;
}

function buildVisibleOptions(
  filtered: SmartSelectOption[],
  collapsedGroups: Set<string>,
  forceExpanded: boolean,
  hierarchy: boolean,
) {
  if (!hierarchy || forceExpanded) return filtered;
  const optionById = new Map(filtered.map((option) => [option.id, option]));
  return filtered.filter((option) => !hasCollapsedAncestor(option, collapsedGroups, optionById));
}

function isDescendantOf(
  option: SmartSelectOption,
  ancestorId: string,
  optionById: Map<string, SmartSelectOption>,
) {
  let parentId = option.parentId;
  while (parentId) {
    if (parentId === ancestorId) return true;
    parentId = optionById.get(parentId)?.parentId;
  }
  return false;
}

function findInitialFocusedIndex(
  visible: SmartSelectOption[],
  mode: "single" | "multi",
  value: string | string[],
  preferredIndex?: "first" | "last",
) {
  if (visible.length === 0) return -1;
  if (preferredIndex === "first") return 0;
  if (preferredIndex === "last") return visible.length - 1;
  if (mode === "single") {
    const selectedIndex = visible.findIndex((option) => option.id === value);
    return selectedIndex >= 0 ? selectedIndex : 0;
  }
  return 0;
}

function isSelectable(option: SmartSelectOption, selectableGroups = true) {
  return !option.isHeader && (selectableGroups || !option.isGroup);
}

function groupLabelCapsuleClass(selected: boolean, focused: boolean) {
  if (selected) return "border-blue-200 bg-blue-50 font-medium text-blue-700 hover:bg-blue-100";
  if (focused) return "border-slate-300 bg-slate-200 text-slate-800";
  return "border-slate-200 bg-slate-100/90 text-slate-700 hover:border-slate-300 hover:bg-slate-200";
}

function groupToggleIndicatorClass(collapsed: boolean, roomier = false) {
  const sizeClass = roomier ? "h-7 w-7 rounded-md" : "h-5 w-5 rounded";
  return collapsed
    ? `inline-flex ${sizeClass} items-center justify-center bg-slate-200/90 text-slate-600 ring-1 ring-slate-300/70 transition-colors hover:bg-slate-300 hover:text-slate-700`
    : `inline-flex ${sizeClass} items-center justify-center bg-slate-100/80 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700`;
}

function renderCycleActionButton(action: SmartSelectCycleAction | undefined, t: (key: string, params?: Record<string, string | number>) => string) {
  if (!action) return undefined;
  const fallback = t("smartSelect.cycleSwitch");
  return (
    <button
      type="button"
      onClick={action.onClick}
      title={action.title ?? action.label ?? fallback}
      aria-label={action.ariaLabel ?? action.label ?? fallback}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
    >
      {action.icon ?? <Repeat className="h-3 w-3" />}
    </button>
  );
}

function normalizeSingleBehavior(props: SingleModeProps, options: SmartSelectOption[], t: (key: string, params?: Record<string, string | number>) => string) {
  const behavior = props.behavior;
  const legacyCycleAction = props.onCycleOwnerFilter
    ? {
        onClick: props.onCycleOwnerFilter,
        title: t("debtTx.ownerFilterTitle", { label: props.ownerFilterLabel || t("common.all") }),
        ariaLabel: t("debtTx.ownerFilterAria", { label: props.ownerFilterLabel || t("common.all") }),
      }
    : undefined;
  const cycleAction = behavior?.cycleAction ?? props.cycleAction ?? legacyCycleAction;

  return {
    hierarchy: resolveHierarchyBehavior(options, behavior?.hierarchy),
    searchable: resolveSearchBehavior(
      options,
      behavior?.search ?? props.searchable,
      resolveHierarchyBehavior(options, behavior?.hierarchy),
    ),
    collapsibleGroups: behavior?.collapsibleGroups ?? true,
    clearable: behavior?.clearable ?? true,
    cycleSelectionWithArrowKeys: behavior?.cycleSelectionWithArrowKeys ?? true,
    initialCollapsedAll: behavior?.initialCollapsedAll ?? false,
    accordionGroups: behavior?.accordionGroups ?? false,
    groupSelectOnDoubleClick: behavior?.groupSelectOnDoubleClick ?? false,
    expandOnGroupSelect: behavior?.expandOnGroupSelect ?? false,
    selectableGroups: behavior?.selectableGroups ?? true,
    headerExtra: behavior?.headerExtra ?? props.headerExtra,
    cycleAction,
    minDropdownWidth: behavior?.minDropdownWidth,
    fitContent: behavior?.fitContent ?? false,
    dropdownMaxHeight: behavior?.dropdownMaxHeight,
    density: behavior?.density ?? "regular",
    expandedGroupColumns: behavior?.expandedGroupColumns,
    resizableDropdown: behavior?.resizableDropdown ?? false,
    autoOpen: behavior?.autoOpen ?? false,
    showGroupCounts: behavior?.showGroupCounts ?? true,
    onDropdownClose: behavior?.onDropdownClose,
    create: behavior?.create ?? (props.onCreateClick
      ? {
          type: "button" as const,
          onClick: props.onCreateClick,
          label: props.createLabel,
        }
      : undefined),
  };
}

function normalizeMultiBehavior(props: MultiModeProps, options: SmartSelectOption[]) {
  const behavior = props.behavior;
  return {
    hierarchy: resolveHierarchyBehavior(options, behavior?.hierarchy),
    searchable: resolveSearchBehavior(
      options,
      behavior?.search ?? false,
      resolveHierarchyBehavior(options, behavior?.hierarchy),
    ),
    collapsibleGroups: behavior?.collapsibleGroups ?? true,
    clearable: false,
    cycleSelectionWithArrowKeys: false,
    initialCollapsedAll: behavior?.initialCollapsedAll ?? false,
    accordionGroups: behavior?.accordionGroups ?? false,
    groupSelectOnDoubleClick: behavior?.groupSelectOnDoubleClick ?? false,
    expandOnGroupSelect: behavior?.expandOnGroupSelect ?? false,
    selectableGroups: behavior?.selectableGroups ?? true,
    headerExtra: behavior?.headerExtra,
    cycleAction: behavior?.cycleAction,
    minDropdownWidth: behavior?.minDropdownWidth,
    fitContent: behavior?.fitContent ?? false,
    dropdownMaxHeight: behavior?.dropdownMaxHeight,
    density: behavior?.density ?? "regular",
    expandedGroupColumns: behavior?.expandedGroupColumns,
    resizableDropdown: behavior?.resizableDropdown ?? false,
    autoOpen: behavior?.autoOpen ?? false,
    showGroupCounts: behavior?.showGroupCounts ?? true,
    onDropdownClose: behavior?.onDropdownClose,
    create: behavior?.create ?? (props.onInlineCreate
      ? {
          type: "inline" as const,
          onCreate: props.onInlineCreate,
          onCreated: props.onCreated,
        }
      : undefined),
  };
}

export function SmartSelect(props: SmartSelectProps) {
  const { mode, value, onChange, options, placeholder } = props;
  const { t } = useI18n();
  const [createdOptions, setCreatedOptions] = useState<SmartSelectOption[]>([]);
  const selectedCreatedOptions = useMemo(() => {
    const selectedIds = new Set(
      mode === "single"
        ? (value ? [value] : [])
        : (value as string[]),
    );
    if (selectedIds.size === 0) return [];
    return createdOptions.filter((option) => selectedIds.has(option.id));
  }, [createdOptions, mode, value]);
  const effectiveOptions = useMemo(
    () => mergeSmartSelectOptions(options, selectedCreatedOptions),
    [options, selectedCreatedOptions],
  );
  const normalizedBehavior = mode === "single"
    ? normalizeSingleBehavior(props, effectiveOptions, t)
    : normalizeMultiBehavior(props, effectiveOptions);

  const {
    hierarchy,
    searchable,
    collapsibleGroups,
    clearable,
    cycleSelectionWithArrowKeys,
    initialCollapsedAll,
    accordionGroups,
    groupSelectOnDoubleClick,
    expandOnGroupSelect,
    selectableGroups,
    headerExtra,
    cycleAction,
    minDropdownWidth,
    fitContent,
    dropdownMaxHeight,
    density,
    expandedGroupColumns,
    resizableDropdown,
    autoOpen,
    showGroupCounts,
    onDropdownClose,
    create,
  } = normalizedBehavior;
  const micro = density === "micro";
  const dense = density === "dense" || micro;
  const compact = density === "compact" || dense;
  const rowHeight = micro ? 16 : dense ? 26 : compact ? 30 : 36;
  const headerHeight = micro ? 24 : dense ? 30 : compact ? 34 : 42;
  const singleGridColumns = mode === "single" && expandedGroupColumns
    ? Math.max(2, Math.min(6, Math.floor(expandedGroupColumns)))
    : undefined;
  const fullGridRowStyle = singleGridColumns ? { gridColumn: "1 / -1" } : undefined;
  const resolvedDropdownMaxHeight = dropdownMaxHeight ?? (compact ? 320 : 360);

  const isSingleCreateButton = mode === "single" && create?.type === "button" ? create : undefined;
  const isMultiInlineCreate = mode === "multi" && create?.type === "inline" ? create : undefined;

  const listId = useId();
  const selectedOption = mode === "single"
    ? effectiveOptions.find((option) => option.id === value)
    : undefined;
  const selectedLabel = selectedOption ? stripIndent(selectedOption.label) : "";
  const selectedTitle = selectedOption
    ? (selectedOption.title || [selectedLabel, selectedOption.subLabel].filter(Boolean).join(" · "))
    : (placeholder || t("txForm.selectPlaceholder"));
  const groupChildCounts = useMemo(() => buildGroupChildCounts(effectiveOptions), [effectiveOptions]);
  const selectableOptions = useMemo(
    () => effectiveOptions.filter((option) => isSelectable(option, selectableGroups)),
    [effectiveOptions, selectableGroups],
  );
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0, minWidth: 0, maxHeight: 0 });
  // Multi-mode draft: checkbox/keyboard edits land here; committing happens
  // on confirm button, label click (single-select), or outside click.
  const [multiDraft, setMultiDraft] = useState<string[] | null>(null);

  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const autoOpenedRef = useRef(false);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const inlineCreateInputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!searchable) return effectiveOptions;
    return hierarchy ? filterWithGroups(effectiveOptions, search) : filterFlatOptions(effectiveOptions, search);
  }, [effectiveOptions, hierarchy, search, searchable]);

  const visible = useMemo(
    () => buildVisibleOptions(filtered, collapsedGroups, search.trim().length > 0, hierarchy),
    [collapsedGroups, filtered, hierarchy, search],
  );
  const visibleOptionById = useMemo(
    () => new Map(visible.map((option) => [option.id, option])),
    [visible],
  );
  const visibleIndexById = useMemo(
    () => new Map(visible.map((option, index) => [option.id, index])),
    [visible],
  );
  const visibleChildrenByParentId = useMemo(() => {
    const children = new Map<string, SmartSelectOption[]>();
    for (const option of visible) {
      if (!option.parentId) continue;
      const list = children.get(option.parentId) ?? [];
      list.push(option);
      children.set(option.parentId, list);
    }
    return children;
  }, [visible]);
  const groupedSingleHierarchy = !!singleGridColumns && hierarchy && search.trim().length === 0;

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setSearch("");
    setShowNew(false);
    setFocusedIndex(-1);
    setMultiDraft(null);
    onDropdownClose?.();
  }, [onDropdownClose]);

  // Commit the multi draft (if any) then close. Used by outside-click and
  // the confirm button so checkbox edits are not lost when closing.
  const commitMultiAndClose = useCallback(() => {
    if (multiDraft !== null) {
      (onChange as (ids: string[]) => void)(multiDraft);
    }
    closeDropdown();
  }, [closeDropdown, multiDraft, onChange]);

  const calcPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const boundary = triggerRef.current.closest("[data-smart-select-boundary]");
    const boundaryRect = boundary instanceof HTMLElement ? boundary.getBoundingClientRect() : null;
    const boundaryPadding = 8;
    const boundaryTop = (boundaryRect?.top ?? 0) + boundaryPadding;
    const boundaryLeft = (boundaryRect?.left ?? 0) + boundaryPadding;
    const boundaryRight = (boundaryRect?.right ?? window.innerWidth) - boundaryPadding;
    const boundaryBottom = (boundaryRect?.bottom ?? window.innerHeight) - boundaryPadding;
    const minWidth = minDropdownWidth && minDropdownWidth > 0 ? minDropdownWidth : 0;
    const availableWidth = Math.max(120, boundaryRight - boundaryLeft);
    let contentWidth = 0;
    if (fitContent) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context) {
        const font = window.getComputedStyle(triggerRef.current).font;
        context.font = font;
        contentWidth = effectiveOptions.reduce((maxWidth, option) => {
          const label = stripIndent(option.label);
          const detail = option.subLabel || option.title || "";
          const indentWidth = Math.max(0, option.label.length - label.length) * 5;
          const measured = context.measureText(detail ? `${label} · ${detail}` : label).width + indentWidth;
          return Math.max(maxWidth, measured);
        }, 0) + (dense ? 48 : 56);
        if (singleGridColumns && contentWidth > 0) {
          contentWidth = contentWidth * singleGridColumns + (singleGridColumns - 1) * 4 + 16;
        }
      }
    }
    const requiredWidth = Math.max(rect.width, minWidth, contentWidth);
    const width = Math.min(requiredWidth, availableWidth);
    const left = Math.min(Math.max(boundaryLeft, rect.left), Math.max(boundaryLeft, boundaryRight - width));
    const estimatedHeight = (searchable ? headerHeight : 0)
      + ((isSingleCreateButton || isMultiInlineCreate) ? headerHeight : 0)
      + Math.min(
        visible.length || effectiveOptions.length || 1,
        Math.max(4, Math.floor(resolvedDropdownMaxHeight / rowHeight)),
      ) * rowHeight
      + 16;
    const below = Math.max(48, boundaryBottom - rect.bottom - 4);
    const above = Math.max(48, rect.top - boundaryTop - 4);
    const openAbove = below < estimatedHeight && above > below;
    const availableHeight = openAbove ? above : below;
    const maxHeight = Math.max(48, Math.min(estimatedHeight, availableHeight));
    const rawTop = openAbove ? rect.top - maxHeight - 4 : rect.bottom + 4;
    const top = Math.min(Math.max(boundaryTop, rawTop), Math.max(boundaryTop, boundaryBottom - maxHeight));
    setDropdownPos({ top, left, width, minWidth: width, maxHeight });
  }, [dense, effectiveOptions, fitContent, headerHeight, isMultiInlineCreate, isSingleCreateButton, minDropdownWidth, resolvedDropdownMaxHeight, rowHeight, searchable, singleGridColumns, visible.length]);

  const openDropdown = useCallback((preferredIndex?: "first" | "last") => {
    const nextCollapsed = initialCollapsedGroups(
      effectiveOptions,
      mode === "single" ? value : "",
      hierarchy && collapsibleGroups,
      initialCollapsedAll,
    );
    const nextFiltered = searchable
      ? (hierarchy ? filterWithGroups(effectiveOptions, "") : filterFlatOptions(effectiveOptions, ""))
      : effectiveOptions;
    const nextVisible = buildVisibleOptions(nextFiltered, nextCollapsed, false, hierarchy);

    setCollapsedGroups(nextCollapsed);
    setSearch("");
    setShowNew(false);
    setOpen(true);
    setFocusedIndex(findInitialFocusedIndex(nextVisible, mode, value, preferredIndex));
    window.requestAnimationFrame(() => calcPosition());
  }, [calcPosition, collapsibleGroups, effectiveOptions, hierarchy, initialCollapsedAll, mode, searchable, value]);

  useEffect(() => {
    if (!autoOpen) {
      autoOpenedRef.current = false;
      return;
    }
    if (open || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    openDropdown("first");
  }, [autoOpen, open, openDropdown]);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      if (accordionGroups) {
        const optionById = new Map(effectiveOptions.map((option) => [option.id, option]));
        const target = optionById.get(groupId);
        if (target && prev.has(groupId)) {
          const next = new Set(prev);
          next.delete(groupId);

          for (const option of effectiveOptions) {
            if (!(option.isHeader || option.isGroup) || option.id === groupId) continue;
            const sameParent = option.parentId === target.parentId;
            const underSibling = option.parentId
              ? effectiveOptions.some((sibling) =>
                  (sibling.isHeader || sibling.isGroup)
                  && sibling.id !== groupId
                  && sibling.parentId === target.parentId
                  && isDescendantOf(option, sibling.id, optionById),
                )
              : false;
            if (sameParent || underSibling) next.add(option.id);
          }

          let current: SmartSelectOption | undefined = target;
          while (current) {
            next.delete(current.id);
            current = current.parentId ? optionById.get(current.parentId) : undefined;
          }
          return next;
        }
      }
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, [accordionGroups, effectiveOptions]);

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => calcPosition();
    const handleResize = () => calcPosition();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [calcPosition, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => calcPosition());
    return () => window.cancelAnimationFrame(frame);
  }, [calcPosition, open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDownOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (triggerRef.current && path.includes(triggerRef.current)) return;
      if (dropdownRef.current && path.includes(dropdownRef.current)) return;
      // Commit pending multi-mode draft edits before closing so checkbox
      // toggles made before clicking away are applied.
      if (mode === "multi" && multiDraft !== null) {
        (onChange as (ids: string[]) => void)(multiDraft);
      }
      closeDropdown();
    };
    document.addEventListener("pointerdown", handlePointerDownOutside, true);
    return () => document.removeEventListener("pointerdown", handlePointerDownOutside, true);
  }, [closeDropdown, mode, multiDraft, onChange, open]);

  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    const listNode = listRef.current;
    const row =
      document.getElementById(`${listId}-${focusedIndex}`) ??
      (listNode?.children[focusedIndex] as HTMLElement | undefined);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, listId, open]);

  useEffect(() => {
    if (!showNew) return;
    inlineCreateInputRef.current?.focus();
  }, [showNew]);

  useEffect(() => {
    if (!open || !searchable) return;
    const input = dropdownRef.current?.querySelector<HTMLInputElement>("input[data-search]");
    input?.focus();
  }, [open, searchable]);

  useEffect(() => {
    const handleCreated = (event: Event) => {
      const option = (event as CustomEvent<SmartSelectOption>).detail;
      if (!option?.id || !option.label) return;
      setCreatedOptions((prev) => mergeSmartSelectOptions(prev, [option]));
    };
    window.addEventListener(SMART_SELECT_CREATED_EVENT, handleCreated);
    return () => window.removeEventListener(SMART_SELECT_CREATED_EVENT, handleCreated);
  }, []);

  function selectSingle(id: string, options?: { close?: boolean }) {
    (onChange as (id: string) => void)(id);
    if (options?.close !== false) closeDropdown();
  }

  function selectOrToggleSingleGroup(option: SmartSelectOption) {
    if (expandOnGroupSelect && selectableGroups && !groupSelectOnDoubleClick && hierarchy && collapsibleGroups) {
      selectSingle(option.id, { close: false });
      if (collapsedGroups.has(option.id)) toggleGroup(option.id);
      return;
    }
    if ((!selectableGroups || groupSelectOnDoubleClick) && hierarchy && collapsibleGroups) {
      toggleGroup(option.id);
      return;
    }
    selectSingle(option.id);
  }

  function toggleMulti(id: string) {
    const current = multiDraft ?? (value as string[]);
    const next = current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id];
    // Checkbox interaction only updates the draft; the dropdown stays open
    // until the user confirms, clicks a label (single-select), or clicks away.
    setMultiDraft(next);
  }

  function commitMultiSelection(ids: string[]) {
    (onChange as (ids: string[]) => void)(ids);
    closeDropdown();
  }

  function selectMultiOnly(id: string) {
    // Clicking the label row = single-select this option, commit and close.
    commitMultiSelection([id]);
  }

  async function createInlineOption() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      if (isMultiInlineCreate) {
        const newOption = await isMultiInlineCreate.onCreate(newName.trim(), newColor);
        setCreatedOptions((prev) => mergeSmartSelectOptions(prev, [newOption]));
        // Creating a tag is an explicit intent to select it: add to the
        // working draft (not auto-commit) so the user can still adjust.
        const current = multiDraft ?? (value as string[]);
        if (!current.includes(newOption.id)) setMultiDraft([...current, newOption.id]);
        isMultiInlineCreate.onCreated?.(newOption);
      } else {
        const res = await fetch("/api/v1/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName.trim(), color: newColor }),
        });
        const data = await res.json();
        if (!data.ok || !data.tag) {
          window.alert(data.error ?? t("smartSelect.createFailed"));
          return;
        }
        const newOption: SmartSelectOption = {
          id: data.tag.id,
          label: data.tag.name,
          color: data.tag.color,
        };
        const current = multiDraft ?? (value as string[]);
        if (!current.includes(newOption.id)) setMultiDraft([...current, newOption.id]);
      }
      setNewName("");
      setShowNew(false);
    } catch {
      window.alert(t("smartSelect.networkError"));
    } finally {
      setCreating(false);
    }
  }

  function handleDropdownKeyDown(event: React.KeyboardEvent) {
    const total = visible.length;
    if (total === 0 && event.key !== "Tab") return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusedIndex((prev) => (prev + 1 < total ? prev + 1 : 0));
        return;
      case "ArrowUp":
        event.preventDefault();
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : total - 1));
        return;
      case "Home":
        event.preventDefault();
        setFocusedIndex(0);
        return;
      case "End":
        event.preventDefault();
        setFocusedIndex(total - 1);
        return;
      case "Enter": {
        event.preventDefault();
        if (search.trim() && visible.length === 1) {
          const only = visible[0];
          if (only.isHeader) return;
          if (only.isGroup && mode === "single") {
            selectOrToggleSingleGroup(only);
            return;
          }
          if (only.isGroup && hierarchy && collapsibleGroups && (!selectableGroups || groupSelectOnDoubleClick)) {
            toggleGroup(only.id);
            return;
          }
          if (mode === "single") selectSingle(only.id);
          else toggleMulti(only.id);
          return;
        }
        if (focusedIndex < 0 || focusedIndex >= total) return;
        const focused = visible[focusedIndex];
        if (focused.isHeader) {
          if (hierarchy && collapsibleGroups) toggleGroup(focused.id);
          return;
        }
        if (focused.isGroup && hierarchy && collapsibleGroups) {
          if (mode === "single") selectOrToggleSingleGroup(focused);
          else if (!selectableGroups || groupSelectOnDoubleClick) toggleGroup(focused.id);
          else toggleMulti(focused.id);
          return;
        }
        if (mode === "single") selectSingle(focused.id);
        else toggleMulti(focused.id);
        return;
      }
      case "Escape":
        event.preventDefault();
        closeDropdown();
        return;
      case "Tab":
        closeDropdown();
        return;
      default:
        return;
    }
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!open && mode === "single" && cycleSelectionWithArrowKeys) {
      const currentIndex = selectableOptions.findIndex((option) => option.id === value);
      const selectByIndex = (index: number) => {
        const next = selectableOptions[index];
        if (next) (onChange as (id: string) => void)(next.id);
      };

      switch (event.key) {
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          if (selectableOptions.length > 0) {
            selectByIndex(currentIndex >= 0 ? (currentIndex + 1) % selectableOptions.length : 0);
          }
          return;
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          if (selectableOptions.length > 0) {
            selectByIndex(
              currentIndex >= 0
                ? (currentIndex - 1 + selectableOptions.length) % selectableOptions.length
                : selectableOptions.length - 1,
            );
          }
          return;
        case "Home":
          event.preventDefault();
          if (selectableOptions.length > 0) selectByIndex(0);
          return;
        case "End":
          event.preventDefault();
          if (selectableOptions.length > 0) selectByIndex(selectableOptions.length - 1);
          return;
      }
    }

    if (!open) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDropdown("first");
      }
      return;
    }

    if (!searchable) handleDropdownKeyDown(event);
  }

  function isGroupedPanelParent(option: SmartSelectOption) {
    return groupedSingleHierarchy
      && !!option.isGroup
      && !collapsedGroups.has(option.id)
      && (visibleChildrenByParentId.get(option.id)?.length ?? 0) > 0;
  }

  function hasGroupedPanelAncestor(option: SmartSelectOption) {
    if (!groupedSingleHierarchy) return false;
    let parentId = option.parentId;
    while (parentId) {
      const parent = visibleOptionById.get(parentId);
      if (!parent) return false;
      if (isGroupedPanelParent(parent)) return true;
      parentId = parent.parentId;
    }
    return false;
  }

  function renderSingleGroupOption(option: SmartSelectOption, insidePanel = false) {
    const index = visibleIndexById.get(option.id) ?? 0;
    const selected = option.id === value;
    const collapsed = collapsedGroups.has(option.id) && search.trim().length === 0;
    const capsuleLayout = Boolean(singleGridColumns) || insidePanel;
    const focused = index === focusedIndex;
    const optionLabel = capsuleLayout ? stripIndent(option.label) : option.label;
    return (
      <button
        key={option.id}
        id={`${listId}-${index}`}
        style={insidePanel || singleGridColumns ? undefined : fullGridRowStyle}
        type="button"
        role="option"
        aria-selected={selected}
        title={option.title || stripIndent(option.label)}
        onClick={() => {
          selectOrToggleSingleGroup(option);
        }}
        onDoubleClick={() => {
          if (selectableGroups && groupSelectOnDoubleClick) selectSingle(option.id);
        }}
        onMouseEnter={() => setFocusedIndex(index)}
        className={
          capsuleLayout
            ? "flex h-8 min-w-0 items-center gap-1 text-center text-xs outline-none"
            : `flex ${micro ? "h-5 px-1.5 text-[11px]" : dense ? "h-7 px-2 text-xs" : compact ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm"} w-full items-center gap-1.5 text-left transition-colors ${
                focused ? "bg-blue-50" : ""
              } ${selected ? "font-medium text-blue-700" : "text-slate-700"}`
        }
      >
        <span
          onClick={(event) => {
            event.stopPropagation();
            if (hierarchy && collapsibleGroups) toggleGroup(option.id);
          }}
          className={capsuleLayout
            ? "order-2 z-10 flex shrink-0 cursor-pointer items-center justify-center"
            : "flex shrink-0 cursor-pointer items-center gap-1 px-0.5 text-slate-400 hover:text-slate-600"}
        >
          {hierarchy && collapsibleGroups ? (
            <>
              <span className={groupToggleIndicatorClass(collapsed, capsuleLayout)}>
                {collapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </span>
            </>
          ) : null}
        </span>
        <span
          className={capsuleLayout
            ? `order-1 min-w-0 flex-1 truncate rounded-md border px-2 py-1.5 ${groupLabelCapsuleClass(selected, focused)}`
            : "min-w-0 flex-1 truncate"}
          title={option.title || stripIndent(option.label)}
        >
          {optionLabel}
        </span>
        {!singleGridColumns && !insidePanel && option.subLabel ? (
          <span className="max-w-[48%] shrink-0 truncate text-[10px] text-slate-400" title={option.subLabel}>{option.subLabel}</span>
        ) : null}
      </button>
    );
  }

  function renderSingleLeafOption(option: SmartSelectOption, insidePanel = false) {
    const index = visibleIndexById.get(option.id) ?? 0;
    const selected = option.id === value;
    const optionLabel = (singleGridColumns || insidePanel) ? stripIndent(option.label) : option.label;
    return (
      <button
        key={option.id}
        id={`${listId}-${index}`}
        type="button"
        role="option"
        aria-selected={selected}
        title={option.title || optionLabel}
        onClick={() => selectSingle(option.id)}
        onMouseEnter={() => setFocusedIndex(index)}
        className={
          insidePanel
            ? `flex h-8 min-w-0 items-center justify-center rounded-md border px-2 text-center text-xs transition-colors ${
                index === focusedIndex ? "border-blue-200 bg-blue-50" : "border-slate-200/70 bg-slate-50 hover:border-slate-300 hover:bg-slate-100"
              } ${selected ? "border-blue-200 bg-blue-50 font-medium text-blue-700" : "text-slate-700"}`
            : singleGridColumns
              ? `flex h-8 min-w-0 items-center justify-center rounded-md px-2 text-center text-xs transition-colors ${
                  index === focusedIndex ? "bg-blue-50" : "hover:bg-slate-50"
                } ${selected ? "bg-blue-50 font-medium text-blue-700" : "text-slate-700"}`
              : `flex ${micro ? "h-5 px-1.5 text-[11px]" : dense ? "h-7 px-2 text-xs" : compact ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm"} w-full items-center gap-1.5 text-left transition-colors ${
                  index === focusedIndex ? "bg-blue-50" : ""
                } ${selected ? "font-medium text-blue-700" : "text-slate-700"}`
        }
      >
        <span className="min-w-0 flex-1 truncate" title={option.title || optionLabel}>{optionLabel}</span>
        {!insidePanel && option.subLabel ? (
          <span className="max-w-[48%] shrink-0 truncate text-[10px] text-slate-400" title={option.subLabel}>{option.subLabel}</span>
        ) : null}
      </button>
    );
  }

  function renderGroupedChildrenPanel(parent: SmartSelectOption, depth = 0): ReactNode {
    if (!isGroupedPanelParent(parent)) return null;
    const children = visibleChildrenByParentId.get(parent.id) ?? [];
    return (
      <div
        key={`${parent.id}:children`}
        style={depth === 0 ? fullGridRowStyle : { gridColumn: "1 / -1" }}
        className={[
          "my-0.5 rounded-md border p-1.5",
          depth === 0
            ? "border-slate-400/70 bg-slate-200/95 shadow-inner"
            : "border-slate-400/60 bg-slate-300/70",
        ].join(" ")}
      >
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${singleGridColumns ?? 2}, minmax(0, 1fr))` }}
        >
          {children.map((child) => {
            if (child.isHeader) return null;
            if (child.isGroup) {
              return [
                renderSingleGroupOption(child, true),
                renderGroupedChildrenPanel(child, depth + 1),
              ];
            }
            return renderSingleLeafOption(child, true);
          })}
        </div>
      </div>
    );
  }

  function renderGroupedSingleOptions() {
    return visible.map((option, index) => {
      if (hasGroupedPanelAncestor(option)) return null;
      if (option.isHeader) {
        const collapsed = collapsedGroups.has(option.id) && search.trim().length === 0;
        return (
          <div
            key={option.id}
            style={fullGridRowStyle}
            className={`flex ${micro ? "h-4 px-1.5" : dense ? "h-6 px-2" : compact ? "h-7 px-2" : "h-8 px-3"} w-full items-center justify-between text-xs font-medium transition-colors ${
              index === focusedIndex ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"
            }`}
            onMouseEnter={() => setFocusedIndex(index)}
          >
            <button
              type="button"
              onClick={() => hierarchy && collapsibleGroups && toggleGroup(option.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-0.5 text-left text-slate-600"
            >
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded">
                {hierarchy && collapsibleGroups ? (
                  collapsed
                    ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                    : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                ) : null}
              </span>
              <span className="truncate">{option.label}</span>
            </button>
            {!search.trim() && hierarchy && showGroupCounts ? (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-slate-400">
                {groupChildCounts.get(option.id) ?? 0}
              </span>
            ) : null}
          </div>
        );
      }
      if (option.isGroup) {
        return [
          renderSingleGroupOption(option),
          renderGroupedChildrenPanel(option),
        ];
      }
      return renderSingleLeafOption(option);
    });
  }

  const dropdown = (
    <div
      ref={dropdownRef}
      data-smart-select-dropdown="true"
      onKeyDown={handleDropdownKeyDown}
      className={`flex flex-col overflow-hidden ${resizableDropdown ? "resize" : ""} ${compact ? "rounded-[10px]" : "rounded-[12px]"} border border-slate-200/80 bg-surface-white shadow-[0_18px_40px_rgba(15,23,42,0.12)]`}
      style={{
        position: "fixed",
        top: dropdownPos.top,
        left: dropdownPos.left,
        width: dropdownPos.width,
        minWidth: resizableDropdown ? dropdownPos.minWidth : dropdownPos.width,
        minHeight: resizableDropdown ? Math.min(180, dropdownPos.maxHeight || 180) : undefined,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: dropdownPos.maxHeight || "calc(100vh - 16px)",
        zIndex: 30000,
      }}
    >
      {mode === "single" ? (
        <>
          {(searchable || isSingleCreateButton || cycleAction || headerExtra) ? (
            <div className={`flex min-w-0 items-center gap-1 border-b border-slate-200/70 px-2 ${compact ? "py-1" : "pt-2 pb-1"}`}>
              {searchable ? (
                <input
                  data-search
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setFocusedIndex(0);
                  }}
                  className="h-7 min-w-0 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder={t("smartSelect.search")}
                />
              ) : (
                <div className="min-w-0 flex-1" />
              )}
              <div className="flex shrink-0 items-center gap-1">
                {isSingleCreateButton ? (
                  <button
                    type="button"
                    onClick={() => {
                      closeDropdown();
                      isSingleCreateButton.onClick();
                    }}
                    title={isSingleCreateButton.label ?? t("smartSelect.add")}
                    aria-label={isSingleCreateButton.label ?? t("smartSelect.add")}
                    className="secondary-button !px-0 h-7 w-7 shrink-0 text-blue-600 hover:bg-blue-50"
                  >
                    <Plus className="h-[18px] w-[18px]" />
                  </button>
                ) : null}
                {renderCycleActionButton(cycleAction, t)}
                {headerExtra}
              </div>
            </div>
          ) : null}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className={`min-h-0 flex-1 overflow-y-auto ${singleGridColumns ? "grid gap-1 p-1" : ""}`}
            style={{
              maxHeight: resizableDropdown ? undefined : resolvedDropdownMaxHeight,
              ...(singleGridColumns ? { gridTemplateColumns: `repeat(${singleGridColumns}, minmax(0, 1fr))` } : {}),
            }}
          >
            {groupedSingleHierarchy ? renderGroupedSingleOptions() : visible.map((option, index) => {
              if (option.isHeader) {
                const collapsed = collapsedGroups.has(option.id) && search.trim().length === 0;
                return (
                  <div
                    key={option.id}
                    style={fullGridRowStyle}
                    className={`flex ${micro ? "h-4 px-1.5" : dense ? "h-6 px-2" : compact ? "h-7 px-2" : "h-8 px-3"} w-full items-center justify-between text-xs font-medium transition-colors ${
                      index === focusedIndex ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"
                    }`}
                    onMouseEnter={() => setFocusedIndex(index)}
                  >
                    <button
                      type="button"
                      onClick={() => hierarchy && collapsibleGroups && toggleGroup(option.id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-0.5 text-left text-slate-600"
                    >
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded">
                        {hierarchy && collapsibleGroups ? (
                          collapsed
                            ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                            : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                        ) : null}
                      </span>
                      <span className="truncate">{option.label}</span>
                    </button>
                    {!search.trim() && hierarchy && showGroupCounts ? (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-slate-400">
                        {groupChildCounts.get(option.id) ?? 0}
                      </span>
                    ) : null}
                  </div>
                );
              }
              if (option.isGroup) {
                return renderSingleGroupOption(option);
              }

              const selected = option.id === value;
              const optionLabel = singleGridColumns ? stripIndent(option.label) : option.label;
              return (
                <button
                  key={option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={option.title || optionLabel}
                  onClick={() => selectSingle(option.id)}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={singleGridColumns
                    ? `flex h-8 min-w-0 items-center justify-center rounded-md px-2 text-center text-xs transition-colors ${
                        index === focusedIndex ? "bg-blue-50" : "hover:bg-slate-50"
                      } ${selected ? "bg-blue-50 font-medium text-blue-700" : "text-slate-700"}`
                    : `flex ${micro ? "h-5 px-1.5 text-[11px]" : dense ? "h-7 px-2 text-xs" : compact ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm"} w-full items-center gap-1.5 text-left transition-colors ${
                        index === focusedIndex ? "bg-blue-50" : ""
                      } ${selected ? "font-medium text-blue-700" : "text-slate-700"}`}
                >
                  <span className="min-w-0 flex-1 truncate" title={option.title || optionLabel}>{optionLabel}</span>
                  {option.subLabel ? (
                    <span className="max-w-[48%] shrink-0 truncate text-[10px] text-slate-400" title={option.subLabel}>{option.subLabel}</span>
                  ) : null}
                </button>
              );
            })}
            {visible.length === 0 ? (
              <div
                style={fullGridRowStyle}
                className="px-3 py-4 text-center text-xs text-slate-400"
              >
                {search ? t("smartSelect.noMatch", { search }) : t("smartSelect.noOptions")}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {(searchable || cycleAction || headerExtra) ? (
            <div className={`flex min-w-0 items-center gap-1 border-b border-slate-200/70 px-2 ${compact ? "py-1" : "pt-2 pb-1"}`}>
              {searchable ? (
                <input
                  data-search
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setFocusedIndex(0);
                  }}
                  className="h-7 min-w-0 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder={t("smartSelect.search")}
                />
              ) : (
                <div className="min-w-0 flex-1" />
              )}
              <div className="flex shrink-0 items-center gap-1">
                {renderCycleActionButton(cycleAction, t)}
                {headerExtra}
              </div>
            </div>
          ) : null}

          {isMultiInlineCreate ? (
            !showNew ? (
              <button
                type="button"
                onClick={() => setShowNew(true)}
                title={isMultiInlineCreate.buttonLabel ?? t("smartSelect.add")}
                aria-label={isMultiInlineCreate.buttonLabel ?? t("smartSelect.add")}
                className="flex h-9 w-full items-center justify-between border-b border-slate-200/70 bg-slate-50/90 px-3 text-sm transition-colors hover:bg-blue-50/70"
              >
                <span className="text-slate-500">{placeholder || t("txForm.selectTags")}</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-blue-50/80 text-blue-700">
                  <Plus className="h-[18px] w-[18px]" />
                </span>
              </button>
            ) : (
              <div className="space-y-2 border-b border-slate-200/70 bg-blue-50/60 px-3 py-2">
                <div className="flex gap-2">
                  <input
                    ref={inlineCreateInputRef}
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.stopPropagation();
                        void createInlineOption();
                      }
                      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        event.stopPropagation();
                      }
                    }}
                    className="h-8 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("smartSelect.tagName")}
                  />
                  <button
                    type="button"
                    onClick={() => void createInlineOption()}
                    disabled={!newName.trim() || creating}
                    className="primary-button h-8 px-3 text-sm disabled:opacity-50"
                  >
                    {creating ? "..." : t("smartSelect.create")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNew(false);
                      setNewName("");
                    }}
                    className="secondary-button h-8 w-8 px-0 text-slate-400"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewColor(color)}
                      className={`h-5 w-5 rounded-full border-2 transition-colors ${
                        newColor === color ? "scale-110 border-foreground" : "border-transparent"
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            )
          ) : null}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="min-h-0 flex-1 overflow-y-auto"
            style={{ maxHeight: resizableDropdown ? undefined : 240 }}
          >
            {visible.map((option, index) => {
              const checked = (multiDraft ?? (value as string[])).includes(option.id);
              const color = option.color || PRESET_COLORS[0];
              return (
                <div
                  key={option.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={checked}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={`flex ${micro ? "h-5 px-1.5 text-[11px]" : dense ? "h-7 px-2 text-xs" : compact ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm"} w-full items-center gap-2 text-left transition-colors cursor-pointer ${
                    index === focusedIndex ? "bg-blue-50" : ""
                  } ${checked ? "font-medium" : ""}`}
                  onClick={() => selectMultiOnly(option.id)}
                >
                  <span
                    role="checkbox"
                    aria-checked={checked}
                    tabIndex={-1}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      checked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-surface-white"
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleMulti(option.id);
                    }}
                  >
                    {checked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate text-slate-700">{option.label}</span>
                </div>
              );
            })}
            {visible.length === 0 && !showNew ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">{t("smartSelect.noOptions")}</div>
            ) : null}
          </div>
          {multiDraft !== null ? (
            <div className="border-t border-slate-200/70 bg-slate-50/90 px-3 py-2">
              <button
                type="button"
                onClick={commitMultiAndClose}
                className="primary-button h-8 w-full text-sm"
              >
                {t("table.confirm")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <>
      <div
        ref={triggerRef}
        role="button"
        tabIndex={0}
        onClick={() => (open ? commitMultiAndClose() : openDropdown())}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && focusedIndex >= 0 ? `${listId}-${focusedIndex}` : undefined}
        className={`flex ${micro ? "h-6 rounded-[7px] px-1.5 text-[11px]" : dense ? "h-7 rounded-[8px] px-2 text-xs" : compact ? "h-8 rounded-[8px] px-2 text-xs" : "h-9 rounded-[10px] px-3 text-sm"} w-full items-center justify-between border border-slate-300/70 bg-surface-white outline-none transition-colors hover:border-slate-400/60 focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-100`}
      >
        {mode === "single" ? (
          <span className={`${selectedLabel ? "text-slate-800" : "text-slate-400"} flex min-w-0 flex-1 items-center`} title={selectedTitle}>
            <span className="min-w-0 truncate">{selectedLabel || placeholder || t("txForm.selectPlaceholder")}</span>
            {selectedOption?.subLabel ? (
              <span className="ml-1 max-w-[42%] shrink-0 truncate text-[10px] text-slate-400">{selectedOption.subLabel}</span>
            ) : null}
          </span>
        ) : (
          <MultiTriggerDisplay
            value={value as string[]}
            options={effectiveOptions}
            placeholder={placeholder}
          />
        )}
        {mode === "single" && value && clearable ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                (onChange as (id: string) => void)("");
              }}
              className="text-slate-300 transition-colors hover:text-slate-500"
              tabIndex={-1}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </span>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
      </div>
      {open ? createPortal(dropdown, document.body) : null}
    </>
  );
}

function MultiTriggerDisplay({
  value,
  options,
  placeholder,
}: {
  value: string[];
  options: SmartSelectOption[];
  placeholder?: string;
}) {
  const { t } = useI18n();
  const selected = options.filter((option) => value.includes(option.id));

  if (selected.length === 0) {
    return <span className="text-slate-400">{placeholder || t("txForm.selectPlaceholder")}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {selected.slice(0, 3).map((option) => (
        <span
          key={option.id}
          className="inline-flex min-w-0 max-w-[120px] items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
          style={{
            backgroundColor: `${option.color || PRESET_COLORS[0]}18`,
            borderColor: `${option.color || PRESET_COLORS[0]}60`,
            color: option.color || PRESET_COLORS[0],
          }}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: option.color || PRESET_COLORS[0] }}
          />
          <span className="truncate">{option.label}</span>
        </span>
      ))}
      {selected.length > 3 ? (
        <span className="shrink-0 text-xs text-slate-500">+{selected.length - 3}</span>
      ) : null}
    </span>
  );
}
