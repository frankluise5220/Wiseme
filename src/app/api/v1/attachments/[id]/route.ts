/**
 * API: /api/v1/attachments/:id
 *
 * Single transaction attachment by its attachment id.
 *
 * GET     Download the attachment bytes (inline Content-Disposition with the stored name).
 * DELETE  Delete the attachment record and its stored file.
 *
 * Success:  GET returns raw bytes; DELETE returns { ok: true }.
 * Failure:  { ok: false, code, error } with English code/error.
 *
 * Authentication: cookie session or X-Api-Key (see getApiHouseholdScope).
 * Only attachments whose entry belongs to the current household are accessible.
 */
import { NextResponse } from "next/server";
import { deleteAttachmentFile, readAttachmentFile, sanitizeAttachmentName } from "@/lib/server/attachments";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function encodeRfc5987Value(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDisposition(fileName: string) {
  const safeName = sanitizeAttachmentName(fileName);
  const asciiName = safeName.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "'");
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987Value(safeName)}`;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const { id } = await context.params;
    const result = await readAttachmentFile(id, ctx.householdId);
    if (!result) {
      return NextResponse.json({ ok: false, code: "ATTACHMENT_NOT_FOUND", error: "Attachment was not found." }, { status: 404, headers: corsHeaders() });
    }
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        ...corsHeaders(),
        "Content-Type": result.attachment.mimeType || "application/octet-stream",
        "Content-Disposition": contentDisposition(result.attachment.name || "attachment"),
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "ATTACHMENT_DOWNLOAD_FAILED", error: error instanceof Error ? error.message : "Attachment download failed." }, { status: 500, headers: corsHeaders() });
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const { id } = await context.params;
    const deleted = await deleteAttachmentFile(id, ctx.householdId);
    if (!deleted) {
      return NextResponse.json({ ok: false, code: "ATTACHMENT_NOT_FOUND", error: "Attachment was not found." }, { status: 404, headers: corsHeaders() });
    }
    return NextResponse.json({ ok: true }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "ATTACHMENT_DELETE_FAILED", error: error instanceof Error ? error.message : "Attachment delete failed." }, { status: 500, headers: corsHeaders() });
  }
}
