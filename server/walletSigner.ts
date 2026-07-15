import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { CONFIG } from "../src/config.js";
import { decryptSecret, encryptSecret, EncryptedBlob, isValidBase58SolanaPrivateKey } from "./walletVault.js";

/**
 * In-memory only signer override. Populated by importing or unlocking an
 * encrypted wallet via the System Security screen. Never written to disk
 * in plaintext and never returned to the client.
 */
let unlockedSecretKeyBase58: string | null = null;

export function setUnlockedPrivateKey(privateKeyBase58: string): void {
  if (!isValidBase58SolanaPrivateKey(privateKeyBase58)) {
    throw new Error("Invalid Solana private key.");
  }
  unlockedSecretKeyBase58 = privateKeyBase58;
}

export function lockWallet(): void {
  unlockedSecretKeyBase58 = null;
}

export function isWalletUnlocked(): boolean {
  return unlockedSecretKeyBase58 !== null;
}

/**
 * Resolve the active signing keypair: prefer an explicitly unlocked wallet,
 * falling back to the bot's configured SOLANA_PRIVATE_KEY.
 */
export function getActiveKeypair(): Keypair {
  const secretKeyBase58 = unlockedSecretKeyBase58 || CONFIG.solanaPrivateKey;
  if (!secretKeyBase58) {
    throw new Error("No Solana private key configured.");
  }
  const secretKey = bs58.decode(secretKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}

export function getActivePublicKey(): string {
  return getActiveKeypair().publicKey.toBase58();
}

export function encryptActiveKey(passphrase: string): EncryptedBlob {
  const secretKeyBase58 = unlockedSecretKeyBase58 || CONFIG.solanaPrivateKey;
  if (!secretKeyBase58) {
    throw new Error("No active Solana private key to export.");
  }
  return encryptSecret(secretKeyBase58, passphrase);
}

export function decryptToPrivateKey(blob: EncryptedBlob, passphrase: string): string {
  const privateKey = decryptSecret(blob, passphrase);
  if (!isValidBase58SolanaPrivateKey(privateKey)) {
    throw new Error("Decrypted data is not a valid Solana private key.");
  }
  return privateKey;
}
