import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type StoredAttachment = {
  id: string;
  name: string | null;
  mimeType: string | null;
  url: string | null;
  entryId: string;
};

function attachmentRoot() {
  return path.resolve(process.env.MMH_ATTACHMENT_DIR || path.join(process.cwd(), "data", "attachments"));
}

export function attachmentFilePath(id: string) {
  return path.join(attachmentRoot(), `${id}.bin`);
}

export function attachmentDownloadUrl(id: string) {
  return `/api/v1/attachments/${encodeURIComponent(id)}`;
}

export function sanitizeAttachmentName(name: string) {
  return name.replace(/[\\/:*?"<>|\x00-\x1F]+/g, "_").trim().slice(0, 180) || "attachment";
}

export function attachmentResponseItem(item: StoredAttachment) {
  return {
    id: item.id,
    name: item.name || "attachment",
    mimeType: item.mimeType || "application/octet-stream",
    url: attachmentDownloadUrl(item.id),
  };
}

export async function saveEntryAttachment(params: {
  entryId: string;
  householdId: string;
  file: File;
}) {
  const { entryId, householdId, file } = params;
  if (file.size <= 0) throw new Error("EMPTY_FILE");
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error("FILE_TOO_LARGE");

  const entry = await prisma.txRecord.findFirst({
    where: { id: entryId, householdId, deletedAt: null },
    select: { id: true },
  });
  if (!entry) throw new Error("ENTRY_NOT_FOUND");

  const id = randomUUID();
  const name = sanitizeAttachmentName(file.name || "attachment");
  await mkdir(attachmentRoot(), { recursive: true });
  await writeFile(attachmentFilePath(id), Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
  const created = await prisma.attachment.create({
    data: {
      id,
      entryId,
      name,
      mimeType: file.type || "application/octet-stream",
      url: attachmentDownloadUrl(id),
    },
    select: { id: true, name: true, mimeType: true, url: true, entryId: true },
  });
  return attachmentResponseItem(created);
}

export async function readAttachmentFile(id: string, householdId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id, transactions: { householdId, deletedAt: null } },
    select: { id: true, name: true, mimeType: true, url: true, entryId: true },
  });
  if (!attachment) return null;
  const bytes = await readFile(attachmentFilePath(id));
  return { attachment, bytes };
}

export async function deleteAttachmentFile(id: string, householdId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id, transactions: { householdId, deletedAt: null } },
    select: { id: true },
  });
  if (!attachment) return false;
  await prisma.attachment.delete({ where: { id } });
  await unlink(attachmentFilePath(id)).catch(() => undefined);
  return true;
}
