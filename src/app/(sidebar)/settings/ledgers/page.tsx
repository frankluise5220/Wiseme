"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, RefreshCw, Shield, X } from "lucide-react";
import { SettingsActionButton, SettingsPrimaryAddButton } from "@/components/settings/SettingsPageScaffold";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { useI18n } from "@/lib/i18n";

type Household = {
  id: string;
  name: string;
  createdAt?: string;
};

type CreateForm = {
  name: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  adminPasswordConfirm: string;
};

type SwitchForm = {
  householdId: string;
  username: string;
  password: string;
};

type DeleteForm = {
  householdId: string;
  confirmName: string;
  dbPassword: string;
};

type ApiResult = {
  ok?: boolean;
  error?: string;
};

const emptyCreateForm: CreateForm = {
  name: "",
  adminName: "",
  adminEmail: "",
  adminPassword: "",
  adminPasswordConfirm: "",
};

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function LedgerSettingsPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [active, setActive] = useState<Household | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSystem, setIsSystem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [switchForm, setSwitchForm] = useState<SwitchForm | null>(null);
  const [deleteForm, setDeleteForm] = useState<DeleteForm | null>(null);

  const activeId = active?.id ?? "";
  const activeName = getHouseholdDisplayName(active);
  const deleteTarget = useMemo(
    () => households.find((item) => item.id === deleteForm?.householdId) ?? null,
    [deleteForm?.householdId, households],
  );

  async function loadHouseholds() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/v1/households", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? t("settings.ledgers.loadFailed"));
      }
      setHouseholds(data.households ?? []);
      setActive(data.active ?? null);
      setIsAdmin(data.isAdmin === true);
      setIsSystem(data.isSystem === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.ledgers.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHouseholds();
  }, []);

  async function switchTo(householdId: string, username?: string, password?: string) {
    setBusy(`switch:${householdId}`);
    setError("");
    try {
      const res = await fetch("/api/v1/households/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ householdId, username, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? t("settings.ledgers.switchFailed"));
      }
      setSwitchForm(null);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.ledgers.switchFailed"));
    } finally {
      setBusy(null);
    }
  }

  function startSwitch(household: Household) {
    if (household.id === activeId) return;
    if (isAdmin) {
      void switchTo(household.id);
      return;
    }
    setError("");
    setSwitchForm({
      householdId: household.id,
      username: household.name,
      password: "",
    });
  }

  async function createLedger() {
    const name = createForm.name.trim();
    const adminName = createForm.adminName.trim() || name;
    const adminEmail = createForm.adminEmail.trim();
    if (!name) {
      setError(t("settings.ledgers.nameRequired"));
      return;
    }
    if (!adminName) {
      setError(t("settings.ledgers.adminNameRequired"));
      return;
    }
    if (!adminEmail) {
      setError(t("settings.ledgers.emailRequired"));
      return;
    }
    if (!createForm.adminPassword) {
      setError(t("settings.ledgers.passwordRequired"));
      return;
    }
    if (createForm.adminPassword !== createForm.adminPasswordConfirm) {
      setError(t("settings.ledgers.passwordMismatch"));
      return;
    }

    setBusy("create");
    setError("");
    try {
      const res = await fetch("/api/v1/households", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          adminName,
          adminEmail,
          adminPassword: createForm.adminPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? t("settings.ledgers.createFailed"));
      }
      setShowCreate(false);
      setCreateForm(emptyCreateForm);
      await loadHouseholds();
      await switchTo(data.household.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.ledgers.createFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function renameLedger(householdId: string) {
    const name = editName.trim();
    if (!name) {
      setError(t("settings.ledgers.nameRequired"));
      return;
    }
    setBusy(`rename:${householdId}`);
    setError("");
    try {
      const res = await fetch("/api/v1/households", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: householdId, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? t("settings.ledgers.renameFailed"));
      }
      setEditingId(null);
      setEditName("");
      await loadHouseholds();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.ledgers.renameFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function deleteLedger() {
    if (!deleteForm || !deleteTarget) return;
    const displayName = getHouseholdDisplayName(deleteTarget);
    if (deleteForm.confirmName.trim() !== displayName) {
      setError(t("settings.ledgers.confirmNameMismatch", { name: displayName }));
      return;
    }
    if (!deleteForm.dbPassword.trim()) {
      setError(t("settings.ledgers.currentPasswordRequired"));
      return;
    }
    setBusy(`delete:${deleteForm.householdId}`);
    setError("");
    try {
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deleteForm.dbPassword, verifySystem: true }),
      });
      const verifyData = await readApiResult(verifyRes, t);
      if (!verifyRes.ok || !verifyData.ok) {
        throw new Error(verifyData.error ?? t("settings.ledgers.verifyPasswordFailed"));
      }

      const res = await fetch("/api/v1/households", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteForm.householdId }),
      });
      const data = await readApiResult(res, t);
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? t("settings.ledgers.deleteFailed"));
      }
      setDeleteForm(null);
      await loadHouseholds();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.ledgers.deleteFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{t("settings.ledgers.title")}</h2>
          <p className="mt-1 text-xs text-slate-500">{t("settings.ledgers.description")}</p>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">{t("settings.ledgers.current")}</div>
            <div className="mt-1 text-xs text-slate-500">{active ? activeName : t("settings.ledgers.loading")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => loadHouseholds()}
              disabled={loading}
              className="secondary-button h-8 gap-1.5 px-2.5 text-xs disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {t("settings.ledgers.refresh")}
            </button>
            <SettingsPrimaryAddButton
              onClick={() => {
                setError("");
                setCreateForm(emptyCreateForm);
                setShowCreate(true);
              }}
            >
              {t("settings.ledgers.add")}
            </SettingsPrimaryAddButton>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="w-[36%] px-4 py-2 text-left">{t("settings.ledgers.name")}</th>
                <th className="w-[14%] px-3 py-2 text-left">{t("settings.ledgers.status")}</th>
                <th className="w-[24%] px-3 py-2 text-left">{t("settings.ledgers.createdAt")}</th>
                <th className="px-4 py-2 text-right">{t("settings.ledgers.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">{t("settings.ledgers.loadingRows")}</td>
                </tr>
              ) : households.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">{t("settings.ledgers.empty")}</td>
                </tr>
              ) : (
                households.map((household) => {
                  const isActive = household.id === activeId;
                  const isEditing = editingId === household.id;
                  const displayName = getHouseholdDisplayName(household);
                  const rowBusy = busy?.endsWith(household.id);
                  return (
                    <tr key={household.id} className={isActive ? "bg-blue-50/40" : undefined}>
                      <td className="px-4 py-2 align-middle">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void renameLedger(household.id);
                                if (event.key === "Escape") {
                                  setEditingId(null);
                                  setEditName("");
                                }
                              }}
                              autoFocus
                              className="form-input h-8"
                            />
                            <button
                              type="button"
                              onClick={() => renameLedger(household.id)}
                              disabled={rowBusy}
                              className="h-8 w-8 rounded-md border border-slate-200 bg-white text-emerald-700 hover:bg-slate-50 disabled:opacity-50"
                              title={t("common.save")}
                            >
                              <Check className="mx-auto h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null);
                                setEditName("");
                              }}
                              disabled={rowBusy}
                              className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                              title={t("common.cancel")}
                            >
                              <X className="mx-auto h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="font-medium text-slate-800">{displayName}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-middle">
                        {isActive ? (
                          <span className="inline-flex h-6 items-center rounded-full bg-blue-100 px-2 text-xs font-medium text-blue-700">{t("settings.ledgers.currentBadge")}</span>
                        ) : (
                          <span className="text-xs text-slate-400">{t("settings.ledgers.switchable")}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-middle text-xs text-slate-500">{formatDate(household.createdAt)}</td>
                      <td className="px-4 py-2 align-middle">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => startSwitch(household)}
                            disabled={isActive || rowBusy}
                            className="h-8 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {t("settings.ledgers.switch")}
                          </button>
                          {isAdmin ? (
                            <SettingsActionButton
                              label={t("settings.ledgers.editName")}
                              variant="edit"
                              onClick={() => {
                                setEditingId(household.id);
                                setEditName(displayName);
                              }}
                              disabled={rowBusy}
                            />
                          ) : null}
                          {isSystem ? (
                            <SettingsActionButton
                              label={isActive ? t("settings.ledgers.deleteDisabledHint") : t("settings.ledgers.delete")}
                              variant="delete"
                              onClick={() => {
                                setError("");
                                setDeleteForm({ householdId: household.id, confirmName: "", dbPassword: "" });
                              }}
                              disabled={isActive || households.length <= 1 || rowBusy}
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showCreate ? (
        <Modal title={t("settings.ledgers.add")} onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="form-label">{t("settings.ledgers.name")}</span>
                <input
                  value={createForm.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setCreateForm((prev) => ({ ...prev, name, adminName: prev.adminName === "" || prev.adminName === prev.name ? name : prev.adminName }));
                  }}
                  className="form-input"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5">
                <span className="form-label">{t("settings.ledgers.adminName")}</span>
                <input
                  value={createForm.adminName}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminName: event.target.value }))}
                  className="form-input"
                  placeholder={createForm.name || t("settings.ledgers.adminNamePlaceholder")}
                />
                <span className="text-xs text-slate-400">{t("settings.ledgers.adminNameHint")}</span>
              </label>
              <label className="grid gap-1.5 sm:col-span-2">
                <span className="form-label">{t("settings.ledgers.email")}</span>
                <input
                  type="email"
                  value={createForm.adminEmail}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminEmail: event.target.value }))}
                  className="form-input"
                  autoComplete="email"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="form-label">{t("settings.ledgers.adminPassword")}</span>
                <input
                  type="password"
                  value={createForm.adminPassword}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminPassword: event.target.value }))}
                  className="form-input"
                  autoComplete="new-password"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="form-label">{t("settings.ledgers.confirmPassword")}</span>
                <input
                  type="password"
                  value={createForm.adminPasswordConfirm}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminPasswordConfirm: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createLedger();
                  }}
                  className="form-input"
                  autoComplete="new-password"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} disabled={busy === "create"} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {t("common.cancel")}
              </button>
              <button type="button" onClick={createLedger} disabled={busy === "create"} className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {busy === "create" ? t("settings.ledgers.creating") : t("settings.ledgers.add")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {switchForm ? (
        <Modal title={t("settings.ledgers.switchTitle")} onClose={() => setSwitchForm(null)}>
          <div className="space-y-4">
            <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {t("settings.ledgers.switchTo", { name: getHouseholdDisplayName(households.find((item) => item.id === switchForm.householdId)) })}
            </div>
            <label className="grid gap-1.5">
              <span className="form-label">{t("settings.ledgers.targetAdminName")}</span>
              <input
                value={switchForm.username}
                onChange={(event) => setSwitchForm((prev) => prev ? { ...prev, username: event.target.value } : prev)}
                className="form-input"
                autoFocus
              />
            </label>
            <label className="grid gap-1.5">
              <span className="form-label">{t("settings.ledgers.password")}</span>
              <input
                type="password"
                value={switchForm.password}
                onChange={(event) => setSwitchForm((prev) => prev ? { ...prev, password: event.target.value } : prev)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void switchTo(switchForm.householdId, switchForm.username, switchForm.password);
                }}
                className="form-input"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSwitchForm(null)} disabled={busy?.startsWith("switch:")} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => switchTo(switchForm.householdId, switchForm.username, switchForm.password)} disabled={busy?.startsWith("switch:")} className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {t("settings.ledgers.confirmSwitch")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {deleteForm && deleteTarget ? (
        <Modal title={t("settings.ledgers.deleteTitle")} onClose={() => setDeleteForm(null)} tone="danger">
          <div className="space-y-4">
            <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              {t("settings.ledgers.deleteWarning", { name: getHouseholdDisplayName(deleteTarget) })}
            </div>
            <label className="grid gap-1.5">
              <span className="form-label">{t("settings.ledgers.confirmNameLabel")}</span>
              <input
                value={deleteForm.confirmName}
                onChange={(event) => setDeleteForm((prev) => prev ? { ...prev, confirmName: event.target.value } : prev)}
                className="form-input"
                autoFocus
              />
            </label>
            <label className="grid gap-1.5">
              <span className="form-label inline-flex items-center gap-1.5"><Shield className="h-3.5 w-3.5 text-amber-500" />{t("settings.ledgers.currentPasswordLabel")}</span>
              <input
                type="password"
                value={deleteForm.dbPassword}
                onChange={(event) => setDeleteForm((prev) => prev ? { ...prev, dbPassword: event.target.value } : prev)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void deleteLedger();
                }}
                className="form-input"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteForm(null)} disabled={busy?.startsWith("delete:")} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {t("common.cancel")}
              </button>
              <button type="button" onClick={deleteLedger} disabled={busy?.startsWith("delete:")} className="h-9 rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {t("settings.ledgers.confirmDelete")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

async function readApiResult(response: Response, t: (key: string, params?: Record<string, string | number>) => string): Promise<ApiResult> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(t("settings.ledgers.emptyResponse", { status: response.status }));
  }

  try {
    return JSON.parse(body) as ApiResult;
  } catch {
    throw new Error(t("settings.ledgers.invalidResponse", { status: response.status }));
  }
}

function Modal({
  title,
  children,
  onClose,
  tone = "default",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  tone?: "default" | "danger";
}) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className={`flex items-center justify-between border-b px-5 py-4 ${tone === "danger" ? "border-red-100 bg-red-50" : "border-slate-200 bg-slate-50"}`}>
          <div className={`text-sm font-semibold ${tone === "danger" ? "text-red-800" : "text-slate-800"}`}>{title}</div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md text-slate-500 hover:bg-white" title={t("settings.ledgers.close")}>
            <X className="mx-auto h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
