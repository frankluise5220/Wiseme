"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsPageHeader,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { SESSION_DAY_OPTIONS } from "@/lib/session-days";
import { useI18n } from "@/lib/i18n";

type ManagedUser = {
  id: string;
  name: string;
  email?: string | null;
  role: string;
  isSystem?: boolean;
  hasPassword?: boolean;
  sessionDays?: number;
  createdAt?: string;
};

function UserModal({
  initial,
  onSave,
  onCancel,
  users,
}: {
  initial?: ManagedUser;
  onSave: (data: { name: string; email?: string; role: string; password?: string }) => void;
  onCancel: () => void;
  users: ManagedUser[];
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [role, setRole] = useState(initial?.role ?? "user");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const isSystemUser = initial?.isSystem ?? false;
  const hasExistingPassword = initial?.hasPassword ?? false;
  const isEditing = !!initial;

  // Whether this is the last admin of the current ledger and is being demoted.
  const isLastAdmin = initial?.role === "admin" && users.filter(u => u.role === "admin").length <= 1;

  function validate(): string | null {
    if (!name.trim()) return t("settings.users.error.usernameRequired");
    if (!isEditing) {
      if (!password && !confirmPassword) return t("settings.users.error.passwordRequired");
      if (password !== confirmPassword) return t("settings.users.error.passwordMismatch");
    } else {
      // When editing, both password fields must match if either was filled in.
      if (password || confirmPassword) {
        if (password !== confirmPassword) return t("settings.users.error.passwordMismatch");
      }
    }
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) { setError(err); return; }
    setError("");
    onSave({ name: name.trim(), email: email.trim() || undefined, role, password: password.trim() || undefined });
  }

  return (
    <div className="app-modal-backdrop z-[1100]">
      <div className="app-modal-panel max-w-md">
        <div className="modal-header shrink-0">
          <div className="text-sm font-semibold text-slate-800">{isEditing ? t("settings.users.modalTitleEdit") : t("settings.users.modalTitleAdd")}</div>
          <button type="button" onClick={onCancel} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.users.field.username")}</label>
            <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder={t("settings.users.placeholder.username")} value={name} onChange={(e) => { setName(e.target.value); setError(""); }} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.users.field.recoveryEmail")}</label>
            <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder={t("settings.users.placeholder.recoveryEmail")} value={email ?? ""} onChange={(e) => { setEmail(e.target.value); setError(""); }} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.users.field.role")}</label>
            <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:opacity-60 disabled:bg-slate-50"
              value={role} onChange={(e) => setRole(e.target.value)} disabled={isSystemUser}>
              <option value="admin">{t("settings.users.roleOptionAdmin")}</option>
              <option value="user">{t("settings.users.roleOptionUser")}</option>
              <option value="viewer">{t("settings.users.roleOptionViewer")}</option>
            </select>
            {isSystemUser && <div className="mt-1 text-[11px] text-slate-500">{t("settings.users.systemRoleFixed")}</div>}
            {isLastAdmin && !isSystemUser && <div className="mt-1 text-[11px] text-amber-600">{t("settings.users.lastAdminWarning")}</div>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              {isEditing ? (hasExistingPassword ? t("settings.users.password.edit") : t("settings.users.password.set")) : t("settings.users.password.label")}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 pr-10 text-sm outline-none"
                placeholder={isEditing ? (hasExistingPassword ? t("settings.users.placeholder.passwordKeep") : t("settings.users.placeholder.passwordNew")) : t("settings.users.password.set")}
                value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }}
              />
              <button type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 select-none"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? t("settings.users.password.hide") : t("settings.users.password.show")}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              {isEditing ? t("settings.users.confirmPassword.edit") : t("settings.users.confirmPassword.label")}
            </label>
            <input
              type={showPassword ? "text" : "password"}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder={t("settings.users.placeholder.confirmPassword")}
              value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(""); }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="secondary-button h-9 px-4" onClick={onCancel}>{t("common.cancel")}</button>
            <button className="primary-button h-9 px-4 disabled:opacity-50"
              onClick={handleSubmit} disabled={!name.trim()}>
              {isEditing ? t("common.save") : t("settings.users.add")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [savingSessionUserId, setSavingSessionUserId] = useState("");

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    try {
      const res = await fetch("/api/v1/settings/users");
      const text = await res.text();
      let data: { ok?: boolean; users?: ManagedUser[]; canManageUsers?: boolean; error?: string } | { raw: string } = { raw: "" };
      try {
        data = JSON.parse(text) as { ok?: boolean; users?: ManagedUser[]; canManageUsers?: boolean; error?: string };
      } catch {
        data = { raw: text.slice(0, 200) };
      }
      if ("ok" in data && data.ok && Array.isArray(data.users)) {
        setUsers(data.users);
        setCanManageUsers(data.canManageUsers === true);
        setLoadError("");
      } else {
        setUsers([]);
        setCanManageUsers(false);
        const hint = "ok" in data ? (data.error || t("settings.users.requestFailed", { status: res.status })) : t("settings.users.requestFailed", { status: res.status });
        setLoadError(hint);
      }
    } catch {
      setUsers([]);
      setCanManageUsers(false);
      setLoadError(t("settings.users.networkError"));
    }
  }

  async function handleSave(data: { name: string; email?: string; role: string; password?: string }) {
    try {
      const url = "/api/v1/settings/users";
      const body = editingUser
        ? { id: editingUser.id, name: data.name, email: data.email ?? "", role: data.role, password: data.password }
        : data;
      const res = await fetch(url, {
        method: editingUser ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => null);
      if (result?.ok) {
        await fetchUsers();
        setShowModal(false);
        setEditingUser(null);
      } else {
        window.alert(result?.error || (editingUser ? t("settings.users.updateFailed") : t("settings.users.addFailed")));
      }
    } catch { window.alert(editingUser ? t("settings.users.updateFailed") : t("settings.users.addFailed")); }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    if (!deletePassword.trim()) {
      setDeleteError(t("settings.users.delete.passwordRequired"));
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/v1/settings/users?id=${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePassword }),
      });
      const result = await res.json().catch(() => null);
      if (result?.ok) {
        setDeleteTarget(null);
        setDeletePassword("");
        await fetchUsers();
      } else {
        setDeleteError(result?.error || t("settings.users.deleteFailed"));
      }
    } catch {
      setDeleteError(t("settings.users.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function saveUserSessionDays(user: ManagedUser, next: number) {
    const prevUsers = users;
    setSavingSessionUserId(user.id);
    setUsers((items) => items.map((item) => item.id === user.id ? { ...item, sessionDays: next } : item));
    try {
      const res = await fetch("/api/v1/settings/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, sessionDays: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setUsers(prevUsers);
        window.alert(data.error || t("settings.users.saveFailed"));
      }
    } catch {
      setUsers(prevUsers);
      window.alert(t("settings.users.saveFailed"));
    } finally {
      setSavingSessionUserId("");
    }
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.users.title")}
        description={t("settings.users.description")}
        count={users.length}
      />

      {loadError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      <SettingsSection
        title={t("settings.users.list")}
        count={users.length}
        actions={
          canManageUsers ? (
            <SettingsPrimaryAddButton onClick={() => { setEditingUser(null); setShowModal(true); }}>
              {t("settings.users.add")}
            </SettingsPrimaryAddButton>
          ) : null
        }
      >
        <SettingsTable minWidth={820} maxWidth="full">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[28%]" />
            <col className="w-[16%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>{t("settings.users.col.user")}</SettingsTh>
              <SettingsTh>{t("settings.users.col.email")}</SettingsTh>
              <SettingsTh>{t("settings.users.col.session")}</SettingsTh>
              <SettingsTh>{t("settings.users.col.role")}</SettingsTh>
              <SettingsTh>{t("settings.users.col.status")}</SettingsTh>
              <SettingsTh align="right">{t("settings.users.col.actions")}</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {users.length > 0 ? users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50">
                <SettingsTd className="text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-800">{u.name}</div>
                  </div>
                </SettingsTd>
                <SettingsTd className="text-sm">
                  <div className="truncate text-slate-600">{u.email || "—"}</div>
                </SettingsTd>
                <SettingsTd>
                  <select
                    value={u.sessionDays ?? 30}
                    onChange={(event) => void saveUserSessionDays(u, Number(event.target.value))}
                    disabled={!canManageUsers || savingSessionUserId === u.id}
                    className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none disabled:opacity-60"
                    title={t("settings.users.sessionDaysTitle")}
                  >
                    {SESSION_DAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </SettingsTd>
                <SettingsTd>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${
                    u.role === "admin"
                      ? "bg-blue-50 text-blue-700"
                      : u.role === "viewer"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-slate-100 text-slate-500"
                  }`}>
                    {u.role === "admin"
                      ? t("settings.users.role.admin")
                      : u.role === "viewer"
                        ? t("settings.users.role.viewer")
                        : t("settings.users.role.user")}
                  </span>
                </SettingsTd>
                <SettingsTd>
                  {u.isSystem ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">{t("settings.users.status.system")}</span>
                  ) : (
                    <span className="text-xs text-slate-400">{t("settings.users.status.normal")}</span>
                  )}
                </SettingsTd>
                <SettingsTd align="right">
                  {canManageUsers ? (
                    <SettingsRowActions>
                      <SettingsActionButton
                        label={t("settings.users.edit")}
                        variant="edit"
                        onClick={() => { setEditingUser(u); setShowModal(true); }}
                      />
                      {!u.isSystem ? (
                        <SettingsActionButton
                          label={t("settings.users.delete")}
                          variant="delete"
                          onClick={() => {
                            setDeleteTarget(u);
                            setDeletePassword("");
                            setDeleteError("");
                          }}
                        />
                      ) : null}
                    </SettingsRowActions>
                  ) : null}
                </SettingsTd>
              </tr>
            )) : (
              <SettingsEmptyRow colSpan={6}>{t("settings.users.empty")}</SettingsEmptyRow>
            )}
          </tbody>
        </SettingsTable>
      </SettingsSection>

      {showModal && (
        <UserModal
          initial={editingUser ?? undefined}
          users={users}
          onSave={handleSave}
          onCancel={() => { setShowModal(false); setEditingUser(null); }}
        />
      )}

      {deleteTarget && (
        <div className="app-modal-backdrop z-[1100]">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{t("settings.users.delete")}</div>
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeletePassword("");
                  setDeleteError("");
                }}
                className="secondary-button h-8 px-2"
                disabled={deleting}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="text-xs text-slate-500">{t("settings.users.delete.passwordHint")}</div>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {t("settings.users.delete.confirm", { name: deleteTarget.name })}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">{t("settings.users.delete.passwordLabel")}</label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(""); }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder={t("settings.users.delete.passwordRequired")}
                  autoFocus
                />
              </div>
              {deleteError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{deleteError}</div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="secondary-button h-9 px-4"
                  onClick={() => {
                    setDeleteTarget(null);
                    setDeletePassword("");
                    setDeleteError("");
                  }}
                  disabled={deleting}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                  onClick={handleDelete}
                  disabled={deleting || !deletePassword.trim()}
                >
                  {deleting ? t("settings.users.deleting") : t("settings.users.confirmDelete")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
