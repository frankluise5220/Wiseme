"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { buildGroupedAccountOptions, buildAccountDisplayOption, type AccountDisplaySource } from "@/lib/account-display";
import { SmartSelect } from "@/components/SmartSelect";
import { buildCategoryTreeOptions } from "@/components/categorySmartSelect";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";

type AccountOption = AccountDisplaySource;
type CategoryOption = { id: string; name: string; type: string; sortOrder?: number; isSystem?: boolean };
type TransactionDraft = {
  id?: string;
  date: string;
  amount: string;
  type: "expense" | "income" | "transfer";
  accountId: string;
  toAccountId: string;
  categoryId: string;
  note: string;
};

type Props = {
  accounts: AccountOption[];
  categories: CategoryOption[];
  defaultAccountId?: string;
};

const EMPTY_DRAFT: TransactionDraft = {
  date: new Date().toISOString().slice(0, 10),
  amount: "",
  type: "expense",
  accountId: "",
  toAccountId: "",
  categoryId: "",
  note: "",
};

export function MobileTransactionForm({ accounts, categories, defaultAccountId = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TransactionDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const scrollYRef = useRef(0);
  const { t } = useI18n();

  const availableCategories = useMemo(
    () => categories.filter((category) => category.type === draft.type),
    [categories, draft.type],
  );
  const accountOptions = useMemo(
    () => buildGroupedAccountOptions(accounts.map((account) => buildAccountDisplayOption(account, undefined, { fields: getAccountLabelFieldsPreference() }))),
    [accounts],
  );
  const transferAccountOptions = useMemo(
    () => accountOptions.filter((option) => option.isHeader || option.id !== draft.accountId),
    [accountOptions, draft.accountId],
  );
  const categoryOptions = useMemo(
    () => [
      { id: "", label: t("mobileTxForm.uncategorized") },
      ...buildCategoryTreeOptions(availableCategories, t),
    ],
    [availableCategories, t],
  );

  useEffect(() => {
    if (!open) return;
    scrollYRef.current = window.scrollY;
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
      window.requestAnimationFrame(() => window.scrollTo({ top: scrollYRef.current, left: 0 }));
    };
  }, [open]);

  const openCreate = useCallback(() => {
    setDraft({ ...EMPTY_DRAFT, accountId: defaultAccountId || accounts[0]?.id || "" });
    setError("");
    setOpen(true);
  }, [accounts, defaultAccountId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("quickEntry") !== "1") return;
    openCreate();
    url.searchParams.delete("quickEntry");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [openCreate]);

  useEffect(() => {
    const openEdit = async (event: Event) => {
      const entryId = (event as CustomEvent<{ entryId?: string }>).detail?.entryId?.trim();
      if (!entryId) return;
      setError("");
      try {
        const response = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(entryId)}`);
        const result = await response.json().catch(() => null);
        const entry = result?.data;
        if (!response.ok || !result?.ok || !entry) throw new Error(result?.error ?? t("mobileTxForm.loadFailed"));
        if (entry.type !== "expense" && entry.type !== "income" && entry.type !== "transfer") {
          throw new Error(t("mobileTxForm.editOtherPageHint"));
        }
        setDraft({
          id: entry.id,
          date: String(entry.date ?? "").slice(0, 10),
          amount: String(Math.abs(Number(entry.amount) || 0)),
          type: entry.type,
          accountId: entry.accountId ?? "",
          toAccountId: entry.toAccountId ?? "",
          categoryId: entry.categoryId ?? "",
          note: entry.note ?? "",
        });
        setOpen(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("mobileTxForm.loadFailed"));
      }
    };
    window.addEventListener("mmh:create-transaction:open", openCreate);
    window.addEventListener("mmh:mobile-transaction:edit", openEdit);
    return () => {
      window.removeEventListener("mmh:create-transaction:open", openCreate);
      window.removeEventListener("mmh:mobile-transaction:edit", openEdit);
    };
  }, [openCreate, t]);

  function close() {
    if (saving) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setOpen(false);
  }

  function update<K extends keyof TransactionDraft>(key: K, value: TransactionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function swapTransferAccounts() {
    setDraft((current) => ({ ...current, accountId: current.toAccountId, toAccountId: current.accountId }));
  }

  async function save() {
    const amount = Number(draft.amount);
    if (!draft.date || !Number.isFinite(amount) || amount <= 0 || !draft.accountId) {
      setError(t("mobileTxForm.fillRequired"));
      return;
    }
    if (draft.type === "transfer" && !draft.toAccountId) {
      setError(t("mobileTxForm.selectToAccount"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const body = {
        ...(draft.id ? { id: draft.id } : {}),
        date: draft.date,
        amount,
        type: draft.type,
        accountId: draft.accountId,
        toAccountId: draft.type === "transfer" ? draft.toAccountId : undefined,
        categoryId: draft.type === "transfer" ? undefined : draft.categoryId || undefined,
        note: draft.note.trim() || undefined,
      };
      const response = await fetch("/api/v1/transactions/detail", {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error ?? t("mobileTxForm.saveFailed"));
      setOpen(false);
      dispatchFinanceDataChanged({
        reason: "mobile-transaction-save",
        accountIds: [draft.accountId, draft.toAccountId].filter((id): id is string => Boolean(id)),
        entryIds: draft.id ? [draft.id] : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("mobileTxForm.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-end overflow-hidden bg-slate-950/30" role="dialog" aria-modal="true" aria-label={draft.id ? t("mobileTxForm.editTitle") : t("mobileTxForm.newTitle")}>
      <div className="flex h-[min(86dvh,42rem)] max-h-[calc(100dvh-max(0.75rem,env(safe-area-inset-top)))] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl">
        <div className="shrink-0 px-4 pt-3">
        <div className="mx-auto mb-3 h-1 w-10 rounded bg-slate-200" />
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{draft.id ? t("mobileTxForm.editTitle") : t("mobileTxForm.newTitle")}</h2>
          <button type="button" onClick={close} className="flex h-10 w-10 items-center justify-center text-slate-500" aria-label={t("mobileTxForm.close")}>
            <X size={20} />
          </button>
        </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
          {(["expense", "income", "transfer"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => update("type", type)}
              className={`h-10 rounded-md text-sm font-medium ${draft.type === type ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"}`}
            >
              {type === "expense" ? t("mobileTxForm.expense") : type === "income" ? t("mobileTxForm.income") : t("mobileTxForm.transfer")}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.date")}</span>
            <input className="form-input mt-1" type="date" value={draft.date} onChange={(event) => update("date", event.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.amount")}</span>
            <input className="form-input mt-1 text-right tabular-nums" inputMode="decimal" type="number" min="0" step="0.01" placeholder="0.00" value={draft.amount} onChange={(event) => update("amount", event.target.value)} />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-slate-500">{draft.type === "transfer" ? t("mobileTxForm.transferFromAccount") : t("mobileTxForm.account")}</span>
          <div className="mt-1 rounded-[10px] ring-1 ring-rose-200/80 [&>[role=button]]:h-11">
            <SmartSelect
              mode="single"
              value={draft.accountId}
              onChange={(value) => update("accountId", value)}
              options={accountOptions}
              placeholder={t("mobileTxForm.selectAccountPlaceholder")}
              behavior={{ search: true, hierarchy: true, density: "regular", minDropdownWidth: 340, dropdownMaxHeight: 320 }}
            />
          </div>
        </label>

        {draft.type === "transfer" ? (
          <div className="mt-1.5 flex justify-center">
            <button
              type="button"
              onClick={swapTransferAccounts}
              disabled={!draft.accountId && !draft.toAccountId}
              title={t("txForm.swapAccounts")}
              aria-label={t("txForm.swapAccounts")}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 active:bg-slate-100 disabled:opacity-40"
            >
              <ArrowLeftRight size={15} />
            </button>
          </div>
        ) : null}

        {draft.type === "transfer" ? (
          <label className="mt-1.5 block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.transferToAccount")}</span>
            <div className="mt-1 rounded-[10px] ring-1 ring-rose-200/80 [&>[role=button]]:h-11">
              <SmartSelect
                mode="single"
                value={draft.toAccountId}
                onChange={(value) => update("toAccountId", value)}
                options={transferAccountOptions}
                placeholder={t("mobileTxForm.selectAccountPlaceholder")}
                behavior={{ search: true, hierarchy: true, density: "regular", minDropdownWidth: 340, dropdownMaxHeight: 320 }}
              />
            </div>
          </label>
        ) : (
          <label className="mt-3 block">
            <span className="text-xs text-slate-500">{t("mobileTxForm.category")}</span>
            <div className="mt-1 rounded-[10px] ring-1 ring-rose-200/80 [&>[role=button]]:h-11">
              <SmartSelect
                mode="single"
                value={draft.categoryId}
                onChange={(value) => update("categoryId", value)}
                options={categoryOptions}
                placeholder={t("mobileTxForm.uncategorized")}
                behavior={{ search: true, density: "regular", minDropdownWidth: 340, dropdownMaxHeight: 320 }}
              />
            </div>
          </label>
        )}

        <label className="mt-3 block">
          <span className="text-xs text-slate-500">{t("mobileTxForm.note")}</span>
          <input className="form-input mt-1" value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder={t("mobileTxForm.optional")} />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button type="button" disabled={saving} onClick={save} className="primary-button mt-4 h-11 w-full disabled:opacity-60">
          {saving ? t("mobileTxForm.saving") : t("mobileTxForm.save")}
        </button>
        </div>
      </div>
    </div>
  );
}

export function openMobileTransactionEdit(entryId: string) {
  window.dispatchEvent(new CustomEvent("mmh:mobile-transaction:edit", { detail: { entryId } }));
}
