import { NextResponse } from "next/server";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * Lists the database-API models available to signed-in administrators.
 *
 * Auth: browser administrator session cookie only.
 *
 * GET /api/v1/db/models
 */

const BLOCKED_MODELS = new Set([
  "AccessKey",
  "AiChannel",
  "ApiKey",
  "EmailAccount",
  "FundQueryApi",
  "PasswordResetToken",
  "SystemSetting",
  "User",
  "UserSettings",
]);

const READ_ALLOWED_MODELS = new Set([
  "Account",
  "AccountAlias",
  "AccountGroup",
  "BillOverride",
  "Category",
  "CommandAlias",
  "CreditCardCycle",
  "FundConfirmDays",
  "FundFeeRate",
  "FundHolding",
  "FundNavCache",
  "FundSnapshot",
  "Institution",
  "InsuranceProduct",
  "RegularInvestPlan",
  "Tag",
  "TxRecord",
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  try {
    const scope = await getApiHouseholdScope(req);
    if (scope.authMethod !== "session") {
      return NextResponse.json(
        { ok: false, code: "API_KEY_SCOPE_DENIED", error: "API keys cannot access the database API." },
        { status: 403, headers: corsHeaders() },
      );
    }
    if (!scope.user || !(scope.user.role === "admin" || scope.user.isSystem === true)) {
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN", error: "Administrator access is required for the database API." },
        { status: 403, headers: corsHeaders() },
      );
    }

    // Dynamically fetch all model metadata via Prisma's DMMF API
    const { Prisma } = await import("@prisma/client");
    const dmmf = Prisma?.dmmf?.datamodel?.models || [];

    const models = dmmf
      .filter((model: any) => !BLOCKED_MODELS.has(model.name) && READ_ALLOWED_MODELS.has(model.name))
      .map((model: any) => ({
        name: model.name,
        dbName: model.dbName || model.name,
        title: model.name,
        fields: model.fields.map((field: any) => ({
          name: field.name,
          type: field.type,
          kind: field.kind,
          isRequired: field.isRequired,
          isId: field.isId,
          isUnique: field.isUnique,
          hasDefaultValue: field.hasDefaultValue,
          default: field.default?.value || field.default,
        })),
      }));

    return NextResponse.json({
      ok: true,
      models,
    }, { headers: corsHeaders() });
  } catch (e) {
    console.error("[db-models] Failed to list database models:", e);

    return NextResponse.json({
      ok: false,
      code: e instanceof Error ? e.name || "MODEL_LIST_FAILED" : "MODEL_LIST_FAILED",
      error: e instanceof Error ? e.message : "Unable to list database models.",
    }, { status: 401, headers: corsHeaders() });
  }
}
