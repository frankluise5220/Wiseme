"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Pencil, Plus, Shield, Trash2 } from "lucide-react";

import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import {
  getInsuranceAction,
  getInsuranceProductName,
  insuranceCashValueDelta,
  type InsuranceAction,
} from "@/lib/insurance/transaction";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import {
  AdvancedDataTable,
  type AdvancedDataTableColumn,
  type AdvancedDataTableSummaryRow,
} from "./AdvancedDataTable";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchDeleteMessage,
  BasicDetailBatchReplaceButton,
  BasicDetailSelectionProvider,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
} from "./BasicDetailSelection";
import { dispatchEntryEdit, EntryRowActions } from "./EntryRowActions";
import {
  InsurancePolicyEditModal,
  type InsurancePolicyEditMeta,
  type InsurancePolicyEditValue,
} from "./InsurancePolicyEditModal";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import {
  InsuranceProductEditModal,
  type InsuranceProductEditInstitution,
  type InsuranceProductEditOption,
  type InsuranceProductEditValue,
} from "./InsuranceProductEditModal";
import { InsuranceEntryEditModal, type InsuranceEntryEditValue } from "./InsuranceEntryEditModal";
import { InsurancePolicyDeleteModal } from "./InsurancePolicyDeleteModal";
import type { SmartSelectOption } from "./SmartSelect";

type InsuranceEntry = {
  id: string;
  date: string;
  typeLabel: string;
  productName: string;
  cashAccountLabel: string;
  cashAccountId: string | null;
  note: string;
  fundArrivalDate?: string | null;
  amount: number;
  businessTransactionId?: string | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  coverageAmount: number | null;
  paymentTermYears: number | null;
  edit?: {
    type: "investment";
    date: string;
    amount: number;
    note: string;
    fundArrivalDate?: string | null;
    accountId?: string;
    cashAccountId?: string;
    insuranceProductId?: string | null;
    insuranceAction?: InsuranceAction;
    insuranceProductName?: string;
    source?: string | null;
  };
};

type InsuranceCashAccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
};

type InsuranceHolding = {
  id: string;
  label: string;
  policyNo?: string | null;
  startDate?: string | null;
  ownerName?: string;
  policyholderPersonId?: string | null;
  insuredPersonName?: string;
  insuredPersonId?: string | null;
  beneficiaryName?: string | null;
  cashValue?: number | null;
  coverageAmount?: number | null;
  totalPremium?: number | null;
  lastPremiumAmount?: number | null;
  status?: string | null;
  statusLabel?: string;
  frequencyLabel?: string;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  institutionId?: string | null;
  institutionName?: string | null;
  ownerGroupId?: string | null;
  productType?: string | null;
  accountingType?: string | null;
  currency?: string | null;
  accountId?: string | null;
  premiumMode?: string | null;
  premiumFrequencyMonths?: number | null;
  cashValueEnabled?: boolean | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  note?: string | null;
  relatedEntryIds: string[];
};

type InsuranceProductRow = {
  id: string;
  accountId?: string | null;
  policyNo?: string | null;
  name: string;
  productType?: string | null;
  accountingType?: string | null;
  cashValueEnabled?: boolean | null;
  institutionId?: string | null;
  institutionName?: string | null;
  ownerGroupId?: string | null;
  ownerGroupName?: string | null;
  policyholderPersonId?: string | null;
  policyholderPersonName?: string | null;
  insuredUserName?: string | null;
  insuredPersonId?: string | null;
  insuredPersonName?: string | null;
  beneficiaryName?: string | null;
  startDate?: string | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  status?: string | null;
  currency?: string | null;
  premiumMode?: string | null;
  premiumFrequencyMonths?: number | null;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  coverageAmount?: number | null;
  note?: string | null;
};

function todayLocalYmd() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function normalizeInsuranceMetricMode(
  productType?: string | null,
  accountingType?: string | null,
  cashValueEnabled?: boolean | null,
) {
  const normalizedProductType = productType ?? "other";
  const normalizedAccountingType = accountingType ?? "asset";
  if (cashValueEnabled === false) return "coverage";
  if (normalizedAccountingType === "protection") return "coverage";
  if (normalizedAccountingType === "hybrid") return "hybrid";
  if (
    ["critical_illness", "medical", "accident", "term_life", "whole_life"].includes(
      normalizedProductType,
    )
  ) {
    return "hybrid";
  }
  return "balance";
}

function frequencyLabel(t: (key: string) => string, months?: number | null) {
  if (months === 1) return t("insuranceShell.frequency.monthly");
  if (months === 3) return t("insuranceShell.frequency.quarterly");
  if (months === 6) return t("insuranceShell.frequency.semiannual");
  if (months === 12) return t("insuranceShell.frequency.annual");
  if (months === 999999) return t("insuranceShell.frequency.single");
  return "-";
}

function statusLabel(t: (key: string) => string, status?: string | null) {
  if (status === "matured") return t("insuranceShell.status.matured");
  if (status === "surrendered") return t("insuranceShell.status.surrendered");
  if (status === "lapsed") return t("insuranceShell.status.lapsed");
  return t("insuranceShell.status.active");
}

