import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // AES-256 requires a 256-bit (32-byte) key
const SALT_LENGTH = 16; // 128-bit salt for scrypt key derivation
const IV_LENGTH = 12; // 96-bit IV, the standard/recommended size for AES-GCM

export interface EncryptedBlob {
  version: 1;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext secret (e.g. a base58 Solana private key) with a
 * user-supplied passphrase using AES-256-GCM. The result never contains
 * the plaintext and can be safely exported/downloaded.
 */
export function encryptSecret(plaintext: string, passphrase: string): EncryptedBlob {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt a blob produced by encryptSecret. Throws if the passphrase is
 * wrong or the blob has been tampered with (GCM auth tag mismatch).
 */
export function decryptSecret(blob: EncryptedBlob, passphrase: string): string {
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const authTag = Buffer.from(blob.authTag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  const key = deriveKey(passphrase, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf-8");
}

export function isValidBase58SolanaPrivateKey(candidate: string): boolean {
  try {
    const secretKey = bs58.decode(candidate);
    Keypair.fromSecretKey(secretKey);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_WALLET_VAULT_PATH = "./data/wallet.vault.json";

function resolveVaultPath(): string {
  return path.resolve(process.env.WALLET_VAULT_FILE || DEFAULT_WALLET_VAULT_PATH);
}

export async function saveEncryptedWallet(blob: EncryptedBlob): Promise<void> {
  const fullPath = resolveVaultPath();
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(blob, null, 2), "utf-8");
}

export async function loadEncryptedWallet(): Promise<EncryptedBlob | null> {
  try {
    const raw = await readFile(resolveVaultPath(), "utf-8");
    return JSON.parse(raw) as EncryptedBlob;
  } catch {
    return null;
  }
}
