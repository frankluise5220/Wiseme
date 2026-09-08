/**
 * API authentication helpers.
 *
 * Mixed authentication strategy:
 * 1. Try cookie-based session auth first (browser users)
 * 2. Fall back to independent AccessKey auth (Android / external clients)
 */
import { prisma } from "@/lib/db/prisma";
import { getApiKeyPolicyDecision } from "@/lib/api-key-policy";
import { getHouseholdScope, type HouseholdContext } from "@/lib/server/household-scope";
import { verifyAccessKey } from "@/lib/server/access-key-auth";

export type ApiAuthMethod = "session" | "accessKey";

export type ApiHouseholdContext = HouseholdContext & {
  authMethod: ApiAuthMethod;
  accessKey?: {
    id: string;
    name: string;
  };
};

function getProvidedApiKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

/**
 * Get the HouseholdContext for an API request.
 *
 * First tries cookie session auth (getHouseholdScope); if that fails or there is no
 * cookie login state, falls back to X-Api-Key / Bearer AccessKey auth.
 *
 * @throws Error when both authentication methods fail
 */
export async function getApiHouseholdScope(req: Request): Promise<ApiHouseholdContext> {
  // Strategy 1: cookie-based session auth
  try {
    const ctx = await getHouseholdScope();
    // A household can be auto-created/resolved for setup and server-rendered
    // pages even when there is no authenticated user. That must not count as
    // API authentication when middleware is bypassed or unavailable.
    if (ctx.user && ctx.householdId) {
      return { ...ctx, authMethod: "session" };
    }
  } catch {
    // Ignore cookie errors and fall back to the API Key
  }

  // Strategy 2: X-Api-Key header auth
  const apiKey = getProvidedApiKey(req);
  if (!apiKey) {
    throw new Error("Missing authentication credentials.");
  }

  const url = new URL(req.url);
  const policy = getApiKeyPolicyDecision(url.pathname, req.method);
  if (!policy.ok) {
    const error = new Error(policy.error ?? "API key access is not allowed for this endpoint.");
    error.name = policy.code ?? "API_KEY_SCOPE_DENIED";
    throw error;
  }

  const accessKey = await verifyAccessKey(apiKey);
  if (!accessKey) {
    throw new Error("Invalid API key.");
  }

  const adminUser = await prisma.user.findFirst({
    where: { OR: [{ role: "admin" }, { isSystem: true }] },
    orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, role: true, isSystem: true, householdId: true },
  });

  if (!adminUser) {
    throw new Error("Administrator user is not configured.");
  }

  // Resolve the household
  let household = await prisma.household.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!household) {
    throw new Error("No ledger is available.");
  }

  return {
    householdId: household.id,
    hidFilter: { householdId: household.id },
    user: {
      id: adminUser.id,
      name: adminUser.name,
      role: adminUser.role,
      isSystem: adminUser.isSystem,
      householdId: adminUser.householdId,
    },
    authMethod: "accessKey",
    accessKey,
  };
}

/**
 * Extract the API Key from a request (without verification).
 */
export { getProvidedApiKey };
