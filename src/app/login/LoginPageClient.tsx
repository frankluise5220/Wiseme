"use client";

import { useEffect, useState } from "react";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { useI18n } from "@/lib/i18n";
import { getProductIntro } from "@/lib/product-intro";
import { MmhLogo } from "@/components/MmhLogo";

type HouseholdChoice = {
  id: string;
  name: string;
};

type AuthVerifyResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  households?: HouseholdChoice[];
  householdId?: string | null;
  message?: string;
  maskedEmailHint?: string | null;
};

type PasswordStatusResponse = {
  ok: boolean;
  hasPassword: boolean;
  needsInitialLedgerSetup?: boolean;
  passwordResetEnabled?: boolean;
  users?: LoginUserChoice[];
};

type LoginUserChoice = {
  id: string;
  name: string;
  role?: string;
  isSystem?: boolean;
  householdId?: string | null;
  householdName?: string | null;
};

type CreateLedgerResponse = {
  ok: boolean;
  error?: string;
};

type ResetStep = "request" | "confirm";
type LoginMode = "login" | "setup" | "create";

const SYSTEM_LOGIN_SCOPE_ID = "__system__";

function getLoginUserScopeId(user: LoginUserChoice) {
  return user.householdId ?? SYSTEM_LOGIN_SCOPE_ID;
}

function getInitialLoginSelection(users: LoginUserChoice[]) {
  const firstUser = users.find((user) => !!user.householdId) ?? users[0] ?? null;
  return {
    scopeId: firstUser ? getLoginUserScopeId(firstUser) : "",
    user: firstUser,
  };
}

