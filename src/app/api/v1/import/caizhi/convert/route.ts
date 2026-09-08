import { NextRequest, NextResponse } from "next/server";
import { convertCaizhiBackupToMmhBackup } from "@/lib/importers/caizhi/export";

export const runtime = "nodejs";
const UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024;

function encodeRfc5987Value(value: string) {
  return encodeURIComponent(value).replace(/[\'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function asciiHeaderFileName(fileName: string) {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/["\\;]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (fallback && /[A-Za-z0-9]/.test(fallback)) return fallback;
  return "caizhi-converted.mmhbackup";
}

function attachmentDisposition(fileName: string) {
  return `attachment; filename="${asciiHeaderFileName(fileName)}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

/**
 * POST /api/v1/import/caizhi/convert
 *
 * Converts a Caizhi `.mh8` / Jet database backup to an encrypted MMH
 * `.mmhbackup` package. The converted package is a household-scoped backup
 * containing accounts, categories, and daily income/expense/transfer records
 * that can be restored through the normal MMH backup restore flow.
 *
 * Multipart form fields:
 * - file: Caizhi backup file
 * - backupPassphrase: passphrase for the generated MMH backup package
 * - householdName?: optional ledger name written into the generated backup
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, code: "MISSING_FILE", error: "Missing Caizhi backup file" }, { status: 400 });
    }
    if (file.size <= 0) {
      return NextResponse.json({ ok: false, code: "EMPTY_FILE", error: "Caizhi backup file is empty" }, { status: 400 });
    }
    if (file.size > UPLOAD_LIMIT_BYTES) {
      return NextResponse.json({ ok: false, code: "FILE_TOO_LARGE", error: "Caizhi backup file exceeds 128MB" }, { status: 413 });
    }

    const backupPassphrase = String(form.get("backupPassphrase") ?? "").trim();
    if (!backupPassphrase) {
      return NextResponse.json({ ok: false, code: "MISSING_PASSPHRASE", error: "Backup passphrase is required" }, { status: 400 });
    }

    const householdName = String(form.get("householdName") ?? "").trim() || null;
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await convertCaizhiBackupToMmhBackup(buffer, file.name || "caizhi.mh8", backupPassphrase, {
      householdName,
    });

    return new Response(result.json, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachmentDisposition(result.fileName),
        "Cache-Control": "no-store",
        "X-MMH-Caizhi-Summary": encodeURIComponent(JSON.stringify(result.summary)),
      },
    });
  } catch (error) {
    console.error("Caizhi backup conversion failed", error);
    const message = error instanceof Error ? error.message : "Caizhi backup conversion failed";
    return NextResponse.json({ ok: false, code: "CONVERT_FAILED", error: message }, { status: 500 });
  }
}
