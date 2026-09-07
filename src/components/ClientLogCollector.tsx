"use client";

import { useEffect } from "react";
import { installClientLogCollector } from "@/lib/client/feedback-logs";

/**
 * Installs the client-side log collector used by the feedback form.
 * Renders nothing; errors are kept in memory until the user submits feedback.
 */
export function ClientLogCollector() {
  useEffect(() => {
    installClientLogCollector();
  }, []);
  return null;
}
