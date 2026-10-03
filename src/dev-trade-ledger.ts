/**
 * Remembers which pump.fun creator made each coin the bot sold, and how the
 * trade went, so a new launch by a creator we have traded before can be
 * recognised (and judged on our own results) the moment the on-chain feed sees it.
 *
 * Persisted to data/dev-trade-ledger.json. Every failure is swallowed: this must
 * never touch trading.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { fetchCreatorWallet } from "./dev-reputation.js";
import { logger } from "./logger.js";

const MAX_TRADES_PER_CREATOR = 20;
const MAX_CREATORS = 2000;

export interface DevTrade {
  mint: string;
  symbol: string;
  pnlPercent: number;
  at: number;
}

export type DevLedger = Record<string, DevTrade[]>;

export interface DevTradeSummary {
  trades: number;
  wins: number;
  avgPnlPercent: number;
}

const lastAt = (trades: DevTrade[]): number => trades[trades.length - 1]?.at ?? 0;

/** Pure: a new ledger with the trade added (newest kept, per-creator and total size capped). */
export function addDevTrade(ledger: DevLedger, creator: string, trade: DevTrade): DevLedger {
  const next: DevLedger = { ...ledger };
  next[creator] = [...(next[creator] ?? []), trade].slice(-MAX_TRADES_PER_CREATOR);
  const creators = Object.keys(next);
  if (creators.length > MAX_CREATORS) {
    const oldest = creators.sort((a, b) => lastAt(next[a]) - lastAt(next[b]))[0];
    delete next[oldest];
  }
  return next;
}

/** Pure: our results with one creator, or undefined if we never traded them. */
export function summariseDevTrades(trades: DevTrade[] | undefined): DevTradeSummary | undefined {
  if (!trades?.length) return undefined;
  const sum = trades.reduce((s, t) => s + t.pnlPercent, 0);
  return {
    trades: trades.length,
    wins: trades.filter((t) => t.pnlPercent > 0).length,
    avgPnlPercent: sum / trades.length,
  };
}

/** Pure: a saved ledger, keeping only well-formed entries. */
export function parseDevLedger(text: string): DevLedger {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: DevLedger = {};
    for (const [creator, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const trades = list.filter(
        (t): t is DevTrade =>
          typeof t?.mint === "string" && typeof t?.symbol === "string" && Number.isFinite(t?.pnlPercent) && Number.isFinite(t?.at)
      );
      if (trades.length) out[creator] = trades;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------- runtime state ----------

let ledger: DevLedger = {};
let saveChain: Promise<void> = Promise.resolve();

export const devLedgerPath = (): string => path.join(path.dirname(CONFIG.stateFilePath), "dev-trade-ledger.json");

export async function loadDevTradeLedger(): Promise<void> {
  try {
    ledger = parseDevLedger(await readFile(devLedgerPath(), "utf-8"));
  } catch {
    ledger = {};
  }
}

/** Hot path: one object lookup, no network. */
export function knownDevSummary(creator: string): DevTradeSummary | undefined {
  return summariseDevTrades(ledger[creator]);
}

/** Called for every SELL: finds the coin's creator on-chain and files the result under it. */
export async function recordDevTrade(mint: string, symbol: string, pnlPercent: number | undefined): Promise<void> {
  try {
    if (!mint || pnlPercent === undefined || !Number.isFinite(pnlPercent)) return;
    const creator = await fetchCreatorWallet(mint);
    if (!creator) return; // not a pump.fun coin, or the read failed
    ledger = addDevTrade(ledger, creator, { mint, symbol, pnlPercent, at: Date.now() });
    const snapshot = JSON.stringify(ledger, null, 2);
    saveChain = saveChain
      .then(async () => {
        const file = devLedgerPath();
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, snapshot, "utf-8");
        await rename(`${file}.tmp`, file);
      })
      .catch((e) => logger.debug(`dev trade ledger write failed: ${e instanceof Error ? e.message : String(e)}`));
  } catch (error) {
    logger.debug(`dev trade ledger ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
