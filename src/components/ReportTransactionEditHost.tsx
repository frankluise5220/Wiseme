"use client";

import type { SmartSelectOption } from "@/components/SmartSelect";
import { DepositFormModal } from "@/components/DepositFormModal";
import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import { WealthFormModal } from "@/components/WealthFormModal";
import { useI18n } from "@/lib/i18n";

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  kind?: string;
  investProductType?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  currency?: string | null;
};

type CategoryOption = {
  id: string;
  label: string;
  parentId: string | null;
  type: string;
};

type TagOption = { id: string; name: string; color?: string | null };
type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function numericFormValue(formData: FormData, key: string) {
  return Number(formValue(formData, key).replace(/,/g, ""));
}

function savedTypeMatchesSubmitted(submittedType: string, savedType: string, savedSource: string) {
  if (!submittedType || !savedType) return true;
  if (submittedType === savedType) return true;
  return submittedType === "advance" && savedType === "transfer" && savedSource === "advance";
}

export function ReportTransactionEditHost({
  accounts,
  accountSSOptions,
  cashAccounts,
  investmentAccounts,
  cashAccountSSOptions,
  investmentAccountSSOptions,
  expenseCategories,
  incomeCategories,
  tags,
  nestedFieldData,
}: {
  accounts: AccountOption[];
  accountSSOptions: SmartSelectOption[];
  cashAccounts: AccountOption[];
  investmentAccounts: AccountOption[];
  cashAccountSSOptions: SmartSelectOption[];
  investmentAccountSSOptions: SmartSelectOption[];
  expenseCategories: CategoryOption[];
  incomeCategories: CategoryOption[];
  tags: TagOption[];
  nestedFieldData: NestedFieldData;
}) {
  const { t } = useI18n();

  async function updateEntry(formData: FormData): Promise<{ ok: true } | { ok: false; error: string }> {
    const entryId = formValue(formData, "entryId");
    if (!entryId) return { ok: false, error: t("reportTxEdit.missingEntryId") };

    let tagIds: string[] = [];
    try {
      const parsed = JSON.parse(formValue(formData, "tagIds") || "[]");
      if (Array.isArray(parsed)) tagIds = parsed.filter((id): id is string => typeof id === "string" && Boolean(id));
    } catch {
      return { ok: false, error: t("reportTxEdit.invalidTags") };
    }

    const submittedType = formValue(formData, "type");
    const response = await fetch("/api/v1/transactions/detail", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: entryId,
        type: submittedType,
        date: formValue(formData, "date"),
        postedAt: formValue(formData, "postedAt"),
        amount: numericFormValue(formData, "amount"),
        accountId: formValue(formData, "accountId"),
        fromAccountId: formValue(formData, "fromAccountId"),
        toAccountId: formValue(formData, "toAccountId"),
        categoryId: formValue(formData, "categoryId"),
        counterpartyInstitutionId: formValue(formData, "counterpartyInstitutionId"),
        note: formValue(formData, "note"),
        toNote: formValue(formData, "toNote"),
        tagIds,
      }),
    });
    const result = await response.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      data?: { type?: string | null; source?: string | null };
    } | null;
    if (!response.ok || !result?.ok) {
      return { ok: false, error: result?.error || response.statusText || t("reportTxEdit.saveFailed") };
    }
    const savedType = String(result.data?.type ?? "").trim();
    const savedSource = String(result.data?.source ?? "").trim();
    if (!savedTypeMatchesSubmitted(submittedType, savedType, savedSource)) {
      return { ok: false, error: t("reportTxEdit.typeNotChanged", { saved: savedType, submitted: submittedType }) };
    }
    return { ok: true };
  }

  async function updateInvestment(formData: FormData): Promise<{ ok: true } | { ok: false; error: string }> {
    const entryId = formValue(formData, "entryId");
    if (!entryId) return { ok: false, error: t("reportTxEdit.missingEntryId") };

    const payload: Record<string, string> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") payload[key] = value;
    });
    const response = await fetch("/api/v1/transactions/detail", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        id: entryId,
        type: "investment",
        fundSubtype: payload.subtype || payload.fundSubtype || "buy",
        note: payload.note || payload.memo || "",
      }),
    });
    const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    return response.ok && result?.ok
      ? { ok: true }
      : { ok: false, error: result?.error || response.statusText || t("reportTxEdit.saveFailed") };
  }

  return (
    <>
      <TransactionFormModal
        accounts={accounts}
        transferAccounts={accounts}
        accountSSOptions={accountSSOptions}
        transferAccountSSOptions={accountSSOptions}
        expenseCategories={expenseCategories}
        incomeCategories={incomeCategories}
        advanceCategories={expenseCategories}
        action={updateEntry}
        editAction={updateEntry}
        allTags={tags}
        nestedFieldData={nestedFieldData}
        hideTrigger
      />
      <InvestmentFormModal
        mode="edit"
        hideTrigger
        accountId={investmentAccounts[0]?.id ?? ""}
        cashAccounts={cashAccounts}
        investmentAccounts={investmentAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        investmentAccountSSOptions={investmentAccountSSOptions}
        nestedFieldData={nestedFieldData}
        createAction={updateInvestment}
        editAction={updateInvestment}
      />
      <WealthFormModal
        mode="edit"
        accountId={investmentAccounts[0]?.id ?? ""}
        cashAccounts={cashAccounts}
        investmentAccounts={investmentAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        investmentAccountSSOptions={investmentAccountSSOptions}
        nestedFieldData={nestedFieldData}
        createAction={updateInvestment}
        editAction={updateInvestment}
      />
      <DepositFormModal
        mode="edit"
        accountId={investmentAccounts[0]?.id ?? ""}
        cashAccounts={cashAccounts}
        investmentAccounts={investmentAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        investmentAccountSSOptions={investmentAccountSSOptions}
        nestedFieldData={nestedFieldData}
        createAction={updateInvestment}
        editAction={updateInvestment}
      />
    </>
  );
}