function parseOptionalNumber(input: string) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function mergeFamilyMemberOptions(
  t: (key: string) => string,
  language: string,
  options: SmartSelectOption[],
  people: ReadonlyArray<{ id?: string | null; name?: string | null }>,
) {
  const byName = new Map<string, SmartSelectOption>();

  function addOption(candidate: SmartSelectOption) {
    const normalizedName = candidate.label.trim();
    if (!normalizedName) return;
    const normalizedCandidate: SmartSelectOption = {
      ...candidate,
      label: normalizedName,
      subLabel: t("institution.type.family_member"),
    };
    const existing = byName.get(normalizedName);
    const existingIsSynthetic = existing?.id.startsWith("name:") ?? false;
    const candidateIsSynthetic = normalizedCandidate.id.startsWith("name:");
    if (!existing || (existingIsSynthetic && !candidateIsSynthetic)) {
      byName.set(normalizedName, normalizedCandidate);
    }
  }

  for (const option of options) {
    addOption(option);
  }

  for (const person of people) {
    const id = String(person.id ?? "").trim();
    const name = String(person.name ?? "").trim();
    if (!name) continue;
    addOption({
      id: id || `name:${name}`,
      label: name,
      subLabel: t("institution.type.family_member"),
    });
  }

  return Array.from(byName.values()).sort((a, b) => a.label.localeCompare(b.label, language));
}

function buildInsuranceEntries(
  t: (key: string) => string,
  detailEntries: Array<Record<string, unknown>>,
): InsuranceEntry[] {
  return detailEntries
    .filter((entry) => entry.source === "insurance")
    .map((entry) => {
      const insuranceAction = getInsuranceAction({
        source: "insurance",
        insuranceAction: typeof entry.insuranceAction === "string" ? entry.insuranceAction : null,
        fundSubtype: typeof entry.fundSubtype === "string" ? entry.fundSubtype : null,
      });
      const isRedeemEntry = insuranceAction === "refund";
      const typeLabel =
        isRedeemEntry
          ? t("insuranceShell.entryType.refund")
          : insuranceAction === "additional_premium"
            ? t("insuranceShell.entryType.additionalPremium")
            : t("insuranceShell.renewal");
      const rawAmount = Number(entry.amount ?? 0);
      const amount = isRedeemEntry ? Math.abs(rawAmount) : -Math.abs(rawAmount);
      const productName = getInsuranceProductName({
        source: "insurance",
        insuranceProductName:
          typeof entry.insuranceProductName === "string" ? entry.insuranceProductName : null,
        fundName: typeof entry.fundName === "string" ? entry.fundName : null,
      });

      const cashAccountId = isRedeemEntry
        ? (entry.toAccountId ? String(entry.toAccountId) : null)
        : (entry.accountId ? String(entry.accountId) : null);

      // Cash account display: institution · card name
      const accountInstitutionName = String(entry.accountInstitutionName ?? "");
      const toAccountInstitutionName = String(entry.toAccountInstitutionName ?? "");
      const rawAccountName = isRedeemEntry
        ? String(entry.toAccountName ?? "")
        : String(entry.accountName ?? "");
      const rawInstitution = isRedeemEntry ? toAccountInstitutionName : accountInstitutionName;
      const cashAccountLabel = [rawInstitution, rawAccountName]
        .filter(Boolean)
        .join(" · ") || rawAccountName || "-";

      return {
        id: String(entry.id ?? ""),
        date: String(entry.date ?? ""),
        typeLabel,
        productName,
        cashAccountLabel,
        cashAccountId,
        note: String(entry.note ?? ""),
        fundArrivalDate: entry.fundArrivalDate == null ? null : String(entry.fundArrivalDate).slice(0, 10),
        amount,
        businessLinkCount: Number(entry.businessLinkCount ?? 0),
        businessLinkLabels: Array.isArray(entry.businessLinkLabels)
          ? entry.businessLinkLabels.map(String).filter(Boolean)
          : [],
        coverageAmount:
          entry.coverageAmount == null ? null : Number(entry.coverageAmount),
        paymentTermYears:
          entry.paymentTermYears == null ? null : Number(entry.paymentTermYears),
        edit: {
          type: "investment",
          date: String(entry.date ?? ""),
          amount: Math.abs(rawAmount),
          note: String(entry.note ?? ""),
          fundArrivalDate: entry.fundArrivalDate == null ? null : String(entry.fundArrivalDate).slice(0, 10),
          accountId: isRedeemEntry
            ? String(entry.accountId ?? "")
            : String(entry.toAccountId ?? ""),
          cashAccountId: isRedeemEntry
            ? String(entry.toAccountId ?? "")
            : String(entry.accountId ?? ""),
          insuranceProductId:
            entry.insuranceProductId == null ? null : String(entry.insuranceProductId),
          insuranceAction,
          insuranceProductName: productName,
          source: "insurance",
        },
      };
    });
}

function buildInsuranceHoldings(
  t: (key: string) => string,
  products: InsuranceProductRow[],
  entries: InsuranceEntry[],
): InsuranceHolding[] {
  return products.map((product) => {
    const relatedEntries = entries.filter(
      (entry) => entry.edit?.insuranceProductId === product.id,
    );
    const sortedEntries = [...relatedEntries].sort((a, b) => a.date.localeCompare(b.date));
    const metricMode = normalizeInsuranceMetricMode(
      product.productType,
      product.accountingType,
      product.cashValueEnabled,
    );
    const balance = relatedEntries.reduce((sum, entry) => sum + insuranceCashValueDelta({
      amount: entry.amount,
      insuranceAction: entry.edit?.insuranceAction,
      fundSubtype: entry.edit?.insuranceAction === "refund" ? "redeem" : "buy",
      source: "insurance",
    }), 0);
    const totalPremium = relatedEntries
      .filter((entry) => entry.amount < 0)
      .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
    const lastPremiumEntry = [...relatedEntries]
      .filter((entry) => entry.amount < 0)
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    return {
      id: product.id,
      label: product.name,
      policyNo: product.policyNo ?? null,
      startDate: sortedEntries[0]?.date ?? product.startDate ?? null,
      ownerName: product.policyholderPersonName ?? product.ownerGroupName ?? "",
      policyholderPersonId: product.policyholderPersonId ?? null,
      insuredPersonName: product.insuredPersonName ?? product.insuredUserName ?? "",
      insuredPersonId: product.insuredPersonId ?? null,
      beneficiaryName: product.beneficiaryName ?? null,
      cashValue: metricMode === "coverage" ? null : balance,
      coverageAmount: product.coverageAmount ?? null,
      totalPremium,
      lastPremiumAmount: lastPremiumEntry ? Math.abs(lastPremiumEntry.amount) : null,
      status: product.status ?? null,
      statusLabel: statusLabel(t, product.status),
      frequencyLabel: frequencyLabel(t, product.premiumFrequencyMonths),
      paymentTermYears: product.paymentTermYears ?? null,
      coverageTermYears: product.coverageTermYears ?? null,
      institutionId: product.institutionId ?? null,
      institutionName: product.institutionName ?? null,
      ownerGroupId: product.ownerGroupId ?? null,
      productType: product.productType ?? null,
      accountingType: product.accountingType ?? null,
      currency: product.currency ?? null,
      accountId: product.accountId ?? null,
      premiumMode: product.premiumMode ?? null,
      premiumFrequencyMonths: product.premiumFrequencyMonths ?? null,
      cashValueEnabled: product.cashValueEnabled ?? null,
      effectiveDate: product.effectiveDate ?? null,
      maturityDate: product.maturityDate ?? null,
      note: product.note ?? null,
      relatedEntryIds: relatedEntries.map((entry) => entry.id),
    };
  });
}

