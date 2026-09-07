"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { GripVertical, SlidersHorizontal, Trash2 } from "lucide-react";
import { DateRangeColumnFilter, NumberRangeColumnFilter, TableColumnFilter, TextColumnFilter } from "./TableColumnFilter";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "@/lib/i18n";
import {
  APP_PREFS_EVENT,
  DEFAULT_ROW_HEIGHT_MODE,
  getRowHeightModePreference,
  ROW_HEIGHT_PRESETS,
  type RowHeightMode,
} from "@/lib/client/appPreferences";

const HORIZONTAL_SCROLL_TOLERANCE_PX = 4;
const ROW_VIRTUALIZATION_THRESHOLD = 200;
const HEADER_SORT_CLICK_DELAY_MS = 220;
// Compact rows stay fixed; the user-facing row-height preference owns normal density.
const COMPACT_ROW_HEIGHT = 30;
const COMPACT_ROW_CONTENT_HEIGHT = 20;
const ROW_BORDER_HEIGHT = 1;
const ROW_ACTIONS_COMPACT_CLASS =
  " [&_button]:h-5 [&_button]:w-5 [&_button]:min-h-0 [&_svg]:h-3 [&_svg]:w-3";
const ROW_ACTIONS_SIZE_CLASS: Record<RowHeightMode, string> = {
  41: " [&_button]:max-h-7",
  39: " [&_button]:max-h-[27px]",
  37: " [&_button]:max-h-[26px]",
  35: " [&_button]:max-h-[26px]",
  33: " [&_button]:max-h-6",
  31: " [&_button]:max-h-[22px]",
};
const HEADER_PADDING_CLASS: Record<RowHeightMode, string> = {
  41: "px-3 py-1.5",
  39: "px-3 py-[5px]",
  37: "px-3 py-[5px]",
  35: "px-3 py-1",
  33: "px-2.5 py-[3px]",
  31: "px-2.5 py-[3px]",
};
// Body text size tracks row-height mode: 41px rows are 14px, 39/37px rows are 13px, and compact rows are 12px.
// Column render callbacks should inherit this instead of hardcoding text-xs.
// Small secondary labels and button text keep their own explicit sizing.
const BODY_TEXT_CLASS: Record<RowHeightMode, string> = {
  41: "text-sm",
  // Arbitrary font-size classes need an explicit line-height to keep rows stable.
  39: "text-[13px]/[18px]",
  37: "text-[13px]/[18px]",
  35: "text-xs",
  33: "text-xs",
  31: "text-xs",
};

function isInteractiveRowTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(
    "button, input, select, textarea, a, [role='button'], [data-row-double-click-ignore]",
  );
}

export type AdvancedDataTableColumn<T> = {
  key: string;
  label: ReactNode;
  width: number;
  minWidth?: number;
  /** Lowest width a user may choose by dragging. Defaults to 52px. */
  resizeMinWidth?: number;
  align?: "left" | "center" | "right";
  hideable?: boolean;
  defaultHidden?: boolean;
  className?: string;
  headerClassName?: string;
  filterText?: (row: T) => string | null | undefined;
  sortValue?: (row: T) => string | number | null | undefined;
  filterKind?: "multi" | "dateRange" | "numberRange" | "text";
  filterNumber?: (row: T) => number | null | undefined;
  filterTitle?: (row: T) => string;
  filterSearchText?: (row: T) => string;
  /** Render simple cell content as a single truncated line. */
  truncate?: boolean;
  /** Full text shown when the pointer rests over a clipped cell. */
  cellTitle?: (row: T) => string | null | undefined;
  render: (row: T, index: number) => ReactNode;
};

export type AdvancedDataTableBatchAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  title?: string;
  ariaLabel?: string;
  tone?: "default" | "primary" | "danger";
};

export type AdvancedDataTableSummaryRow = {
  cells: Readonly<Record<string, ReactNode | undefined>>;
  selectCell?: ReactNode;
  rowClassName?: string;
  cellClassName?: string;
};

export type AdvancedDataTableDropPosition = "before" | "after";
export type AdvancedDataTableSortState = { key: string; direction: "asc" | "desc" };
export type AdvancedDataTableRowDropTarget<T> = {
  row: T;
  index: number;
};

export type AdvancedDataTablePagination = {
  page: number;
  pageSize: number;
  all?: boolean;
  onPageChange: (page: number) => void;
  onRowCountChange?: (count: number) => void;
};

type RowItem<T> = {
  row: T;
  index: number;
  key: string;
};

type ResizeGuide = {
  x: number;
  top: number;
  height: number;
};

type ColumnMenuAnchor = {
  top: number;
  right: number;
};

type ColumnMenuTriggerDetail = {
  anchorRect?: {
    left?: number;
    right?: number;
    bottom?: number;
  };
};

type ResizeSession = {
  key: string;
  width: number;
  baseWidths: Record<string, number>;
};

