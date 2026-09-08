"use client";

export const AI_CONFIG_CHANGED_EVENT = "mmh:ai-config:changed";

export function dispatchAiConfigChanged() {
  window.dispatchEvent(new Event(AI_CONFIG_CHANGED_EVENT));
}
