"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type InsurancePolicyDeleteValue = {
  id: string;
  name: string;
  institutionName?: string | null;
  ownerName?: string | null;
  relatedEntryCount: number;
};

export function InsurancePolicyDeleteModal({
  open,
  value,
  deleting,
  onClose,
  onDelete,
}: {
  open: boolean;
  value: InsurancePolicyDeleteValue | null;
  deleting: boolean;
  onClose: () => void;
  onDelete: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const { t } = useI18n();

  useEffect(() => {
    if (open) {
      setPassword("");
    }
  }, [open, value?.id]);

  if (!open || !value) return null;

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-lg">
        <div className="modal-header">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <AlertTriangle className="h-4 w-4 text-rose-500" />
            {t("insurancePolicy.deleteTitle")}
          </div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            {value.relatedEntryCount > 0
              ? t("insurancePolicy.hasRelated", { count: value.relatedEntryCount })
              : t("insurancePolicy.noRelated")}
          </div>

          <div className="rounded-lg bg-slate-50/70 px-3 py-2 text-[11px] leading-5 text-slate-500">
            {[
              value.name ? t("insurancePolicy.policyLine", { name: value.name }) : "",
              value.institutionName ? t("insurancePolicy.institutionLine", { name: value.institutionName }) : "",
              value.ownerName ? t("insurancePolicy.ownerLine", { name: value.ownerName }) : "",
            ]
              .filter(Boolean)
              .join("  ")}
          </div>

          {value.relatedEntryCount > 0 ? (
            <div className="space-y-1">
              <div className="form-label">{t("insurancePolicy.confirmPassword")}</div>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="form-input"
                autoComplete="current-password"
                placeholder={t("insurancePolicy.passwordPlaceholder")}
              />
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="secondary-button h-9 px-4">
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => {
                if (deleting) return;
                void onDelete(password);
              }}
              className="h-9 rounded-[10px] bg-rose-600 px-4 text-sm text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
            >
              {deleting ? t("stockPanel.deleting") : t("settings.accounts.confirmDelete")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
