"use client";

import { getSidebarHideInitialDataPreference } from "@/lib/client/appPreferences";

export const FIRST_USE_GUIDE_OPEN_EVENT = "mmh:first-use-guide:open";

export function dispatchFirstUseGuideOpen() {
  if (getSidebarHideInitialDataPreference()) return;
  window.dispatchEvent(new CustomEvent(FIRST_USE_GUIDE_OPEN_EVENT));
}
