"use client";

import { useEffect, useMemo, useState } from "react";
import { SmartSelect } from "./SmartSelect";
import { fetchSettingsTags } from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";

type EntryTagOption = { id: string; name: string; color: string | null };

/**
 * Reusable tag picker for a transaction entry. Loads the household tag list on
 * mount and supports inline tag creation (POST /api/v1/tags). Used by the
 * investment transaction modals (fund/metal/wealth/deposit/insurance) to let
 * users attach tags to investment entries, mirroring the income/expense form.
 */
export function EntryTagsField({
  value,
  onChange,
  className,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [tagList, setTagList] = useState<EntryTagOption[]>([]);

  useEffect(() => {
    const target = (window as unknown as { __mmhTagsReady?: boolean }).__mmhTagsReady === true;
    void fetchSettingsTags({ force: !target }).then((tags) => {
      setTagList(tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = useMemo(
    () => tagList.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color })),
    [tagList],
  );

  return (
    <div className={className}>
      <div className="text-xs font-medium text-slate-600">{t("detail.column.tags")}</div>
      <SmartSelect
        mode="multi"
        value={value}
        onChange={onChange}
        options={options}
        placeholder={t("txForm.selectTags")}
        onInlineCreate={async (name, color) => {
          const res = await fetch("/api/v1/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, color }),
          });
          const data = await res.json();
          if (!data.ok || !data.tag) throw new Error(data.error ?? t("txForm.createFailed"));
          return { id: data.tag.id, label: data.tag.name, color: data.tag.color };
        }}
        onCreated={(tag) => {
          setTagList((prev) => [...prev, { id: tag.id, name: tag.label, color: tag.color ?? null }]);
          onChange([...(value ?? []), tag.id]);
        }}
      />
    </div>
  );
}
