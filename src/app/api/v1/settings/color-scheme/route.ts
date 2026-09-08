import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { cookies } from "next/headers";

// GET: get the current user's color scheme
export async function GET() {
  const cookieStore = await cookies();
  const scheme = cookieStore.get("colorScheme")?.value ?? "red_up_green_down";
  return NextResponse.json({ ok: true, colorScheme: scheme });
}

// PUT: update the color scheme (writes to UserSettings and the cookie)
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { colorScheme } = body;

  if (colorScheme !== "red_up_green_down" && colorScheme !== "green_up_red_down") {
    return NextResponse.json({ ok: false, code: "INVALID_COLOR_SCHEME", error: "无效的颜色方案" }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, colorScheme });
  res.cookies.set("colorScheme", colorScheme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    httpOnly: false,
    sameSite: "lax",
  });

  return res;
}