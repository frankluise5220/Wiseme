"use client";

import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import type { LoanTypeValue } from "@/lib/loan-type";

type EntryKind =
  | "transaction"
  | "advance"
  | "transfer"
  | "income"
  | "expense"
  | "fx"
  | "fx-sell"
  | "investment"
  | "stock"
  | "stock-sell"
  | "stock-transfer"
  | "stock-dividend"
  | "property"
  | "metal"
  | "wealth"
  | "deposit"
  | "deposit-buy"
  | "deposit-redeem"
  | "insurance"
  | "debt"
  | "loan"
  | "regular-task";

export type LoanType = LoanTypeValue;
type LoanMode = "repay_out" | "prepay_out";

type EntryAction = {
  key: EntryKind;
  label: string;
  disabled?: boolean;
  loanType?: LoanType;
  mode?: LoanMode;
  children?: EntryAction[];
};

type Props = {
  defaultAction: EntryKind;
  actions: EntryAction[];
  className?: string;
  hideDefaultActionInMenu?: boolean;
  context?: {
    defaultAccountId?: string;
    defaultCashAccountId?: string;
    defaultTransferFromAccountId?: string;
    defaultTransferToAccountId?: string;
    defaultInvestmentAccountId?: string;
    defaultStockAccountId?: string;
    defaultStockCashAccountId?: string;
    defaultStockTransferFromAccountId?: string;
    defaultPropertyAccountId?: string;
    defaultMetalAccountId?: string;
    defaultWealthAccountId?: string;
    defaultDepositAccountId?: string;
    defaultDepositSubtype?: "buy" | "redeem";
    defaultInsuranceAccountId?: string;
    defaultDebtAccountId?: string;
    defaultDebtInstitutionId?: string;
    defaultScheduledTaskType?: "fund_regular_invest" | "loan_repayment" | "transfer" | "insurance_premium";
    defaultFundCode?: string;
    defaultFundName?: string;
  };
};

function makeRequestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getCurrentFundContext(context?: Props["context"]) {
  if (typeof window === "undefined") {
    return {
      fundCode: context?.defaultFundCode ?? "",
      fundName: context?.defaultFundName ?? "",
    };
  }
  try {
    const q = new URLSearchParams(window.location.search);
    const view = q.get("view") ?? "";
    const urlFundCode = view === "investfund" || view === "investmoney"
      ? q.get("fundCode")?.trim() ?? ""
      : "";
    const defaultFundCode = context?.defaultFundCode?.trim() ?? "";
    return {
      fundCode: urlFundCode || defaultFundCode,
      fundName: !urlFundCode || urlFundCode === defaultFundCode ? context?.defaultFundName?.trim() ?? "" : "",
    };
  } catch {
    return {
      fundCode: context?.defaultFundCode ?? "",
      fundName: context?.defaultFundName ?? "",
    };
  }
}

