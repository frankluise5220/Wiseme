import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_MAX_BYTES = 1024 * 1024;
const MODEL_LIST_ERROR_MAX_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.google.internal.",
]);

function joinBaseUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) return `${base}${p.slice(3)}`;
  if (base.endsWith("/v1") && p.startsWith("/api/")) return `${base.slice(0, -3)}${p}`;
  return `${base}${p}`;
}

function parseIPv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return nums;
}

function isPrivateIPv4(parts: number[]) {
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isLoopbackIPv4(parts: number[]) {
  return parts[0] === 127;
}

function isBlockedIPv4(parts: number[]) {
  const [a, b, c, d] = parts;
  if (a === 0) return true;
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

function normalizeIPv6(value: string) {
  return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackIPv6(value: string) {
  return normalizeIPv6(value) === "::1" || normalizeIPv6(value) === "0:0:0:0:0:0:0:1";
}

function isBlockedIPv6(value: string) {
  const normalized = normalizeIPv6(value);
  return (
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fe80::") ||
    normalized.startsWith("ff") ||
    normalized === "fd00:ec2::254"
  );
}

function isExplicitLocalhost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost";
}

function assertAllowedAddress(address: string, explicitLocalhost: boolean) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = parseIPv4(address);
    if (!parts) throw new Error("Resolved address is invalid.");
    if (isBlockedIPv4(parts)) throw new Error("AI model URL resolves to a blocked network address.");
    if (isLoopbackIPv4(parts) && !explicitLocalhost) {
      throw new Error("AI model URL resolves to loopback through a non-localhost name.");
    }
    return;
  }
  if (family === 6) {
    if (isBlockedIPv6(address)) throw new Error("AI model URL resolves to a blocked network address.");
    if (isLoopbackIPv6(address) && !explicitLocalhost) {
      throw new Error("AI model URL resolves to loopback through a non-localhost name.");
    }
  }
}

async function validateModelListUrl(rawUrl: string) {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new Error("AI model URL is too long.");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI model URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("AI model URL must not contain credentials.");
  }
  if (url.hash) {
    throw new Error("AI model URL must not contain a fragment.");
  }

  const hostname = url.hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(hostname) || hostname.endsWith(".metadata.google.internal")) {
    throw new Error("AI model URL uses a blocked metadata hostname.");
  }

  const explicitLocalhost = isExplicitLocalhost(hostname);
  const addressHostname = hostname.replace(/^\[|\]$/g, "");
  const directIpFamily = net.isIP(addressHostname);
  if (directIpFamily) {
    const directLoopback =
      directIpFamily === 4
        ? isLoopbackIPv4(parseIPv4(addressHostname) ?? [])
        : isLoopbackIPv6(addressHostname);
    assertAllowedAddress(addressHostname, explicitLocalhost || directLoopback);
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0) {
    throw new Error("AI model URL hostname did not resolve.");
  }
  for (const address of addresses) {
    assertAllowedAddress(address.address, explicitLocalhost);
  }
  return url;
}

async function readResponseText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("AI model response is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function detectModelInfo(id: string, raw: unknown) {
  const lower = id.toLowerCase();
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const capabilities = obj && typeof obj.capabilities === "object" ? (obj.capabilities as Record<string, unknown>) : null;
  const modalities = obj && Array.isArray(obj.modalities) ? (obj.modalities as unknown[]) : null;

  const supportsVision =
    (capabilities?.vision === true ||
      capabilities?.image === true ||
      capabilities?.multimodal === true ||
      (Array.isArray(modalities) &&
        modalities.some((m) => typeof m === "string" && /image|vision|multimodal/i.test(m)))) ||
    /gpt-4o|vision|qwen[-_]?vl|glm-4v|internvl|llava|pix|multimodal|mm/.test(lower);

  const category =
    supportsVision
      ? "vision"
      : /embed|embedding/.test(lower)
        ? "embedding"
        : /whisper|audio|tts|speech|transcrib/.test(lower)
          ? "audio"
          : /dall|image|sdxl|stable[-_ ]diffusion|flux/.test(lower)
            ? "image"
            : "text";

  return { id, category, supportsVision };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "Administrator access required." }, { status: 403 });
  }

  const body = await req.json() as { baseUrl?: string; apiKey?: string; modelsUrl?: string };
  const { baseUrl, apiKey, modelsUrl } = body;

  if (!baseUrl) {
    return NextResponse.json({ ok: false, code: "MISSING_BASE_URL", error: "Missing baseUrl." }, { status: 400 });
  }

  const cleanUrl = baseUrl.replace(/\/$/, "");
  const suffix = modelsUrl || "/v1/models";

  try {
    const url = await validateModelListUrl(joinBaseUrl(cleanUrl, suffix));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const key = (apiKey ?? "").trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      const text = await readResponseText(response, MODEL_LIST_ERROR_MAX_BYTES).catch(() => "");
      return NextResponse.json(
        { ok: false, code: "MODEL_FETCH_FAILED", error: `HTTP ${response.status}: ${text}` },
        { status: response.status },
      );
    }

    const text = await readResponseText(response, MODEL_LIST_MAX_BYTES);
    const data = JSON.parse(text) as Record<string, unknown>;
    const raw: unknown[] = Array.isArray(data.data) ? data.data
      : Array.isArray(data.models) ? data.models as unknown[]
      : Array.isArray(data) ? data as unknown[]
      : [];

    const modelInfos = raw
      .map((m) => {
        if (typeof m === "string") return detectModelInfo(m, m);
        const obj = m as Record<string, unknown>;
        const id = String(obj.id ?? obj.name ?? "").trim();
        if (!id) return null;
        return detectModelInfo(id, m);
      })
      .filter((x): x is { id: string; category: string; supportsVision: boolean } => !!x);

    const models = modelInfos.map((m) => m.id);

    return NextResponse.json({ ok: true, models, modelInfos });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: (e as { name?: string })?.name === "AbortError" ? "MODEL_LIST_TIMEOUT" : "MODEL_LIST_FAILED",
        error: e instanceof Error ? e.message : "Model list request failed.",
      },
      { status: 500 },
    );
  }
}
