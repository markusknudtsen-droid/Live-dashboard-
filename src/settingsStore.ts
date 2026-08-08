import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

export interface BotSettings {
  active_status: boolean;
  buy_amount_sol: number;
  override_enabled: boolean;
  private_withdrawal_address: string;
  min_confidence: number;
  stop_loss_percent: number;
  take_profit_percent: number;
  engine_port: number;
  engine_api_key: string;
  preserve_classic_dashboard: boolean;
  updated_at: number;
}

function defaultSettings(): BotSettings {
  // Seed defaults from the .env-configured values so an unconfigured
  // dashboard never silently overrides the operator's env settings.
  return {
    active_status: true,
    buy_amount_sol: CONFIG.maxPositionSol,
    override_enabled: false,
    private_withdrawal_address: "",
    min_confidence: CONFIG.minConfidence,
    stop_loss_percent: CONFIG.stopLossPercent,
    take_profit_percent: CONFIG.takeProfitPercent,
    engine_port: Number(process.env.BOT_ENGINE_PORT || 5050),
    engine_api_key: process.env.BOT_ENGINE_API_KEY || "",
    preserve_classic_dashboard: true,
    updated_at: Date.now(),
  };
}

function resolveSettingsPath(): string {
  return path.resolve(process.env.BOT_SETTINGS_FILE || "./data/settings.json");
}

export async function loadSettings(): Promise<BotSettings> {
  try {
    const raw = await readFile(resolveSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BotSettings>;
    return { ...defaultSettings(), ...parsed };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(settings: BotSettings): Promise<void> {
  const fullPath = resolveSettingsPath();
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(settings, null, 2), "utf-8");
}

export function validateSettingsPatch(patch: Partial<BotSettings>): string | null {
  if (patch.buy_amount_sol !== undefined) {
    if (!Number.isFinite(patch.buy_amount_sol) || patch.buy_amount_sol <= 0 || patch.buy_amount_sol > 10) {
      return "buy_amount_sol must be a number between 0 and 10.";
    }
  }
  if (patch.min_confidence !== undefined) {
    if (!Number.isFinite(patch.min_confidence) || patch.min_confidence < 0 || patch.min_confidence > 100) {
      return "min_confidence must be a number between 0 and 100.";
    }
  }
  if (patch.stop_loss_percent !== undefined) {
    if (!Number.isFinite(patch.stop_loss_percent) || patch.stop_loss_percent < 1 || patch.stop_loss_percent > 95) {
      return "stop_loss_percent must be a number between 1 and 95.";
    }
  }
  if (patch.take_profit_percent !== undefined) {
    if (
      !Number.isFinite(patch.take_profit_percent) ||
      patch.take_profit_percent < 1 ||
      patch.take_profit_percent > 1000
    ) {
      return "take_profit_percent must be a number between 1 and 1000.";
    }
  }
  if (patch.private_withdrawal_address !== undefined && patch.private_withdrawal_address.length > 0) {
    if (patch.private_withdrawal_address.length < 32 || patch.private_withdrawal_address.length > 44) {
      return "private_withdrawal_address must be a valid Solana address.";
    }
  }
  if (patch.engine_port !== undefined) {
    if (!Number.isInteger(patch.engine_port) || patch.engine_port < 1 || patch.engine_port > 65535) {
      return "engine_port must be an integer between 1 and 65535.";
    }
  }
  if (patch.engine_api_key !== undefined) {
    if (typeof patch.engine_api_key !== "string" || patch.engine_api_key.length > 256) {
      return "engine_api_key must be a string up to 256 characters.";
    }
  }
  return null;
}
