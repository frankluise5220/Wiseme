"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { createPortal } from "react-dom";
import { MailSearch, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const EmailSettingsPanel = dynamic(
  () => import("@/components/EmailSettingsPanel").then((mod) => mod.EmailSettingsPanel),
  {
    ssr: false,
    loading: () => <EmailSettingsLoading />,
  },
);

function EmailSettingsLoading() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">
      {t("creditBill.mailImportLoading")}
    </div>
  );
}

type CreditBillMailImportButtonProps = {
  accountId?: string;
  accountName: string;
};

type CreditBillMailImportDialogProps = {
  open: boolean;
  onClose: () => void;
  accountId?: string;
  accountName?: string;
};

export function CreditBillMailImportDialog({ open, onClose, accountId, accountName }: CreditBillMailImportDialogProps) {
  void accountId;
  void accountName;
  const { t } = useI18n();
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!open || typeof document === "undefined") return null;

  // When the statement preview opens, hide the mail dialog visually but keep
  // the tree mounted so the preview dialog (a child of EmailSettingsPanel)
  // stays alive. Fully close only after the preview is dismissed.
  const mailOverlayHidden = previewOpen;

  return createPortal(
    <div className={`fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/30 px-4 py-4${mailOverlayHidden ? " pointer-events-none opacity-0" : ""}`}>
      <div className="flex max-h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800">{t("creditBill.fetchMailTitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title={t("creditBill.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <EmailSettingsPanel
            embedded
            onStatementPreviewOpened={() => setPreviewOpen(true)}
            onStatementPreviewClosed={onClose}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function CreditBillMailImportButton(props: CreditBillMailImportButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700"
        title={t("creditBill.fetchMailTitle")}
      >
        <MailSearch className="h-3.5 w-3.5" />
        {t("creditBill.fetchMailTitle")}
      </button>

      <CreditBillMailImportDialog
        open={open}
        onClose={() => setOpen(false)}
        accountId={props.accountId}
        accountName={props.accountName}
      />
    </>
  );
}
