/**
 * Lightweight utilities for parsing and assembling Base URLs.
 * Splits input into protocol, host, port, and path parts.
 *
 * Note: a full URL is not required; port/path may be omitted.
 * Mainly used for parsing/pre-filling client-side forms.
 */

export interface ParsedUrl {
  protocol: string;   // "http:" | "https:"
  host: string;       // without port
  port: string;       // empty string means not provided
  path: string;       // with "/" prefix, e.g. "/v1"
}

/** Split a baseUrl into four independent fields; return safe defaults on parse failure. */
export function parseBaseUrl(raw: string | null | undefined): ParsedUrl {
  if (!raw) {
    return { protocol: "https:", host: "", port: "", path: "" };
  }
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol,          // e.g. "http:" or "https:"
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search + u.hash, // keep the full path part
    };
  } catch {
    return { protocol: "https:", host: "", port: "", path: "" };
  }
}

/** Reassemble the four independent fields into a full URL string. */
export function buildBaseUrl(p: ParsedUrl): string {
  const host = p.host.trim();
  if (!host) return "";
  let base = `${p.protocol || "https:"}//${host}`;
  const port = p.port.trim();
  if (port) base += `:${port}`;
  const path = p.path.trim();
  if (path) {
    base += path;
  }
  return base;
}

/** HTTP / HTTPS */
export const PROTOCOL_OPTIONS = [
  { value: "https:", label: "HTTPS" },
  { value: "http:", label: "HTTP" },
] as const;

/** Common port quick options. */
export const PORT_SUGGESTIONS: { value: string; labelKey: string }[] = [
  { value: "", labelKey: "urlInput.portSuggestion.default" },
  { value: "443", labelKey: "urlInput.portSuggestion.443" },
  { value: "80", labelKey: "urlInput.portSuggestion.80" },
  { value: "11434", labelKey: "urlInput.portSuggestion.11434" },
  { value: "3000", labelKey: "urlInput.portSuggestion.3000" },
  { value: "8080", labelKey: "urlInput.portSuggestion.8080" },
] as const;

/**
 * Build a clean form-data object from a set of filled-in parsed fields.
 * For merging when saving externally.
 */
export function assembledBaseUrl<T extends Record<string, unknown>>(
  partial: ParsedUrl,
  extra: Omit<T, "baseUrl"> & { baseUrl?: string },
): T & { baseUrl: string } {
  return {
    ...extra,
    baseUrl: buildBaseUrl(partial),
  } as unknown as T & { baseUrl: string };
}