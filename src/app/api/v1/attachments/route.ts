/**
 * API: /api/v1/attachments
 *
 * Transaction entry attachments.
 *
 * GET    ?entryId=<TxRecord.id>       List attachments for one transaction entry.
 * POST   multipart/form-data          Upload attachments for an existing entry.
 *        Fields: entryId (TxRecord.id), files (one or more File parts).
 *        Each file is limited to 5 MB; at least one file is required.
 *
 * Success:  { ok: true, data: [{ id, name, mimeType, url }] }
 * Failure:  { ok: false, code, error } with English code/error.
 *
 * Authentication: cookie session or X-Api-Key (see getApiHouseholdScope).
 * The target entry must belong to the current household and not be deleted.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { attachmentResponseItem, saveEntryAttachment } from "@/lib/server/attachments";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const url = new URL(req.url);
    const entryId = url.searchParams.get("entryId")?.trim();
    if (!entryId) {
      return NextResponse.json({ ok: false, code: "ENTRY_ID_REQUIRED", error: "entryId is required." }, { status: 400, headers: corsHeaders() });
    }
    const attachments = await prisma.attachment.findMany({
      where: { entryId, transactions: { householdId: ctx.householdId, deletedAt: null } },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, name: true, mimeType: true, url: true, entryId: true },
    });
    return NextResponse.json({ ok: true, data: attachments.map(attachmentResponseItem) }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "ATTACHMENT_LIST_FAILED", error: error instanceof Error ? error.message : "Attachment list failed." }, { status: 500, headers: corsHeaders() });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const form = await req.formData();
    const entryId = String(form.get("entryId") ?? "").trim();
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    if (!entryId) {
      return NextResponse.json({ ok: false, code: "ENTRY_ID_REQUIRED", error: "entryId is required." }, { status: 400, headers: corsHeaders() });
    }
    if (files.length === 0) {
      return NextResponse.json({ ok: false, code: "FILES_REQUIRED", error: "At least one file is required." }, { status: 400, headers: corsHeaders() });
    }
    const data: ReturnType<typeof attachmentResponseItem>[] = [];
    for (const file of files) {
      data.push(await saveEntryAttachment({ entryId, householdId: ctx.householdId, file }));
    }
    return NextResponse.json({ ok: true, data }, { headers: corsHeaders() });
  } catch (error) {
    const code = error instanceof Error ? error.message : "ATTACHMENT_UPLOAD_FAILED";
    const status = code === "FILE_TOO_LARGE" ? 413 : code === "ENTRY_NOT_FOUND" ? 404 : code === "EMPTY_FILE" ? 400 : 500;
    const message = code === "FILE_TOO_LARGE"
      ? "Each attachment must be 5 MB or smaller."
      : code === "ENTRY_NOT_FOUND"
        ? "Transaction entry was not found."
        : code === "EMPTY_FILE"
          ? "Attachment file is empty."
          : "Attachment upload failed.";
    return NextResponse.json({ ok: false, code, error: message }, { status, headers: corsHeaders() });
  }
}
