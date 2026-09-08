export type BatchReplaceField = "date" | "postedAt" | "type" | "amount" | "inflow" | "outflow" | "account" | "viewAccount" | "toAccount" | "categoryId" | "institution" | "tagId" | "remark";

export type BatchReplaceRequest = {
  ids: string[];
  field: BatchReplaceField;
  value: string;
  contextAccountId?: string | null;
  contextAccountIds?: string[];
};

export type BatchReplaceResult = {
  ok: boolean;
  updatedCount?: number;
  changed?: Array<{ id: string; date: string; oldValue: string; newValue: string; field: string }>;
  notFoundIds?: string[];
  error?: string;
};

export async function batchReplaceEntries(request: BatchReplaceRequest): Promise<BatchReplaceResult> {
  const ids = Array.from(new Set(request.ids.map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) return { ok: false, error: "请先勾选记录" };

  const value = request.value.trim();
  if (!["remark", "categoryId", "postedAt", "institution", "tagId"].includes(request.field) && !value) return { ok: false, error: "请输入替换值" };

  const updates = ids.map((id) => ({ id, [request.field]: value }));
  const res = await fetch("/api/v1/entries/batch-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      updates,
      contextAccountId: request.contextAccountId ?? undefined,
      contextAccountIds: request.contextAccountIds?.length ? request.contextAccountIds : undefined,
    }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "批量替换失败" }));
  return data;
}
