import "dotenv/config";

export interface AppConfig {
  openRouterApiKey: string;
  solanaPrivateKey: string;
  minConfidence: number;
  maxPositionSol: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  scanIntervalSeconds: number;
  solanaRpcUrl: string;
  dexScreenerApiUrl: string;
  scanChains: string[];
  dashboardApiUrl: string;
  dashboardApiKey: string;
  dashboardWebUrl: string;
  allowSkipPreflight: boolean;
  httpTimeoutMs: number;
  httpMaxRetries: number;
  logLevel: "debug" | "info" | "warn" | "error";
  stateFilePath: string;
}

function parseNumberInRange(
  key: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function parseIntegerInRange(
  key: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseLogLevel(raw: string | undefined): AppConfig["logLevel"] {
  const level = (raw || "info").toLowerCase();
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  throw new Error("LOG_LEVEL must be one of: debug, info, warn, error.");
}

function parseScanChains(raw: string | undefined): string[] {
  return (raw || "solana")
    .split(",")
    .map((chain) => chain.trim().toLowerCase())
    .filter(Boolean);
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    openRouterApiKey: env.OPENROUTER_API_KEY || "",
    solanaPrivateKey: env.SOLANA_PRIVATE_KEY || "",
    minConfidence: parseNumberInRange("MIN_CONFIDENCE", env.MIN_CONFIDENCE, 80, 0, 100),
    maxPositionSol: parseNumberInRange("MAX_POSITION_SOL", env.MAX_POSITION_SOL, 0.5, 0.001, 10),
    stopLossPercent: parseNumberInRange("STOP_LOSS_PERCENT", env.STOP_LOSS_PERCENT, 15, 1, 95),
    takeProfitPercent: parseNumberInRange("TAKE_PROFIT_PERCENT", env.TAKE_PROFIT_PERCENT, 50, 1, 1000),
    scanIntervalSeconds: parseIntegerInRange("SCAN_INTERVAL_SECONDS", env.SCAN_INTERVAL_SECONDS, 60, 5, 3600),
    solanaRpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    dexScreenerApiUrl: env.DEXSCREENER_API_URL || "https://api.dexscreener.com",
    scanChains: parseScanChains(env.SCAN_CHAINS),
    dashboardApiUrl: env.DASHBOARD_API_URL || "",
    dashboardApiKey: env.DASHBOARD_API_KEY || "",
    dashboardWebUrl: env.DASHBOARD_WEB_URL || "",
    allowSkipPreflight: parseBoolean(env.ALLOW_SKIP_PREFLIGHT, false),
    httpTimeoutMs: parseIntegerInRange("HTTP_TIMEOUT_MS", env.HTTP_TIMEOUT_MS, 10000, 1000, 120000),
    httpMaxRetries: parseIntegerInRange("HTTP_MAX_RETRIES", env.HTTP_MAX_RETRIES, 3, 0, 10),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    stateFilePath: env.BOT_STATE_FILE || "./data/state.json",
  };
}

export const CONFIG = buildConfig();

export function validateConfig(config: AppConfig = CONFIG): void {
  if (!config.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required. Set it in your .env file.");
  }
  if (!config.solanaPrivateKey) {
    throw new Error("SOLANA_PRIVATE_KEY is required. Set it in your .env file.");
  }
  if (config.scanChains.length === 0) {
    throw new Error("SCAN_CHAINS must include at least one chain.");
  }
  console.log("✅ Configuration validated");
  console.log(`   Min Confidence: ${config.minConfidence}%`);
  console.log(`   Max Position: ${config.maxPositionSol} SOL`);
  console.log(`   Stop Loss: -${config.stopLossPercent}%`);
  console.log(`   Take Profit: +${config.takeProfitPercent}%`);
  console.log(`   Scan Interval: ${config.scanIntervalSeconds}s`);
  console.log(`   Chains: ${config.scanChains.join(", ")}`);
}
