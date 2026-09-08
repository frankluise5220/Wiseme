export type LedgerInviteCodeRecord = {
  code: string;
  createdAt?: string;
  usedAt?: string;
  usedHouseholdId?: string;
  usedHouseholdName?: string;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeInviteRecords(records: LedgerInviteCodeRecord[]) {
  const byCode = new Map<string, LedgerInviteCodeRecord>();
  for (const record of records) {
    const code = cleanText(record.code);
    if (!code) continue;
    const existing = byCode.get(code);
    byCode.set(code, {
      code,
      createdAt: cleanText(record.createdAt) || existing?.createdAt || undefined,
      usedAt: cleanText(record.usedAt) || existing?.usedAt || undefined,
      usedHouseholdId: cleanText(record.usedHouseholdId) || existing?.usedHouseholdId || undefined,
      usedHouseholdName: cleanText(record.usedHouseholdName) || existing?.usedHouseholdName || undefined,
    });
  }
  return Array.from(byCode.values());
}

export function parseLedgerInviteCodeRecords(value: string | null | undefined): LedgerInviteCodeRecord[] {
  const text = cleanText(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeInviteRecords(parsed.map((item) => {
        if (typeof item === "string") return { code: item };
        if (item && typeof item === "object") {
          const source = item as Record<string, unknown>;
          return {
            code: cleanText(source.code),
            createdAt: cleanText(source.createdAt) || undefined,
            usedAt: cleanText(source.usedAt) || undefined,
            usedHouseholdId: cleanText(source.usedHouseholdId) || undefined,
            usedHouseholdName: cleanText(source.usedHouseholdName) || undefined,
          };
        }
        return { code: "" };
      }));
    }
    if (typeof parsed === "string" && parsed.trim()) return [{ code: parsed.trim() }];
  } catch {}
  return [{ code: text }];
}

export function serializeLedgerInviteCodeRecords(records: LedgerInviteCodeRecord[]) {
  const normalized = normalizeInviteRecords(records);
  return normalized.length > 0 ? JSON.stringify(normalized) : "";
}

export function createLedgerInviteCodeRecord(code: string, createdAt = new Date().toISOString()): LedgerInviteCodeRecord {
  return { code: cleanText(code), createdAt };
}

export function activeLedgerInviteCodes(records: LedgerInviteCodeRecord[]) {
  return records.filter((record) => !record.usedAt).map((record) => record.code);
}

export function findLedgerInviteCodeRecord(records: LedgerInviteCodeRecord[], code: string) {
  const target = cleanText(code);
  return records.find((record) => record.code === target) ?? null;
}

export function markLedgerInviteCodeUsed(
  records: LedgerInviteCodeRecord[],
  code: string,
  used: { householdId: string; householdName: string; usedAt?: string },
) {
  const target = cleanText(code);
  const usedAt = used.usedAt ?? new Date().toISOString();
  return normalizeInviteRecords(records.map((record) => (
    record.code === target
      ? {
          ...record,
          usedAt,
          usedHouseholdId: used.householdId,
          usedHouseholdName: used.householdName,
        }
      : record
  )));
}
