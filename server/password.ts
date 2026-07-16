import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// 64 bytes of scrypt output provides 512 bits of derived-key material — far
// beyond the 256-bit security level needed here — giving ample entropy
// margin for password verification while keeping derivation time reasonable
// for interactive login.
const KEY_LENGTH = 64;

/**
 * Hash a plaintext password into a `salt:hash` string (both hex encoded)
 * suitable for storing in DASHBOARD_PASSWORD_HASH.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a `salt:hash` string produced by hashPassword.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Constant-time comparison for secondary confirmation codes / secrets.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
