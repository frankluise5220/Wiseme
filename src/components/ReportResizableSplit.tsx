"use client";

import type { ReactNode } from "react";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { useI18n } from "@/lib/i18n";

const STORAGE_KEY = "mmh:reports:summary-height";

export function ReportResizableSplit({
  hasDetails,
  children,
}: {
  hasDetails: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <ResizableVerticalSplit
      storageKey={STORAGE_KEY}
      hasLowerPane={hasDetails}
      separatorLabel={t("reportResizable.separatorLabel")}
      separatorTitle={t("reportResizable.separatorTitle")}
    >
      {children}
    </ResizableVerticalSplit>
  );
}