function InsuranceEntryRecordsTable({
  columns,
  rows,
  hasSelectedHolding,
  cashAccounts,
  toolbarTitle,
  toolbarRightContent,
  onRowDoubleClick,
  rowActions,
}: {
  columns: AdvancedDataTableColumn<InsuranceEntry>[];
  rows: InsuranceEntry[];
  hasSelectedHolding: boolean;
  cashAccounts: InsuranceCashAccountOption[];
  toolbarTitle?: ReactNode;
  toolbarRightContent?: ReactNode;
  onRowDoubleClick: (entry: InsuranceEntry) => void;
  rowActions: (entry: InsuranceEntry) => ReactNode;
}) {
  const { t } = useI18n();
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const currentEntryIds = useMemo(() => rows.map((entry) => entry.id), [rows]);
  usePruneBasicDetailSelection(currentEntryIds);
  const accountOptions = useMemo(
    () => cashAccounts.map((account) => ({ id: account.id, label: account.label })),
    [cashAccounts],
  );

  return (
    <AdvancedDataTable
      storageKey="mmh_insurance_entries_table_v2"
      columns={columns}
      rows={rows}
      rowKey={(entry) => entry.id}
      minTableWidth={1020}
      emptyText={hasSelectedHolding ? t("insuranceShell.emptyRelatedEntries") : t("insuranceShell.selectPolicyFirst")}
      selectable
      fillHeight
      toolbarTitle={toolbarTitle}
      toolbarRightContent={toolbarRightContent}
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      onRowDoubleClick={onRowDoubleClick}
      rowActions={rowActions}
      rowActionsWidth={112}
      rowActionsMinWidth={92}
      batchActionSlot={
        <>
          <BasicDetailBatchReplaceButton
            accountOptions={accountOptions}
            fields={["date", "account", "remark"]}
            targetLabel={t("insuranceShell.entriesTitle")}
          />
          <BasicDetailBatchDeleteButton recordLabel={t("insuranceShell.entriesTitle")} />
        </>
      }
    />
  );
}

