import { Router } from "express";
import { loadSettings, saveSettings, validateSettingsPatch, BotSettings } from "../../src/settingsStore.js";
import { lockWallet } from "../walletSigner.js";

const router = Router();

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 4)}${"•".repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
}

function serializeSettings(settings: BotSettings): Omit<BotSettings, "engine_api_key"> & { engine_api_key_masked: string } {
  const { engine_api_key, ...rest } = settings;
  return {
    ...rest,
    engine_api_key_masked: maskSecret(engine_api_key),
  };
}

async function checkEngineConnection(port: number, apiKey: string): Promise<{ connected: boolean; latency_ms: number; detail: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
      headers: apiKey ? { "x-api-key": apiKey } : undefined,
      signal: controller.signal,
    });
    const latency = Date.now() - start;
    return {
      connected: response.ok,
      latency_ms: latency,
      detail: response.ok ? `ok (${response.status})` : `unhealthy (${response.status})`,
    };
  } catch (error: unknown) {
    const latency = Date.now() - start;
    const detail = error instanceof Error ? error.message : String(error);
    return { connected: false, latency_ms: latency, detail };
  } finally {
    clearTimeout(timeout);
  }
}

router.get("/", async (_req, res) => {
  const settings = await loadSettings();
  res.json(serializeSettings(settings));
});

router.get("/connection", async (_req, res) => {
  const settings = await loadSettings();
  const connection = await checkEngineConnection(settings.engine_port, settings.engine_api_key);
  res.json({
    port: settings.engine_port,
    ...connection,
  });
});

router.post("/connection/test", async (req, res) => {
  const body = (req.body ?? {}) as { port?: number; engine_api_key?: string };
  const settings = await loadSettings();
  const port = body.port ?? settings.engine_port;
  const apiKey = body.engine_api_key ?? settings.engine_api_key;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: "port must be an integer between 1 and 65535." });
    return;
  }
  if (typeof apiKey !== "string" || apiKey.length > 256) {
    res.status(400).json({ error: "engine_api_key must be a string up to 256 characters." });
    return;
  }

  const connection = await checkEngineConnection(port, apiKey);
  res.json({
    port,
    ...connection,
  });
});

router.post("/kill-switch", async (_req, res) => {
  const current = await loadSettings();
  const next: BotSettings = {
    ...current,
    active_status: false,
    override_enabled: true,
    updated_at: Date.now(),
  };
  lockWallet();
  await saveSettings(next);
  res.json({
    ok: true,
    settings: serializeSettings(next),
  });
});

router.put("/", async (req, res) => {
  const patch = (req.body ?? {}) as Partial<BotSettings>;
  const validationError = validateSettingsPatch(patch);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const current = await loadSettings();
  const next: BotSettings = {
    ...current,
    ...patch,
    updated_at: Date.now(),
  };
  await saveSettings(next);
  res.json(serializeSettings(next));
});

export default router;
