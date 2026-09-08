"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const DISPLAY_QUERY_PARAMS = [
  "pageSize", "detailPage", "detailAll", "billPage", "focusEntryId", "quickEntry",
];

function navigationKey(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  // Background table refreshes normalize these without leaving the workspace.
  for (const key of DISPLAY_QUERY_PARAMS) params.delete(key);
  params.sort();
  return `${pathname}?${params.toString()}`;
}

export function useCloseOnNavigation(open: boolean, onClose: () => void) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentLocation = navigationKey(pathname, searchParams.toString());
  const previousLocationRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (previousLocationRef.current === null) {
      previousLocationRef.current = currentLocation;
      return;
    }
    if (previousLocationRef.current === currentLocation) return;
    previousLocationRef.current = currentLocation;
    if (open) onCloseRef.current();
  }, [currentLocation, open]);
}