export function InsuranceShell({
  accountId,
  holdings,
  entries,
  familyMemberOptions = [],
  cashAccounts = [],
  cashAccountSSOptions = [],
}: {
  accountId: string;
  accountLabel: string;
  institutionName?: string;
  holdings: InsuranceHolding[];
  entries: InsuranceEntry[];
  familyMemberOptions?: SmartSelectOption[];
  cashAccounts?: InsuranceCashAccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
}) {
  const [refreshedEntries, setRefreshedEntries] = useState<InsuranceEntry[] | null>(null);
  const [refreshedHoldings, setRefreshedHoldings] = useState<InsuranceHolding[] | null>(null);
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | null>(null);
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [familyMemberOptionsState, setFamilyMemberOptionsState] =
    useState<SmartSelectOption[]>(familyMemberOptions);
  const familyMemberOptionsStateRef = useRef<SmartSelectOption[]>(familyMemberOptions);
  const [policyEditValue, setPolicyEditValue] =
    useState<InsurancePolicyEditValue | null>(null);
  const [policyEditMeta, setPolicyEditMeta] =
    useState<InsurancePolicyEditMeta | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [deletePolicyValue, setDeletePolicyValue] = useState<{
    readonly id: string;
    readonly name: string;
    readonly institutionName: string | null;
    readonly ownerName: string | null;
    readonly relatedEntryCount: number;
  } | null>(null);
  const [deletingPolicy, setDeletingPolicy] = useState(false);
  const [productEditValue, setProductEditValue] = useState<InsuranceProductEditValue | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [entryEditValue, setEntryEditValue] = useState<InsuranceEntryEditValue | null>(null);
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());
  const refreshSeq = useRef(0);
  const currentHoldingsRef = useRef<InsuranceHolding[]>(holdings);
  const familyMemberOptionsRef = useRef<SmartSelectOption[]>(familyMemberOptions);

  const { t, language } = useI18n();

  const currentEntries = refreshedEntries ?? entries;
  const currentHoldings = refreshedHoldings ?? holdings;

  useEffect(() => {
    currentHoldingsRef.current = currentHoldings;
  }, [currentHoldings]);

  useEffect(() => {
    familyMemberOptionsRef.current = familyMemberOptions;
  }, [familyMemberOptions]);

  useEffect(() => {
    familyMemberOptionsStateRef.current = familyMemberOptionsState;
  }, [familyMemberOptionsState]);

  const refreshInsuranceData = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const [detailRes, productsRes, accountsRes] = await Promise.all([
        fetch(
          `/api/v1/business-transactions/insurance?accountId=${encodeURIComponent(accountId)}`,
          { cache: "no-store" },
        ),
        fetch("/api/v1/insurance-products", { cache: "no-store" }),
        fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }),
      ]);
      const [detailData, productsData, accountsData] = await Promise.all([
        detailRes.json().catch(() => null),
        productsRes.json().catch(() => null),
        accountsRes.json().catch(() => null),
      ]);
      if (seq !== refreshSeq.current) return;
      if (!detailRes.ok || !detailData?.ok || !Array.isArray(detailData?.data?.entries)) {
        return;
      }
      if (!productsRes.ok || !productsData?.ok || !Array.isArray(productsData?.products)) {
        return;
      }

      const nextEntries = buildInsuranceEntries(t, detailData.data.entries);
      const nextProducts = (productsData.products as InsuranceProductRow[]).filter(
        (product) => product.accountId === accountId,
      );
      const previousHoldingsById = new Map(
        currentHoldingsRef.current.map((holding) => [holding.id, holding]),
      );
      const nextHoldings = buildInsuranceHoldings(t, nextProducts, nextEntries).map((holding) => {
        const previous = previousHoldingsById.get(holding.id);
        if (!previous) return holding;
        return {
          ...holding,
          policyNo: holding.policyNo ?? previous.policyNo ?? null,
          ownerName: holding.ownerName || previous.ownerName,
          policyholderPersonId:
            holding.policyholderPersonId ?? previous.policyholderPersonId ?? null,
          insuredPersonName: holding.insuredPersonName || previous.insuredPersonName,
          insuredPersonId: holding.insuredPersonId ?? previous.insuredPersonId ?? null,
          beneficiaryName: holding.beneficiaryName || previous.beneficiaryName,
          institutionName: holding.institutionName || previous.institutionName,
        };
      });

      const fetchedFamilyOptions = Array.isArray(accountsData?.institutions)
        ? accountsData.institutions
            .filter((item: { type?: string | null }) => item?.type === "family_member")
            .map((item: { id: string; name: string }) => ({
              id: String(item.id),
              label: String(item.name ?? ""),
              subLabel: t("institution.type.family_member"),
            }))
        : [];

      setFamilyMemberOptionsState(
        mergeFamilyMemberOptions(
          t,
          language,
          fetchedFamilyOptions.length > 0 ? fetchedFamilyOptions : familyMemberOptionsRef.current,
          nextHoldings.flatMap((holding) => [
            { id: holding.policyholderPersonId, name: holding.ownerName },
            { id: holding.insuredPersonId, name: holding.insuredPersonName },
            { id: null, name: holding.beneficiaryName },
          ]),
        ),
      );
      setRefreshedEntries(nextEntries);
      setRefreshedHoldings(nextHoldings);
    } catch {}
  }, [accountId, t, language]);

  const linkInsuranceCashFlow = useCallback(async (entry: InsuranceEntry) => {
    const id = String(entry.id ?? "").trim();
    if (!id || linkingIds.has(id)) return;
    const businessTransactionId = String(entry.businessTransactionId ?? "").trim();
    if (!businessTransactionId) {
      window.alert(t("insuranceShell.missingBusinessId"));
      return;
    }
    setLinkingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType: "insurance", businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("insuranceShell.linkFailed"));
      await refreshInsuranceData();
      dispatchFinanceDataChanged({ reason: "insurance-link-cash-flow", accountIds: [accountId], entryIds: [data.data?.cashEntryId, id].filter(Boolean) });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("insuranceShell.linkFailed"));
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [accountId, linkingIds, t, refreshInsuranceData]);

  useEffect(() => {
    setRefreshedEntries(null);
    setRefreshedHoldings(null);
    setSelectedHoldingId(null);
  }, [accountId]);

  useEffect(() => {
    setFamilyMemberOptionsState((previous) =>
      mergeFamilyMemberOptions(t, language, familyMemberOptions, [
        ...previous.map((item) => ({ id: item.id, name: item.label })),
        ...currentHoldings.flatMap((holding) => [
          { id: holding.policyholderPersonId, name: holding.ownerName },
          { id: holding.insuredPersonId, name: holding.insuredPersonName },
          { id: null, name: holding.beneficiaryName },
        ]),
      ]),
    );
  }, [currentHoldings, familyMemberOptions]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean }>).detail;
      // Remark-only edits do not change holdings: skip the shell refresh.
      if (detail?.balanceChanged === false) return;
      void refreshInsuranceData();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [refreshInsuranceData]);

  useEffect(() => {
    function onInsuranceEdit(event: Event) {
      const detail = (event as CustomEvent<{
        entryId: string;
        date: string;
        amount: number;
        note: string;
        accountId?: string;
        cashAccountId?: string;
        insuranceProductId?: string | null;
        insuranceAction?: InsuranceAction;
        fundArrivalDate?: string | null;
        insuranceProductName?: string;
        source?: string | null;
      }>).detail;
      const sourceEntry = currentEntries.find((entry) => entry.id === detail.entryId);
      if (!sourceEntry) return;
      setEntryEditValue({
        id: sourceEntry.id,
        date: detail.date,
        arrivalDate: detail.fundArrivalDate?.slice(0, 10) ?? sourceEntry.fundArrivalDate?.slice(0, 10) ?? detail.date,
        amount: String(detail.amount),
        cashAccountId: detail.cashAccountId ?? "",
        coverageAmount: sourceEntry.coverageAmount == null ? "" : String(sourceEntry.coverageAmount),
        paymentTermYears:
          sourceEntry.paymentTermYears == null ? "" : String(sourceEntry.paymentTermYears),
        note: detail.note ?? sourceEntry.note ?? "",
        insuranceAction: detail.insuranceAction ?? (sourceEntry.amount > 0 ? "refund" : "premium"),
        insuranceProductId: detail.insuranceProductId ? String(detail.insuranceProductId) : "",
        insuranceProductName: detail.insuranceProductName ?? sourceEntry.productName,
      });
    }

    window.addEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
    return () => window.removeEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
  }, [currentEntries]);

  useEffect(() => {
    void refreshInsuranceData();
  }, [refreshInsuranceData]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok || !Array.isArray(data?.institutions)) return;
        const nextOptions = data.institutions
          .filter((item: { type?: string | null }) => item?.type === "family_member")
          .map((item: { id: string; name: string }) => ({
            id: String(item.id),
            label: String(item.name ?? ""),
            subLabel: t("institution.type.family_member"),
          }));
        setFamilyMemberOptionsState((prev) =>
          mergeFamilyMemberOptions(
            t,
            language,
            nextOptions,
            prev.map((item) => ({ id: item.id, name: item.label })),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleHoldings = useMemo(
    () =>
      currentHoldings
        .filter((holding) => holding.relatedEntryIds.length > 0 || holding.status !== "lapsed")
        .filter((holding) => !showActiveOnly || holding.status === "active"),
    [currentHoldings, showActiveOnly],
  );

  const selectedHolding = useMemo(
    () => visibleHoldings.find((holding) => holding.id === selectedHoldingId) ?? null,
    [selectedHoldingId, visibleHoldings],
  );
  // Default to the first visible policy so related entries are visible on open.
  const initialInsuranceSelectionRef = useRef(false);
  useEffect(() => {
    if (initialInsuranceSelectionRef.current || selectedHoldingId || visibleHoldings.length === 0) return;
    initialInsuranceSelectionRef.current = true;
    setSelectedHoldingId(visibleHoldings[0].id);
  }, [selectedHoldingId, visibleHoldings]);
  const productEditOptions = useMemo<InsuranceProductEditOption[]>(
    () => currentHoldings.map((holding) => ({ id: holding.id, label: holding.label })),
    [currentHoldings],
  );
  const productEditInstitutions = useMemo<InsuranceProductEditInstitution[]>(
    () =>
      Array.from(
        new Map(
          currentHoldings
            .map((holding) => ({
              id: String(holding.institutionId ?? ""),
              label: String(holding.institutionName ?? ""),
            }))
            .filter((item) => item.id && item.label)
            .map((item) => [item.id, item] as const),
        ).values(),
      ).sort((a, b) => a.label.localeCompare(b.label, language)),
    [currentHoldings, language],
  );

  const visibleEntries = useMemo(() => {
    if (!selectedHolding) return [];
    const relatedIds = new Set(selectedHolding.relatedEntryIds);
    return currentEntries.filter((entry) => relatedIds.has(entry.id));
  }, [currentEntries, selectedHolding]);

  const openInsurancePaymentModal = useCallback((insuranceAction: "premium" | "additional_premium") => {
    if (!selectedHolding) return;
    const recentCashAccountId =
      [...visibleEntries]
        .reverse()
        .find((entry) => entry.amount < 0 && entry.cashAccountId)?.cashAccountId ??
      cashAccounts[0]?.id ??
      "";
    const defaultAmount =
      insuranceAction === "premium" && selectedHolding.lastPremiumAmount != null
        ? String(selectedHolding.lastPremiumAmount)
        : "";
    setEntryEditValue({
      id: "",
      date: todayLocalYmd(),
      arrivalDate: todayLocalYmd(),
      amount: defaultAmount,
      cashAccountId: recentCashAccountId,
      coverageAmount:
        selectedHolding.coverageAmount != null ? String(selectedHolding.coverageAmount) : "",
      paymentTermYears:
        selectedHolding.paymentTermYears != null ? String(selectedHolding.paymentTermYears) : "",
      note: "",
      insuranceAction,
      insuranceProductId: selectedHolding.id,
      insuranceProductName: selectedHolding.label,
    });
  }, [cashAccounts, selectedHolding, visibleEntries]);

  const holdingSummary = useMemo(() => {
    const totalCashValue = visibleHoldings.reduce(
      (sum, holding) => sum + (holding.cashValue ?? 0),
      0,
    );
    const totalCoverageAmount = visibleHoldings.reduce(
      (sum, holding) => sum + (holding.coverageAmount ?? 0),
      0,
    );
    const totalPremium = visibleHoldings.reduce(
      (sum, holding) => sum + (holding.totalPremium ?? 0),
      0,
    );
    return { totalCashValue, totalCoverageAmount, totalPremium };
  }, [visibleHoldings]);

  const holdingSummaryRow = useMemo<AdvancedDataTableSummaryRow>(
    () => ({
      cells: {
        name: <span className="font-semibold text-slate-800">{t("debtShell.summaryRow")}</span>,
        totalPremium: (
          <span className="font-semibold tabular-nums text-slate-800">
            {formatMoney(holdingSummary.totalPremium)}
          </span>
        ),
        cashValue: (
          <span className={`font-semibold tabular-nums ${amountClass(holdingSummary.totalCashValue)}`}>
            {formatMoney(holdingSummary.totalCashValue)}
          </span>
        ),
        coverageAmount: (
          <span className="font-semibold tabular-nums text-slate-800">
            {formatMoney(holdingSummary.totalCoverageAmount)}
          </span>
        ),
      },
      rowClassName: "bg-slate-50/80",
    }),
    [holdingSummary, t],
  );

  async function savePolicyEdit(next: InsurancePolicyEditValue) {
    const holding = currentHoldings.find((item) => item.id === next.id);
    if (!holding) {
      window.alert(t("insuranceShell.policyNotFound"));
      return;
    }

    const policyholderPersonId = next.policyholderPersonId.trim() || null;
    const insuredPersonId = next.insuredPersonId.trim() || null;
    const policyNo = next.policyNo.trim() || null;
    const effectiveDate = next.effectiveDate.trim() || null;
    const paymentTermYears = parseOptionalNumber(next.paymentTermYears);
    const coverageAmount = parseOptionalNumber(next.coverageAmount);

    setSavingPolicy(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: next.id,
          mode: "policy",
          policyNo,
          effectiveDate,
          policyholderPersonId,
          policyholderPersonName: policyholderPersonId
            ? familyMemberOptionsState.find((item) => item.id === policyholderPersonId)?.label?.trim() || undefined
            : undefined,
          insuredPersonId,
          insuredPersonName: insuredPersonId
            ? familyMemberOptionsState.find((item) => item.id === insuredPersonId)?.label?.trim() || undefined
            : undefined,
          paymentTermYears,
          coverageAmount,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("insuranceShell.savePolicyFailed"));
      }
      setPolicyEditValue(null);
      setPolicyEditMeta(null);
      dispatchFinanceDataChanged({ reason: "insurance-policy-save", accountIds: [accountId] });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("insuranceShell.savePolicyFailed"));
    } finally {
      setSavingPolicy(false);
    }
  }

  async function deletePolicyById(target: {
    id: string;
    relatedEntryCount: number;
  }, password?: string) {
    setDeletingPolicy(true);
    try {
      const response = await fetch(`/api/v1/insurance-products?id=${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        headers: target.relatedEntryCount > 0 ? { "Content-Type": "application/json" } : undefined,
        body:
          target.relatedEntryCount > 0
            ? JSON.stringify({ password: password ?? "", cascade: true })
            : undefined,
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("insuranceShell.deletePolicyFailed"));
      }
      setDeletePolicyValue(null);
      setPolicyEditValue(null);
      setPolicyEditMeta(null);
      setSelectedHoldingId(null);
      dispatchFinanceDataChanged({ reason: "insurance-policy-delete", accountIds: [accountId] });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("insuranceShell.deletePolicyFailed"));
    } finally {
      setDeletingPolicy(false);
    }
  }

  async function saveProductEdit(next: InsuranceProductEditValue) {
    const holding = currentHoldings.find((item) => item.id === next.id);
    if (!holding) {
      window.alert(t("insuranceShell.productNotFound"));
      return;
    }

    setSavingProduct(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...next,
          mode: "master",
          shortName: next.shortName.trim() || null,
          note: next.note.trim() || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("insuranceShell.saveProductFailed"));
      }
      setProductEditValue(null);
      dispatchFinanceDataChanged({ reason: "insurance-product-save", accountIds: [accountId] });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("insuranceShell.saveProductFailed"));
    } finally {
      setSavingProduct(false);
    }
  }

  const holdingColumns = useMemo<AdvancedDataTableColumn<InsuranceHolding>[]>(
    () => [
      {
        key: "name",
        label: t("insuranceShell.colPolicyName"),
        width: 240,
        minWidth: 160,
        filterText: (holding) => holding.label,
        sortValue: (holding) => holding.label,
        render: (holding) => (
          <span className="block truncate font-medium text-slate-700" title={holding.label}>
            {holding.label}
          </span>
        ),
      },
      {
        key: "policyNo",
        label: t("insuranceShell.colPolicyNo"),
        width: 140,
        minWidth: 96,
        hideable: true,
        filterText: (holding) => holding.policyNo ?? "",
        render: (holding) => (
          <span className="block truncate tabular-nums text-slate-600" title={holding.policyNo ?? ""}>
            {holding.policyNo || "-"}
          </span>
        ),
      },
      {
        key: "insuredPersonName",
        label: t("insuranceShell.colInsured"),
        width: 110,
        minWidth: 84,
        hideable: true,
        filterText: (holding) => holding.insuredPersonName ?? "",
        sortValue: (holding) => holding.insuredPersonName ?? "",
        render: (holding) => (
          <span className="truncate text-slate-600">{holding.insuredPersonName || "-"}</span>
        ),
      },
      {
        key: "ownerName",
        label: t("insuranceShell.colPolicyholder"),
        width: 110,
        minWidth: 84,
        hideable: true,
        filterText: (holding) => holding.ownerName ?? "",
        sortValue: (holding) => holding.ownerName ?? "",
        render: (holding) => (
          <span className="truncate text-slate-600">{holding.ownerName || "-"}</span>
        ),
      },
      {
        key: "startDate",
        label: t("insuranceShell.colStartDate"),
        width: 112,
        minWidth: 88,
        hideable: true,
        filterText: (holding) => holding.startDate ?? "",
        sortValue: (holding) => holding.startDate ?? "",
        render: (holding) => (
          <span className="tabular-nums text-slate-600">{holding.startDate || "-"}</span>
        ),
      },
      {
        key: "paymentTerm",
        label: t("insuranceShell.colPaymentTerm"),
        width: 96,
        minWidth: 74,
        align: "right",
        hideable: true,
        render: (holding) => (
          <span className="tabular-nums text-slate-600">
            {holding.paymentTermYears != null
              ? t("insuranceShell.paymentYears", { years: holding.paymentTermYears })
              : "-"}
          </span>
        ),
      },
      {
        key: "lastPremiumAmount",
        label: t("insuranceShell.colLastPremium"),
        width: 128,
        minWidth: 100,
        align: "right",
        hideable: true,
        sortValue: (holding) => holding.lastPremiumAmount ?? -1,
        render: (holding) => (
          <span className="font-semibold tabular-nums text-slate-700">
            {holding.lastPremiumAmount != null ? formatMoney(holding.lastPremiumAmount) : "-"}
          </span>
        ),
      },
      {
        key: "totalPremium",
        label: t("insuranceShell.colTotalPremium"),
        width: 120,
        minWidth: 92,
        align: "right",
        sortValue: (holding) => holding.totalPremium ?? 0,
        render: (holding) => (
          <span className="font-semibold tabular-nums text-slate-700">
            {formatMoney(holding.totalPremium ?? 0)}
          </span>
        ),
      },
      {
        key: "cashValue",
        label: t("insuranceShell.colCashValue"),
        width: 140,
        minWidth: 108,
        align: "right",
        render: (holding) => (
          <span className={`font-semibold tabular-nums ${amountClass(holding.cashValue ?? 0)}`}>
            {holding.cashValue != null ? formatMoney(holding.cashValue) : "-"}
          </span>
        ),
      },
      {
        key: "coverageAmount",
        label: t("insuranceOverview.totalCoverage"),
        width: 120,
        minWidth: 92,
        align: "right",
        hideable: true,
        render: (holding) => (
          <span className="font-semibold tabular-nums text-slate-700">
            {holding.coverageAmount != null ? formatMoney(holding.coverageAmount) : "-"}
          </span>
        ),
      },
      {
        key: "actions",
        label: "",
        width: 92,
        minWidth: 76,
        align: "right",
        hideable: true,
        render: (holding) => (
          <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 hover:text-blue-600"
              onClick={() => {
                setPolicyEditValue({
                  id: holding.id,
                  policyNo: holding.policyNo ?? "",
                  effectiveDate: holding.effectiveDate ?? holding.startDate ?? "",
                  policyholderPersonId:
                    holding.policyholderPersonId ??
                    familyMemberOptionsStateRef.current.find(
                      (item) => item.label.trim() === (holding.ownerName ?? "").trim(),
                    )?.id ??
                    "",
                  insuredPersonId: holding.insuredPersonId ?? "",
                  paymentTermYears:
                    holding.paymentTermYears != null ? String(holding.paymentTermYears) : "",
                  coverageAmount:
                    holding.coverageAmount != null ? String(holding.coverageAmount) : "",
                });
                setPolicyEditMeta({
                  name: holding.label,
                  institutionName: holding.institutionName ?? null,
                  ownerName: holding.ownerName ?? null,
                });
              }}
              title={t("insuranceShell.editButton")}
              aria-label={t("insuranceShell.editButton")}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-red-200 bg-white text-red-700 transition-colors hover:bg-red-50 hover:text-red-700"
              onClick={() => {
                setDeletePolicyValue({
                  id: holding.id,
                  name: holding.label,
                  institutionName: holding.institutionName ?? null,
                  ownerName: holding.ownerName ?? null,
                  relatedEntryCount: holding.relatedEntryIds.length,
                });
              }}
              title={t("depositShell.deleteButton")}
              aria-label={t("depositShell.deleteButton")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
      },
    ],
    [t],
  );

  const entryColumns = useMemo<AdvancedDataTableColumn<InsuranceEntry>[]>(
    () => [
      {
        key: "date",
        label: t("detail.column.date"),
        width: 100,
        minWidth: 80,
        filterText: (entry) => entry.date,
        render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span>,
      },
      {
        key: "action",
        label: t("depositShell.colAction"),
        width: 90,
        minWidth: 70,
        filterText: (entry) => entry.typeLabel,
        render: (entry) => (
          <span className="inline-flex items-center gap-1 text-slate-700">
            {entry.amount >= 0 ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownLeft className="h-3 w-3" />
            )}
            {entry.typeLabel}
          </span>
        ),
      },
      {
        key: "product",
        label: t("insuranceShell.colInsuranceName"),
        width: 220,
        minWidth: 140,
        filterText: (entry) => entry.productName,
        render: (entry) => (
          <span className="block truncate text-slate-700" title={entry.productName}>
            {entry.productName || "-"}
          </span>
        ),
      },
      {
        key: "cashAccount",
        label: t("txForm.cashAccount"),
        width: 180,
        minWidth: 120,
        hideable: true,
        filterText: (entry) => entry.cashAccountLabel,
        render: (entry) => (
          <span className="block truncate text-slate-600" title={entry.cashAccountLabel}>
            {entry.cashAccountLabel || "-"}
          </span>
        ),
      },
      {
        key: "amount",
        label: t("stats.amount"),
        width: 120,
        minWidth: 90,
        align: "right",
        render: (entry) => (
          <span className={`font-semibold tabular-nums ${amountClass(entry.amount)}`}>
            {formatMoney(entry.amount)}
          </span>
        ),
      },
      {
        key: "note",
        label: t("detail.column.remark"),
        width: 280,
        minWidth: 140,
        hideable: true,
        filterText: (entry) => entry.note,
        render: (entry) => (
          <span className="block truncate text-slate-600" title={entry.note}>
            {entry.note || "-"}
          </span>
        ),
      },
    ],
    [t],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey="mmh:insurance:split-height"
        hasLowerPane={!!selectedHolding}
        defaultUpperHeight={360}
        separatorLabel={t("insuranceShell.resizeLabel")}
        separatorTitle={t("insuranceShell.resizeTitle")}
      >
        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_insurance_holdings_table_v2"
              columns={holdingColumns}
              rows={visibleHoldings}
              rowKey={(holding) => holding.id}
              minTableWidth={1120}
              emptyText={t("insuranceShell.emptyHoldings")}
              showFilters={false}
              showColumnVisibilityButton
              fillHeight
              toolbarTitle={
                <span className="inline-flex items-center gap-2">
                  <Shield className="h-4 w-4 text-cyan-600" />
                  {t("insuranceShell.holdingsTitle")}
                </span>
              }
              toolbarRightContent={
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={showActiveOnly}
                    onChange={(event) => {
                      setShowActiveOnly(event.target.checked);
                      setSelectedHoldingId(null);
                    }}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  {t("insuranceShell.activeOnly")}
                </label>
              }
              summaryRow={holdingSummaryRow}
              onRowClick={(holding) =>
                setSelectedHoldingId((current) => (current === holding.id ? null : holding.id))
              }
              onRowDoubleClick={(holding) => {
                setProductEditValue({
                  id: holding.id,
                  name: holding.label,
                  shortName: "",
                  productType: holding.productType ?? "other",
                  accountingType: holding.accountingType ?? "asset",
                  currency: holding.currency ?? "CNY",
                  institutionId: holding.institutionId ?? "",
                  note: holding.note ?? "",
                });
              }}
              rowClassName={(holding) =>
                `cursor-pointer ${selectedHoldingId === holding.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`
              }
            />
          </div>
        </section>

        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <BasicDetailSelectionProvider
            resetKey={`${accountId}:${selectedHolding?.id ?? "none"}:insurance-entries`}
          >
            <BasicDetailBatchDeleteMessage />
            <div className="min-h-0 flex-1">
              <InsuranceEntryRecordsTable
                columns={entryColumns}
                rows={visibleEntries}
                hasSelectedHolding={!!selectedHolding}
                cashAccounts={cashAccounts}
                toolbarTitle={
                  <span className="inline-flex items-center gap-2">
                    <Shield className="h-4 w-4 text-blue-500" />
                    {t("insuranceShell.entriesTitle")}
                  </span>
                }
                toolbarRightContent={
                  <>
                    <Link
                      href={`/?accountId=${encodeURIComponent(accountId)}&view=detail&detailAll=1`}
                      className="secondary-button h-7 px-2 text-xs"
                    >
                      {t("insuranceShell.allTransactions")}
                    </Link>
                    <button
                      type="button"
                      className="secondary-button h-7 gap-1.5 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!selectedHolding}
                      onClick={() => openInsurancePaymentModal("premium")}
                      title={selectedHolding ? t("insuranceShell.renewalTitle") : t("insuranceShell.selectPolicyFirst")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("insuranceShell.renewal")}
                    </button>
                    <button
                      type="button"
                      className="secondary-button h-7 gap-1.5 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!selectedHolding}
                      onClick={() => openInsurancePaymentModal("additional_premium")}
                      title={selectedHolding ? t("insuranceShell.additionalPremiumTitle") : t("insuranceShell.selectPolicyFirst")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("insuranceShell.addPremium")}
                    </button>
                    <div className="text-xs text-slate-400">
                      {selectedHolding
                        ? t("depositShell.entryCountHint", { count: visibleEntries.length })
                        : t("insuranceShell.selectPolicyFirst")}
                    </div>
                  </>
                }
                onRowDoubleClick={(entry) => {
                  if (!entry.edit) return;
                  dispatchEntryEdit({ entryId: entry.id, edit: entry.edit });
                }}
                rowActions={(entry) => {
                  const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
                  const labels = entry.businessLinkLabels ?? [];
                  const title = hasBusinessLink
                    ? t("depositShell.linkedTitle", {
                        labels: labels.join("、") || t("depositShell.businessRecord"),
                      })
                    : t("depositShell.unlinkedTitle");
                  return (
                    <>
                      <BusinessLinkActionButton
                        active={hasBusinessLink}
                        title={title}
                        busy={linkingIds.has(entry.id)}
                        onClick={() => linkInsuranceCashFlow(entry)}
                      />
                      <EntryRowActions entryId={entry.id} edit={entry.edit} />
                    </>
                  );
                }}
              />
            </div>
          </BasicDetailSelectionProvider>
        </section>
      </ResizableVerticalSplit>

      <InsurancePolicyEditModal
        open={!!policyEditValue}
        saving={savingPolicy}
        value={policyEditValue}
        meta={policyEditMeta}
        familyMemberOptions={familyMemberOptionsState}
        onClose={() => {
          if (savingPolicy) return;
          setPolicyEditValue(null);
          setPolicyEditMeta(null);
        }}
        onChange={setPolicyEditValue}
        onSaved={savePolicyEdit}
      />
      <InsurancePolicyDeleteModal
        open={!!deletePolicyValue}
        value={deletePolicyValue}
        deleting={deletingPolicy}
        onClose={() => {
          if (deletingPolicy) return;
          setDeletePolicyValue(null);
        }}
        onDelete={async (password) => {
          if (!deletePolicyValue) return;
          if (deletePolicyValue.relatedEntryCount > 0 && !password.trim()) {
            window.alert(t("insuranceShell.passwordRequired"));
            return;
          }
          await deletePolicyById(deletePolicyValue, password);
        }}
      />
      <InsuranceProductEditModal
        open={!!productEditValue}
        saving={savingProduct}
        value={productEditValue}
        institutions={productEditInstitutions}
        products={productEditOptions}
        onClose={() => {
          if (savingProduct) return;
          setProductEditValue(null);
        }}
        onChange={setProductEditValue}
        onSaved={saveProductEdit}
      />
      <InsuranceEntryEditModal
        open={!!entryEditValue}
        value={entryEditValue}
        cashAccounts={cashAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        onClose={() => setEntryEditValue(null)}
        onSaved={async (next) => {
          setEntryEditValue(next);
          await refreshInsuranceData();
          dispatchFinanceDataChanged({ reason: "insurance-entry-save", accountIds: [accountId] });
        }}
      />
    </div>
  );
}


