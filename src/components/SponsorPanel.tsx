"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ArrowUpRight, Coffee, Heart, QrCode, Star } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const WECHAT_QR_URL = "/reward/wechat-qr.png";
const ALIPAY_QR_URL = "/reward/alipay-qr.png";
const GITHUB_REPO_URL = "https://github.com/frankluise5220/MMH";

type QrTab = "wechat" | "alipay";

export function SponsorPanel() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<QrTab>("wechat");
  const [failedTabs, setFailedTabs] = useState<Record<QrTab, boolean>>({ wechat: false, alipay: false });
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomed]);

  const activeQrUrl = activeTab === "wechat" ? WECHAT_QR_URL : ALIPAY_QR_URL;
  const activeQrFailed = failedTabs[activeTab];
  const activeQrHint = activeTab === "wechat" ? t("settings.sponsor.qrWechatHint") : t("settings.sponsor.qrAlipayHint");

  function markTabFailed(tab: QrTab) {
    setFailedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  }

  return (
    <div className="space-y-4">
      {/* Hero */}
      <section className="overflow-hidden rounded-xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 px-5 py-5 text-white shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/20">
            <Coffee className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("settings.sponsor.heroTitle")}</h2>
            <p className="mt-0.5 text-xs font-medium text-white/80">{t("settings.sponsor.title")}</p>
          </div>
        </div>
        <p className="mt-3 text-sm leading-6 text-white/95">{t("settings.sponsor.heroSubtitle")}</p>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] text-white/90">
          <Heart className="h-3 w-3" />
          {t("settings.sponsor.voluntaryNote")}
        </div>
      </section>

      {/* QR codes */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex w-fit gap-1 rounded-lg bg-slate-100 p-1">
          {(["wechat", "alipay"] as QrTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`h-8 rounded-md px-4 text-sm transition-colors ${
                activeTab === tab
                  ? "bg-white font-medium text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab === "wechat" ? t("settings.sponsor.tabWechat") : t("settings.sponsor.tabAlipay")}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-col items-center">
          {activeQrFailed ? (
            <div className="flex h-56 w-56 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 px-4 text-center">
              <QrCode className="h-8 w-8 text-slate-300" />
              <div className="text-sm font-medium text-slate-500">{t("settings.sponsor.qrMissing")}</div>
              <div className="text-[11px] leading-4 text-slate-400">{t("settings.sponsor.qrMissingHint")}</div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              title={t("settings.sponsor.zoomHint")}
              className="group rounded-xl border border-slate-200 bg-white p-2 transition-colors hover:border-amber-300"
            >
              <span className="relative block h-52 w-52">
                <Image
                  src={activeQrUrl}
                  alt={activeQrHint}
                  fill
                  sizes="208px"
                  unoptimized
                  className="object-contain"
                  onError={() => markTabFailed(activeTab)}
                />
              </span>
            </button>
          )}

          <p className="mt-3 text-xs text-slate-500">{activeQrHint}</p>
          {activeQrFailed ? null : <p className="mt-0.5 text-[11px] text-slate-400">{t("settings.sponsor.zoomHint")}</p>}
        </div>
      </section>

      {/* Other ways */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h3 className="text-sm font-semibold text-slate-800">{t("settings.sponsor.otherWaysTitle")}</h3>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 transition-colors hover:border-amber-200 hover:bg-amber-50/60"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <Star className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800">{t("settings.sponsor.starGithub")}</span>
            <span className="mt-0.5 block truncate text-xs text-slate-500">{t("settings.sponsor.starGithubDesc")}</span>
          </span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400" />
        </a>
      </section>

      <p className="pb-2 text-center text-xs text-slate-400">
        {t("settings.sponsor.thanksFooter")}
        <Heart className="ml-1 inline h-3 w-3 text-rose-400" />
      </p>

      {/* Zoom modal */}
      {zoomed && !activeQrFailed ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-6 backdrop-blur-sm"
          onClick={() => setZoomed(false)}
        >
          <div
            className="relative flex max-h-full w-full max-w-xs flex-col items-center rounded-2xl bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="relative block h-72 w-72">
              <Image src={activeQrUrl} alt={activeQrHint} fill sizes="288px" unoptimized className="object-contain" />
            </span>
            <p className="mt-3 text-center text-xs text-slate-500">{activeQrHint}</p>
            <button
              type="button"
              onClick={() => setZoomed(false)}
              className="mt-3 inline-flex h-8 items-center rounded-md border border-slate-200 px-4 text-xs text-slate-600 transition-colors hover:bg-slate-50"
            >
              {t("settings.sponsor.close")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
