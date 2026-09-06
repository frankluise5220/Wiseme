import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser } from "@/lib/server/auth";

function noStoreJson(body: unknown) {
  const response = NextResponse.json(body);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

/**
 * GET /api/v1/auth/household-password-status
 * Queries whether an admin user of the current household has set a password.
 *
 * Returns { ok, hasPassword, adminUser }
 * - hasPassword: at least one admin of the current household has set a password
 * - adminUser: the first admin user of the current household (used to guide password setup)
 *
 * Note: if the user is not logged in (no mmh_username cookie),
 * the user is on the login page, so household-level password guidance is not triggered
 * (the login page has its own setup flow).
 */
export async function GET() {
  // When the user is not logged in, skip household-level password guidance (the login page has its own setup flow)
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return noStoreJson({ ok: true, hasPassword: true, adminUser: null });
  }

  const { householdId } = await getHouseholdScope();

  const adminUsers = await prisma.user.findMany({
    where: {
      householdId, role: "admin",
    },
    select: { id: true, name: true, passwordHash: true },
    orderBy: { createdAt: "asc" },
  });

  // Also check isSystem admins (householdId=null); they belong to all households
  const systemAdmins = await prisma.user.findMany({
    where: { isSystem: true, role: "admin" },
    select: { id: true, name: true, passwordHash: true },
    orderBy: { createdAt: "asc" },
  });

  const allAdmins = [...adminUsers, ...systemAdmins];
  const hasPassword = allAdmins.some(u => !!u.passwordHash);
  const adminUser = allAdmins.length > 0
    ? { id: allAdmins[0].id, name: allAdmins[0].name }
    : null;

  return noStoreJson({ ok: true, hasPassword, adminUser });
}
