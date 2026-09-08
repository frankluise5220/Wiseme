"use client";

import type { ButtonHTMLAttributes, TdHTMLAttributes } from "react";
import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, Pencil, Plus, PlusCircle, Star, Trash2 } from "lucide-react";
import { APP_PREFS_EVENT, getSidebarHideInitialDataPreference } from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

function useHideSettingDescriptions() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const update = () => setHidden(getSidebarHideInitialDataPreference());
    update();
    window.addEventListener(APP_PREFS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(APP_PREFS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  return hidden;
}

export function SettingsPageHeader({
  title,
  description,
  count,
  actions,
  toolbar,
  sticky = false,
}: {
  title: string;
  description?: string;
  count?: number | string;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  sticky?: boolean;
}) {
  const { t } = useI18n();
  const hideDescriptions = useHideSettingDescriptions();
  const showDescription = Boolean(description) && !hideDescriptions;

  return (
    <div className={sticky ? "sticky top-0 z-20 border-b border-slate-200 bg-slate-50/95 pb-3 pt-1 backdrop-blur" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0" title={description && hideDescriptions ? description : undefined}>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
            {count !== undefined ? (
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] tabular-nums text-slate-500">
                {t("settings.scaffold.itemCount", { count })}
              </span>
            ) : null}
          </div>
          {showDescription ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {toolbar ? <div className="mt-3 flex flex-wrap items-center gap-2">{toolbar}</div> : null}
    </div>
  );
}

export function SettingsPrimaryAddButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
    >
      <Plus className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

export function SettingsActionButton({
  label,
  variant = "default",
  size = "default",
  icon,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "default" | "edit" | "delete" | "view" | "hide" | "copy" | "add" | "defaultMark";
  size?: "default" | "sm";
  icon?: React.ReactNode;
}) {
  const toneClass =
    variant === "delete"
      ? "text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
      : variant === "edit"
        ? "text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
        : variant === "add" || variant === "defaultMark"
          ? "text-slate-500 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"
          : "text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700";
  const resolvedIcon = icon ?? (
    variant === "delete" ? <Trash2 className="h-3.5 w-3.5" />
      : variant === "edit" ? <Pencil className="h-3.5 w-3.5" />
        : variant === "view" ? <Eye className="h-3.5 w-3.5" />
          : variant === "hide" ? <EyeOff className="h-3.5 w-3.5" />
            : variant === "copy" ? <Copy className="h-3.5 w-3.5" />
              : variant === "add" ? <PlusCircle className="h-3.5 w-3.5" />
                : variant === "defaultMark" ? <Star className="h-3.5 w-3.5" />
                  : null
  );
  return (
    <button
      type="button"
      title={props.title ?? label}
      aria-label={props["aria-label"] ?? label}
      {...props}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-md border text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-6 w-6 border-transparent bg-transparent" : "h-7 w-7 border-slate-200 bg-white",
        toneClass,
        className ?? "",
      ].join(" ")}
    >
      {resolvedIcon}
      {children ? <span className="sr-only">{children}</span> : null}
    </button>
  );
}

export function SettingsSection({
  title,
  description,
  count,
  actions,
  children,
}: {
  title: string;
  description?: string;
  count?: number | string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hideDescriptions = useHideSettingDescriptions();
  const showDescription = Boolean(description) && !hideDescriptions;

  return (
    <section className="panel-surface overflow-hidden">
      <div className="panel-header gap-3">
        <div className="min-w-0" title={description && hideDescriptions ? description : undefined}>
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-slate-800">{title}</div>
            {count !== undefined ? <span className="text-xs tabular-nums text-slate-400">({count})</span> : null}
          </div>
          {showDescription ? <div className="mt-1 text-xs text-slate-500">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsTable({
  minWidth = 760,
  maxWidth = "full",
  className,
  children,
}: {
  minWidth?: number;
  maxWidth?: number | "full";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "w-full overflow-hidden rounded-md border border-slate-200 bg-white",
        className ?? "",
      ].join(" ")}
      style={maxWidth === "full" ? undefined : { maxWidth: `${maxWidth}px` }}
    >
      <div className="overflow-auto">
        <table className="w-full table-fixed border-separate border-spacing-0" style={{ minWidth: `min(100%, ${minWidth}px)` }}>
          {children}
        </table>
      </div>
    </div>
  );
}

export function SettingsTh({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right" | "center";
}) {
  return (
    <th
      className={[
        "border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

export function SettingsTd({
  children,
  align,
  className,
  ...tdProps
}: {
  children: React.ReactNode;
  align?: "right" | "center";
  className?: string;
} & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...tdProps}
      className={[
        "border-b border-slate-100 px-3 py-2 text-xs text-slate-600",
        align === "right" ? "text-right tabular-nums" : align === "center" ? "text-center" : "text-left",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </td>
  );
}

export function SettingsEmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-slate-400">
        {children}
      </td>
    </tr>
  );
}

export function SettingsRowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-1.5">{children}</div>;
}

export function SettingsPreferencePanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const hideDescriptions = useHideSettingDescriptions();
  const showDescription = Boolean(description) && !hideDescriptions;

  return (
    <section className="panel-surface overflow-hidden">
      <div className="panel-header">
        <div title={description && hideDescriptions ? description : undefined}>
          <div className="text-sm font-medium text-slate-800">{title}</div>
          {showDescription ? <div className="mt-1 text-xs text-slate-500">{description}</div> : null}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
