"use client";

import { useState } from "react";
import { SettingsActionButton } from "@/components/settings/SettingsPageScaffold";
import { notifySettingsDataChanged, type SettingsDataScope } from "@/lib/client/settingsCache";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

function scopeForEntity(entity: "accountGroup" | "account" | "institution" | "counterparty" | "category"): SettingsDataScope {
  return entity === "category" ? "categories" : "accounts";
}

export function SettingsDeleteButton({
  label,
  entity,
  id,
  refresh,
  onDeleted,
}: {
  label: string;
  entity: "accountGroup" | "account" | "institution" | "counterparty" | "category";
  id: string;
  refresh?: boolean;
  onDeleted?: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const { t } = useI18n();

  async function onDelete() {
    if (deleting) return;
    const confirmed = await showConfirmDialog({
      title: t("settingsDelete.confirmTitle"),
      message: t("settingsDelete.confirmMessage", { label }),
      tone: "danger",
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      const res = await fetch("/api/v1/settings/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id }),
      });

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) {
        window.alert(data?.error ?? t("settingsDelete.deleteFailed"));
        return;
      }
      void notifySettingsDataChanged({ scope: scopeForEntity(entity), reason: `${entity}:delete`, prefetch: true });
      onDeleted?.();
      if (refresh !== false) {
        dispatchFinanceDataChanged({ reason: "settings-entity:delete" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("settingsDelete.deleteFailed");
      window.alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <SettingsActionButton
      label={t("settingsDelete.deleteLabel", { label })}
      variant="delete"
      onClick={onDelete}
      disabled={deleting}
    />
  );
}
