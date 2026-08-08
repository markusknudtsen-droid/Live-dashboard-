import { Router } from "express";
import { Connection } from "@solana/web3.js";
import { CONFIG } from "../../src/config.js";
import rateLimit from "express-rate-limit";
import { SERVER_CONFIG } from "../env.js";
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
const sensitiveLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });

function maskSecret(secret: string): string {
  // Only ever return a masked preview; never log or return the full value.
  if (!secret) return "";
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 4)}${"•".repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
}

async function runCheck(check: () => Promise<string>): Promise<{ healthy: boolean; detail: string; latency_ms: number | null }> {
  const startedAt = Date.now();
  try {
    const detail = await check();
    return { healthy: true, detail, latency_ms: Date.now() - startedAt };
  } catch (error: unknown) {
    return {
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
      latency_ms: null,
    };
  }
}

router.get("/", async (_req, res) => {
  const [rpcStatus, dexStatus] = await Promise.all([runCheck(checkSolanaRpc), runCheck(checkDexScreener)]);

  let walletAddress: string | null = null;
  try {
    walletAddress = getActivePublicKey();
  } catch {
    walletAddress = null;
  }

  const hasVault = (await loadEncryptedWallet()) !== null;
  const missingRequirements: string[] = [];
  if (CONFIG.dryRun) missingRequirements.push("Set DRY_RUN=false to enable real-Solana execution.");
  if (!CONFIG.solanaPrivateKey) missingRequirements.push("Add SOLANA_PRIVATE_KEY for the live wallet.");
  if (!CONFIG.openRouterApiKey) missingRequirements.push("Add OPENROUTER_API_KEY for live AI analysis.");
  if (!SERVER_CONFIG.ingestApiKey) missingRequirements.push("Set DASHBOARD_INGEST_KEY so the bot can push trades into the dashboard.");
  if (!SERVER_CONFIG.walletEncryptionPassphrase) {
    missingRequirements.push("Set WALLET_ENCRYPTION_PASSPHRASE to enable encrypted wallet import/export.");
  }
  if (!SERVER_CONFIG.withdrawalConfirmationCode) {
    missingRequirements.push("Set WITHDRAWAL_CONFIRMATION_CODE before allowing live withdrawals.");
  }

  res.json({
    connections: {
      solana_rpc: rpcStatus,
      dexscreener: dexStatus,
      openrouter_key_configured: Boolean(CONFIG.openRouterApiKey),
      dashboard_api_url_configured: Boolean(CONFIG.dashboardApiUrl),
      dashboard_ingest_key_configured: Boolean(SERVER_CONFIG.ingestApiKey),
    },
    connection_manager: {
      dashboard_port: SERVER_CONFIG.port,
      engine_mode: CONFIG.dryRun ? "paper" : "live",
      real_trading_ready: missingRequirements.length === 0,
      missing_requirements: missingRequirements,
    },
    keys: {
      openrouter_api_key: maskSecret(CONFIG.openRouterApiKey),
      dashboard_api_key: maskSecret(SERVER_CONFIG.ingestApiKey || CONFIG.dashboardApiKey),
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
