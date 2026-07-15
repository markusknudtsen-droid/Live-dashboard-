import { Router } from "express";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CONFIG } from "../../src/config.js";
import { loadState, saveState, TradeHistoryItem } from "../../src/persistence.js";
import { loadSettings } from "../../src/settingsStore.js";
import { getActiveKeypair } from "../walletSigner.js";
import { SERVER_CONFIG } from "../env.js";
import { safeCompare } from "../password.js";
import rateLimit from "./rateLimit.js";

const router = Router();
const withdrawLimiter = rateLimit({ windowMs: 60_000, max: 3 });

// Reserved so the wallet always has funds for transaction fees and never gets
// fully drained by a withdrawal. 0.05 SOL comfortably covers many transaction
// fees at current network rates and matches the bot's own low-balance safety
// threshold (see src/index.ts), keeping the reserve consistent across the app.
const RESERVE_SOL = 0.05;

router.get("/", async (_req, res) => {
  const connection = new Connection(CONFIG.solanaRpcUrl, "confirmed");
  const keypair = getKeypairSafely(res);
  if (!keypair) return;

  try {
    const balanceLamports = await connection.getBalance(keypair.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    const extractableSol = Math.max(0, balanceSol - RESERVE_SOL);
    const settings = await loadSettings();

    res.json({
      wallet_address: keypair.publicKey.toBase58(),
      balance_sol: balanceSol,
      extractable_sol: extractableSol,
      reserved_sol: RESERVE_SOL,
      private_withdrawal_address: settings.private_withdrawal_address,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to read wallet balance: ${message}` });
  }
});

router.post("/withdraw", withdrawLimiter, async (req, res) => {
  const { amountSol, destinationAddress, confirmationCode } = req.body ?? {};

  if (!SERVER_CONFIG.withdrawalConfirmationCode) {
    res.status(500).json({ error: "Withdrawal confirmation is not configured on the server." });
    return;
  }

  if (typeof confirmationCode !== "string" || !safeCompare(confirmationCode, SERVER_CONFIG.withdrawalConfirmationCode)) {
    res.status(403).json({ error: "Secondary verification failed. Incorrect confirmation code." });
    return;
  }

  if (typeof amountSol !== "number" || !Number.isFinite(amountSol) || amountSol <= 0) {
    res.status(400).json({ error: "amountSol must be a positive number." });
    return;
  }

  if (typeof destinationAddress !== "string" || destinationAddress.length < 32 || destinationAddress.length > 44) {
    res.status(400).json({ error: "destinationAddress must be a valid Solana address." });
    return;
  }

  let destinationPubkey: PublicKey;
  try {
    destinationPubkey = new PublicKey(destinationAddress);
  } catch {
    res.status(400).json({ error: "destinationAddress is not a valid Solana public key." });
    return;
  }

  const keypair = getKeypairSafely(res);
  if (!keypair) return;

  const connection = new Connection(CONFIG.solanaRpcUrl, "confirmed");
  const balanceLamports = await connection.getBalance(keypair.publicKey);
  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
  const extractableSol = balanceSol - RESERVE_SOL;

  if (amountSol > extractableSol) {
    res.status(400).json({
      error: `Requested amount exceeds extractable balance (${extractableSol.toFixed(4)} SOL available).`,
    });
    return;
  }

  try {
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: destinationPubkey,
        lamports,
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair], {
      commitment: "confirmed",
      skipPreflight: CONFIG.allowSkipPreflight,
    });

    const state = await loadState();
    const historyItem: TradeHistoryItem = {
      timestamp: Date.now(),
      symbol: "SOL",
      action: "WITHDRAW",
      confidence: 100,
      result: "SUCCESS",
      txSignature: signature,
    };
    state.tradeHistory.push(historyItem);
    await saveState(state);

    res.json({ success: true, tx_signature: signature, amount_sol: amountSol, destination: destinationAddress });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Withdrawal failed: ${message}` });
  }
});

function getKeypairSafely(res: import("express").Response) {
  try {
    return getActiveKeypair();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
    return null;
  }
}

export default router;
