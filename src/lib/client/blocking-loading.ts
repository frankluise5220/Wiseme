"use client";

let activeOverlay: HTMLElement | null = null;

/**
 * Show a full-screen blocking overlay with a spinner and message.
 * Prevents user interaction while a long-running operation is in progress.
 *
 * @returns A function to close the overlay.
 */
export function showBlockingLoading(message: string): () => void {
  if (typeof document === "undefined") return () => {};

  // Remove any existing overlay to avoid duplicates
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }

  const overlay = document.createElement("div");
  overlay.className =
    "fixed inset-0 z-[10001] flex flex-col items-center justify-center bg-slate-950/40 backdrop-blur-[1px]";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-busy", "true");

  const panel = document.createElement("div");
  panel.className =
    "flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white px-8 py-6 shadow-2xl shadow-slate-900/20";

  // Spinner (inline SVG to avoid depending on icon font)
  const spinner = document.createElement("div");
  spinner.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-blue-600">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  `;

  const messageNode = document.createElement("p");
  messageNode.className = "text-sm font-medium text-slate-700";
  messageNode.textContent = message;

  panel.appendChild(spinner.firstElementChild!);
  panel.appendChild(messageNode);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  return function closeBlockingLoading() {
    if (activeOverlay === overlay) {
      overlay.remove();
      activeOverlay = null;
    }
  };
}
