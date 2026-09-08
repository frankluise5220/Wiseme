type StatementPreviewCategorySyncItem = {
  type?: string | null;
  remark?: string | null;
};

function normalizePreviewRemark(value?: string | null) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function statementPreviewCategorySyncKey(item: StatementPreviewCategorySyncItem) {
  const transactionType = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
  const remark = normalizePreviewRemark(item.remark);
  return transactionType && remark ? `${transactionType}\u0000${remark}` : "";
}
