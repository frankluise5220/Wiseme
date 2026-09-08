"use client";

type ConfirmDialogTone = "default" | "danger";

export type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
};

export type ChoiceDialogOption<T extends string> = {
  value: T;
  label: string;
  tone?: ConfirmDialogTone;
};

export type ChoiceDialogOptions<T extends string> = {
  title: string;
  message: string;
  choices: ChoiceDialogOption<T>[];
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
};

function appendTextBlock(parent: HTMLElement, text: string) {
  const lines = text.split("\n");
  for (const line of lines) {
    const node = document.createElement(line.trim() ? "p" : "div");
    node.textContent = line;
    node.className = line.trim() ? "text-sm leading-6 text-slate-600" : "h-2";
    parent.appendChild(node);
  }
}

export function showConfirmDialog({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  tone = "default",
}: ConfirmDialogOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/30 px-4 py-6 backdrop-blur-[1px]";

    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.className =
      "w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20";

    const body = document.createElement("div");
    body.className = "space-y-3 p-5";

    const heading = document.createElement("div");
    heading.className = "flex items-start gap-3";

    const icon = document.createElement("div");
    icon.className =
      tone === "danger"
        ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"
        : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600";
    icon.textContent = tone === "danger" ? "!" : "i";

    const titleBox = document.createElement("div");
    titleBox.className = "min-w-0 flex-1";

    const titleNode = document.createElement("h2");
    titleNode.className = "text-base font-semibold text-slate-900";
    titleNode.textContent = title;

    const messageNode = document.createElement("div");
    messageNode.className = "mt-2 space-y-1";
    appendTextBlock(messageNode, message);

    titleBox.append(titleNode, messageNode);
    heading.append(icon, titleBox);
    body.appendChild(heading);

    const footer = document.createElement("div");
    footer.className = "flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className =
      "inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100";
    cancelButton.textContent = cancelLabel;

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className =
      tone === "danger"
        ? "inline-flex h-9 items-center justify-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700"
        : "inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700";
    confirmButton.textContent = confirmLabel;

    footer.append(cancelButton, confirmButton);
    panel.append(body, footer);
    overlay.appendChild(panel);

    function close(result: boolean) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      previousActive?.focus?.();
      resolve(result);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      }
    }

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(false);
    });
    cancelButton.addEventListener("click", () => close(false));
    confirmButton.addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    confirmButton.focus();
  });
}

export function showChoiceDialog<T extends string>({
  title,
  message,
  choices,
  cancelLabel = "取消",
  tone = "default",
}: ChoiceDialogOptions<T>): Promise<T | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/30 px-4 py-6 backdrop-blur-[1px]";

    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.className =
      "w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20";

    const body = document.createElement("div");
    body.className = "space-y-3 p-5";

    const heading = document.createElement("div");
    heading.className = "flex items-start gap-3";

    const icon = document.createElement("div");
    icon.className =
      tone === "danger"
        ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"
        : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600";
    icon.textContent = tone === "danger" ? "!" : "i";

    const titleBox = document.createElement("div");
    titleBox.className = "min-w-0 flex-1";

    const titleNode = document.createElement("h2");
    titleNode.className = "text-base font-semibold text-slate-900";
    titleNode.textContent = title;

    const messageNode = document.createElement("div");
    messageNode.className = "mt-2 space-y-1";
    appendTextBlock(messageNode, message);

    titleBox.append(titleNode, messageNode);
    heading.append(icon, titleBox);
    body.appendChild(heading);

    const footer = document.createElement("div");
    footer.className = "flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className =
      "inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100";
    cancelButton.textContent = cancelLabel;
    footer.appendChild(cancelButton);

    function close(result: T | null) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      previousActive?.focus?.();
      resolve(result);
    }

    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        choice.tone === "danger"
          ? "inline-flex h-9 items-center justify-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700"
          : "inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700";
      button.textContent = choice.label;
      button.addEventListener("click", () => close(choice.value));
      footer.appendChild(button);
    }

    panel.append(body, footer);
    overlay.appendChild(panel);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
    }

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(null);
    });
    cancelButton.addEventListener("click", () => close(null));
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    cancelButton.focus();
  });
}
