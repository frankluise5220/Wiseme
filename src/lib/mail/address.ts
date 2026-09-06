const BARE_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+$/;
const ANGLED_ADDRESS_RE = /<([^\s@<>]+@[^\s@<>]+)>/;

/**
 * Extracts the plain address from a sender value.
 * Accepts "a@b.c" and "Display Name <a@b.c>".
 * Returns null when no well-formed address is present.
 */
export function extractAddress(value: string | undefined | null): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const angled = raw.match(ANGLED_ADDRESS_RE);
  const candidate = angled ? angled[1] : raw;
  return BARE_ADDRESS_RE.test(candidate) ? candidate : null;
}

/** True when the value can be used as an SMTP sender (MAIL FROM must be a real address). */
export function isValidSender(value: string | undefined | null): boolean {
  return extractAddress(value) !== null;
}
