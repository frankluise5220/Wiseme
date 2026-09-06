import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";

export const runtime = "nodejs";

function cors() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

async function resolveBillStorageAccountId(accountId: string) {
  const { householdId } = await getHouseholdScope();
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      kind: true,
      creditBillMode: true,
    },
  });
  if (!account) return null;
  const billAccountIds = await getCreditBillAccountIds(prisma, account);
  return billAccountIds[0] ?? account.id;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") ?? "";
  const statementMonth = searchParams.get("statementMonth") ?? "";
  if (!accountId || !statementMonth) {
    return NextResponse.json({ ok: true, overrides: [] }, { headers: cors() });
  }
  const storageAccountId = await resolveBillStorageAccountId(accountId);
  if (!storageAccountId) {
    return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404, headers: cors() });
  }
  const overrides = await prisma.billOverride.findMany({
    where: { accountId: storageAccountId, statementMonth: { startsWith: statementMonth.slice(0, 7) } },
    orderBy: { statementMonth: "desc" },
  });
  return NextResponse.json({ ok: true, overrides }, { headers: cors() });
}

const SaveSchema = z.object({
  accountId: z.string(),
  statementMonth: z.string(),
  amount: z.number(),
  note: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as unknown;
    const parse = SaveSchema.safeParse(body);
    if (!parse.success) {
      return NextResponse.json({ ok: false, code: "MISSING_FIELDS", error: "缺少必填字段" }, { status: 400, headers: cors() });
    }
    const { accountId, statementMonth, amount, note } = parse.data;
    const storageAccountId = await resolveBillStorageAccountId(accountId);
    if (!storageAccountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404, headers: cors() });
    }
    const existing = await prisma.billOverride.findFirst({
      where: { accountId: storageAccountId, statementMonth },
    });
    let override;
    if (existing) {
      override = await prisma.billOverride.update({
        where: { id: existing.id },
        data: { amount: String(amount), note },
      });
    } else {
      override = await prisma.billOverride.create({
        data: { accountId: storageAccountId, statementMonth, amount: String(amount), note },
      });
    }
    revalidateAfterTxChange();
    return NextResponse.json({ ok: true, override }, { headers: cors() });
  } catch (err) {
    console.error("[bill/override POST]", err);
    return NextResponse.json({ ok: false, code: "SAVE_FAILED", error: String(err) }, { status: 500, headers: cors() });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") ?? "";
  const statementMonth = searchParams.get("statementMonth") ?? "";
  if (!accountId || !statementMonth) {
    return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "缺少参数" }, { status: 400, headers: cors() });
  }
  const storageAccountId = await resolveBillStorageAccountId(accountId);
  if (!storageAccountId) {
    return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404, headers: cors() });
  }

  const existing = await prisma.billOverride.findFirst({
    where: { accountId: storageAccountId, statementMonth },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "RECORD_NOT_FOUND", error: "账单覆盖记录不存在" }, { status: 404, headers: cors() });
  }

  await prisma.billOverride.delete({ where: { id: existing.id } });
  revalidateAfterTxChange();
  return NextResponse.json({ ok: true }, { headers: cors() });
}
