import { getInsuranceAction, getInsuranceProductName } from "@/lib/insurance/transaction";

type InsuranceDetailLike = {
  readonly source?: string | null;
  readonly insuranceAction?: string | null;
  readonly insuranceProductName?: string | null;
  readonly fundName?: string | null;
  readonly fundSubtype?: string | null;
  readonly note?: string | null;
  readonly categoryName?: string | null;
};

export function getInsuranceDetailCategoryName(entry: InsuranceDetailLike) {
  if (entry.source !== "insurance") {
    return (entry.categoryName ?? "").trim();
  }
  return getInsuranceAction(entry) === "refund" ? "保险回款" : "保险支出";
}

export function getInsuranceDetailNote(entry: InsuranceDetailLike) {
  const rawNote = (entry.note ?? "").trim();
  if (entry.source !== "insurance") {
    return rawNote;
  }
  const action = getInsuranceAction(entry);
  const actionLabel =
    action === "refund"
      ? "保险回款"
      : action === "additional_premium"
        ? "保全缴费"
        : "保险续期";
  const taskPrefix = rawNote.includes("计划任务") ? "计划任务：" : "";
  const productName = getInsuranceProductName(entry);
  return productName ? `${taskPrefix}${actionLabel}：${productName}` : `${taskPrefix}${actionLabel}`;
}
