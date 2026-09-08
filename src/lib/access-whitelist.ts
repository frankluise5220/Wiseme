export const DEFAULT_ALLOWED_ACCESS_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizeAccessHostname(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  try {
    const hostname = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
    return hostname.replace(/^\[|\]$/g, "");
  } catch {
    if (raw.startsWith("[") && raw.includes("]")) {
      return raw.slice(1, raw.indexOf("]")).trim().toLowerCase();
    }
    return raw.split(":")[0]?.trim().toLowerCase() ?? "";
  }
}

export function isDefaultAllowedAccessHostname(value: string) {
  const normalized = normalizeAccessHostname(value);
  return DEFAULT_ALLOWED_ACCESS_HOSTS.has(normalized);
}

export function normalizeAllowedAccessList(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((item) => normalizeAccessHostname(String(item ?? "")))
        .filter((item) => item && !isDefaultAllowedAccessHostname(item)),
    ),
  );
}

export function parseAllowedAccessList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeAllowedAccessList(parsed);
  } catch {
    return [];
  }
}

export function isAccessHostnameAllowed(hostname: string, allowedList: string[]) {
  const normalized = normalizeAccessHostname(hostname);
  if (!normalized) return false;
  if (isDefaultAllowedAccessHostname(normalized)) return true;
  return allowedList.some((item) => {
    const allowed = normalizeAccessHostname(item);
    if (!allowed) return false;
    if (allowed.startsWith("*.")) return normalized.endsWith(allowed.slice(1));
    return normalized === allowed;
  });
}

function splitHeaderValues(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractForwardedHosts(value: string | null): string[] {
  return splitHeaderValues(value)
    .flatMap((entry) => entry.split(";").map((part) => part.trim()))
    .filter((part) => part.toLowerCase().startsWith("host="))
    .map((part) => part.slice("host=".length).replace(/^"|"$/g, ""));
}

export function extractAccessHostnames(
  headers: { get(name: string): string | null },
  fallbackHostname?: string | null,
) {
  const candidates: string[] = [];
  candidates.push(...extractForwardedHosts(headers.get("forwarded")));
  candidates.push(...splitHeaderValues(headers.get("x-forwarded-host")));

  const origin = headers.get("origin");
  if (origin) {
    try {
      candidates.push(new URL(origin).hostname);
    } catch {
      // Ignore malformed Origin; the Host headers still decide access.
    }
  }

  const host = headers.get("host");
  if (host) candidates.push(host);
  if (candidates.length === 0 && fallbackHostname) candidates.push(fallbackHostname);

  return Array.from(new Set(candidates.map(normalizeAccessHostname).filter(Boolean)));
}

export function getExplicitAccessHostnames(hostnames: string[]) {
  return hostnames.filter((hostname) => !isDefaultAllowedAccessHostname(hostname));
}