export function LoginPageClient({ householdName }: { householdName: string | null }) {
  const [mode, setMode] = useState<LoginMode>("login");
  // Start in the checking state so the login form only renders after the
  // password-status check resolves. Otherwise the form briefly shows without
  // the book/user rows (2 rows) and then re-renders with them (3 rows),
  // making the layout appear to flip between two different rule sets.
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [username, setUsername] = useState("");
  const [selectedHouseholdId, setSelectedHouseholdId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [password, setPassword] = useState("");
  const [systemUsers, setSystemUsers] = useState<LoginUserChoice[]>([]);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [householdChoices, setHouseholdChoices] = useState<HouseholdChoice[]>([]);
  const [pendingLogin, setPendingLogin] = useState<{ username: string; password: string } | null>(null);
  const [initialLedgerSetup, setInitialLedgerSetup] = useState(false);

  const [setupUsername, setSetupUsername] = useState("admin");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [createInviteCode, setCreateInviteCode] = useState("");
  const [createLedgerName, setCreateLedgerName] = useState("");
  const [createAdminName, setCreateAdminName] = useState("admin");
  const [createAdminEmail, setCreateAdminEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createConfirmPassword, setCreateConfirmPassword] = useState("");

  const [showReset, setShowReset] = useState(false);
  const [resetStep, setResetStep] = useState<ResetStep>("request");
  const [resetUsername, setResetUsername] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetEmailHint, setResetEmailHint] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetInfo, setResetInfo] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetHouseholdId, setResetHouseholdId] = useState("");
  const [resetHouseholdChoices, setResetHouseholdChoices] = useState<HouseholdChoice[]>([]);
  const { t } = useI18n();
  const currentHouseholdDisplayName = getHouseholdDisplayName({ name: householdName }, t("login.defaultBook"));
  const productIntro = getProductIntro(t);
  const loginHouseholdChoices = getLoginHouseholdChoices();
  const selectedHouseholdUsers = selectedHouseholdId
    ? systemUsers.filter((user) => getLoginUserScopeId(user) === selectedHouseholdId)
    : [];

  function getLoginUserLabel(user: LoginUserChoice) {
    return user.isSystem ? `${user.name} · ${t("login.systemUserBadge")}` : user.name;
  }

  function getLoginHouseholdChoices() {
    const seen = new Set<string>();
    const choices: HouseholdChoice[] = [];
    for (const user of systemUsers) {
      const id = getLoginUserScopeId(user);
      if (seen.has(id)) continue;
      seen.add(id);
      choices.push({
        id,
        name: user.householdId
          ? getHouseholdDisplayName({ id: user.householdId, name: user.householdName }, t("login.defaultBook"))
          : t("login.systemScope"),
      });
    }
    return choices;
  }

  function selectLoginHousehold(scopeId: string) {
    const user = systemUsers.find((item) => getLoginUserScopeId(item) === scopeId) ?? null;
    setSelectedHouseholdId(scopeId);
    setSelectedUserId(user?.id ?? "");
    setUsername(user?.name ?? "");
    cancelHouseholdChoice();
  }

  function getSelectedLoginUser() {
    const user = systemUsers.find((item) => item.id === selectedUserId) ?? null;
    if (!user) return null;
    if (selectedHouseholdId && getLoginUserScopeId(user) !== selectedHouseholdId) return null;
    return user;
  }

  function openPasswordReset() {
    setResetStep("request");
    setResetInfo("");
    setResetEmail("");
    setResetEmailHint("");
    setResetHouseholdId("");
    setResetHouseholdChoices([]);
    if (!passwordResetEnabled) {
      setResetError(t("login.reset.mailNotConfigured"));
      setShowReset(true);
      setResetUsername(getSelectedLoginUser()?.name ?? username);
      cancelHouseholdChoice();
      return;
    }
    setResetError("");
    setShowReset(true);
    setResetUsername(getSelectedLoginUser()?.name ?? username);
    cancelHouseholdChoice();
  }

  useEffect(() => {
    const controller = new AbortController();
    // Generous timeout: a slow first compile or cold API route must not
    // silently degrade the login form into a book-less two-row layout.
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    let mounted = true;

    void fetch("/api/v1/auth/password-status", {
      signal: controller.signal,
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    })
      .then(async (res) => {
        const contentType = res.headers.get("content-type") ?? "";
        if (!res.ok || !contentType.includes("application/json")) {
          throw new Error(`password-status returned ${res.status}`);
        }
        return res.json() as Promise<PasswordStatusResponse>;
      })
      .then((data) => {
        if (!mounted) return;
        if (data.ok) {
          const needsInitialLedgerSetup = data.needsInitialLedgerSetup === true;
          const users = data.users ?? [];
          setInitialLedgerSetup(needsInitialLedgerSetup);
          setMode(needsInitialLedgerSetup ? "create" : data.hasPassword ? "login" : "setup");
          setSystemUsers(users);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
          const initialSelection = getInitialLoginSelection(users);
          setSelectedHouseholdId(initialSelection.scopeId);
          if (initialSelection.user) {
            setSelectedUserId(initialSelection.user.id);
            setUsername(initialSelection.user.name);
          } else {
            setSelectedUserId("");
            setUsername("");
          }
          // A password exists but no user list came back (degraded status):
          // never silently render a login form without the ledger row.
          if (users.length === 0 && data.hasPassword && !needsInitialLedgerSetup) {
            setError(t("login.error.statusCheckFailed"));
          }
        } else {
          setMode("login");
          setInitialLedgerSetup(false);
          setSystemUsers([]);
          setSelectedHouseholdId("");
          setSelectedUserId("");
          setPasswordResetEnabled(false);
          setError(t("login.error.statusCheckFailed"));
        }
        if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("reset") === "1") {
          setShowReset(true);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setMode("login");
        setInitialLedgerSetup(false);
        setSystemUsers([]);
        setSelectedHouseholdId("");
        setSelectedUserId("");
        setPasswordResetEnabled(false);
        setError(t("login.error.statusCheckFailed"));
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (mounted) {
          setChecking(false);
        }
      });

    return () => {
      mounted = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [t]);

  async function verifyLogin(params: { userId?: string; username?: string; password: string; householdId?: string }) {
    const res = await fetch("/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await res.json().catch(() => null) as AuthVerifyResponse | null
      : null;
    if (!data) {
      return {
        ok: false,
        error: res.ok ? t("login.error.responseInvalid") : t("login.error.apiStatus", { status: res.status }),
      };
    }
    if (!res.ok && !data.error) {
      return { ...data, error: t("login.error.failedStatus", { status: res.status }) };
    }
    return data;
  }

  async function handleLogin() {
    const selectedUser = getSelectedLoginUser();
    const selectedScopeId = selectedHouseholdId && selectedHouseholdId !== SYSTEM_LOGIN_SCOPE_ID
      ? selectedHouseholdId
      : "";
    const trimmedUsername = (selectedUser?.name ?? username).trim();
    const trimmedPassword = password.trim();
    if (loginHouseholdChoices.length > 0 && !selectedHouseholdId) { setError(t("login.error.bookRequired")); return; }
    if (!trimmedUsername) { setError(t("login.error.usernameRequired")); return; }
    if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }

    setLoading(true);
    setError("");
    setHouseholdChoices([]);
    setPendingLogin(null);

    try {
      const data = await verifyLogin({
        ...(selectedUser ? { userId: selectedUser.id } : {}),
        username: trimmedUsername,
        ...(selectedScopeId ? { householdId: selectedScopeId } : {}),
        password: trimmedPassword,
      });
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      if (data.code === "AMBIGUOUS_USER" && data.households?.length) {
        setPendingLogin({ username: trimmedUsername, password: trimmedPassword });
        setHouseholdChoices(data.households);
        setError(data.error ?? t("login.error.ambiguousUser"));
        return;
      }
      setError(data.error ?? t("login.error.loginFailed"));
    } catch {
      setError(t("login.error.verifyRetry"));
    } finally {
      setLoading(false);
    }
  }

  async function handleHouseholdChoice(householdId: string) {
    const credentials = pendingLogin ?? { username: username.trim(), password: password.trim() };
    if (!credentials.username) { setError(t("login.error.usernameRequired")); return; }
    if (!credentials.password) { setError(t("login.error.passwordRequired")); return; }

    setLoading(true);
    setError("");
    try {
      const data = await verifyLogin({ ...credentials, householdId });
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      setError(data.error ?? t("login.error.loginFailed"));
    } catch {
      setError(t("login.error.verifyRetry"));
    } finally {
      setLoading(false);
    }
  }

  function cancelHouseholdChoice() {
    setHouseholdChoices([]);
    setPendingLogin(null);
    setError("");
  }

  async function handleSetup() {
    const trimmedUsername = setupUsername.trim();
    const trimmedPassword = newPassword.trim();
    if (!trimmedUsername) { setError(t("login.error.usernameRequired")); return; }
    if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }
    if (trimmedPassword !== confirmPassword.trim()) { setError(t("login.error.passwordMismatch")); return; }

    setLoading(true);
    setError("");
    try {
      const setupRes = await fetch("/api/v1/auth/password-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: trimmedPassword, username: trimmedUsername }),
      });
      const setupData = await setupRes.json() as { ok: boolean; error?: string };
      if (!setupData.ok) {
        setError(setupData.error ?? t("login.error.setupFailed"));
        return;
      }

      const loginData = await verifyLogin({ username: trimmedUsername, password: trimmedPassword });
      if (loginData.ok) {
        window.location.href = "/";
        return;
      }
      setError(loginData.error ?? t("login.error.loginFailed"));
    } catch {
      setError(t("login.error.setupRetry"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateLedger() {
    const trimmedInviteCode = createInviteCode.trim();
    const trimmedLedgerName = createLedgerName.trim();
    const trimmedAdminName = createAdminName.trim() || "admin";
    const trimmedAdminEmail = createAdminEmail.trim();
    const trimmedPassword = createPassword.trim();
    const trimmedConfirmPassword = createConfirmPassword.trim();
    if (!initialLedgerSetup && !trimmedInviteCode) { setError(t("login.error.inviteRequired")); return; }
    if (!trimmedLedgerName) { setError(t("login.error.ledgerNameRequired")); return; }
    if (!trimmedAdminName) { setError(t("login.error.adminUsernameRequired")); return; }
    if (!initialLedgerSetup && !trimmedAdminEmail) { setError(t("login.error.adminEmailRequired")); return; }
    if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }
    if (trimmedPassword !== trimmedConfirmPassword) { setError(t("login.error.passwordMismatch")); return; }

    setLoading(true);
    setError("");
    try {
      const createRes = await fetch("/api/v1/auth/create-ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(initialLedgerSetup ? {} : { inviteCode: trimmedInviteCode }),
          name: trimmedLedgerName,
          adminName: trimmedAdminName,
          adminEmail: trimmedAdminEmail || undefined,
          adminPassword: trimmedPassword,
        }),
      });
      const createData = await createRes.json().catch(() => null) as CreateLedgerResponse | null;
      if (!createRes.ok || !createData?.ok) {
        setError(createData?.error ?? t("login.error.createFailed"));
        return;
      }
      window.location.href = "/";
    } catch {
      setError(t("login.error.createRetry"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResetRequest(selectedHouseholdId = resetHouseholdId) {
    if (!resetUsername.trim()) { setResetError(t("login.error.usernameRequired")); return; }
    const previewOnly = !resetEmailHint;
    if (!previewOnly && !resetEmail.trim()) { setResetError(t("login.reset.emailRequired")); return; }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: resetUsername.trim(),
          ...(previewOnly ? { preview: true } : { email: resetEmail.trim() }),
          ...(selectedHouseholdId ? { householdId: selectedHouseholdId } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as AuthVerifyResponse | null;
      if (!data?.ok) {
        if (data?.code === "AMBIGUOUS_USER" && data.households?.length) {
          setResetHouseholdChoices(data.households);
          setResetError(data.error ?? t("login.reset.ambiguousUserEmail"));
          return;
        }
        setResetError(data?.error ?? t("login.reset.sendFailed"));
        return;
      }
      setResetHouseholdId(data.householdId ?? selectedHouseholdId ?? "");
      setResetHouseholdChoices([]);
      if (previewOnly) {
        setResetEmailHint(data.maskedEmailHint ?? "");
        setResetInfo(data.message ?? t("login.reset.completeEmail"));
        return;
      }
      setResetInfo(data.message ?? t("login.reset.codeSent"));
      setResetStep("confirm");
    } catch {
      setResetError(t("login.reset.sendRetry"));
    } finally {
      setResetLoading(false);
    }
  }

  async function handleResetConfirm(selectedHouseholdId = resetHouseholdId) {
    if (!resetUsername.trim()) { setResetError(t("login.error.usernameRequired")); return; }
    if (!resetCode.trim()) { setResetError(t("login.reset.codeRequired")); return; }
    if (!resetNewPassword.trim()) { setResetError(t("login.reset.newPasswordRequired")); return; }
    if (resetNewPassword.trim() !== resetConfirmPassword.trim()) {
      setResetError(t("login.error.passwordMismatch"));
      return;
    }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: resetUsername.trim(),
          code: resetCode.trim(),
          newPassword: resetNewPassword.trim(),
          ...(selectedHouseholdId ? { householdId: selectedHouseholdId } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as AuthVerifyResponse | null;
      if (!data?.ok) {
        if (data?.code === "AMBIGUOUS_USER" && data.households?.length) {
          setResetHouseholdChoices(data.households);
          setResetError(data.error ?? t("login.reset.ambiguousCode"));
          return;
        }
        setResetError(data?.error ?? t("login.reset.failed"));
        return;
      }
      setResetInfo(t("login.reset.done"));
      setResetStep("request");
      setShowReset(false);
      setResetHouseholdId("");
      setResetHouseholdChoices([]);
      setPassword(resetNewPassword.trim());
      setUsername(resetUsername.trim());
    } catch {
      setResetError(t("login.reset.retry"));
    } finally {
      setResetLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="p-6 text-center text-sm text-slate-500">{t("common.loading")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/58 p-4 backdrop-blur-sm">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-white/16 bg-white/92 shadow-[0_24px_80px_rgba(15,23,42,0.34)] backdrop-blur-xl lg:grid-cols-[minmax(0,1fr)_390px]">
        <section className="relative hidden overflow-hidden bg-slate-950 px-8 py-8 text-white lg:block">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-blue-400/20 blur-3xl" />
          <div className="absolute -bottom-16 left-8 h-56 w-56 rounded-full bg-emerald-300/15 blur-3xl" />
          <div className="relative">
            <h1 className="mt-4 text-3xl font-semibold leading-tight">{productIntro.title}</h1>
            <div className="mt-2 text-sm text-amber-100">{productIntro.mantra}</div>
            <p className="mt-5 text-base leading-7 text-slate-100">{productIntro.lead}</p>
            <div className="mt-6 space-y-4 text-sm leading-7 text-slate-300">
              {productIntro.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <div className="mt-6 grid grid-cols-3 gap-2">
              {productIntro.highlights.map((item) => (
                <span key={item} className="rounded-lg border border-white/12 bg-white/[0.08] px-2 py-2 text-center text-[11px] leading-4 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm">
                  {item}
                </span>
              ))}
            </div>
          </div>
        </section>

        <div className="min-w-0">
        <div className="border-b border-slate-200/70 bg-white/72 px-6 py-5 shadow-[inset_0_-1px_0_rgba(148,163,184,0.14)] backdrop-blur">
          {householdName && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("login.book")}</div>}
          <div className="flex items-center">
            <div className="flex min-w-0 items-center gap-2">
              <MmhLogo size={40} />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-slate-800">{householdName ? currentHouseholdDisplayName : "MoneyMoneyHome"}</div>
                {!householdName && <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-400">{t("login.productTagline")}</div>}
              </div>
            </div>
          </div>
          {mode === "login" && <div className="mt-1 text-xs text-slate-500">{t("login.continueHint")}</div>}
          {mode === "setup" && <div className="mt-1 text-xs text-slate-500">{t("login.setupHint")}</div>}
          {mode === "create" && (
            <div className="mt-1 text-xs text-slate-500">
              {initialLedgerSetup ? t("login.initialCreateHint") : t("login.createHint")}
            </div>
          )}
        </div>

        {mode === "login" && (
          <div className="space-y-4 p-6">
            {!showReset && (
              <>
                {loginHouseholdChoices.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("login.book")}</div>
                    <select
                      value={selectedHouseholdId}
                      onChange={(event) => selectLoginHousehold(event.target.value)}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      autoFocus
                    >
                      {loginHouseholdChoices.map((household) => (
                        <option key={household.id} value={household.id}>{household.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
                  {selectedHouseholdUsers.length > 0 ? (
                    <select
                      value={selectedUserId}
                      onChange={(event) => {
                        const user = selectedHouseholdUsers.find((item) => item.id === event.target.value);
                        setSelectedUserId(user?.id ?? "");
                        setUsername(user?.name ?? "");
                        cancelHouseholdChoice();
                      }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {selectedHouseholdUsers.map((user) => (
                        <option key={user.id} value={user.id}>{getLoginUserLabel(user)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={username}
                      onChange={(event) => {
                        setSelectedUserId("");
                        setUsername(event.target.value);
                        cancelHouseholdChoice();
                      }}
                      type="text"
                      autoComplete="username"
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      placeholder={t("login.usernamePlaceholder")}
                    />
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
                  <input
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      cancelHouseholdChoice();
                    }}
                    type="password"
                    autoComplete="current-password"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.passwordPlaceholder")}
                    autoFocus={loginHouseholdChoices.length === 0}
                    onKeyDown={(event) => { if (event.key === "Enter") void handleLogin(); }}
                  />
                </div>

                {householdChoices.length > 0 && (
                  <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{t("login.chooseBook")}</div>
                      <div className="mt-1 text-xs text-slate-500">{t("login.ambiguousBookHint")}</div>
                    </div>
                    <div className="space-y-2">
                      {householdChoices.map((household) => (
                        <button
                          key={household.id}
                          type="button"
                          className="w-full rounded-lg border border-blue-100 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                          disabled={loading}
                          onClick={() => void handleHouseholdChoice(household.id)}
                        >
                          {getHouseholdDisplayName(household)}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="text-xs text-slate-500 hover:text-slate-700"
                      disabled={loading}
                      onClick={cancelHouseholdChoice}
                    >
                      {t("login.reenterUsername")}
                    </button>
                  </div>
                )}

                {error && <div className="text-sm text-red-600">{error}</div>}
                <button
                  type="button"
                  className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={loading}
                  onClick={() => void handleLogin()}
                >
                  {loading ? t("login.verifying") : t("login.enter")}
                </button>
              </>
            )}

            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              onClick={() => {
                if (showReset) {
                  setShowReset(false);
                  setResetStep("request");
                  setResetError("");
                  setResetInfo("");
                  return;
                }
                openPasswordReset();
              }}
              disabled={loading || resetLoading}
            >
              {showReset ? t("common.collapse") : t("login.forgotPassword")}
            </button>

            {showReset && (
              <div className="space-y-3 border-t border-slate-100 pt-2">
                <div className="text-xs font-medium text-slate-600">{t("login.reset.title")}</div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
                  <input
                    value={resetUsername}
                    onChange={(event) => {
                      setResetUsername(event.target.value);
                      setResetEmail("");
                      setResetEmailHint("");
                      setResetHouseholdId("");
                      setResetHouseholdChoices([]);
                    }}
                    type="text"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    placeholder={t("login.usernamePlaceholder")}
                  />
                </div>
                {resetStep === "request" && (
                  resetEmailHint ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.emailLabel")}</div>
                      <div className="text-[11px] text-slate-500">{t("login.reset.emailHint", { hint: resetEmailHint })}</div>
                      <input
                        value={resetEmail}
                        onChange={(event) => {
                          setResetEmail(event.target.value);
                          setResetHouseholdChoices([]);
                        }}
                        type="email"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.emailPlaceholder")}
                      />
                    </div>
                  ) : null
                )}
                {resetStep === "confirm" && (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.code")}</div>
                      <input
                        value={resetCode}
                        onChange={(event) => setResetCode(event.target.value)}
                        type="text"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.codePlaceholder")}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.newPassword")}</div>
                      <input
                        value={resetNewPassword}
                        onChange={(event) => setResetNewPassword(event.target.value)}
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.newPasswordPlaceholder")}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.confirmNewPassword")}</div>
                      <input
                        value={resetConfirmPassword}
                        onChange={(event) => setResetConfirmPassword(event.target.value)}
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.confirmNewPasswordPlaceholder")}
                      />
                    </div>
                  </>
                )}
                {resetHouseholdChoices.length > 0 && (
                  <div className="space-y-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div className="text-xs text-slate-500">{t("login.reset.chooseBookHint")}</div>
                    {resetHouseholdChoices.map((household) => (
                      <button
                        key={household.id}
                        type="button"
                        className="w-full rounded-lg border border-blue-100 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                        disabled={resetLoading}
                        onClick={() => {
                          setResetHouseholdId(household.id);
                          if (resetStep === "request") {
                            void handleResetRequest(household.id);
                          } else {
                            void handleResetConfirm(household.id);
                          }
                        }}
                      >
                        {getHouseholdDisplayName(household)}
                      </button>
                    ))}
                  </div>
                )}
                {resetError && <div className="text-sm text-red-600">{resetError}</div>}
                {resetInfo && <div className="text-sm text-slate-600">{resetInfo}</div>}
                {resetStep === "request" ? (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      disabled={resetLoading}
                      onClick={() => void handleResetRequest()}
                    >
                      {resetLoading ? t("login.reset.processing") : resetEmailHint ? t("login.reset.sendCode") : t("login.reset.nextStep")}
                    </button>
                    {resetEmailHint ? (
                      <button
                        type="button"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={resetLoading}
                        onClick={() => {
                          setResetEmail("");
                          setResetEmailHint("");
                          setResetError("");
                          setResetInfo("");
                          setResetHouseholdChoices([]);
                        }}
                      >
                        {t("login.reenterUsername")}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="h-9 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                      disabled={resetLoading}
                      onClick={() => void handleResetConfirm()}
                    >
                      {resetLoading ? t("login.reset.submitting") : t("login.reset.resetPassword")}
                    </button>
                    <button
                      type="button"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                      disabled={resetLoading}
                      onClick={() => {
                        setResetStep("request");
                        setResetError("");
                        setResetInfo("");
                      }}
                    >
                      {t("login.reset.backStep")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {mode === "create" && (
          <div className="space-y-4 p-6">
            {!initialLedgerSetup && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("login.inviteCode")}</div>
                <input
                  value={createInviteCode}
                  onChange={(event) => setCreateInviteCode(event.target.value)}
                  type="password"
                  autoComplete="off"
                  className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder={t("login.invitePlaceholder")}
                  autoFocus
                />
              </div>
            )}
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.ledgerName")}</div>
              <input
                value={createLedgerName}
                onChange={(event) => setCreateLedgerName(event.target.value)}
                type="text"
                autoComplete="organization"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.ledgerNamePlaceholder")}
                autoFocus={initialLedgerSetup}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.adminUsername")}</div>
              <input
                value={createAdminName}
                onChange={(event) => setCreateAdminName(event.target.value)}
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.adminUsernamePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">
                {initialLedgerSetup ? t("login.adminEmailOptional") : t("login.adminEmail")}
              </div>
              <input
                value={createAdminEmail}
                onChange={(event) => setCreateAdminEmail(event.target.value)}
                type="email"
                autoComplete="email"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.adminEmailPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
              <input
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.passwordPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div>
              <input
                value={createConfirmPassword}
                onChange={(event) => setCreateConfirmPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.confirmPassword")}
                onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }}
              />
            </div>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
              onClick={() => void handleCreateLedger()}
            >
              {loading ? t("login.creating") : t("login.createAndEnter")}
            </button>
            {!initialLedgerSetup && (
              <button
                type="button"
                className="h-10 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={loading}
                onClick={() => {
                  setError("");
                  setResetError("");
                  setResetInfo("");
                  setShowReset(false);
                  setCreateInviteCode("");
                  setCreateLedgerName("");
                  setCreateAdminName("admin");
                  setCreateAdminEmail("");
                  setCreatePassword("");
                  setCreateConfirmPassword("");
                  setMode("login");
                }}
              >
                {t("login.backToLogin")}
              </button>
            )}
          </div>
        )}

        {mode === "setup" && (
          <div className="space-y-4 p-6">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
              <input
                value={setupUsername}
                onChange={(event) => setSetupUsername(event.target.value)}
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="admin"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.setupPassword")}</div>
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.passwordPlaceholder")}
                onKeyDown={(event) => { if (event.key === "Enter") void handleSetup(); }}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div>
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.confirmPassword")}
                onKeyDown={(event) => { if (event.key === "Enter") void handleSetup(); }}
              />
            </div>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
              onClick={() => void handleSetup()}
            >
              {loading ? t("login.setting") : t("login.setupAndEnter")}
            </button>
          </div>
        )}

        {mode === "login" && !showReset && (
          <div className="px-6 pb-6 -mt-2">
            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              disabled={loading}
              onClick={() => {
                setError("");
                setResetError("");
                setResetInfo("");
                setShowReset(false);
                setCreateInviteCode("");
                setCreateLedgerName("");
                setCreateAdminName("admin");
                setCreateAdminEmail("");
                setCreatePassword("");
                setCreateConfirmPassword("");
                setMode("create");
              }}
            >
              {t("login.createAccount")}
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
