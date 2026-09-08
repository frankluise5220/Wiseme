import type { EntryCashFlowDirection } from "@/lib/server/entry-business-link";

export function getCashFlowDate(params: {
  direction: EntryCashFlowDirection;
  operationDate: Date;
  settlementDate?: Date | null;
  fallbackDate?: Date | null;
}) {
  if (params.direction === "inflow") {
    return params.settlementDate ?? params.fallbackDate ?? params.operationDate;
  }
  return params.fallbackDate ?? params.operationDate;
}
