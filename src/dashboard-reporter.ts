import { CONFIG } from "./config.js";
import { httpPost } from "./http.js";
import { logger } from "./logger.js";
import type { TradeEvent } from "./trader.js";

/**
 * The JSON payload the bot POSTs to the dashboard for each executed trade.
 * Snake-cased to match the dashboard's REST conventions.
 */
export interface DashboardTradePayload {
  type: "BUY" | "SELL";
  symbol: string;
  token_address: string;
  chain_id: string;
  amount_sol: number;
  price: number;
  paper: boolean;
  tx_signature: string;
  timestamp: number;
  confidence?: number;
  pnl_percent?: number;
  reason?: string;
}

function toPayload(event: TradeEvent): DashboardTradePayload {
  return {
    type: event.type,
    symbol: event.symbol,
    token_address: event.tokenAddress,
    chain_id: event.chainId,
    amount_sol: event.amountSol,
    price: event.price,
    paper: event.paper,
    tx_signature: event.txSignature,
    timestamp: event.timestamp,
    confidence: event.confidence,
    pnl_percent: event.pnlPercent,
    reason: event.reason,
  };
}

/**
 * Whether trade reporting is configured. When no DASHBOARD_API_URL is set the
 * reporter is a no-op, so the bot runs identically with or without a dashboard.
 */
export function isDashboardReportingEnabled(): boolean {
  return Boolean(CONFIG.dashboardApiUrl);
}

/**
 * Best-effort POST of a single trade to the dashboard ingestion endpoint
 * (`${DASHBOARD_API_URL}/trades/ingest`). Never throws: a dashboard being down
 * or misconfigured must never interrupt or fail a trade. Authenticated with the
 * DASHBOARD_API_KEY via the `x-api-key` header when one is configured.
 */
export async function reportTrade(event: TradeEvent): Promise<void> {
  if (!isDashboardReportingEnabled()) return;

  const url = `${CONFIG.dashboardApiUrl.replace(/\/$/, "")}/trades/ingest`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.dashboardApiKey) {
    headers["x-api-key"] = CONFIG.dashboardApiKey;
  }

  try {
    await httpPost(url, toPayload(event), { headers });
    logger.debug(`📤 Reported ${event.paper ? "paper " : ""}${event.type} ${event.symbol} to dashboard`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Dashboard trade report failed (non-fatal): ${message}`);
  }
}