function reorderRowItems<T>(items: RowItem<T>[], sourceKey: string, targetKey: string, position: AdvancedDataTableDropPosition) {
  const sourceIndex = items.findIndex((item) => item.key === sourceKey);
  const targetIndex = items.findIndex((item) => item.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const next = [...items];
  const [moving] = next.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((item) => item.key === targetKey);
  if (targetIndexAfterRemoval < 0) return items;
  next.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
  return next.every((item, index) => item.key === items[index]?.key) ? items : next;
}

function getDropPositionFromClientY(rowElement: HTMLElement, clientY: number): AdvancedDataTableDropPosition {
  const rect = rowElement.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

// Center a row inside the table viewport without scrolling ancestor containers.
function scrollViewportToRowCenter(viewport: HTMLElement, target: HTMLElement) {
  const viewportRect = viewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  viewport.scrollTop += targetRect.top - viewportRect.top - Math.max(0, (viewportRect.height - targetRect.height) / 2);
}

export type AdvancedDataTableProps<T> = {
  storageKey: string;
  columns: AdvancedDataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  emptyText?: ReactNode;
  minTableWidth?: number;
  rowClassName?: (row: T, index: number) => string;
  rowBackgroundGroupKey?: (row: T, index: number) => string | null | undefined;
  rowBackgroundEnabled?: boolean;
  onRowClick?: (row: T, index: number) => void;
  onRowDoubleClick?: (row: T, index: number) => void;
  draggableRows?: boolean;
  rowDragDisabled?: (row: T, index: number) => boolean;
  rowDropAllowed?: (sourceRow: T, targetRow: T, sourceIndex: number, targetIndex: number, position: AdvancedDataTableDropPosition) => boolean;
  rowDropTargetAtEnd?: (sourceRow: T, sourceIndex: number, orderedRows: T[]) => AdvancedDataTableRowDropTarget<T> | null;
  onRowReorder?: (sourceRow: T, targetRow: T, sourceIndex: number, targetIndex: number, position: AdvancedDataTableDropPosition) => void | Promise<void>;
  onDisplayRowsChange?: (rows: T[]) => void;
  selectable?: boolean;
  selectOnRowClick?: boolean;
  selectAllScope?: "allRows" | "renderedRows";
  rowSelectable?: (row: T, index: number) => boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  batchActions?: AdvancedDataTableBatchAction[];
  batchActionSlot?: ReactNode;
  rowActions?: (row: T, index: number) => ReactNode;
  rowActionsWidth?: number;
  rowActionsMinWidth?: number;
  showFilters?: boolean;
  fillHeight?: boolean;
  compactRows?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarTitle?: ReactNode;
  toolbarLeftContent?: ReactNode;
  toolbarRightContent?: ReactNode;
  showTableStateInCustomToolbar?: boolean;
  showColumnVisibilityButton?: boolean;
  sortable?: boolean;
  defaultSort?: AdvancedDataTableSortState | null;
  filterRows?: (
    rows: T[],
    filters: Partial<Record<string, string[]>>,
    columns: AdvancedDataTableColumn<T>[],
  ) => T[];
  sortRows?: (
    rows: T[],
    sortState: AdvancedDataTableSortState | null,
    columns: AdvancedDataTableColumn<T>[],
  ) => T[];
  pagination?: AdvancedDataTablePagination;
  columnVisibilityTriggerId?: string;
  summaryRow?: AdvancedDataTableSummaryRow;
  resetKey?: string;
  resetDisplayStateOnMount?: boolean;
  scrollToRowKey?: string | null;
};

function alignClass(align?: "left" | "center" | "right") {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function batchActionToneClass(tone: AdvancedDataTableBatchAction["tone"]) {
  if (tone === "danger") return "border-red-200 bg-red-50 text-red-700 hover:bg-red-100";
  if (tone === "primary") return "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100";
  return "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
}

function groupedRowBackgroundClass(groupIndex: number, rowInGroupIndex: number) {
  const isFirstPalette = groupIndex % 2 === 0;
  const isStrongShade = rowInGroupIndex % 2 === 1;
  if (isFirstPalette) {
    return isStrongShade ? "bg-sky-100/75 hover:bg-sky-200" : "bg-sky-50/90 hover:bg-sky-100";
  }
  return isStrongShade ? "bg-amber-100/75 hover:bg-amber-200" : "bg-amber-50/90 hover:bg-amber-100";
}

function inferBatchActionIcon(action: AdvancedDataTableBatchAction) {
  if (action.icon) return action.icon;
  if (action.tone === "danger") return <Trash2 className="h-3.5 w-3.5" />;
  return null;
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function normalizeStoredFilters(
  value: Partial<Record<string, string[]>> | null | undefined,
  filterableColumnKeys: ReadonlySet<string>,
) {
  const next: Partial<Record<string, string[]>> = {};
  for (const [key, values] of Object.entries(value ?? {})) {
    if (!filterableColumnKeys.has(key) || !Array.isArray(values)) continue;
    next[key] = values.filter((item): item is string => typeof item === "string");
  }
  return next;
}

function normalizeStoredSortState(
  value: AdvancedDataTableSortState | null | undefined,
  sortableColumnKeys: ReadonlySet<string>,
) {
  if (!value || !sortableColumnKeys.has(value.key)) return null;
  if (value.direction !== "asc" && value.direction !== "desc") return null;
  return value;
}

function labelText(label: ReactNode, fallback: string) {
  return typeof label === "string" ? label : fallback;
}

function sortFilterValue(a: string, b: string) {
  if (a === "-") return 1;
  if (b === "-") return -1;
  return a.localeCompare(b, "zh-CN", { numeric: true });
}

function rowMatchesColumnFilter<T>(row: T, column: AdvancedDataTableColumn<T>, values: string[] | undefined) {
  if (!column.filterText || (values?.length ?? 0) === 0) return true;
  const rawValue = column.filterText(row);
  if (rawValue == null) return false;
  const value = rawValue.trim() || "-";
  if (column.filterKind === "dateRange") {
    const [from = "", to = ""] = values ?? [];
    const dateValue = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? value;
    if (from && dateValue < from) return false;
    if (to && dateValue > to) return false;
    return true;
  }
  if (column.filterKind === "numberRange") {
    const [from = "", to = ""] = values ?? [];
    const fromNumber = from.trim() === "" ? null : Number(from);
    const toNumber = to.trim() === "" ? null : Number(to);
    if ((fromNumber != null && !Number.isFinite(fromNumber)) || (toNumber != null && !Number.isFinite(toNumber))) return true;
    const rawNumber = column.filterNumber?.(row);
    if (rawNumber == null || !Number.isFinite(rawNumber)) return false;
    if (fromNumber != null && rawNumber < fromNumber) return false;
    if (toNumber != null && rawNumber > toNumber) return false;
    return true;
  }
  if (column.filterKind === "text") {
    const query = values?.[0]?.trim().toLowerCase() ?? "";
    if (!query) return true;
    const haystack = [
      value,
      column.filterSearchText?.(row) ?? "",
      column.filterTitle?.(row) ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  }
  return values?.includes(value) ?? true;
}

function rowMatchesFilters<T>(
  row: T,
  columns: AdvancedDataTableColumn<T>[],
  filters: Partial<Record<string, string[]>>,
  options?: { excludeKey?: string },
) {
  for (const [key, values] of Object.entries(filters)) {
    if (key === options?.excludeKey || (values?.length ?? 0) === 0) continue;
    const column = columns.find((item) => item.key === key);
    if (!column?.filterText) continue;
    if (!rowMatchesColumnFilter(row, column, values)) return false;
  }
  return true;
}

export function AdvancedDataTable<T>({
  storageKey,
  columns,
  rows,
  rowKey,
  emptyText,
  minTableWidth,
  rowClassName,
  rowBackgroundGroupKey,
  rowBackgroundEnabled = false,
  onRowClick,
  onRowDoubleClick,
  draggableRows = false,
  rowDragDisabled,
  rowDropAllowed,
  rowDropTargetAtEnd,
  onRowReorder,
  onDisplayRowsChange,
  selectable = false,
  selectOnRowClick = false,
  selectAllScope = "allRows",
  rowSelectable,
  selectedKeys,
  onSelectionChange,
  batchActions = [],
  batchActionSlot,
  rowActions,
  rowActionsWidth = 96,
  rowActionsMinWidth = 76,
  showFilters = true,
  fillHeight = false,
  compactRows = false,
  toolbarMode = "default",
  toolbarTitle,
  toolbarLeftContent,
  toolbarRightContent,
  showTableStateInCustomToolbar = false,
  showColumnVisibilityButton = true,
  sortable = true,
  defaultSort = null,
  filterRows,
  sortRows,
  pagination,
  columnVisibilityTriggerId,
  summaryRow,
  resetKey,
  resetDisplayStateOnMount = false,
  scrollToRowKey,
}: AdvancedDataTableProps<T>) {
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrolledAnchorKeyRef = useRef<string | null>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [needsHorizontalScroll, setNeedsHorizontalScroll] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [externalColumnMenuAnchor, setExternalColumnMenuAnchor] = useState<ColumnMenuAnchor | null>(null);
  const [filters, setFilters] = useState<Partial<Record<string, string[]>>>({});
  const [activeFilterColumn, setActiveFilterColumn] = useState<string | null>(null);
  const [sortState, setSortState] = useState<AdvancedDataTableSortState | null>(null);
  const [rowHeightMode, setRowHeightMode] = useState<RowHeightMode>(DEFAULT_ROW_HEIGHT_MODE);
  const rowHeightPreset = ROW_HEIGHT_PRESETS[rowHeightMode];
  const rowHeight = compactRows ? COMPACT_ROW_HEIGHT : rowHeightPreset.height;
  const rowPaddingY = compactRows
    ? Math.max(2, Math.floor((COMPACT_ROW_HEIGHT - COMPACT_ROW_CONTENT_HEIGHT - ROW_BORDER_HEIGHT) / 2))
    : rowHeightPreset.padding;
  const rowCellPaddingStyle = { paddingTop: rowPaddingY, paddingBottom: rowPaddingY };
  const rowActionsSizeClass = ROW_ACTIONS_SIZE_CLASS[rowHeightMode];
  const [internalSelectedKeys, setInternalSelectedKeys] = useState<Set<string>>(new Set());
  const [draggedRowKey, setDraggedRowKey] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<{ key: string; position: AdvancedDataTableDropPosition } | null>(null);
  const [resizeGuide, setResizeGuide] = useState<ResizeGuide | null>(null);
  const [resizeSession, setResizeSession] = useState<ResizeSession | null>(null);
  const suppressNextClickRef = useRef(false);
  const dragCancelledRef = useRef(false);
  const headerSortClickTimerRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const lastResetKeyRef = useRef(resetKey);
  const tableDisplayStateHydratedRef = useRef(false);
  const skipNextFiltersWriteRef = useRef(false);
  const skipNextSortWriteRef = useRef(false);
  const paginationPage = pagination?.page;
  const paginationPageSize = pagination?.pageSize;
  const paginationAll = pagination?.all ?? false;
  const paginationOnPageChange = pagination?.onPageChange;
  const paginationOnRowCountChange = pagination?.onRowCountChange;

  useEffect(() => {
    const syncRowSizing = () => {
      setRowHeightMode(getRowHeightModePreference());
    };
    syncRowSizing();
    window.addEventListener(APP_PREFS_EVENT, syncRowSizing);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncRowSizing);
  }, []);

  const clearPendingHeaderSortClick = useCallback(() => {
    if (headerSortClickTimerRef.current == null) return;
    window.clearTimeout(headerSortClickTimerRef.current);
    headerSortClickTimerRef.current = null;
  }, []);

  const effectiveSelectedKeys = selectedKeys ?? internalSelectedKeys;
  const tableColumns = useMemo<AdvancedDataTableColumn<T>[]>(() => {
    if (!rowActions) return columns;
    return [
      ...columns,
      {
        key: "__row_actions",
        label: "",
        width: rowActionsWidth,
        minWidth: rowActionsMinWidth,
        align: "right",
        render: (row, index) => (
          <div
            data-row-double-click-ignore
            data-advanced-table-row-actions
            className={`flex items-center justify-end gap-1${compactRows ? ROW_ACTIONS_COMPACT_CLASS : rowActionsSizeClass}`}
            onClick={(event) => event.stopPropagation()}
          >
            {rowActions(row, index)}
          </div>
        ),
      },
    ];
  }, [columns, compactRows, rowActions, rowActionsMinWidth, rowActionsSizeClass, rowActionsWidth]);
  const hiddenStorageKey = `${storageKey}:hidden:v2`;
  const hideableColumnKeys = useMemo(
    () => new Set(tableColumns.filter((column) => column.hideable).map((column) => column.key)),
    [tableColumns],
  );
  const defaultHiddenKeys = useMemo(
    () => tableColumns.filter((column) => column.defaultHidden && column.hideable).map((column) => column.key),
    [tableColumns],
  );
  const filterableColumnKeysSignature = useMemo(
    () => tableColumns.filter((column) => column.filterText).map((column) => column.key).join("\u001F"),
    [tableColumns],
  );
  const filterableColumnKeys = useMemo(
    () => new Set(filterableColumnKeysSignature ? filterableColumnKeysSignature.split("\u001F") : []),
    [filterableColumnKeysSignature],
  );
  const sortableColumnKeysSignature = useMemo(
    () => tableColumns.filter((column) => column.sortValue || column.filterText).map((column) => column.key).join("\u001F"),
    [tableColumns],
  );
  const sortableColumnKeys = useMemo(
    () => new Set(sortableColumnKeysSignature ? sortableColumnKeysSignature.split("\u001F") : []),
    [sortableColumnKeysSignature],
  );
  const filtersStorageKey = `${storageKey}:filters:v2`;
  const sortStorageKey = `${storageKey}:sort:v1`;

  useEffect(() => {
    setColumnWidths(readJson<Record<string, number>>(`${storageKey}:widths`, {}));
    const savedHiddenKeys = readJson<string[] | null>(hiddenStorageKey, null);
    const legacyHiddenKeys = savedHiddenKeys == null ? readJson<string[]>(`${storageKey}:hidden`, []) : [];
    const rawHiddenKeys = savedHiddenKeys ?? [...defaultHiddenKeys, ...legacyHiddenKeys];
    setHiddenKeys(new Set(rawHiddenKeys.filter((key) => hideableColumnKeys.has(key))));
  }, [defaultHiddenKeys, hiddenStorageKey, hideableColumnKeys, storageKey]);

  useEffect(() => {
    tableDisplayStateHydratedRef.current = false;
    skipNextFiltersWriteRef.current = true;
    skipNextSortWriteRef.current = true;
    if (resetDisplayStateOnMount) {
      setFilters({});
      setSortState(null);
      writeJson(sortStorageKey, null);
      writeJson(filtersStorageKey, {});
    } else {
      setFilters(normalizeStoredFilters(
        readJson<Partial<Record<string, string[]>>>(filtersStorageKey, {}),
        filterableColumnKeys,
      ));
      if (!sortable) {
        setSortState(null);
        writeJson(sortStorageKey, null);
      } else {
        const storedSort = readJson<AdvancedDataTableSortState | null | undefined>(sortStorageKey, undefined);
        setSortState(normalizeStoredSortState(
          storedSort === undefined ? defaultSort : storedSort,
          sortableColumnKeys,
        ));
      }
    }
    setActiveFilterColumn(null);
    tableDisplayStateHydratedRef.current = true;
  }, [defaultSort, filterableColumnKeys, filtersStorageKey, resetDisplayStateOnMount, sortable, sortStorageKey, sortableColumnKeys]);

  useEffect(() => {
    if (!tableDisplayStateHydratedRef.current) return;
    if (skipNextFiltersWriteRef.current) {
      skipNextFiltersWriteRef.current = false;
      return;
    }
    writeJson(filtersStorageKey, filters);
  }, [filters, filtersStorageKey]);

  useEffect(() => {
    if (!tableDisplayStateHydratedRef.current) return;
    if (skipNextSortWriteRef.current) {
      skipNextSortWriteRef.current = false;
      return;
    }
    writeJson(sortStorageKey, sortState);
  }, [sortState, sortStorageKey]);

  useEffect(() => {
    if (!resetDisplayStateOnMount) return;
    return () => {
      writeJson(filtersStorageKey, {});
      writeJson(sortStorageKey, null);
    };
  }, [filtersStorageKey, resetDisplayStateOnMount, sortStorageKey]);

  useEffect(() => {
    return () => clearPendingHeaderSortClick();
  }, [clearPendingHeaderSortClick]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    if (resetKey == null) return;
    if (lastResetKeyRef.current === resetKey) return;
    lastResetKeyRef.current = resetKey;
    skipNextFiltersWriteRef.current = false;
    skipNextSortWriteRef.current = false;
    setFilters({});
    setSortState(null);
    setActiveFilterColumn(null);
    clearPendingHeaderSortClick();
    writeJson(filtersStorageKey, {});
    writeJson(sortStorageKey, null);
  }, [clearPendingHeaderSortClick, filtersStorageKey, resetKey, sortStorageKey]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewportWidth(Math.floor(node.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setNeedsHorizontalScroll(node.scrollWidth > node.clientWidth + HORIZONTAL_SCROLL_TOLERANCE_PX);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const table = node.querySelector("table");
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [fillHeight, hiddenKeys, minTableWidth, selectable, tableColumns, viewportWidth, rows.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = columnMenuRef.current;
      if (!node || !(event.target instanceof Node) || node.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!columnVisibilityTriggerId) return;
    const onTrigger = (event: Event) => {
      const detail = (event as CustomEvent<ColumnMenuTriggerDetail>).detail;
      const rect = detail?.anchorRect ?? (
        document.activeElement instanceof HTMLElement
          ? document.activeElement.getBoundingClientRect()
          : null
      );
      if (rect && Number.isFinite(rect.right) && Number.isFinite(rect.bottom)) {
        setExternalColumnMenuAnchor({
          top: Math.max(8, rect.bottom ?? 8) + 4,
          right: Math.max(8, window.innerWidth - (rect.right ?? window.innerWidth - 8)),
        });
      } else {
        setExternalColumnMenuAnchor(null);
      }
      setMenuOpen(true);
    };
    window.addEventListener(columnVisibilityTriggerId, onTrigger);
    return () => window.removeEventListener(columnVisibilityTriggerId, onTrigger);
  }, [columnVisibilityTriggerId]);

  const visibleColumns = useMemo(
    () => tableColumns.filter((column) => !column.hideable || !hiddenKeys.has(column.key)),
    [hiddenKeys, tableColumns],
  );
  const activeFilterMeta = useMemo(() => {
    const empty = {
      columnKey: null as string | null,
      options: [] as string[],
      counts: undefined as Record<string, number> | undefined,
      titles: undefined as Record<string, string> | undefined,
      searchText: undefined as Record<string, string> | undefined,
    };
    if (!activeFilterColumn) return empty;
    const column = tableColumns.find((item) => item.key === activeFilterColumn);
    if (!column?.filterText) return empty;
    if (column.filterKind === "dateRange" || column.filterKind === "numberRange" || column.filterKind === "text") {
      return empty;
    }
    const baseRows = showFilters
      ? rows.filter((row) => rowMatchesFilters(row, tableColumns, filters, { excludeKey: column.key }))
      : rows;
    const values = new Set<string>();
    const counts: Record<string, number> = {};
    const titles: Record<string, string> = {};
    const searchTextParts: Record<string, Set<string>> = {};
    for (const row of baseRows) {
      const rawValue = column.filterText(row);
      if (rawValue == null) continue;
      const value = rawValue.trim() || "-";
      values.add(value);
      counts[value] = (counts[value] ?? 0) + 1;
      const title = column.filterTitle?.(row)?.trim();
      if (title && !titles[value]) titles[value] = title;
      const searchParts = [
        column.filterSearchText?.(row) ?? "",
        column.filterTitle?.(row) ?? "",
      ].map((item) => item.trim()).filter(Boolean);
      if (searchParts.length === 0) continue;
      searchTextParts[value] ??= new Set<string>();
      for (const item of searchParts) searchTextParts[value].add(item);
    }
    return {
      columnKey: column.key,
      options: Array.from(values).sort(sortFilterValue),
      counts,
      titles,
      searchText: Object.fromEntries(
        Object.entries(searchTextParts).map(([value, parts]) => [value, Array.from(parts).join(" ")]),
      ),
    };
  }, [activeFilterColumn, filters, rows, showFilters, tableColumns]);
  const filteredRows = useMemo(() => {
    if (!showFilters) return rows;
    if (filterRows) return filterRows(rows, filters, tableColumns);
    const activeFilters = Object.entries(filters).filter(([, values]) => (values?.length ?? 0) > 0);
    if (activeFilters.length === 0) return rows;
    return rows.filter((row) => rowMatchesFilters(row, tableColumns, filters));
  }, [filterRows, filters, rows, showFilters, tableColumns]);

  useEffect(() => {
    if (!showFilters || filteredRows.length > 0) return;
    const activeValues = Object.values(filters).filter((values) => (values?.length ?? 0) > 0);
    if (activeValues.length === 0) return;
    if (activeValues.some((values) => values?.includes("__NO_MATCH__"))) return;
    setFilters({});
    setActiveFilterColumn(null);
  }, [filteredRows.length, filters, rows.length, showFilters]);

  const orderedRows = useMemo(() => {
    if (!sortable || !sortState) return filteredRows;
    if (sortRows) return sortRows(filteredRows, sortState, tableColumns);
    const column = tableColumns.find((item) => item.key === sortState.key);
    const readValue = column?.sortValue ?? column?.filterText;
    if (!readValue) return filteredRows;
    return filteredRows
      .map((row, index) => ({ row, index, value: readValue(row) }))
      .sort((a, b) => {
        const aEmpty = a.value == null || a.value === "";
        const bEmpty = b.value == null || b.value === "";
        if (aEmpty || bEmpty) {
          if (aEmpty && bEmpty) return a.index - b.index;
          return aEmpty ? 1 : -1;
        }
        const compared = typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), "zh-CN", { numeric: true });
        return compared === 0
          ? a.index - b.index
          : sortState.direction === "asc" ? compared : -compared;
      })
      .map((item) => item.row);
  }, [filteredRows, sortRows, sortState, sortable, tableColumns]);
  useEffect(() => {
    onDisplayRowsChange?.(orderedRows);
  }, [onDisplayRowsChange, orderedRows]);
  const hasPagination = paginationPage != null && !!paginationOnPageChange;
  const pageSize = paginationAll ? Math.max(1, orderedRows.length) : paginationPageSize && paginationPageSize > 0 ? paginationPageSize : orderedRows.length || 1;
  const pageCount = paginationAll ? 1 : Math.max(1, Math.ceil(orderedRows.length / pageSize));
  const currentPage = paginationAll ? 1 : Math.min(Math.max(1, paginationPage ?? 1), pageCount);
  const pageStartIndex = hasPagination ? (currentPage - 1) * pageSize : 0;
  const paginatedRows = useMemo(
    () => hasPagination ? orderedRows.slice(pageStartIndex, pageStartIndex + pageSize) : orderedRows,
    [hasPagination, orderedRows, pageSize, pageStartIndex],
  );
  useEffect(() => {
    paginationOnRowCountChange?.(orderedRows.length);
  }, [orderedRows.length, paginationOnRowCountChange]);
  useEffect(() => {
    if (paginationPage == null || !paginationOnPageChange) return;
    if (paginationPage !== currentPage) paginationOnPageChange(currentPage);
  }, [currentPage, paginationOnPageChange, paginationPage]);
  const allRowKeys = useMemo(() => orderedRows.map((row, index) => rowKey(row, index)), [orderedRows, rowKey]);
  const rowItems = useMemo(
    () => paginatedRows.map((row, index) => {
      const globalIndex = pageStartIndex + index;
      return { row, index: globalIndex, key: rowKey(row, globalIndex) };
    }),
    [pageStartIndex, paginatedRows, rowKey],
  );
  const displayRowItems = useMemo(() => {
    if (!draggedRowKey || !dragTarget) return rowItems;
    return reorderRowItems(rowItems, draggedRowKey, dragTarget.key, dragTarget.position);
  }, [dragTarget, draggedRowKey, rowItems]);
  const rowBackgroundClassByKey = useMemo(() => {
    const classByKey = new Map<string, string>();
    if (!rowBackgroundEnabled || !rowBackgroundGroupKey) return classByKey;
    let currentGroupKey = "";
    let groupIndex = -1;
    let rowInGroupIndex = 0;
    for (const { row, index, key } of displayRowItems) {
      const groupKey = String(rowBackgroundGroupKey(row, index) ?? "");
      if (!groupKey) continue;
      if (groupKey !== currentGroupKey) {
        currentGroupKey = groupKey;
        groupIndex += 1;
        rowInGroupIndex = 0;
      }
      classByKey.set(key, groupedRowBackgroundClass(groupIndex, rowInGroupIndex));
      rowInGroupIndex += 1;
    }
    return classByKey;
  }, [displayRowItems, rowBackgroundEnabled, rowBackgroundGroupKey]);

  const shouldVirtualizeRows = displayRowItems.length > ROW_VIRTUALIZATION_THRESHOLD;
  // TanStack Virtual intentionally returns imperative helpers; keep it isolated here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualizeRows ? displayRowItems.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedRowItems = shouldVirtualizeRows
    ? virtualRows.map((virtualRow) => ({
        item: displayRowItems[virtualRow.index],
        displayIndex: virtualRow.index,
        virtualRow,
      })).filter((entry): entry is { item: RowItem<T>; displayIndex: number; virtualRow: (typeof virtualRows)[number] } => !!entry.item)
    : displayRowItems.map((item, displayIndex) => ({ item, displayIndex, virtualRow: null }));
  const selectableRowKeys = useMemo(
    () => selectAllScope === "renderedRows"
      ? displayRowItems.filter(({ row, index }) => rowSelectable?.(row, index) ?? true).map(({ key }) => key)
      : rowSelectable ? rowItems.filter(({ row, index }) => rowSelectable(row, index)).map(({ key }) => key) : allRowKeys,
    [allRowKeys, displayRowItems, rowItems, rowSelectable, selectAllScope],
  );
  const selectableRowKeySet = useMemo(() => new Set(selectableRowKeys), [selectableRowKeys]);
  const selectedSelectableKeys = useMemo(() => {
    if (!selectable || effectiveSelectedKeys.size === 0) return new Set<string>();
    const next = new Set<string>();
    for (const key of selectableRowKeys) {
      if (effectiveSelectedKeys.has(key)) next.add(key);
    }
    return next;
  }, [effectiveSelectedKeys, selectable, selectableRowKeys]);
  const virtualPaddingTop = shouldVirtualizeRows ? virtualRows[0]?.start ?? 0 : 0;
  const virtualPaddingBottom = shouldVirtualizeRows
    ? Math.max(0, rowVirtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0))
    : 0;

  useLayoutEffect(() => {
    if (!scrollToRowKey) {
      scrolledAnchorKeyRef.current = null;
      return;
    }
    // Scroll once per anchor key; later row-data refreshes must not yank the viewport back.
    if (scrolledAnchorKeyRef.current === scrollToRowKey) return;
    const targetIndex = displayRowItems.findIndex((item) => item.key === scrollToRowKey);
    if (targetIndex < 0) return;
    scrolledAnchorKeyRef.current = scrollToRowKey;
    const viewport = viewportRef.current;
    if (shouldVirtualizeRows) {
      rowVirtualizer.scrollToIndex(targetIndex, { align: "center" });
      // Dynamic row measurement can leave the estimate-based scroll off; fine-tune once the row is mounted.
      const frame = window.requestAnimationFrame(() => {
        const target = viewport?.querySelector<HTMLElement>(`[data-advanced-row-key="${CSS.escape(scrollToRowKey)}"]`);
        if (viewport && target) scrollViewportToRowCenter(viewport, target);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const target = viewport?.querySelector<HTMLElement>(`[data-advanced-row-key="${CSS.escape(scrollToRowKey)}"]`);
    if (viewport && target) scrollViewportToRowCenter(viewport, target);
  }, [displayRowItems, rowVirtualizer, scrollToRowKey, shouldVirtualizeRows]);

  const layout = useMemo(() => {
    const controlWidth = selectable ? (draggableRows ? 58 : 38) : (draggableRows ? 30 : 0);
    const baseWidths = visibleColumns.map((column) => {
      const saved = columnWidths[column.key];
      const defaultMinWidth = column.minWidth ?? 52;
      const resizeMinWidth = column.resizeMinWidth ?? 52;
      const hasSavedWidth = Number.isFinite(saved);
      const preferredWidth = hasSavedWidth
        ? Math.max(resizeMinWidth, saved)
        : Math.max(defaultMinWidth, column.width);
      const minWidth = hasSavedWidth && saved < defaultMinWidth
        ? Math.max(resizeMinWidth, saved)
        : defaultMinWidth;
      return { key: column.key, minWidth, resizeMinWidth, preferredWidth } as const;
    });
    const minColumnsTotal = baseWidths.reduce((sum, column) => sum + column.minWidth, 0);
    const basePreferredColumnsTotal = baseWidths.reduce((sum, column) => sum + column.preferredWidth, 0);
    const basePreferredTotal = controlWidth + basePreferredColumnsTotal;
    const preferredTotal = Math.max(minTableWidth ?? 0, basePreferredTotal);
    const preferredScale =
      basePreferredColumnsTotal > 0 && preferredTotal > basePreferredTotal
        ? Math.max(0, preferredTotal - controlWidth) / basePreferredColumnsTotal
        : 1;
    const preferredWidths = baseWidths.map((column) => ({
      ...column,
      preferredWidth: Math.max(column.minWidth, column.preferredWidth * preferredScale),
    }));
    const preferredColumnsTotal = preferredWidths.reduce((sum, column) => sum + column.preferredWidth, 0);
    const minTotal = controlWidth + minColumnsTotal;
    const availableWidth = viewportWidth || preferredTotal;
    const hasManualWidths = Object.keys(columnWidths).length > 0;

    if (resizeSession) {
      const resizingColumn = baseWidths.find((column) => column.key === resizeSession.key);
      if (resizingColumn) {
        const targetWidth = Math.max(resizingColumn.resizeMinWidth, resizeSession.width);
        const otherColumns = baseWidths.filter((column) => column.key !== resizeSession.key);
        const otherBaseTotal = otherColumns.reduce(
          (sum, column) => sum + (resizeSession.baseWidths[column.key] ?? column.preferredWidth),
          0,
        );
        const availableColumnWidth = Math.max(0, availableWidth - controlWidth, (minTableWidth ?? 0) - controlWidth);
        const targetTotal = targetWidth + otherBaseTotal;
        const extraWidth = Math.max(0, availableColumnWidth - targetTotal);
        const otherScale = otherBaseTotal > 0 ? (otherBaseTotal + extraWidth) / otherBaseTotal : 1;
        const colWidths = Object.fromEntries(baseWidths.map((column) => {
          if (column.key === resizeSession.key) return [column.key, targetWidth];
          const baseWidth = resizeSession.baseWidths[column.key] ?? column.preferredWidth;
          return [column.key, baseWidth * otherScale];
        }));
        const resizedColumnsTotal = Object.values(colWidths).reduce((sum, width) => sum + width, 0);
        return {
          tableWidth: controlWidth + resizedColumnsTotal,
          controlWidth,
          colWidths,
        };
      }
    }

    if (!hasManualWidths && availableWidth >= controlWidth + preferredColumnsTotal) {
      const availableColumnWidth = Math.max(0, availableWidth - controlWidth);
      const growScale = preferredColumnsTotal > 0 ? availableColumnWidth / preferredColumnsTotal : 1;
      return {
        tableWidth: availableWidth,
        controlWidth,
        colWidths: Object.fromEntries(
          preferredWidths.map((column) => [column.key, column.preferredWidth * growScale]),
        ),
      };
    }

    if (hasManualWidths && availableWidth >= controlWidth + preferredColumnsTotal) {
      const availableColumnWidth = Math.max(0, availableWidth - controlWidth);
      const growScale = preferredColumnsTotal > 0 ? availableColumnWidth / preferredColumnsTotal : 1;
      return {
        tableWidth: availableWidth,
        controlWidth,
        colWidths: Object.fromEntries(
          preferredWidths.map((column) => [column.key, column.preferredWidth * growScale]),
        ),
      };
    }

    if (!hasManualWidths && availableWidth >= minTotal) {
      const availableColumnWidth = Math.max(0, availableWidth - controlWidth);
      const shrinkNeeded = Math.max(0, preferredColumnsTotal - availableColumnWidth);
      const shrinkCapacity = preferredWidths.reduce(
        (sum, column) => sum + Math.max(0, column.preferredWidth - column.minWidth),
        0,
      );
      return {
        tableWidth: availableWidth,
        controlWidth,
        colWidths: Object.fromEntries(
          preferredWidths.map((column) => {
            if (shrinkCapacity <= 0) return [column.key, column.minWidth];
            const capacity = Math.max(0, column.preferredWidth - column.minWidth);
            return [column.key, column.preferredWidth - shrinkNeeded * (capacity / shrinkCapacity)];
          }),
        ),
      };
    }

    return {
      tableWidth: Math.max(minTableWidth ?? 0, controlWidth + basePreferredColumnsTotal),
      controlWidth,
      colWidths: Object.fromEntries(baseWidths.map((column) => [column.key, column.preferredWidth])),
    };
  }, [columnWidths, draggableRows, minTableWidth, resizeSession, selectable, viewportWidth, visibleColumns]);

  const setSelection = useCallback((next: Set<string>) => {
    if (onSelectionChange) onSelectionChange(next);
    else setInternalSelectedKeys(next);
  }, [onSelectionChange]);

  useLayoutEffect(() => {
    if (!selectable || effectiveSelectedKeys.size === 0) return;
    let needsPrune = false;
    for (const key of effectiveSelectedKeys) {
      if (!selectableRowKeySet.has(key)) {
        needsPrune = true;
        break;
      }
    }
    if (!needsPrune) return;
    const next = new Set<string>();
    for (const key of effectiveSelectedKeys) {
      if (selectableRowKeySet.has(key)) next.add(key);
    }
    setSelection(next);
  }, [effectiveSelectedKeys, selectable, selectableRowKeySet, setSelection]);

  const setColumnWidth = useCallback((key: string, width: number, minWidth: number) => {
    setColumnWidths((prev) => {
      const next = { ...prev, [key]: Math.max(minWidth, Math.round(width)) };
      writeJson(`${storageKey}:widths`, next);
      return next;
    });
  }, [storageKey]);

  const beginResize = useCallback((event: ReactMouseEvent, column: AdvancedDataTableColumn<T>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    const minWidth = column.resizeMinWidth ?? 52;
    const startX = event.clientX;
    const startWidth = layout.colWidths[column.key] ?? columnWidths[column.key] ?? column.width;
    setResizeSession({ key: column.key, width: startWidth, baseWidths: layout.colWidths });
    const updateResizeGuide = (clientX: number) => {
      const viewportRect = viewportRef.current?.getBoundingClientRect();
      if (!viewportRect) return;
      setResizeGuide({ x: clientX, top: viewportRect.top, height: viewportRect.height });
    };
    const onMove = (moveEvent: MouseEvent) => {
      updateResizeGuide(moveEvent.clientX);
      const width = Math.max(minWidth, startWidth + moveEvent.clientX - startX);
      setResizeSession((current) => current ? { ...current, width } : current);
      setColumnWidth(column.key, width, minWidth);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      resizeCleanupRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizeGuide(null);
      setResizeSession(null);
    };
    updateResizeGuide(startX);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
    resizeCleanupRef.current = onUp;
  }, [columnWidths, layout.colWidths, setColumnWidth]);

  function toggleColumn(key: string) {
    const column = tableColumns.find((item) => item.key === key);
    if (!column?.hideable) return;
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeJson(hiddenStorageKey, Array.from(next));
      return next;
    });
  }

  function toggleAllRows(checked: boolean) {
    setSelection(checked ? new Set(selectableRowKeys) : new Set());
  }

  function toggleRow(key: string, checked: boolean) {
    const next = new Set(selectedSelectableKeys);
    if (checked) next.add(key);
    else next.delete(key);
    setSelection(next);
  }

  function toggleSort(key: string) {
    setSortState((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }

  function handleHeaderSortClick(event: ReactMouseEvent<HTMLElement>, key: string, canOpenFilter: boolean) {
    if (!canOpenFilter) {
      toggleSort(key);
      return;
    }
    if (event.detail > 1) {
      clearPendingHeaderSortClick();
      if (sortState?.key === key && sortState.direction === "desc") {
        toggleSort(key);
      }
      return;
    }
    clearPendingHeaderSortClick();
    headerSortClickTimerRef.current = window.setTimeout(() => {
      headerSortClickTimerRef.current = null;
      toggleSort(key);
    }, HEADER_SORT_CLICK_DELAY_MS);
  }

  function handleHeaderLabelDoubleClick(event: ReactMouseEvent<HTMLElement>, key: string, canOpenFilter: boolean) {
    if (!canOpenFilter) return;
    event.preventDefault();
    event.stopPropagation();
    clearPendingHeaderSortClick();
    setActiveFilterColumn(key);
  }

  function handleRowDragStart(event: ReactDragEvent<HTMLElement>, key: string, dragDisabled: boolean) {
    const fromHandle = event.target instanceof Element && !!event.target.closest("[data-row-drag-handle]");
    if (!draggableRows || dragDisabled || !fromHandle) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
    dragCancelledRef.current = false;
    setDraggedRowKey(key);
    suppressNextClickRef.current = true;
  }

  function getDropPosition(event: ReactDragEvent<HTMLTableRowElement>): AdvancedDataTableDropPosition {
    return getDropPositionFromClientY(event.currentTarget, event.clientY);
  }

  const canDropOnRow = useCallback((targetRow: T, targetIndex: number, targetKey: string, dragDisabled: boolean, position: AdvancedDataTableDropPosition) => {
    if (!draggableRows || dragDisabled || !draggedRowKey || draggedRowKey === targetKey) return false;
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === draggedRowKey);
    if (sourceIndex < 0) return false;
    return rowDropAllowed?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, position) ?? true;
  }, [draggableRows, draggedRowKey, orderedRows, rowDropAllowed, rowKey]);

  function handleRowDragOver(event: ReactDragEvent<HTMLTableRowElement>, row: T, index: number, key: string, dragDisabled: boolean) {
    const position = getDropPosition(event);
    if (!canDropOnRow(row, index, key, dragDisabled, position)) {
      if (key === draggedRowKey && dragTarget) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragTarget({ key, position });
  }

  const getRowItemByKey = useCallback((key: string) => {
    const targetIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === key);
    const targetRow = targetIndex >= 0 ? orderedRows[targetIndex] : undefined;
    return targetRow ? { row: targetRow, index: targetIndex, key } : null;
  }, [orderedRows, rowKey]);

  const getGlobalDragTarget = useCallback((clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;

    const element = document.elementFromPoint(clientX, clientY);
    const rowElementFromPoint = element instanceof Element
      ? element.closest<HTMLElement>("[data-advanced-row-key]")
      : null;
    if (rowElementFromPoint && viewport.contains(rowElementFromPoint)) {
      const key = rowElementFromPoint.dataset.advancedRowKey;
      const item = key ? getRowItemByKey(key) : null;
      return item
        ? { ...item, position: getDropPositionFromClientY(rowElementFromPoint, clientY) }
        : null;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const rowElements = Array.from(viewport.querySelectorAll<HTMLElement>("[data-advanced-row-key]"));
    if (rowElements.length === 0) return null;

    const visibleRowElements = rowElements
      .map((rowElement) => ({ rowElement, rect: rowElement.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom);
    if (visibleRowElements.length === 0) return null;

    const edgeTarget = clientY < viewportRect.top
      ? { rowElement: visibleRowElements[0].rowElement, position: "before" as const }
      : clientY > viewportRect.bottom
        ? { rowElement: visibleRowElements[visibleRowElements.length - 1].rowElement, position: "after" as const }
        : null;
    if (edgeTarget) {
      const key = edgeTarget.rowElement.dataset.advancedRowKey;
      const item = key ? getRowItemByKey(key) : null;
      return item ? { ...item, position: edgeTarget.position } : null;
    }

    const nearest = visibleRowElements.reduce((best, candidate) => {
      const bestDistance = Math.abs(clientY - (best.rect.top + best.rect.height / 2));
      const candidateDistance = Math.abs(clientY - (candidate.rect.top + candidate.rect.height / 2));
      return candidateDistance < bestDistance ? candidate : best;
    });
    const key = nearest.rowElement.dataset.advancedRowKey;
    const item = key ? getRowItemByKey(key) : null;
    return item
      ? { ...item, position: getDropPositionFromClientY(nearest.rowElement, clientY) }
      : null;
  }, [getRowItemByKey]);

  const getAllowedGlobalDragTarget = useCallback((clientX: number, clientY: number) => {
    if (!draggedRowKey) return null;
    const target = getGlobalDragTarget(clientX, clientY);
    if (target) {
      const dragDisabled = (sortable && sortState != null) || (rowDragDisabled?.(target.row, target.index) ?? false);
      if (canDropOnRow(target.row, target.index, target.key, dragDisabled, target.position)) return target;
    }
    if (!rowDropTargetAtEnd) return null;
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === draggedRowKey);
    if (sourceIndex < 0) return null;
    const tailTarget = rowDropTargetAtEnd(orderedRows[sourceIndex], sourceIndex, orderedRows);
    if (!tailTarget || tailTarget.index < 0 || tailTarget.index >= orderedRows.length) return null;
    const tailKey = rowKey(tailTarget.row, tailTarget.index);
    if (tailKey === draggedRowKey) return null;
    const tailElement = Array.from(
      viewportRef.current?.querySelectorAll<HTMLElement>("[data-advanced-row-key]") ?? [],
    ).find((element) => element.dataset.advancedRowKey === tailKey);
    if (!tailElement || clientY < tailElement.getBoundingClientRect().bottom) return null;
    const dragDisabled = (sortable && sortState != null) || (rowDragDisabled?.(tailTarget.row, tailTarget.index) ?? false);
    if (!canDropOnRow(tailTarget.row, tailTarget.index, tailKey, dragDisabled, "after")) return null;
    return { ...tailTarget, key: tailKey, position: "after" as const };
  }, [canDropOnRow, draggedRowKey, getGlobalDragTarget, orderedRows, rowDropTargetAtEnd, rowDragDisabled, rowKey, sortState, sortable]);

  const updateGlobalDragTarget = useCallback((clientX: number, clientY: number) => {
    const target = getAllowedGlobalDragTarget(clientX, clientY);
    if (!target) return false;
    setDragTarget({ key: target.key, position: target.position });
    return true;
  }, [getAllowedGlobalDragTarget]);

  const handleRowDragEnd = useCallback(() => {
    setDraggedRowKey(null);
    setDragTarget(null);
    window.setTimeout(() => {
      suppressNextClickRef.current = false;
    }, 0);
  }, []);

  const cancelRowDrag = useCallback(() => {
    dragCancelledRef.current = true;
    handleRowDragEnd();
  }, [handleRowDragEnd]);

  function hasActiveTextSelection() {
    if (typeof window === "undefined") return false;
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
  }

  const dropOnPreviewTarget = useCallback((sourceKey: string) => {
    if (!dragTarget) return false;
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === sourceKey);
    const targetIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === dragTarget.key);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;
    const targetRow = orderedRows[targetIndex];
    const targetDragDisabled = rowDragDisabled?.(targetRow, targetIndex) ?? false;
    if (targetDragDisabled) return false;
    if (!(rowDropAllowed?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, dragTarget.position) ?? true)) return false;
    void onRowReorder?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, dragTarget.position);
    return true;
  }, [dragTarget, onRowReorder, orderedRows, rowDropAllowed, rowDragDisabled, rowKey]);

  const dropOnResolvedTarget = useCallback((
    sourceKey: string,
    target: RowItem<T> & { position: AdvancedDataTableDropPosition },
  ) => {
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === sourceKey);
    if (sourceIndex < 0 || sourceIndex === target.index) return false;
    const sourceRow = orderedRows[sourceIndex];
    const targetDragDisabled = (sortable && sortState != null) || (rowDragDisabled?.(target.row, target.index) ?? false);
    if (targetDragDisabled) return false;
    if (!(rowDropAllowed?.(sourceRow, target.row, sourceIndex, target.index, target.position) ?? true)) return false;
    void onRowReorder?.(sourceRow, target.row, sourceIndex, target.index, target.position);
    return true;
  }, [onRowReorder, orderedRows, rowDropAllowed, rowDragDisabled, rowKey, sortState, sortable]);

  function handleRowDrop(event: ReactDragEvent<HTMLTableRowElement>, targetRow: T, targetIndex: number, targetKey: string, dragDisabled: boolean) {
    if (!draggableRows || dragDisabled) return;
    const sourceKey = draggedRowKey ?? event.dataTransfer.getData("text/plain");
    if (!sourceKey) return;
    if (sourceKey === targetKey) {
      if (!dragTarget) return;
    } else if (!canDropOnRow(targetRow, targetIndex, targetKey, dragDisabled, getDropPosition(event))) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = getDropPosition(event);
    dropOnRowAtPosition(event, sourceKey, targetRow, targetIndex, targetKey, dragDisabled, position);
  }

  function dropOnRowAtPosition(
    event: ReactDragEvent<HTMLTableRowElement>,
    sourceKey: string,
    targetRow: T,
    targetIndex: number,
    targetKey: string,
    dragDisabled: boolean,
    position: AdvancedDataTableDropPosition,
  ) {
    if (dragDisabled || !sourceKey) return;
    if (sourceKey === targetKey) {
      dropOnPreviewTarget(sourceKey);
      handleRowDragEnd();
      return;
    }
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === sourceKey);
    if (sourceIndex < 0) return;
    if (!(rowDropAllowed?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, position) ?? true)) return;
    handleRowDragEnd();
    void onRowReorder?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, position);
  }

  useEffect(() => {
    if (!draggableRows || !draggedRowKey) return;

    const handleGlobalDragOver = (event: DragEvent) => {
      const viewport = viewportRef.current;
      if (viewport && event.clientX < viewport.getBoundingClientRect().left) {
        event.preventDefault();
        cancelRowDrag();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      updateGlobalDragTarget(event.clientX, event.clientY);
    };
    const handleGlobalDrop = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (dragCancelledRef.current || event.dataTransfer?.dropEffect !== "move") {
        handleRowDragEnd();
        return;
      }
      const sourceKey = draggedRowKey;
      const target = getAllowedGlobalDragTarget(event.clientX, event.clientY);
      if (target) {
        dropOnResolvedTarget(sourceKey, target);
      } else {
        dropOnPreviewTarget(sourceKey);
      }
      handleRowDragEnd();
    };
    const handleGlobalDragEnd = () => {
      handleRowDragEnd();
    };
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelRowDrag();
    };

    window.addEventListener("dragover", handleGlobalDragOver);
    window.addEventListener("drop", handleGlobalDrop);
    window.addEventListener("dragend", handleGlobalDragEnd);
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("dragover", handleGlobalDragOver);
      window.removeEventListener("drop", handleGlobalDrop);
      window.removeEventListener("dragend", handleGlobalDragEnd);
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [cancelRowDrag, draggableRows, draggedRowKey, dropOnPreviewTarget, dropOnResolvedTarget, getAllowedGlobalDragTarget, handleRowDragEnd, updateGlobalDragTarget]);

  const selectedCount = selectedSelectableKeys.size;
  const selectedSelectableCount = selectedSelectableKeys.size;
  const allSelected = selectableRowKeys.length > 0 && selectedSelectableCount === selectableRowKeys.length;
  const partiallySelected = selectedSelectableCount > 0 && selectedSelectableCount < selectableRowKeys.length;
  const hasAnyFilters = showFilters && Object.values(filters).some((values) => (values?.length ?? 0) > 0);
  const clearFilters = () => {
    setFilters({});
    setActiveFilterColumn(null);
  };
  const clearSelection = () => setSelection(new Set());
  const columnVisibilityMenuContent = (
    <>
      <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">{t("table.visibleColumns")}</div>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {tableColumns.filter((column) => column.key !== "__row_actions").map((column) => (
          <label key={column.key} className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${column.hideable ? "cursor-pointer text-slate-700 hover:bg-slate-50" : "text-slate-400"}`}>
            <input type="checkbox" checked={!hiddenKeys.has(column.key)} disabled={!column.hideable} onChange={() => toggleColumn(column.key)} className="h-3.5 w-3.5 rounded border-slate-300" />
            <span className="truncate">{column.label}</span>
          </label>
        ))}
      </div>
    </>
  );
  const tableStateControls = (
    <>
      {selectedCount > 0 ? (
        <button
          type="button"
          onClick={clearSelection}
          className="text-xs text-blue-600 hover:text-blue-700"
        >
          {t("table.clearSelection")}
        </button>
      ) : null}
      {hasAnyFilters ? <span>{filteredRows.length}/{rows.length}</span> : null}
      {hasAnyFilters ? (
        <button
          type="button"
          onClick={clearFilters}
          className="text-xs text-blue-600 hover:text-blue-700"
        >
          {t("table.clearFilters")}
        </button>
      ) : null}
    </>
  );
  const headerPaddingClass = compactRows ? "px-3 py-1" : HEADER_PADDING_CLASS[rowHeightMode];
  const cellPaddingClass = "px-3";
  const selectPaddingClass = "px-2";
  const bodyTextClass = compactRows ? "text-xs" : BODY_TEXT_CLASS[rowHeightMode];
  const bodyColSpan = ((selectable || draggableRows) ? 1 : 0) + visibleColumns.length || 1;
  const showToolbar =
    toolbarMode !== "none" &&
    (
      toolbarMode === "default" ||
      !!toolbarLeftContent ||
      !!toolbarRightContent ||
      showColumnVisibilityButton
    );
  const hasHorizontalScroll =
    needsHorizontalScroll ||
    (viewportWidth > 0 && layout.tableWidth > viewportWidth + HORIZONTAL_SCROLL_TOLERANCE_PX);

  return (
    <div
      className={fillHeight ? "flex h-full min-h-0 flex-col" : "min-h-0"}
    >
      {showToolbar ? (
        <div
          data-batch-popover-boundary
          data-advanced-table-toolbar
          className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 bg-white px-3 py-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-slate-500">
            {toolbarMode === "custom" ? (
              <>
                {toolbarLeftContent}
                <span
                  aria-live="polite"
                  className={`whitespace-nowrap text-[11px] font-medium text-blue-700 transition-opacity ${draggedRowKey ? "opacity-100" : "pointer-events-none w-0 overflow-hidden opacity-0"}`}
                >
                  {t("advancedTable.cancelDragHint")}
                </span>
                {showTableStateInCustomToolbar ? tableStateControls : null}
              </>
            ) : (
              <>
                {toolbarLeftContent}
                {selectedCount > 0 ? batchActionSlot : null}
                {selectable && selectedCount > 0 ? <span className="font-medium text-slate-600">{tf("table.selectedCount", { count: selectedCount })}</span> : null}
                {selectedCount > 0 ? batchActions.map((action) => {
                  const icon = inferBatchActionIcon(action);
                  const title = action.title ?? action.label;
                  return (
                    <button
                      key={action.label}
                      type="button"
                      onClick={action.onClick}
                      disabled={action.disabled}
                      className={
                        icon
                          ? `flex h-6 w-6 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${batchActionToneClass(action.tone ?? "primary")}`
                          : "secondary-button h-7 px-2 text-xs"
                      }
                      title={title}
                      aria-label={action.ariaLabel ?? title}
                    >
                      {icon ?? action.label}
                    </button>
                  );
                }) : null}
                {tableStateControls}
                {toolbarTitle ? <span className="font-semibold text-slate-700">{toolbarTitle}</span> : null}
                <span
                  aria-live="polite"
                  className={`whitespace-nowrap text-[11px] font-medium text-blue-700 transition-opacity ${draggedRowKey ? "opacity-100" : "pointer-events-none w-0 overflow-hidden opacity-0"}`}
                >
                  {t("advancedTable.cancelDragHint")}
                </span>
              </>
            )}
          </div>
          <div data-advanced-table-toolbar-actions className="flex shrink-0 items-center gap-2">
            {toolbarRightContent}
            {showColumnVisibilityButton ? (
              <div ref={columnMenuRef} className="relative">
                <button
                  type="button"
                  data-advanced-table-column-settings
                  onClick={() => {
                    setExternalColumnMenuAnchor(null);
                    setMenuOpen((open) => !open);
                  }}
                  className="secondary-button h-7 px-2 text-xs"
                  title={t("table.columnSettings")}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
                {menuOpen && !externalColumnMenuAnchor ? (
                  <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
                    {columnVisibilityMenuContent}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {menuOpen && externalColumnMenuAnchor ? (
        <div
          ref={columnMenuRef}
          className="fixed z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft"
          style={{ top: externalColumnMenuAnchor.top, right: externalColumnMenuAnchor.right }}
        >
          {columnVisibilityMenuContent}
        </div>
      ) : null}

      <div
        ref={viewportRef}
        className={
          fillHeight
            ? `advanced-table-viewport custom-scrollbar ${hasHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden"} min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]`
            : `advanced-table-viewport custom-scrollbar ${hasHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden"} overflow-y-scroll [scrollbar-gutter:stable]`
        }
      >
        <table className="table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200" style={{ width: layout.tableWidth }}>
          <colgroup>
            {(selectable || draggableRows) ? <col style={{ width: layout.controlWidth }} /> : null}
            {visibleColumns.map((column) => <col key={column.key} style={{ width: layout.colWidths[column.key] ?? column.width }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-white">
            <tr data-advanced-table-header-row>
              {(selectable || draggableRows) ? (
                <th className={`border-b border-slate-200 text-center ${selectPaddingClass}`}>
                  {selectable ? (
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(input) => {
                        if (input) input.indeterminate = partiallySelected;
                      }}
                      onChange={(event) => toggleAllRows(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                      aria-label={t("table.selectAll")}
                    />
                  ) : null}
                </th>
              ) : null}
              {visibleColumns.map((column) => (
                <th key={column.key} data-advanced-table-header-cell={column.key} className={["relative select-none border-b border-slate-200 text-center text-xs font-semibold text-slate-600", headerPaddingClass, column.headerClassName ?? ""].join(" ")}>
                  <div className="flex min-w-0 items-center justify-center gap-1">
                    {(column.sortValue || column.filterText) && sortable ? (
                      <span
                        className={`block min-w-0 truncate cursor-pointer select-none text-xs font-semibold transition-transform duration-200 ${sortState?.key === column.key || (filters[column.key]?.length ?? 0) > 0 ? "text-blue-600" : "text-slate-600"} ${sortState?.key === column.key && sortState.direction === "desc" ? "rotate-180" : ""}`}
                        onClick={(event) => handleHeaderSortClick(event, column.key, showFilters && !!column.filterText)}
                        onDoubleClick={(event) => handleHeaderLabelDoubleClick(event, column.key, showFilters && !!column.filterText)}
                        title={showFilters && column.filterText ? (sortState?.key === column.key ? (sortState.direction === "asc" ? t("advancedTable.sortAscDesc") : t("advancedTable.sortDescCancel")) : t("advancedTable.sortClickFilter")) : (sortState?.key === column.key ? (sortState.direction === "asc" ? t("advancedTable.sortAsc") : t("advancedTable.sortDesc")) : t("advancedTable.sortClick"))}
                      >
                        {labelText(column.label, column.key)}
                      </span>
                    ) : (
                      <span
                        className={`block min-w-0 truncate text-xs font-semibold ${((filters[column.key]?.length ?? 0) > 0) ? "text-blue-600" : "text-slate-600"} ${showFilters && column.filterText ? "cursor-pointer hover:text-blue-600" : ""}`}
                        onDoubleClick={(event) => handleHeaderLabelDoubleClick(event, column.key, showFilters && !!column.filterText)}
                        title={showFilters && column.filterText ? t("advancedTable.doubleClickFilter", { label: labelText(column.label, column.key) }) : labelText(column.label, column.key)}
                      >
                        {labelText(column.label, column.key)}
                      </span>
                    )}
                    {showFilters && column.filterText ? (
                      column.filterKind === "dateRange" ? (
                        <DateRangeColumnFilter
                          label={labelText(column.label, column.key)}
                          from={filters[column.key]?.[0] ?? ""}
                          to={filters[column.key]?.[1] ?? ""}
                          open={activeFilterColumn === column.key}
                          labelClassName="hidden"
                          showTrigger={false}
                          onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                          onClose={() => setActiveFilterColumn(null)}
                          onChange={({ from, to }) =>
                            setFilters((prev) => {
                              if (!from && !to) {
                                const next = { ...prev };
                                delete next[column.key];
                                return next;
                              }
                              return { ...prev, [column.key]: [from, to] };
                            })
                          }
                        />
                      ) : column.filterKind === "numberRange" ? (
                        <NumberRangeColumnFilter
                          label={labelText(column.label, column.key)}
                          from={filters[column.key]?.[0] ?? ""}
                          to={filters[column.key]?.[1] ?? ""}
                          open={activeFilterColumn === column.key}
                          labelClassName="hidden"
                          showTrigger={false}
                          onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                          onClose={() => setActiveFilterColumn(null)}
                          onChange={({ from, to }) =>
                            setFilters((prev) => {
                              if (!from && !to) {
                                const next = { ...prev };
                                delete next[column.key];
                                return next;
                              }
                              return { ...prev, [column.key]: [from, to] };
                            })
                          }
                        />
                      ) : column.filterKind === "text" ? (
                        <TextColumnFilter
                          label={labelText(column.label, column.key)}
                          value={filters[column.key]?.[0] ?? ""}
                          open={activeFilterColumn === column.key}
                          labelClassName="hidden"
                          showTrigger={false}
                          onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                          onClose={() => setActiveFilterColumn(null)}
                          onChange={(value) =>
                            setFilters((prev) => {
                              if (!value) {
                                const next = { ...prev };
                                delete next[column.key];
                                return next;
                              }
                              return { ...prev, [column.key]: [value] };
                            })
                          }
                        />
                      ) : (
                        <TableColumnFilter
                          label={labelText(column.label, column.key)}
                          options={activeFilterMeta.columnKey === column.key ? activeFilterMeta.options : []}
                          optionCounts={activeFilterMeta.columnKey === column.key ? activeFilterMeta.counts : undefined}
                          optionTitles={activeFilterMeta.columnKey === column.key ? activeFilterMeta.titles : undefined}
                          optionSearchText={activeFilterMeta.columnKey === column.key ? activeFilterMeta.searchText : undefined}
                          selectedValues={filters[column.key] ?? []}
                          open={activeFilterColumn === column.key}
                          showLabel={false}
                          showTrigger={false}
                          onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                          onClose={() => setActiveFilterColumn(null)}
                          onChange={(values) =>
                            setFilters((prev) => {
                              if (!values || values.length === 0) {
                                const next = { ...prev };
                                delete next[column.key];
                                return next;
                              }
                              return { ...prev, [column.key]: values };
                            })
                          }
                        />
                      )
                    ) : null}
                  </div>
                  <div
                    aria-hidden="true"
                    data-advanced-table-resize-handle={column.key}
                    className="absolute right-[-3px] top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-blue-300/40"
                    onMouseDown={(event) => beginResize(event, column)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={bodyTextClass}>
            {shouldVirtualizeRows && virtualPaddingTop > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={bodyColSpan} style={{ height: virtualPaddingTop, padding: 0, border: 0 }} />
              </tr>
            ) : null}
            {displayRowItems.length > 0 ? renderedRowItems.map(({ item: { row, index, key }, displayIndex, virtualRow }) => {
              const isSelected = effectiveSelectedKeys.has(key);
              const hasSelectedPreviousRow = displayIndex > 0
                && effectiveSelectedKeys.has(displayRowItems[displayIndex - 1]?.key ?? "");
              const hasSelectedNextRow = displayIndex < displayRowItems.length - 1
                && effectiveSelectedKeys.has(displayRowItems[displayIndex + 1]?.key ?? "");
              const isSelectableRow = selectable && (rowSelectable?.(row, index) ?? true);
              const dragDisabled = (sortable && sortState != null) || (rowDragDisabled?.(row, index) ?? false);
              const isDragging = draggedRowKey != null;
              const isDraggedRow = draggedRowKey === key;
              const isAllowedDropTarget = dragTarget
                ? canDropOnRow(row, index, key, dragDisabled, dragTarget.position)
                : false;
              const isBlockedDropTarget = isDragging && !isDraggedRow && !isAllowedDropTarget;
              const toggleCurrentRow = () => {
                if (!isSelectableRow || !selectOnRowClick) return;
                toggleRow(key, !isSelected);
              };
              const rowBackgroundClass = rowBackgroundClassByKey.get(key);
              const baseRowClassName = rowClassName?.(row, displayIndex) ?? (rowBackgroundClass ? "" : "hover:bg-slate-50");
              const selectionShadow = isSelected
                ? [
                    "inset 4px 0 0 #2563eb",
                    "inset -1px 0 0 #60a5fa",
                    hasSelectedPreviousRow ? "" : "inset 0 1px 0 #2563eb",
                    hasSelectedNextRow ? "" : "inset 0 -1px 0 #2563eb",
                  ].filter(Boolean).join(", ")
                : undefined;
              const selectionEndCellStyle = isSelected && !hasSelectedNextRow
                ? { borderBottom: "2px solid #2563eb" }
                : undefined;
              return (
                <tr
                  key={key}
                  data-index={virtualRow?.index}
                  data-advanced-row-key={key}
                  data-advanced-table-body-row
                  ref={shouldVirtualizeRows ? rowVirtualizer.measureElement : undefined}
                  onClick={() => {
                    if (suppressNextClickRef.current) {
                      suppressNextClickRef.current = false;
                      return;
                    }
                    if (hasActiveTextSelection()) return;
                    toggleCurrentRow();
                    onRowClick?.(row, displayIndex);
                  }}
                  onDoubleClick={onRowDoubleClick ? (event) => {
                    if (isInteractiveRowTarget(event.target)) return;
                    onRowDoubleClick(row, displayIndex);
                  } : undefined}
                  onDragOver={(event) => handleRowDragOver(event, row, index, key, dragDisabled)}
                  onDrop={(event) => handleRowDrop(event, row, index, key, dragDisabled)}
                  className={[
                    rowBackgroundClass,
                    baseRowClassName,
                    isSelectableRow && selectOnRowClick ? "cursor-pointer" : "",
                    isBlockedDropTarget ? "cursor-not-allowed" : "",
                    isDraggedRow ? "relative z-10 bg-blue-50/80 outline outline-2 outline-blue-500 outline-offset-[-2px] shadow-[inset_0_0_0_1px_#2563eb]" : "",
                    isSelected
                      ? "relative z-[1] bg-blue-50/75 hover:bg-blue-100/80"
                      : "",
                  ].filter(Boolean).join(" ")}
                  style={{ height: rowHeight, ...(selectionShadow ? { boxShadow: selectionShadow } : {}) }}
                >
                  {(selectable || draggableRows) ? (
                    <td
                      data-advanced-table-row-controls
                      className={`border-b border-slate-100 text-center ${selectPaddingClass}`}
                      style={{ ...rowCellPaddingStyle, ...selectionEndCellStyle }}
                    >
                      <div className="flex items-center justify-center gap-1">
                        {draggableRows ? (
                          <button
                            type="button"
                            draggable={!dragDisabled}
                            data-row-drag-handle
                            onClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => handleRowDragStart(event, key, dragDisabled)}
                            onDragEnd={handleRowDragEnd}
                            className={`flex h-5 w-4 items-center justify-center rounded text-slate-300 transition hover:bg-slate-100 hover:text-slate-500 ${dragDisabled ? "cursor-not-allowed opacity-30" : "cursor-grab active:cursor-grabbing"}`}
                            title={t("advancedTable.dragSort")}
                            aria-label={t("advancedTable.dragSort")}
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                        {selectable ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={!isSelectableRow}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              if (isSelectableRow) toggleRow(key, event.target.checked);
                            }}
                            className="h-3.5 w-3.5 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={t("table.selectRow")}
                          />
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                  {visibleColumns.map((column) => {
                    const cellContent = column.render(row, displayIndex);
                    const titleText = column.cellTitle?.(row) ?? column.filterText?.(row) ?? null;
                    const wrappedContent = column.truncate ? (
                      <div className="min-w-0 truncate" title={titleText ?? undefined}>
                        {cellContent}
                      </div>
                    ) : cellContent;
                    return (
                      <td
                        key={column.key}
                        className={["select-text border-b border-slate-100", bodyTextClass, cellPaddingClass, alignClass(column.align), column.className ?? ""].join(" ")}
                        style={{ ...rowCellPaddingStyle, ...selectionEndCellStyle }}
                      >
                        {wrappedContent}
                      </td>
                  );
                })}
                </tr>
              );
            }) : (
              <tr>
                <td className={`px-4 py-8 text-center text-slate-400 ${bodyTextClass}`} colSpan={bodyColSpan}>
                  {emptyText == null ? t("table.empty") : emptyText}
                </td>
              </tr>
            )}
            {shouldVirtualizeRows && virtualPaddingBottom > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={bodyColSpan} style={{ height: virtualPaddingBottom, padding: 0, border: 0 }} />
              </tr>
            ) : null}
          </tbody>
          {summaryRow ? (
            <tfoot className="sticky bottom-0 z-[1] bg-slate-50/95 backdrop-blur-sm">
              <tr className={summaryRow.rowClassName ?? ""}>
                {(selectable || draggableRows) ? (
                  <td className={`border-t border-slate-200 text-center ${selectPaddingClass} ${summaryRow.cellClassName ?? ""}`}>
                    {summaryRow.selectCell ?? null}
                  </td>
                ) : null}
                {visibleColumns.map((column) => (
                  <td
                    key={column.key}
                    className={[
                      "border-t border-slate-200 font-medium text-slate-700",
                      bodyTextClass,
                      cellPaddingClass,
                      alignClass(column.align),
                      summaryRow.cellClassName ?? "",
                    ].join(" ")}
                  >
                    {summaryRow.cells[column.key] ?? null}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {resizeGuide ? (
        <div
          aria-hidden="true"
          data-advanced-table-resize-guide
          className="pointer-events-none fixed z-50 w-px bg-blue-500"
          style={{ left: resizeGuide.x, top: resizeGuide.top, height: resizeGuide.height }}
        />
      ) : null}
    </div>
  );
}