function dispatchEntryAction(kind: EntryKind, context?: Props["context"], loanType?: LoanType, loanMode?: LoanMode) {
  if (typeof window === "undefined") return;
  const requestId = makeRequestId(kind);
  switch (kind) {
    case "transaction":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "expense" },
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "advance":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "advance" },
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "income":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "income" },
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "expense":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "expense" },
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "transfer":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "transfer" },
            defaultAccountId: context?.defaultTransferFromAccountId ?? context?.defaultAccountId ?? "",
            defaultFromAccountId: context?.defaultTransferFromAccountId ?? context?.defaultAccountId ?? "",
            defaultToAccountId: context?.defaultTransferToAccountId ?? "",
          },
        }),
      );
      return;
    case "fx":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "fx" },
            defaultAccountId: context?.defaultTransferFromAccountId ?? context?.defaultAccountId ?? "",
            defaultFromAccountId: context?.defaultTransferFromAccountId ?? context?.defaultAccountId ?? "",
            defaultToAccountId: context?.defaultTransferToAccountId ?? "",
          },
        }),
      );
      return;
    case "fx-sell":
      // 卖出外汇：外币账户 -> 人民币账户。方向由 TransactionFormModal 的 fxDirection 处理。
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "fx" },
            fxDirection: "sell",
            defaultFromAccountId: "",
            defaultToAccountId: "",
          },
        }),
      );
      return;
    case "investment":
      const currentFund = getCurrentFundContext(context);
      window.dispatchEvent(
        new CustomEvent("mmh:investment:create", {
          detail: {
            requestId,
            defaultAccountId: context?.defaultInvestmentAccountId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultProductType: "fund",
            defaultFundCode: currentFund.fundCode,
            defaultFundName: currentFund.fundName,
          },
        }),
      );
      return;
    case "stock":
    case "stock-sell":
    case "stock-dividend":
      window.dispatchEvent(
        new CustomEvent("mmh:stock:create", {
          detail: {
            requestId,
            defaultAction: kind === "stock-sell" ? "sell" : kind === "stock-dividend" ? "dividend" : "buy",
            defaultStockAccountId: context?.defaultStockAccountId ?? context?.defaultInvestmentAccountId ?? "",
            defaultCashAccountId: context?.defaultStockCashAccountId ?? context?.defaultCashAccountId ?? "",
          },
        }),
      );
      return;
    case "stock-transfer":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "transfer", remark: "银证转账" },
            defaultAccountId: context?.defaultStockTransferFromAccountId ?? context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultFromAccountId: context?.defaultStockTransferFromAccountId ?? context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultToAccountId: context?.defaultStockCashAccountId ?? "",
          },
        }),
      );
      return;
    case "property":
      const fixedAssetAccountId = context?.defaultPropertyAccountId ?? context?.defaultInvestmentAccountId ?? "";
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "expense" },
            lockedType: "expense",
            defaultAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            fixedAssetAccountId,
            fixedAssetRequired: true,
            lockFixedAsset: Boolean(fixedAssetAccountId),
          },
        }),
      );
      return;
    case "metal":
      window.dispatchEvent(
        new CustomEvent("mmh:investment:create", {
          detail: {
            requestId,
            defaultAccountId: context?.defaultMetalAccountId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultProductType: "metal",
          },
        }),
      );
      return;
    case "wealth":
      window.dispatchEvent(
        new CustomEvent("mmh:wealth:create", {
          detail: {
            requestId,
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultWealthAccountId: context?.defaultWealthAccountId ?? "",
          },
        }),
      );
      return;
    case "deposit":
      window.dispatchEvent(
        new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: context?.defaultDepositSubtype ?? "buy",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultDepositAccountId: context?.defaultDepositAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "deposit-buy":
      window.dispatchEvent(
        new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: "buy",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultDepositAccountId: context?.defaultDepositAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "deposit-redeem":
      window.dispatchEvent(
        new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: "redeem",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultDepositAccountId: context?.defaultDepositAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "insurance":
      window.dispatchEvent(
        new CustomEvent("mmh:insurance:create", {
          detail: {
            requestId,
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultInsuranceAccountId: context?.defaultInsuranceAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "debt":
      window.dispatchEvent(
        new CustomEvent("mmh:debt:create", {
          detail: {
            requestId,
            defaultDebtAccountId: context?.defaultDebtAccountId ?? "",
            defaultDebtInstitutionId: context?.defaultDebtInstitutionId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "loan":
      window.dispatchEvent(
        new CustomEvent("mmh:loan:create", {
          detail: {
            requestId,
            ...(loanMode
              ? { mode: loanMode, ...(loanType ? { loanType } : {}) }
              : { loanType: loanType ?? "consumer" }),
            defaultDebtAccountId: context?.defaultDebtAccountId ?? "",
            defaultDebtInstitutionId: context?.defaultDebtInstitutionId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "regular-task":
      if (window.location.pathname === "/regular-invest") {
        window.dispatchEvent(
          new CustomEvent("mmh:regular-task:create", {
            detail: {
              requestId,
              taskType: context?.defaultScheduledTaskType ?? "fund_regular_invest",
              defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
              defaultAccountId: context?.defaultAccountId ?? "",
            },
          }),
        );
      } else {
        window.location.assign("/regular-invest?create=1");
      }
      return;
  }
}

export function UnifiedEntryLauncher({ defaultAction, actions, className, hideDefaultActionInMenu = false, context }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  // 二级菜单默认收起，悬浮分组行时才展开；点击分组行仍直接执行默认动作。
  const [openSubmenuKey, setOpenSubmenuKey] = useState<string | null>(null);
  const [submenuStyle, setSubmenuStyle] = useState<CSSProperties | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const submenuRowRef = useRef<HTMLElement | null>(null);
  const submenuCloseTimerRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  const defaultItem = useMemo(
    () => actions.find((item) => item.key === defaultAction && !item.disabled) ?? actions.find((item) => !item.disabled),
    [actions, defaultAction],
  );

  const openSubmenuAction = useMemo(
    () => actions.find((item) => item.key === openSubmenuKey && item.children && item.children.length > 0) ?? null,
    [actions, openSubmenuKey],
  );

  function cancelSubmenuCloseTimer() {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  }

  function scheduleSubmenuClose() {
    cancelSubmenuCloseTimer();
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null;
      setOpenSubmenuKey(null);
    }, 160);
  }

  useEffect(() => () => cancelSubmenuCloseTimer(), []);

  // 二级菜单为独立 fixed 浮层（.viewport-menu 有 overflow-auto/max-h，放内部会被裁剪）。
  // 悬浮行后向左侧弹出；左侧空间不足时回退到右侧，垂直方向做视口钳制。
  useLayoutEffect(() => {
    if (!openSubmenuAction) return;
    const updatePosition = () => {
      const submenu = submenuRef.current;
      const row = submenuRowRef.current;
      if (!submenu || !row || !row.isConnected) return;
      const rowRect = row.getBoundingClientRect();
      const submenuWidth = submenu.offsetWidth;
      const submenuHeight = submenu.offsetHeight;
      const viewportPadding = 8;
      const spaceLeft = rowRect.left - viewportPadding;
      const left = spaceLeft >= submenuWidth + 6
        ? rowRect.left - submenuWidth - 6
        : Math.min(rowRect.right + 6, window.innerWidth - viewportPadding - submenuWidth);
      const top = Math.max(viewportPadding, Math.min(rowRect.top, window.innerHeight - viewportPadding - submenuHeight));
      setSubmenuStyle({ position: "fixed", top, left, zIndex: 9999 });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [openSubmenuAction, menuStyle]);

  // 菜单整体关闭时收起所有二级菜单。
  useEffect(() => {
    if (!menuOpen) {
      setOpenSubmenuKey(null);
      return;
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const updatePosition = () => {
      const wrap = wrapRef.current;
      const menu = menuRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const menuWidth = menu?.offsetWidth ?? 224;
      const menuHeight = menu?.offsetHeight ?? 336;
      const viewportPadding = 8;
      const rightEdge = window.innerWidth - viewportPadding;
      const leftEdge = viewportPadding;
      const topEdge = viewportPadding;
      const bottomEdge = window.innerHeight - viewportPadding;
      const left = Math.max(leftEdge, Math.min(rect.right - menuWidth, rightEdge - menuWidth));
      const spaceBelow = bottomEdge - rect.bottom;
      const spaceAbove = rect.top - topEdge;
      const top =
        spaceBelow >= menuHeight || spaceBelow >= spaceAbove
          ? Math.max(topEdge, Math.min(rect.bottom + 6, bottomEdge - menuHeight))
          : Math.max(topEdge, rect.top - menuHeight - 6);
      setMenuStyle({
        position: "fixed",
        top,
        left,
        zIndex: 9999,
      });
    };
    const raf = window.requestAnimationFrame(updatePosition);
    function onPointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    function onReposition() {
      updatePosition();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [menuOpen]);

  return (
    <div ref={wrapRef} className={className ?? "relative inline-flex"}>
      <div className="inline-flex h-8 items-stretch overflow-hidden rounded-full bg-blue-600 text-white shadow-sm ring-1 ring-blue-600/90">
        <button
          type="button"
          data-entry-launcher-primary
          data-entry-launcher-primary-action={defaultItem?.key ?? ""}
          onClick={() => {
            setMenuOpen(false);
            if (defaultItem) dispatchEntryAction(defaultItem.key, context, defaultItem.loanType, defaultItem.mode);
          }}
          disabled={!defaultItem}
          className="inline-flex items-center gap-1.5 bg-transparent px-3 text-sm font-medium hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {defaultItem?.label ?? t("txForm.record")}
        </button>
        <div className="my-1 w-px shrink-0 bg-white/35" aria-hidden="true" />
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="inline-flex items-center justify-center bg-transparent px-2.5 hover:bg-white/10"
          title={t("unifiedEntry.moreEntries")}
        >
          <ChevronDown className="h-4 w-4 opacity-90" />
        </button>
      </div>
      {menuOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="viewport-menu min-w-[180px] rounded-[12px] border border-slate-200 bg-white py-1 shadow-[0_12px_32px_rgba(15,23,42,0.16)]"
              data-menu-open="true"
              style={menuStyle ?? { position: "fixed", top: 0, left: 0, zIndex: 9999 }}
            >
              {actions.filter((item) => !hideDefaultActionInMenu || item.key !== defaultItem?.key).map((item) => {
                if (item.children && item.children.length > 0) {
                  const isSubmenuOpen = openSubmenuKey === item.key;
                  return (
                    <div
                      key={item.key}
                      className="py-1"
                      onMouseEnter={(event) => {
                        if (item.disabled) return;
                        cancelSubmenuCloseTimer();
                        submenuRowRef.current = event.currentTarget;
                        setOpenSubmenuKey(item.key);
                      }}
                      onMouseLeave={scheduleSubmenuClose}
                    >
                      <div className="flex items-stretch">
                        <button
                          type="button"
                          aria-haspopup="menu"
                          aria-expanded={isSubmenuOpen}
                          disabled={item.disabled}
                          onClick={() => {
                            setMenuOpen(false);
                            if (!item.disabled) dispatchEntryAction(item.key, context, item.loanType, item.mode);
                          }}
                          className="flex-1 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                        >
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`${item.label} submenu`}
                          aria-haspopup="menu"
                          aria-expanded={isSubmenuOpen}
                          disabled={item.disabled}
                          onClick={(event) => {
                            cancelSubmenuCloseTimer();
                            submenuRowRef.current = event.currentTarget.parentElement;
                            setOpenSubmenuKey(isSubmenuOpen ? null : item.key);
                          }}
                          className="my-auto mr-1.5 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                        >
                          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isSubmenuOpen ? "rotate-90" : ""}`} />
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={item.disabled}
                    onMouseEnter={() => {
                      cancelSubmenuCloseTimer();
                      setOpenSubmenuKey(null);
                    }}
                    onClick={() => {
                      setMenuOpen(false);
                      if (!item.disabled) dispatchEntryAction(item.key, context, item.loanType, item.mode);
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
      {menuOpen && openSubmenuAction && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={submenuRef}
              className="min-w-[150px] rounded-[12px] border border-slate-200 bg-white py-1 shadow-[0_12px_32px_rgba(15,23,42,0.16)]"
              data-menu-open="true"
              style={submenuStyle ?? { position: "fixed", top: -9999, left: -9999, zIndex: 9999 }}
              onMouseEnter={cancelSubmenuCloseTimer}
              onMouseLeave={scheduleSubmenuClose}
            >
              {openSubmenuAction.children?.map((child) => (
                <button
                  key={`${openSubmenuAction.key}:${child.key}:${child.loanType ?? child.mode ?? "default"}`}
                  type="button"
                  disabled={child.disabled}
                  onClick={() => {
                    setMenuOpen(false);
                    if (!child.disabled) dispatchEntryAction(child.key, context, child.loanType, child.mode);
                  }}
                  className="flex w-full items-center whitespace-nowrap px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                >
                  {child.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
