"use client";

import { useI18n } from "@/lib/i18n";

/**
 * Segment-level error boundary for the App Router.
 * This file renders inside the root layout, so it must not return document
 * elements such as `<html>` or `<body>`.
 */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-3xl">
          ⚠️
        </div>
        <h1 className="mb-2 text-lg font-semibold text-slate-900">
          {t("errorPage.title")}
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-slate-500">
          {t("errorPage.description")}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {t("errorPage.retry")}
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("errorPage.reload")}
          </button>
        </div>
      </div>
    </div>
  );
}
