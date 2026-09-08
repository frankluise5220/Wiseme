import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const MASTER_KEY_SETTING = "api_key_encryption_master";
let _masterKey: Buffer | null = null;

/**
 * Encrypts an API Key. Called automatically by the database storage layer; API routes do not need to be aware of it.
 * Return format: base64(iv).base64(ciphertext).base64(tag)
 */
export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${encrypted.toString("base64")}.${tag.toString("base64")}`;
}

/**
 * Decrypts an API Key.
 */
export function decrypt(encrypted: string, key: Buffer): string {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("invalid encrypted format");
  const iv = Buffer.from(parts[0], "base64");
  const ciphertext = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Checks whether a string is already encrypted (checks whether it matches the base64.base64.base64 format).
 */
export function isEncrypted(s: string): boolean {
  return /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(s) && s.split(".").length === 3;
}

/**
 * Gets or creates the master encryption key (stored in the systemSetting table).
 */
export async function getOrCreateMasterKey(): Promise<Buffer> {
  if (_masterKey) return _masterKey;
  const { prisma } = await import("@/lib/db/prisma");
  let setting = await prisma.systemSetting.findUnique({ where: { key: MASTER_KEY_SETTING } });
  if (setting && setting.value) {
    _masterKey = Buffer.from(setting.value, "base64");
    return _masterKey;
  }
  // Generate a 256-bit random key
  _masterKey = crypto.randomBytes(32);
  await prisma.systemSetting.upsert({
    where: { key: MASTER_KEY_SETTING },
    create: { key: MASTER_KEY_SETTING, value: _masterKey.toString("base64") },
    update: { value: _masterKey.toString("base64") },
  });
  console.log("[encrypt] Generated new master encryption key");
  return _masterKey;
}

export function clearMasterKeyCache() {
  _masterKey = null;
}
