import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../src/config.js";
import type { EntryFeatures } from "../src/entry-features.js";

/**
 * A trade pushed to the dashboard by the bot (POST /api/trades/ingest).
 * Stored append-only alongside the bot state file so pushed trades survive
 * restarts and can be merged into the Transaction Log.
 */
export interface ReportedTrade {
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
  /**
   * What the coin looked like at the buy decision, on BUY rows only. Join a
   * SELL back to its entry on token_address to pair features with the outcome.
   */
  features?: EntryFeatures;
  /** When the dashboard received it (server clock). */
  received_at: number;
}

const MAX_STORED = 1000;

function storePath(): string {
  return path.join(path.dirname(CONFIG.stateFilePath), "reported-trades.json");
}

export async function loadReportedTrades(): Promise<ReportedTrade[]> {
  try {
    const raw = await readFile(storePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReportedTrade[]) : [];
  } catch {
    return [];
  }
}

// Serialise the read-modify-write of the store so concurrent ingestion requests
// can't clobber each other and silently drop a trade. Each append waits for the
// previous one to finish.
let writeChain: Promise<void> = Promise.resolve();

export function appendReportedTrade(trade: ReportedTrade): Promise<void> {
  const next = writeChain.then(async () => {
    const existing = await loadReportedTrades();
    existing.push(trade);
    // Keep only the most recent MAX_STORED by timestamp to bound the file size.
    const trimmed = existing.sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_STORED);
    const fullPath = path.resolve(storePath());
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(trimmed, null, 2), "utf-8");
  });
  // Keep the chain alive even if this write rejects, so one failure doesn't
  // wedge all future appends.
  writeChain = next.catch(() => undefined);
  return next;
}
