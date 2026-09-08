"use client";

import { useState, useTransition } from "react";
import { DatabaseZap } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function FillNavButton({
  entryId,
  fundCode,
  action,
  onFilled,
}: {
  entryId: string;
  fundCode: string;
  action?: (formData: FormData) => Promise<{ ok: boolean; error?: string; nav?: number; confirmDate?: string; units?: number }>;
  onFilled?: (data: { nav: number; confirmDate: string; units: number; arrivalDate?: string }) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const { t } = useI18n();

  async function fill() {
    const formData = new FormData();
    formData.set("entryId", entryId);

    startTransition(async () => {
      try {
        if (action) {
          const data = await action(formData);
          if (!data.ok) {
            window.alert(data.error ?? t("fillNav.fetchFailed"));
            return;
          }
          setDone(true);
          if (data.nav != null) {
            onFilled?.({ nav: data.nav, confirmDate: data.confirmDate ?? "", units: data.units ?? 0, arrivalDate: (data as any).arrivalDate ?? "" });
          }
          return;
        }

        const res = await fetch("/api/v1/fund/nav", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          window.alert(data.error ?? t("fillNav.backfillFailed"));
          return;
        }
        setDone(true);
        if (data.nav != null && onFilled) {
          onFilled({ nav: data.nav, confirmDate: data.confirmDate ?? "", units: data.units ?? 0 });
        }
      } catch (e) {
        window.alert(e instanceof Error ? e.message : t("fillNav.fetchFailed"));
      }
    });
  }

  if (done) return <span className="text-xs text-emerald-600">{t("fillNav.fetched")}</span>;

  return (
    <button
      type="button"
      onClick={fill}
      disabled={pending}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
      title={t("fillNav.fetchNavTitle")}
      aria-label={t("fillNav.fetchFundAria", { code: fundCode })}
    >
      <DatabaseZap className={"h-3.5 w-3.5 shrink-0" + (pending ? " animate-pulse" : "")} />
    </button>
  );
}
