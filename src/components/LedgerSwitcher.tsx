"use client";

import { useCallback, useState, useEffect, useRef, RefObject } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Plus, Check, Pencil, X, Trash2, Shield } from "lucide-react";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { useI18n } from "@/lib/i18n";

type Household = { id: string; name: string; createdAt?: string };
type ApiResult = { ok?: boolean; error?: string };

export function LedgerSwitcher({
  current,
  anchorRef,
  open,
  onOpenChange,
}: {
  current: Household | null;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [isSystemUser, setIsSystemUser] = useState(false);
  const [householdsLoaded, setHouseholdsLoaded] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Ledger switch verification dialog
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);
  const [switchUsername, setSwitchUsername] = useState("");
  const [switchPassword, setSwitchPassword] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [switching, setSwitching] = useState(false);

  // Create ledger dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createAdminName, setCreateAdminName] = useState("");
  const [createAdminPassword, setCreateAdminPassword] = useState("");
  const [createAdminPasswordConfirm, setCreateAdminPasswordConfirm] = useState("");
  const [createAdminEmail, setCreateAdminEmail] = useState("");
  const [createDialogError, setCreateDialogError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // Delete ledger state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteDbPassword, setDeleteDbPassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Load the household list once at mount so the first open of the switcher
  // shows data instantly instead of an empty panel while the fetch runs.
  const loadHouseholds = useCallback(() => {
    return fetch("/api/v1/households")
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setHouseholds(d.households);
          setIsAdminUser(d.isAdmin ?? false);
          setIsSystemUser(d.isSystem ?? false);
        }
      })
      .catch(() => {})
      .finally(() => setHouseholdsLoaded(true));
  }, []);

  useEffect(() => {
    void loadHouseholds();
  }, [loadHouseholds]);

  useEffect(() => {
    if (!open) {
      setSwitchTargetId(null);
      setSwitchUsername("");
      setSwitchPassword("");
      setSwitchError("");
      return;
    }
    // Refresh in the background; the previously loaded list stays visible so
    // reopening never shows a blank panel.
    void loadHouseholds();
  }, [open, loadHouseholds]);

  const showSwitchList = isAdminUser || households.length > 1;

  // Switch ledger: open verification dialog
  function startSwitch(id: string) {
    setSwitchTargetId(id);
    setSwitchUsername("");
    setSwitchPassword("");
    setSwitchError("");
  }

  async function handleSwitchVerify() {
    if (!switchTargetId || !switchPassword.trim() || !switchUsername.trim() || switching) return;
    setSwitching(true);
    setSwitchError("");
    try {
      const res = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: switchUsername.trim(), password: switchPassword, householdId: switchTargetId }),
      });
      const d = await res.json();
      if (d.ok) {
        await switchTo(switchTargetId, switchUsername.trim(), switchPassword);
      } else {
        setSwitchError(d.error ?? t("ledgerSwitch.error.verifyFailed"));
      }
    } catch {
      setSwitchError(t("ledgerSwitch.error.network"));
    } finally {
      setSwitching(false);
    }
  }

  async function switchTo(id: string, username?: string, password?: string) {
    const res = await fetch("/api/v1/households/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ householdId: id, username, password }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!res.ok || data?.ok === false) {
      setSwitchError(data?.error ?? t("ledgerSwitch.error.switchFailed", { status: res.status }));
      return false;
    }
    onOpenChange(false);
    router.push("/");
    router.refresh();
    return true;
  }

  function openCreateDialog() {
    const name = newName.trim();
    if (!name || adding) return;
    setCreateAdminName("");
    setCreateAdminPassword("");
    setCreateAdminEmail("");
    setCreateDialogError("");
    setShowCreateDialog(true);
  }

  async function handleCreateWithAdmin() {
    const name = newName.trim();
    if (!name || adding) return;
    if (!createAdminName.trim() || !createAdminPassword.trim()) {
      setCreateDialogError(t("ledgerSwitch.error.fillAdmin"));
      return;
    }
    if (createAdminPassword !== createAdminPasswordConfirm) {
      setCreateDialogError(t("ledgerSwitch.error.passwordMismatch"));
      return;
    }
    if (!createAdminEmail.trim()) {
      setCreateDialogError(t("ledgerSwitch.error.enterEmail"));
      return;
    }
    setAdding(true);
    setCreateDialogError("");
    try {
      const res = await fetch("/api/v1/households", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          adminName: createAdminName.trim(),
          adminPassword: createAdminPassword,
          adminEmail: createAdminEmail.trim(),
        }),
      });
      const d = await res.json();
      if (d.ok) {
        setShowCreateDialog(false);
        const refreshed = await fetch("/api/v1/households", { cache: "no-store" })
          .then(r => r.json())
          .catch(() => null);
        if (refreshed?.ok && Array.isArray(refreshed.households)) {
          setHouseholds(refreshed.households);
        } else if (d.household) {
          setHouseholds(prev => prev.some(h => h.id === d.household.id) ? prev : [...prev, d.household]);
        }
        setNewName("");
        setCreateAdminName("");
        setCreateAdminPassword("");
        setCreateAdminPasswordConfirm("");
        setCreateAdminEmail("");
        onOpenChange(true);
      } else {
        setCreateDialogError(d.error ?? t("ledgerSwitch.error.createFailed"));
      }
    } catch {
      setCreateDialogError(t("ledgerSwitch.error.network"));
    } finally {
      setAdding(false);
    }
  }

  async function renameHousehold(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 50) return;
    try {
      const res = await fetch("/api/v1/households", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: trimmed }),
      });
      if (res.ok) {
        setEditingId(null);
        setEditName("");
        fetch("/api/v1/households")
          .then(r => r.json())
          .then(d => { if (d.ok) setHouseholds(d.households); })
          .catch(() => {});
        router.refresh();
      }
    } catch { /* ignore */ }
  }

  function openDeleteDialog(id: string) {
    const h = households.find(x => x.id === id);
    setDeletingId(id);
    setDeleteConfirmName("");
    setDeleteDbPassword("");
    setDeleteError(h ? t("ledgerSwitch.error.enterNameToDelete", { name: getHouseholdDisplayName(h) }) : "");
  }

  async function handleDelete() {
    if (!deletingId) return;
    const h = households.find(x => x.id === deletingId);
    if (!h) return;
    const displayName = getHouseholdDisplayName(h);
    if (deleteConfirmName.trim() !== displayName) {
      setDeleteError(t("ledgerSwitch.error.nameMismatch", { name: displayName }));
      return;
    }
    if (!deleteDbPassword.trim()) {
      setDeleteError(t("ledgerSwitch.error.enterPassword"));
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      // Verify the current user password first
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deleteDbPassword, verifySystem: true }),
      });
      const vd = await readApiResult(verifyRes, t);
      if (!verifyRes.ok || !vd.ok) {
        setDeleteError(vd.error ?? t("ledgerSwitch.error.passwordWrong"));
        setDeleting(false);
        return;
      }
      // Execute the deletion
      const res = await fetch("/api/v1/households", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deletingId }),
      });
      const d = await readApiResult(res, t);
      if (res.ok && d.ok) {
        setDeletingId(null);
        setDeleteConfirmName("");
        setDeleteDbPassword("");
        const r = await fetch("/api/v1/households");
        const rd = await r.json();
        if (rd.ok) {
          setHouseholds(rd.households);
          if (current?.id === deletingId && rd.households.length > 0) {
            await switchTo(rd.households[0].id);
          }
        }
        router.refresh();
      } else {
        setDeleteError(d.error ?? t("ledgerSwitch.error.deleteFailed"));
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t("ledgerSwitch.error.network"));
    } finally {
      setDeleting(false);
    }
  }

  // Decide up/down expansion from the anchor position to avoid overflowing off-screen
  const anchor = anchorRef.current;
  const anchorRect = anchor?.getBoundingClientRect();
  const dropdownStyle: React.CSSProperties = anchorRect
    ? (() => {
        const width = Math.max(anchorRect.width, 240);
        const left = Math.min(Math.max(anchorRect.left, 8), Math.max(window.innerWidth - width - 8, 8));
        const shouldOpenDown = anchorRect.top < window.innerHeight / 2;
        return shouldOpenDown
          ? {
              position: "fixed",
              left,
              top: anchorRect.bottom + 4,
              width,
              zIndex: 50,
            }
          : {
              position: "fixed",
              left,
              bottom: window.innerHeight - anchorRect.top + 4,
              width,
              zIndex: 50,
            };
      })()
    : { position: "fixed", left: 8, top: 8, zIndex: 50 };

  if (!open) return null;
  // Before the first fetch resolves we cannot know whether switching is
  // available; show the panel with a loading hint instead of nothing.
  if (householdsLoaded && !showSwitchList) return null;

  const content = (
    <>
      <div className="fixed inset-0 z-40" onClick={() => { onOpenChange(false); setEditingId(null); }} />
      <div
        style={dropdownStyle}
        className="rounded-xl border border-foreground/10 bg-white/95 shadow-lg shadow-foreground/5 py-1 backdrop-blur-sm"
      >
          <div className="px-3 py-2 text-[10px] font-bold text-foreground/30 uppercase tracking-[0.2em] border-b border-foreground/5">
            {t("ledgerSwitch.switchLedger")}
          </div>
          <div className="max-h-[40vh] overflow-y-auto">
            {households.length === 0 && !householdsLoaded ? (
              <div className="px-3 py-2 text-xs text-foreground/40">{t("ledgerSwitch.loading")}</div>
            ) : households.map((h) => {
              const isActive = current?.id === h.id;
              const isEditing = editingId === h.id;
              const displayName = getHouseholdDisplayName(h);
              return (
                <div key={h.id}>
                  {isEditing ? (
                    <div className="flex items-center gap-1 px-3 py-2">
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameHousehold(h.id, editName);
                          if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                        }}
                        autoFocus
                        className="flex-1 h-7 rounded border border-foreground/10 bg-white px-2 text-xs outline-none text-foreground"
                      />
                      <button
                        type="button"
                        onClick={() => renameHousehold(h.id, editName)}
                        className="h-7 w-7 rounded border border-foreground/10 bg-white flex items-center justify-center text-accent-green hover:bg-foreground/5"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingId(null); setEditName(""); }}
                        className="h-7 w-7 rounded border border-foreground/10 bg-white flex items-center justify-center text-foreground/40 hover:bg-foreground/5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { if (!isActive) startSwitch(h.id); }}
                      className={`group w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-foreground/5 transition-colors ${
                        isActive ? "bg-foreground/8 text-foreground font-semibold" : "text-foreground/70"
                      }`}
                    >
                      <span className="truncate pr-2">{displayName}</span>
                      <div className="flex items-center gap-1.5">
                        {isSystemUser && !isActive && households.length > 1 && (
                          <Trash2
                            className="h-3 w-3 text-foreground/20 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); openDeleteDialog(h.id); }}
                          />
                        )}
                        {isAdminUser && !isActive && (
                          <Pencil
                            className="h-3 w-3 text-foreground/20 hover:text-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); setEditingId(h.id); setEditName(h.name); }}
                          />
                        )}
                        {isActive && <Check className="h-3.5 w-3.5 text-accent-green" />}
                      </div>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {isAdminUser && (
            <div className="border-t border-foreground/5 px-2 py-1.5">
              <div className="flex items-center gap-1">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") openCreateDialog(); }}
                  placeholder={t("ledgerSwitch.newLedgerPlaceholder")}
                  className="flex-1 h-7 rounded border border-foreground/10 bg-white px-2 text-xs outline-none text-foreground"
                />
                <button
                  type="button"
                  onClick={openCreateDialog}
                  disabled={adding || !newName.trim()}
                  className="h-7 w-7 rounded border border-foreground/10 bg-white flex items-center justify-center text-foreground/40 hover:bg-foreground/5 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Ledger switch verification dialog */}
        {switchTargetId && (() => {
          const h = households.find(x => x.id === switchTargetId);
          if (!h) return null;
          const displayName = getHouseholdDisplayName(h);
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
                  <div className="text-base font-semibold text-slate-800">{t("ledgerSwitch.switchToTitle", { name: displayName })}</div>
                  <div className="mt-1 text-xs text-slate-500">{t("ledgerSwitch.switchToDesc")}</div>
                </div>

                <div className="p-6 space-y-4">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("ledgerSwitch.adminUsername")}</div>
                    <input
                      value={switchUsername}
                      onChange={(e) => setSwitchUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSwitchVerify(); }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                      placeholder={t("ledgerSwitch.usernamePlaceholder")}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("ledgerSwitch.password")}</div>
                    <input
                      type="password"
                      value={switchPassword}
                      onChange={(e) => setSwitchPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSwitchVerify(); }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                      placeholder={t("ledgerSwitch.loginPasswordPlaceholder")}
                    />
                  </div>

                  {switchError && (
                    <div className="text-sm text-red-600">{switchError}</div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        router.push("/login");
                      }}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {t("ledgerSwitch.forgotPassword")}
                    </button>
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setSwitchTargetId(null); setSwitchUsername(""); setSwitchPassword(""); setSwitchError(""); }}
                      disabled={switching}
                      className="flex-1 h-10 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {t("ledgerSwitch.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleSwitchVerify}
                      disabled={switching || !switchUsername.trim() || !switchPassword.trim()}
                      className="flex-1 h-10 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                    >
                      {switching ? t("ledgerSwitch.verifying") : t("ledgerSwitch.confirmSwitch")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Create ledger dialog */}
        {showCreateDialog && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div ref={dialogRef} className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
                <div className="text-base font-semibold text-slate-800">{t("ledgerSwitch.newLedger")}</div>
                <div className="mt-1 text-xs text-slate-500">{t("ledgerSwitch.newLedgerDesc")}</div>
              </div>

              <div className="p-6 space-y-4">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("ledgerSwitch.adminName")}</div>
                  <input
                    value={createAdminName}
                    onChange={(e) => setCreateAdminName(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder={t("ledgerSwitch.adminNamePlaceholder")}
                    autoFocus
                  />
                  <div className="text-[10px] text-slate-400">{t("ledgerSwitch.adminNameHint")}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("ledgerSwitch.email")}</div>
                  <input
                    type="email"
                    value={createAdminEmail}
                    onChange={(e) => setCreateAdminEmail(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder={t("ledgerSwitch.emailPlaceholder")}
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("ledgerSwitch.adminPassword")}</div>
                  <input
                    type="password"
                    value={createAdminPassword}
                    onChange={(e) => setCreateAdminPassword(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder={t("ledgerSwitch.setPasswordPlaceholder")}
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("ledgerSwitch.confirmPassword")}</div>
                  <input
                    type="password"
                    value={createAdminPasswordConfirm}
                    onChange={(e) => setCreateAdminPasswordConfirm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreateWithAdmin(); }}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder={t("ledgerSwitch.retypePasswordPlaceholder")}
                    autoComplete="new-password"
                  />
                </div>

                {createDialogError && (
                  <div className="text-sm text-red-600">{createDialogError}</div>
                )}

                <div className="pt-2 text-xs text-slate-400">
                  {t("ledgerSwitch.createHint")}
                </div>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowCreateDialog(false); setCreateAdminName(""); setCreateAdminPassword(""); setCreateAdminPasswordConfirm(""); setCreateAdminEmail(""); }}
                    disabled={adding}
                    className="flex-1 h-10 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {t("ledgerSwitch.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateWithAdmin}
                    disabled={adding || !createAdminName.trim() || !createAdminPassword.trim() || !createAdminPasswordConfirm.trim() || !createAdminEmail.trim()}
                    className="flex-1 h-10 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {adding ? t("ledgerSwitch.creating") : t("ledgerSwitch.createLedger")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Delete ledger confirmation dialog */}
        {deletingId && (() => {
          const h = households.find(x => x.id === deletingId);
          if (!h) return null;
          const displayName = getHouseholdDisplayName(h);
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
                <div className="px-6 py-5 border-b border-red-100 bg-red-50">
                  <div className="text-base font-semibold text-red-800">{t("ledgerSwitch.deleteLedger")}</div>
                  <div className="mt-1 text-xs text-red-600">{t("ledgerSwitch.deleteLedgerDesc")}</div>
                </div>

                <div className="p-6 space-y-4">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      {t("ledgerSwitch.error.enterNameToDelete", { name: displayName })}
                    </div>
                    <input
                      value={deleteConfirmName}
                      onChange={(e) => { setDeleteConfirmName(e.target.value); setDeleteError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDelete(); }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-red-100 focus:border-red-400"
                      placeholder={displayName}
                      autoFocus
                    />
                  </div>

                  {/* Current user password verification */}
                  <div className="pt-2 border-t border-slate-100">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Shield className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <span className="text-xs font-medium text-amber-700">{t("ledgerSwitch.passwordVerifyTitle")}</span>
                    </div>
                    <input
                      type="password"
                      value={deleteDbPassword}
                      onChange={(e) => { setDeleteDbPassword(e.target.value); setDeleteError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDelete(); }}
                      className="h-10 w-full rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-amber-100 focus:border-amber-400"
                      placeholder={t("ledgerSwitch.currentPasswordPlaceholder")}
                      autoComplete="off"
                    />
                    <div className="mt-1 text-[10px] text-slate-400">{t("ledgerSwitch.passwordVerifyHint")}</div>
                  </div>

                  {deleteError && (
                    <div className="text-sm text-red-600">{deleteError}</div>
                  )}

                  <div className="pt-2 text-xs text-slate-400">
                    {t("ledgerSwitch.deleteWarning")}
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setDeletingId(null); setDeleteConfirmName(""); setDeleteDbPassword(""); setDeleteError(""); }}
                      disabled={deleting}
                      className="flex-1 h-10 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {t("ledgerSwitch.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting || deleteConfirmName.trim() !== displayName || !deleteDbPassword.trim()}
                      className="flex-1 h-10 rounded-md bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t("ledgerSwitch.deleting") : t("ledgerSwitch.confirmDelete")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </>
  );

  return typeof document === "undefined" ? null : createPortal(content, document.body);
}

async function readApiResult(response: Response, t: (key: string, params?: Record<string, string | number>) => string): Promise<ApiResult> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(t("ledgerSwitch.error.serverNoResult", { status: response.status }));
  }

  try {
    return JSON.parse(body) as ApiResult;
  } catch {
    throw new Error(t("ledgerSwitch.error.serverInvalidResult", { status: response.status }));
  }
}
