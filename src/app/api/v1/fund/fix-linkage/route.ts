import { NextRequest, NextResponse } from "next/server";

export async function POST(_req: NextRequest) {
  return NextResponse.json({
    ok: true,
    message: "新数据模型中不再需要联动修复，每条交易记录已包含完整的账户信息",
  });
}
