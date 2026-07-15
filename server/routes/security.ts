import { Router } from "express";
import { Connection } from "@solana/web3.js";
import { CONFIG } from "../../src/config.js";
import rateLimit from "./rateLimit.js";
import {
  getActivePublicKey,
  isWalletUnlocked,
  lockWallet,
  setUnlockedPrivateKey,
  encryptActiveKey,
  decryptToPrivateKey,
} from "../walletSigner.js";
import { loadEncryptedWallet, saveEncryptedWallet, isValidBase58SolanaPrivateKey, encryptSecret } from "../walletVault.js";

const router = Router();
const sensitiveLimiter = rateLimit({ windowMs: 60_000, max: 5 });

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 4)}${"•".repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
}

router.get("/", async (_req, res) => {
  const checks = await Promise.allSettled([checkSolanaRpc(), checkDexScreener()]);
  const [rpcResult, dexResult] = checks;

  let walletAddress: string | null = null;
  try {
    walletAddress = getActivePublicKey();
  } catch {
    walletAddress = null;
  }

  const hasVault = (await loadEncryptedWallet()) !== null;

  res.json({
    connections: {
      solana_rpc: {
        healthy: rpcResult.status === "fulfilled",
        detail: rpcResult.status === "fulfilled" ? rpcResult.value : String(rpcResult.reason),
      },
      dexscreener: {
        healthy: dexResult.status === "fulfilled",
        detail: dexResult.status === "fulfilled" ? dexResult.value : String(dexResult.reason),
      },
      openrouter_key_configured: Boolean(CONFIG.openRouterApiKey),
    },
    keys: {
      openrouter_api_key: maskSecret(CONFIG.openRouterApiKey),
      dashboard_api_key: maskSecret(CONFIG.dashboardApiKey),
    },
    wallet: {
      active_address: walletAddress,
      unlocked_override_active: isWalletUnlocked(),
      encrypted_vault_present: hasVault,
    },
  });
});

async function checkSolanaRpc(): Promise<string> {
  const connection = new Connection(CONFIG.solanaRpcUrl, "confirmed");
  const version = await connection.getVersion();
  return `ok (solana-core ${version["solana-core"]})`;
}

async function checkDexScreener(): Promise<string> {
  const response = await fetch(`${CONFIG.dexScreenerApiUrl}/latest/dex/pairs/solana/`, {
    method: "GET",
  }).catch(() => null);
  if (!response) throw new Error("unreachable");
  return `ok (status ${response.status})`;
}

// --- Wallet import / export (private key management) ---

router.post("/wallet/export", sensitiveLimiter, (req, res) => {
  const { passphrase } = req.body ?? {};
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    res.status(400).json({ error: "passphrase must be at least 8 characters." });
    return;
  }

  try {
    const blob = encryptActiveKey(passphrase);
    res.json({ encrypted_wallet: blob });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

router.post("/wallet/import", sensitiveLimiter, async (req, res) => {
  const { privateKeyBase58, encryptedWallet, passphrase } = req.body ?? {};

  if (typeof passphrase !== "string" || passphrase.length < 8) {
    res.status(400).json({ error: "passphrase must be at least 8 characters (used to re-encrypt at rest)." });
    return;
  }

  let resolvedPrivateKey: string;

  if (typeof privateKeyBase58 === "string" && privateKeyBase58.length > 0) {
    if (!isValidBase58SolanaPrivateKey(privateKeyBase58)) {
      res.status(400).json({ error: "Invalid Solana private key." });
      return;
    }
    resolvedPrivateKey = privateKeyBase58;
  } else if (encryptedWallet) {
    try {
      resolvedPrivateKey = decryptToPrivateKey(encryptedWallet, passphrase);
    } catch {
      res.status(400).json({ error: "Failed to decrypt wallet with the provided passphrase." });
      return;
    }
  } else {
    res.status(400).json({ error: "Provide either privateKeyBase58 or encryptedWallet." });
    return;
  }

  try {
    setUnlockedPrivateKey(resolvedPrivateKey);
    await saveEncryptedWallet(encryptSecret(resolvedPrivateKey, passphrase));
    res.json({ success: true, active_address: getActivePublicKey() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

router.post("/wallet/unlock", sensitiveLimiter, async (req, res) => {
  const { passphrase } = req.body ?? {};
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    res.status(400).json({ error: "passphrase is required." });
    return;
  }

  const blob = await loadEncryptedWallet();
  if (!blob) {
    res.status(404).json({ error: "No encrypted wallet vault found. Import a private key first." });
    return;
  }

  try {
    const privateKey = decryptToPrivateKey(blob, passphrase);
    setUnlockedPrivateKey(privateKey);
    res.json({ success: true, active_address: getActivePublicKey() });
  } catch {
    res.status(403).json({ error: "Incorrect passphrase." });
  }
});

router.post("/wallet/lock", (_req, res) => {
  lockWallet();
  res.json({ success: true });
});

export default router;
