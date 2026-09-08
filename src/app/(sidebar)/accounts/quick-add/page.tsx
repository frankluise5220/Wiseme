"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

type T = (key: string, params?: Record<string, string | number>) => string;

type AccountKindValue = "bank_debit" | "bank_credit";

type Institution = {
  id: string;
  name: string;
  type?: string | null;
};

type Group = {
  id: string;
  name: string;
  sortOrder?: number;
};

type Account = {
  id: string;
  name: string;
  kind: string;
  institutionId: string | null;
  Institution?: { id: string; name: string } | null;
};

type LoadResult = {
  ok: boolean;
  accounts?: Account[];
  groups?: Group[];
  institutions?: Institution[];
  error?: string;
};

// Preset bank names are institution data, not UI copy; they are stored and
// displayed as-is.
const BANK_NAMES = [
  "中国工商银行",
  "中国建设银行",
  "中国农业银行",
  "中国银行",
  "交通银行",
  "招商银行",
  "邮储银行",
  "中信银行",
  "兴业银行",
  "浦发银行",
  "民生银行",
  "光大银行",
  "平安银行",
  "广发银行",
  "华夏银行",
  "北京银行",
  "上海银行",
  "江苏银行",
  "宁波银行",
];

const KIND_VALUES: AccountKindValue[] = ["bank_debit", "bank_credit"];

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function kindOptions(t: T): { value: AccountKindValue; label: string }[] {
  return KIND_VALUES.map((value) => ({ value, label: t(`account.kind.${value}`) }));
}

function accountName(t: T, kind: AccountKindValue, last4: string) {
  const label = kindOptions(t).find((item) => item.value === kind)?.label ?? t("accountsQuickAdd.accountKindFallback");
  return `${label}${last4}`;
}

