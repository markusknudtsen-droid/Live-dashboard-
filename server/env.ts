import "dotenv/config";

export interface ServerConfig {
  port: number;
  dashboardPasswordHash: string;
  jwtSecret: string;
  sessionTtlSeconds: number;
  withdrawalConfirmationCode: string;
  walletEncryptionPassphrase: string;
}

function requireEnv(key: string, fallbackForDev?: string): string {
  const value = process.env[key];
  if (value && value.trim().length > 0) return value;
  if (fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`${key} is required. Set it in your .env file.`);
}

export function buildServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.DASHBOARD_PORT || 4000),
    dashboardPasswordHash: env.DASHBOARD_PASSWORD_HASH || "",
    jwtSecret: env.DASHBOARD_JWT_SECRET || "",
    sessionTtlSeconds: Number(env.DASHBOARD_SESSION_TTL_SECONDS || 3600),
    withdrawalConfirmationCode: env.WITHDRAWAL_CONFIRMATION_CODE || "",
    walletEncryptionPassphrase: env.WALLET_ENCRYPTION_PASSPHRASE || "",
  };
}

export const SERVER_CONFIG = buildServerConfig();

export function validateServerConfig(config: ServerConfig = SERVER_CONFIG): void {
  if (!config.dashboardPasswordHash) {
    throw new Error(
      "DASHBOARD_PASSWORD_HASH is required. Generate one with `npm run hash-password -- <password>`."
    );
  }
  if (!config.jwtSecret || config.jwtSecret.length < 16) {
    throw new Error("DASHBOARD_JWT_SECRET is required and must be at least 16 characters.");
  }
  if (!config.withdrawalConfirmationCode) {
    throw new Error("WITHDRAWAL_CONFIRMATION_CODE is required for secondary withdrawal verification.");
  }
}
