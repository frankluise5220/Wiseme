"use client";

import { Share2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

const INSTALL_HINT_DISMISSED_KEY = "mmh_pwa_install_hint_dismissed";

function isIosDevice() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isSafariBrowser() {
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/i.test(ua);
}

function isStandaloneMode() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function hasDismissedInstallHint() {
  try {
    return window.localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberInstallHintDismissed() {
  try {
    window.localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, "1");
  } catch {}
}

export function PwaServiceWorkerRegistration() {
  const { t } = useI18n();
  const [showInstallHint, setShowInstallHint] = useState(false);
  const [isSafari, setIsSafari] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      }).catch((error) => {
        console.warn("MMH service worker registration failed:", error);
      });
    }, { once: true });
  }, []);

  useEffect(() => {
    if (!isIosDevice() || isStandaloneMode()) return;
    if (hasDismissedInstallHint()) return;
    setIsSafari(isSafariBrowser());
    setShowInstallHint(true);
  }, []);

  function dismissInstallHint() {
    rememberInstallHintDismissed();
    setShowInstallHint(false);
  }

  if (!showInstallHint) return null;

  return (
    <div className="fixed inset-x-3 bottom-[calc(5.75rem+env(safe-area-inset-bottom)+0.75rem)] z-[70] md:hidden">
      <div className="rounded-xl border border-slate-200 bg-white/95 p-3 text-slate-800 shadow-[0_16px_36px_rgba(15,23,42,0.18)] backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-700">
            <Share2 size={17} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{t("pwa.install.title")}</div>
            <div className="mt-1 text-xs leading-5 text-slate-600">
              {isSafari ? t("pwa.install.safariInstruction") : t("pwa.install.openSafariInstruction")}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissInstallHint}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
            aria-label={t("pwa.install.dismiss")}
          >
            <X size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
