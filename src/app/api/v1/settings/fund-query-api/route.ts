import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

const DEFAULT_FUND_QUERY_APIS = [
  {
    code: "eastmoney",
    name: "天天基金",
    baseUrl: "http://fundgz.1234567.com.cn/js/{code}.js",
    priority: 1,
    isActive: true,
  },
  {
    code: "eastmoney_history",
    name: "东方财富历史净值",
    baseUrl: "http://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=5&startDate={date}&endDate={date}",
    priority: 2,
    isActive: true,
  },
  {
    code: "danjuan",
    name: "蛋卷基金",
    baseUrl: "https://danjuanfunds.com/djapi/fund/{code}",
    priority: 3,
    isActive: false,
  },
  {
    code: "alipay",
    name: "支付宝基金",
    baseUrl: "https://fundmobapi.alipay.com/fund/v1/fund/detail?fundCode={code}",
    priority: 5,
    isActive: false,
  },
];

const BROKEN_DEFAULT_BASE_URLS: Record<string, string[]> = {
  alipay: ["https://fundapi.eastmoney.com/fundapi/{code}/nav"],
};

async function ensureDefaultFundQueryApis() {
  await prisma.$transaction(
    DEFAULT_FUND_QUERY_APIS.map((api) =>
      prisma.fundQueryApi.upsert({
        where: { code: api.code },
        create: api,
        update: {},
      }),
    ),
  );
}

async function repairBrokenDefaultFundQueryApis() {
  const updates = DEFAULT_FUND_QUERY_APIS.flatMap((api) =>
    (BROKEN_DEFAULT_BASE_URLS[api.code] ?? []).map((baseUrl) =>
      prisma.fundQueryApi.updateMany({
        where: { code: api.code, baseUrl },
        data: { baseUrl: api.baseUrl },
      }),
    ),
  );
  if (updates.length > 0) await prisma.$transaction(updates);
}

// GET: list FundQueryApi entries within the current household
export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    await ensureDefaultFundQueryApis();
    await repairBrokenDefaultFundQueryApis();

    let apis = await prisma.fundQueryApi.findMany({
      where: {
        OR: [
          { householdId },
          { householdId: null },
        ],
      },
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" },
      ],
    });

    return NextResponse.json({ ok: true, apis });
  } catch {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: "服务器错误" }, { status: 500 });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  code: z.string().min(1).max(40),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

// POST: create a new FundQueryApi within the current household
export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段（name/code/baseUrl）" }, { status: 400 });
  }

  const { name, code, baseUrl, apiKey, priority, isActive } = parse.data;

  const api = await prisma.fundQueryApi.create({
    data: { name, code, baseUrl, apiKey: apiKey || null, priority, isActive, householdId },
  });

  return NextResponse.json({ ok: true, api });
}

// PUT: update fields of a single FundQueryApi within the current household
export async function PUT(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const { id, name, baseUrl, apiKey, priority, isActive } = body;

  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "API 不存在" }, { status: 404 });

  // Authorization check: the API does not belong to the current household
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (apiKey !== undefined) data.apiKey = apiKey || null;
  if (priority !== undefined) data.priority = priority;
  if (isActive !== undefined) data.isActive = isActive;

  await prisma.fundQueryApi.update({ where: { id }, data });

  // If the API is deactivated, clear it from all accounts in the current household that reference it as the default
  if (isActive === false) {
    await prisma.account.updateMany({
      where: { defaultFundQueryApiId: id, householdId },
      data: { defaultFundQueryApiId: null },
    });
  }

  return NextResponse.json({ ok: true });
}

const ReorderSchema = z.object({
  priorities: z.array(z.object({
    id: z.string().min(1),
    priority: z.number().int().min(1),
  })).min(1),
});

// PATCH: batch update priorities of FundQueryApi entries visible to the current household, for drag-and-drop ordering
export async function PATCH(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const parse = ReorderSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_REORDER_DATA", error: "缺少排序数据" }, { status: 400 });
  }

  const ids = parse.data.priorities.map((item) => item.id);
  const existing = await prisma.fundQueryApi.findMany({
    where: { id: { in: ids } },
    select: { id: true, householdId: true },
  });
  if (existing.length !== ids.length) {
    return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "部分 API 不存在" }, { status: 404 });
  }
  if (existing.some((api) => api.householdId !== householdId && api.householdId !== null)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  await prisma.$transaction(
    parse.data.priorities.map((item) =>
      prisma.fundQueryApi.update({
        where: { id: item.id },
        data: { priority: item.priority },
      }),
    ),
  );

  const apis = await prisma.fundQueryApi.findMany({
    where: {
      OR: [
        { householdId },
        { householdId: null },
      ],
    },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" },
    ],
  });

  return NextResponse.json({ ok: true, apis });
}

// DELETE: delete a FundQueryApi within the current household
export async function DELETE(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "API 不存在" }, { status: 404 });

  // Authorization check: the API does not belong to the current household
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  // Clear this API from the default settings of all accounts that reference it before deleting
  await prisma.account.updateMany({
    where: existing.householdId
      ? { defaultFundQueryApiId: id, householdId }
      : { defaultFundQueryApiId: id },
    data: { defaultFundQueryApiId: null },
  });

  await prisma.fundQueryApi.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
