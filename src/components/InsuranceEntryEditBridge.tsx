"use client";

import { useEffect, useState } from "react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

import {
  InsuranceEntryEditModal,
  type InsuranceEntryEditValue,
} from "./InsuranceEntryEditModal";
import type { SmartSelectOption } from "./SmartSelect";
import {
  getInsuranceAction,
  getInsuranceProductName,
  type InsuranceAction,
} from "@/lib/insurance/transaction";
import { useI18n } from "@/lib/i18n";

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

type InsuranceEditEventDetail = {
  requestId?: string;
  entryId: string;
  date?: string;
  amount?: number;
  note?: string;
  cashAccountId?: string;
  accountId?: string | null;
  toAccountId?: string | null;
  insuranceAction?: InsuranceAction;
  insuranceProductName?: string | null;
  insuranceProductId?: string | null;
};

function toDateString(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function toAmountString(value: unknown) {
  const amount = Math.abs(Number(value ?? 0));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "";
}

export function InsuranceEntryEditBridge({
  cashAccounts,
  cashAccountSSOptions,
  nestedFieldData,
}: {
  cashAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
}) {
  const [value, setValue] = useState<InsuranceEntryEditValue | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    let activeRequest = "";

    async function onInsuranceEdit(event: Event) {
      const detail = (event as CustomEvent<InsuranceEditEventDetail>).detail;
      if (!detail?.entryId) return;
      const requestId = detail.requestId ?? `${detail.entryId}-${Date.now()}`;
      activeRequest = requestId;
      setLoading(true);

      try {
        const response = await fetch(
          `/api/v1/transactions/detail?id=${encodeURIComponent(detail.entryId)}`,
          { cache: "no-store" },
        );
        const data = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: Record<string, any>; error?: string }
          | null;
        if (!response.ok || !data?.ok || !data.data) {
          throw new Error(data?.error || t("insuranceEntryEdit.loadFailed"));
        }
        if (activeRequest !== requestId) return;

        const entry = data.data;
        const sourceIsInsurance = entry.source === "insurance" || !!entry.insuranceProductId;
        if (!sourceIsInsurance) {
          throw new Error(t("insuranceEntryEdit.notInsuranceEntry"));
        }

        const insuranceAction = getInsuranceAction(entry);
        const isRedeem = insuranceAction === "refund";
        const cashAccountId =
          detail.cashAccountId ||
          (isRedeem ? entry.toAccountId : entry.accountId) ||
          "";

        setValue({
          id: String(entry.id),
          date: toDateString(entry.date ?? detail.date),
          amount: toAmountString(entry.amount ?? detail.amount),
          cashAccountId,
          coverageAmount: entry.coverageAmount == null ? "" : String(entry.coverageAmount),
          paymentTermYears: entry.paymentTermYears == null ? "" : String(entry.paymentTermYears),
          note: String(entry.note ?? detail.note ?? ""),
          insuranceAction,
          insuranceProductId: String(entry.insuranceProductId ?? detail.insuranceProductId ?? ""),
          insuranceProductName: getInsuranceProductName({
            source: "insurance",
            insuranceProductName: entry.insuranceProductName ?? detail.insuranceProductName ?? null,
            fundName: entry.fundName ?? null,
          }) || t("insuranceEntryEdit.defaultProductName"),
        });
      } catch (error) {
        window.alert(error instanceof Error ? error.message : t("insuranceEntryEdit.loadFailed"));
      } finally {
        if (activeRequest === requestId) setLoading(false);
      }
    }

    window.addEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
    return () => {
      activeRequest = "";
      window.removeEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
    };
  }, [t]);

  return (
    <>
      <InsuranceEntryEditModal
        open={!!value}
        value={value}
        cashAccounts={cashAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        nestedFieldData={nestedFieldData}
        onClose={() => {
          if (!loading) setValue(null);
        }}
        onSaved={async (next) => {
          setValue(next);
          dispatchFinanceDataChanged({ reason: "insurance-entry:save" });
        }}
      />
    </>
  );
}
