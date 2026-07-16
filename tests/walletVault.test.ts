import test from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, isValidBase58SolanaPrivateKey } from "../server/walletVault.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

test("encryptSecret/decryptSecret round-trips a private key with the correct passphrase", () => {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  const blob = encryptSecret(privateKeyBase58, "correct-passphrase-123");
  const decrypted = decryptSecret(blob, "correct-passphrase-123");

  assert.equal(decrypted, privateKeyBase58);
});

test("decryptSecret throws with the wrong passphrase", () => {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const blob = encryptSecret(privateKeyBase58, "correct-passphrase-123");

  assert.throws(() => decryptSecret(blob, "wrong-passphrase"));
});

test("isValidBase58SolanaPrivateKey validates real keys and rejects garbage", () => {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  assert.equal(isValidBase58SolanaPrivateKey(privateKeyBase58), true);
  assert.equal(isValidBase58SolanaPrivateKey("not-a-real-key"), false);
});