export default function QuickAddAccountsPage() {
  const { t } = useI18n();
  const kindOptionsList = useMemo(() => kindOptions(t), [t]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedBanks, setSelectedBanks] = useState<string[]>([]);
  const [selectedKinds, setSelectedKinds] = useState<AccountKindValue[]>(["bank_debit"]);
  const [last4, setLast4] = useState("");
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadAll() {
    setLoading(true);
    setError("");
    const res = await fetch("/api/v1/accounts/internal?balances=false").catch(() => null);
    if (!res) {
      setError(t("accountsQuickAdd.error.loadFailed"));
      setLoading(false);
      return;
    }
    const data = (await res.json().catch(() => ({ ok: false, error: t("accountsQuickAdd.error.invalidResponse") }))) as LoadResult;
    if (!data.ok) {
      setError(data.error || t("accountsQuickAdd.error.loadAccountsFailed"));
      setLoading(false);
      return;
    }
    const nextGroups = data.groups ?? [];
    setInstitutions(data.institutions ?? []);
    setGroups(nextGroups);
    setAccounts(data.accounts ?? []);
    setGroupId((current) => current || nextGroups[0]?.id || "");
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const bankOptions = useMemo(() => {
    const existingBankNames = institutions
      .filter((item) => !item.type || item.type === "bank")
      .map((item) => item.name.trim())
      .filter(Boolean);
    return Array.from(new Set([...BANK_NAMES, ...existingBankNames])).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [institutions]);

  const previewRows = useMemo(() => {
    const rows: { bankName: string; kind: AccountKindValue; name: string; exists: boolean }[] = [];
    const institutionByName = new Map(institutions.map((item) => [normalizeName(item.name), item]));
    for (const bankName of selectedBanks) {
      const institution = institutionByName.get(normalizeName(bankName));
      for (const kind of selectedKinds) {
        const name = accountName(t, kind, last4.trim());
        const exists = accounts.some((account) => account.kind === kind && account.name.trim() === name && (institution ? account.institutionId === institution.id : account.Institution?.name === bankName));
        rows.push({ bankName, kind, name, exists });
      }
    }
    return rows;
  }, [accounts, institutions, last4, selectedBanks, selectedKinds, t]);

  function toggleBank(bankName: string) {
    setSelectedBanks((prev) => prev.includes(bankName) ? prev.filter((item) => item !== bankName) : [...prev, bankName]);
  }

  function toggleKind(kind: AccountKindValue) {
    setSelectedKinds((prev) => prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind]);
  }

  async function ensureInstitution(bankName: string) {
    const existing = institutions.find((item) => normalizeName(item.name) === normalizeName(bankName));
    if (existing) return existing;

    const res = await fetch("/api/v1/institution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: bankName, type: "bank" }),
    }).catch(() => null);
    if (!res) throw new Error(t("accountsQuickAdd.error.institutionCreateFailedNetwork", { name: bankName }));
    const data = await res.json().catch(() => ({ ok: false, error: t("accountsQuickAdd.error.invalidResponse") }));
    if (!data.ok || !data.institution?.id) throw new Error(data.error || t("accountsQuickAdd.error.institutionCreateFailed", { name: bankName }));
    const created = data.institution as Institution;
    setInstitutions((prev) => [...prev, created]);
    return created;
  }

  async function createAccount(institution: Institution, kind: AccountKindValue, name: string) {
    const fullName = `${institution.name}·${name}`;
    const res = await fetch("/api/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind, groupId, institutionId: institution.id }),
    }).catch(() => null);
    if (!res) throw new Error(t("accountsQuickAdd.error.accountCreateFailedNetwork", { name: fullName }));
    const data = await res.json().catch(() => ({ ok: false, error: t("accountsQuickAdd.error.invalidResponse") }));
    if (!data.ok) throw new Error(t("accountsQuickAdd.error.accountCreateFailedDetail", { name: fullName, error: data.error || t("accountsQuickAdd.error.unknown") }));
    return data.account as Account;
  }

  async function handleSubmit() {
    const safeLast4 = last4.trim();
    setMessage("");
    setError("");
    if (selectedBanks.length === 0) {
      setError(t("accountsQuickAdd.error.selectBankRequired"));
      return;
    }
    if (selectedKinds.length === 0) {
      setError(t("accountsQuickAdd.error.selectKindRequired"));
      return;
    }
    if (!/^\d{4}$/.test(safeLast4)) {
      setError(t("accountsQuickAdd.error.invalidLast4"));
      return;
    }

    setSubmitting(true);
    try {
      let createdCount = 0;
      let skippedCount = 0;
      const createdAccounts: Account[] = [];
      const institutionByName = new Map(institutions.map((item) => [normalizeName(item.name), item]));

      for (const bankName of selectedBanks) {
        const institution = institutionByName.get(normalizeName(bankName)) ?? await ensureInstitution(bankName);
        institutionByName.set(normalizeName(bankName), institution);
        for (const kind of selectedKinds) {
          const name = accountName(t, kind, safeLast4);
          const exists = [...accounts, ...createdAccounts].some((account) => account.kind === kind && account.name.trim() === name && account.institutionId === institution.id);
          if (exists) {
            skippedCount++;
            continue;
          }
          const created = await createAccount(institution, kind, name);
          createdAccounts.push({ ...created, institutionId: institution.id, Institution: { id: institution.id, name: institution.name } });
          createdCount++;
        }
      }

      setAccounts((prev) => [...prev, ...createdAccounts]);
      setMessage(
        skippedCount > 0
          ? t("accountsQuickAdd.success.createdWithSkipped", { created: createdCount, skipped: skippedCount })
          : t("accountsQuickAdd.success.createdOnly", { created: createdCount }),
      );
      dispatchFinanceDataChanged({ reason: "quick-add-accounts" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accountsQuickAdd.error.batchFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <div className="mx-auto max-w-5xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500">{t("accountsQuickAdd.breadcrumb")}</div>
            <h1 className="text-lg font-semibold text-slate-900">{t("accountsQuickAdd.title")}</h1>
          </div>
          <Link href="/accounts" className="h-9 px-3 inline-flex items-center rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">
            {t("accountsQuickAdd.backToAccounts")}
          </Link>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-slate-800">{t("accountsQuickAdd.selectBank")}</div>
                  <div className="text-xs text-slate-500">{t("accountsQuickAdd.selectBankHint")}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedBanks(selectedBanks.length === bankOptions.length ? [] : bankOptions)}
                  className="h-8 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50"
                >
                  {selectedBanks.length === bankOptions.length ? t("accountsQuickAdd.clearSelection") : t("accountsQuickAdd.selectAllBanks")}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                {bankOptions.map((bankName) => (
                  <label key={bankName} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${selectedBanks.includes(bankName) ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                    <input type="checkbox" checked={selectedBanks.includes(bankName)} onChange={() => toggleBank(bankName)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                    <span>{bankName}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-4 rounded-lg border border-slate-100 bg-slate-50 p-3">
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-800">{t("accountsQuickAdd.accountType")}</div>
                {kindOptionsList.map((item) => (
                  <label key={item.value} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${selectedKinds.includes(item.value) ? "border-blue-200 bg-white text-blue-700" : "border-slate-200 bg-white text-slate-700"}`}>
                    <input type="checkbox" checked={selectedKinds.includes(item.value)} onChange={() => toggleKind(item.value)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>

              <div className="space-y-1.5">
                <div className="text-sm font-medium text-slate-800">{t("accountsQuickAdd.last4Label")}</div>
                <input
                  value={last4}
                  onChange={(event) => setLast4(event.target.value.replace(/\D/g, "").slice(0, 4))}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={t("accountsQuickAdd.last4Placeholder")}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300"
                />
              </div>

              <div className="space-y-1.5">
                <div className="text-sm font-medium text-slate-800">{t("accountsQuickAdd.owner")}</div>
                <select value={groupId} onChange={(event) => setGroupId(event.target.value)} className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300">
                  <option value="">{t("accountsQuickAdd.defaultOwner")}</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading || submitting}
                className="h-10 w-full rounded-md bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {submitting ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{t("accountsQuickAdd.generating")}</span> : t("accountsQuickAdd.submit")}
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-slate-800">{t("accountsQuickAdd.previewTitle")}</div>
              <div className="text-xs text-slate-500">{t("accountsQuickAdd.previewHint")}</div>
            </div>
            <div className="text-xs text-slate-500">{t("accountsQuickAdd.pendingCombinations", { count: previewRows.length })}</div>
          </div>

          {loading ? (
            <div className="py-8 text-center text-sm text-slate-500">{t("accountsQuickAdd.loading")}</div>
          ) : previewRows.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">{t("accountsQuickAdd.emptyPreview")}</div>
          ) : (
            <div className="overflow-auto rounded-lg border border-slate-100">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("accountsQuickAdd.col.bank")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("accountsQuickAdd.col.type")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("accountsQuickAdd.col.accountName")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("accountsQuickAdd.col.status")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {previewRows.map((row) => (
                    <tr key={`${row.bankName}-${row.kind}`}>
                      <td className="px-3 py-2 text-slate-700">{row.bankName}</td>
                      <td className="px-3 py-2 text-slate-700">{kindOptionsList.find((item) => item.value === row.kind)?.label}</td>
                      <td className="px-3 py-2 text-slate-700">{row.name}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.exists ? <span className="text-amber-600">{t("accountsQuickAdd.status.exists")}</span> : <span className="text-emerald-600">{t("accountsQuickAdd.status.creatable")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {message && <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />{message}</div>}
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      </div>
    </div>
  );
}
