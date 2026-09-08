const FX_CONVERSION_SOURCE = "fx_conversion";

export function txRecordAccountScopeWhere(accountIds: string | string[]) {
  const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : [accountIds].filter(Boolean);
  const accountSide = ids.length === 1 ? { accountId: ids[0] } : { accountId: { in: ids } };
  const toAccountSide = ids.length === 1 ? { toAccountId: ids[0] } : { toAccountId: { in: ids } };
  return {
    OR: [
      accountSide,
      {
        AND: [
          toAccountSide,
          { source: { not: FX_CONVERSION_SOURCE } },
        ],
      },
    ],
  };
}
