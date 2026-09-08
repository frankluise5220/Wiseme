"use client";

import { useCallback, useMemo, useState } from "react";
import { Building2, CheckCircle2, Landmark, Plus, UserRound } from "lucide-react";

import { DebtTransactionModal } from "@/components/DebtTransactionModal";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type CounterpartyGuideRow = {
  id: string;
  name: string;
  shortName: string | null;
  type: string | null;
  accountCount: number;
  payable: number;
  receivable: number;
};

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  kind?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  institutionType?: string | null;
  isInstitutionLoan?: boolean;
  debtDirection?: "payable" | "receivable" | null;
};

type SmartSelectLikeOption = {
  id: string;
  label: string;
  subLabel?: string;
  title?: string;
  isHeader?: boolean;
  parentId?: string;
  kind?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  billingDay?: number | null;
  currency?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

function typeLabel(t: (key: string) => string, type?: string | null) {
  return type === "organization" ? t("institution.type.organization") : t("institution.type.person");
}

const GUIDE_STEPS = [
  { titleKey: "liabilitiesGuide.step1Title", textKey: "liabilitiesGuide.step1Text" },
  { titleKey: "liabilitiesGuide.step2Title", textKey: "liabilitiesGuide.step2Text" },
  { titleKey: "liabilitiesGuide.step3Title", textKey: "liabilitiesGuide.step3Text" },
  { titleKey: "liabilitiesGuide.step4Title", textKey: "liabilitiesGuide.step4Text" },
  { titleKey: "liabilitiesGuide.step5Title", textKey: "liabilitiesGuide.step5Text" },
] as const;

export function LiabilitiesGuideClient({
  counterparties,
  debtAccounts,
  debtObjectOptions,
  cashAccounts,
  cashAccountSSOptions,
  nestedFieldData,
  defaultCashAccountId,
  action,
}: {
  counterparties: CounterpartyGuideRow[];
  debtAccounts: AccountOption[];
  debtObjectOptions: SmartSelectLikeOption[];
  cashAccounts: AccountOption[];
  cashAccountSSOptions: SmartSelectLikeOption[];
  nestedFieldData: NestedFieldData;
  defaultCashAccountId: string;
  action: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
}) {
  const [rows, setRows] = useState(counterparties);
  const [selectedId, setSelectedId] = useState(counterparties[0]?.id ?? "");
  const [showCreate, setShowCreate] = useState(counterparties.length === 0);

  const { t } = useI18n();
  const formatText = useCallback((key: string, values?: Record<string, string | number>) => {
    let text = t(key) as string;
    if (!values) return text;
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }, [t]);

  const selectedRow = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const existingNames = useMemo(
    () => rows.flatMap((row) => [row.name, row.shortName?.trim() || ""]).filter(Boolean),
    [rows],
  );

  function handleCreated(id: string, name: string, extra?: { type?: string }) {
    const nextRow: CounterpartyGuideRow = {
      id,
      name,
      shortName: null,
      type: extra?.type ?? "person",
      accountCount: 0,
      payable: 0,
      receivable: 0,
    };
    setRows((current) => [...current, nextRow]);
    setSelectedId(id);
    setShowCreate(false);
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{t("liabilitiesGuide.title")}</div>
            <div className="text-xs text-slate-500">{t("liabilitiesGuide.subtitle")}</div>
          </div>
          <button type="button" onClick={() => setShowCreate(true)} className="primary-button page-action-button h-8 gap-1 text-xs">
            <Plus className="h-3.5 w-3.5" />
            {t("liabilitiesGuide.addCounterparty")}
          </button>
        </div>
      </header>

      <EntityCreateForm
        mode="full"
        layout="modal"
        open={showCreate}
        onClose={() => setShowCreate(false)}
        entityType="counterparty"
        defaultType="person"
        title={t("liabilitiesGuide.addCounterparty")}
        nameLabel={t("liabilitiesGuide.nameLabel")}
        namePlaceholder={t("liabilitiesGuide.namePlaceholder")}
        existingNames={existingNames}
        onCreated={handleCreated}
      />

      <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 md:px-5 md:py-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(380px,1.1fr)]">
        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <UserRound className="h-4 w-4 text-blue-500" />
              {t("liabilitiesGuide.listTitle")}
            </div>
            <div className="text-xs text-slate-400">{formatText("liabilitiesGuide.objectCount", { count: rows.length })}</div>
          </div>
          <div className="divide-y divide-slate-100">
            {rows.length > 0 ? rows.map((row) => {
              const active = row.id === selectedRow?.id;
              const net = row.receivable - row.payable;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={`block w-full px-4 py-3 text-left transition-colors ${active ? "bg-blue-50" : "hover:bg-slate-50"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-800">{row.shortName?.trim() || row.name}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{typeLabel(t, row.type)}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{row.accountCount > 0 ? formatText("liabilitiesGuide.accountCount", { count: row.accountCount }) : t("liabilitiesGuide.noRecords")}</div>
                    </div>
                    <div className="shrink-0 text-right text-xs tabular-nums">
                      <div className={row.payable > 0 ? "text-rose-700" : "text-slate-400"}>{t("liabilitiesGuide.payable")} ¥{formatMoney(row.payable)}</div>
                      <div className={row.receivable > 0 ? "text-emerald-700" : "text-slate-400"}>{t("liabilitiesGuide.receivable")} ¥{formatMoney(row.receivable)}</div>
                      {net !== 0 ? <div className="mt-0.5 text-[11px] text-slate-500">{t("liabilitiesGuide.net")} ¥{formatMoney(Math.abs(net))}</div> : null}
                    </div>
                  </div>
                </button>
              );
            }) : (
              <div className="px-4 py-10 text-center">
                <div className="text-sm font-medium text-slate-700">{t("liabilitiesGuide.emptyTitle")}</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">{t("liabilitiesGuide.emptyHint")}</div>
                <button type="button" onClick={() => setShowCreate(true)} className="primary-button mt-4 h-8 gap-1 px-3 text-xs">
                  <Plus className="h-3.5 w-3.5" />
                  {t("liabilitiesGuide.addCounterparty")}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-500" />
              {t("liabilitiesGuide.guideTitle")}
            </div>
            {selectedRow ? (
              <DebtTransactionModal
                key={selectedRow.id}
                debtAccounts={debtAccounts}
                cashAccounts={cashAccounts}
                debtObjectOptions={debtObjectOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                nestedFieldData={nestedFieldData}
                defaultDebtInstitutionId={`counterparty:${selectedRow.id}`}
                defaultCashAccountId={defaultCashAccountId}
                action={action}
                triggerLabel={t("liabilitiesGuide.newDebtTransaction")}
              />
            ) : null}
          </div>

          <div className="space-y-3 p-4">
            {selectedRow ? (
              <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm leading-6 text-blue-900">
                {formatText("liabilitiesGuide.selectedHint", { name: selectedRow.shortName?.trim() || selectedRow.name })}
              </div>
            ) : (
              <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
                {t("liabilitiesGuide.noSelectionHint")}
              </div>
            )}

            <div className="grid gap-3">
              {GUIDE_STEPS.map((item) => (
                <div key={item.titleKey} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {t(item.titleKey)}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-600">{t(item.textKey)}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-slate-400" />
                {t("liabilitiesGuide.suggestedOrderTitle")}
              </div>
              <div className="mt-2 text-xs leading-5 text-slate-600">
                {t("liabilitiesGuide.suggestedOrderText")}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
