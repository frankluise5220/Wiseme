"use client";

import { useI18n } from "@/lib/i18n";

type BusinessLinkActionButtonProps = {
  active: boolean;
  title?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export function BusinessLinkActionButton({
  active,
  title,
  busy = false,
  disabled = false,
  onClick,
}: BusinessLinkActionButtonProps) {
  const { t } = useI18n();
  const effectiveTitle = active
    ? title ?? t("businessLink.linked")
    : busy
    ? t("businessLink.linking")
    : title ?? t("detailView.notLinked");
  const clickable = !active && !!onClick && !disabled && !busy;

  return (
    <button
      type="button"
      data-row-double-click-ignore
      onClick={(event) => {
        event.stopPropagation();
        if (!clickable) return;
        onClick();
      }}
      disabled={!clickable}
      className={[
        "flex h-6 w-6 items-center justify-center rounded border bg-white transition-colors disabled:cursor-default",
        active
          ? "border-slate-200 text-slate-500"
          : "border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-60",
      ].join(" ")}
      title={effectiveTitle}
      aria-label={effectiveTitle}
    >
      <span
        className={[
          "inline-flex h-4 w-4 items-center justify-center rounded-full border",
          active
            ? "border-sky-300 bg-sky-100 text-sky-700 shadow-[0_0_0_2px_rgba(14,165,233,0.08)]"
            : "border-slate-200 bg-transparent text-slate-300",
        ].join(" ")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-2.5 w-2.5">
          <path
            d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      </span>
    </button>
  );
}
