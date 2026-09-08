import { revalidatePath, revalidateTag } from "next/cache";

export function revalidateAfterTxChange() {
  revalidateTag("common-data", "max");
  revalidateTag("entries", "max");
  revalidatePath("/");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

export function revalidateAfterEntryOrderChange() {
  revalidateTag("entries", "max");
}

export function revalidateAfterInvestChange() {
  revalidateAfterTxChange();
  revalidateTag("invest-balances", "max");
  revalidateTag("invest-account-data", "max");
  revalidateTag("fund-holding", "max");
  revalidateTag("stock-holding-report", "max");
  revalidateTag("stock-transactions", "max");
  revalidateTag("fixed-asset-display", "max");
  revalidateTag("fixed-asset-transactions", "max");
  revalidatePath("/invest");
  revalidatePath("/investments");
  revalidatePath("/funds");
  revalidatePath("/regular-invest");
  revalidatePath("/reports");
}

export function revalidateAfterSettingsChange() {
  revalidateTag("common-data", "max");
  revalidateTag("invest-balances", "max");
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
  revalidatePath("/settings/institutions");
  revalidatePath("/settings/counterparties");
  revalidatePath("/settings/family-members");
  revalidatePath("/settings/categories");
  revalidatePath("/settings/tags");
}
