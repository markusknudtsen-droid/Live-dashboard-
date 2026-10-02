/**
 * Shadow log: a survivorship-free dataset of EVERY candidate the bot sees.
 *
 * The bot used to record only the coins it bought, so no filter, model or exit
 * could be tested (see the vault note "Why It Loses"). For each new candidate
 * this writes one line with its features at decision time, then price and
 * liquidity at +1/+5/+15/+60 minutes. A price that cannot be read at a horizon
 * is recorded as null, never dropped: a coin that vanished is the rug, and
 * leaving it out is exactly the bias this file exists to avoid.
 *
 * Append-only JSONL next to the state file. Every failure here is swallowed:
 * logging must never touch trading.
 * ponytail: no rotation (~2 KB per candidate), pending checks survive restarts
 * by rereading the file tail. Add rotation if the file passes ~100 MB.
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { fetchLivePrice } from "./live-price.js";
import { logger } from "./logger.js";
import type { TokenCandidate } from "./scanner.js";
import type { TradeSignal } from "./analyze.js";

export const SHADOW_HORIZONS_MIN = [1, 5, 15, 60];

export interface PendingCheck {
  mint: string;
  chainId: string;
  t0: number;
  price0: number;
  done: number[];
}

const shadowFile = (): string => path.join(path.dirname(CONFIG.stateFilePath), "shadow-candidates.jsonl");
const seen = new Set<string>();
let pending: PendingCheck[] = [];
let writeChain: Promise<void> = Promise.resolve();

function append(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  writeChain = writeChain
    .then(async () => {
      await mkdir(path.dirname(shadowFile()), { recursive: true });
      await appendFile(shadowFile(), line, "utf-8");
    })
    .catch((e) => logger.debug(`shadow log write failed: ${e instanceof Error ? e.message : String(e)}`));
}

/** Pure: horizons (minutes) whose time has come and that are not recorded yet. */
export function dueHorizons(check: PendingCheck, now: number): number[] {
  return SHADOW_HORIZONS_MIN.filter((h) => !check.done.includes(h) && now - check.t0 >= h * 60_000);
}

/** Pure: rebuild unfinished checks from file lines (restart recovery). */
export function pendingFromLines(lines: string[], now: number): PendingCheck[] {
  const map = new Map<string, PendingCheck>();
  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const mint = String(o.mint ?? "");
    if (o.type === "candidate" && typeof o.t === "number" && now - o.t < 61 * 60_000) {
      map.set(`${mint}@${o.t}`, { mint, chainId: String(o.chainId ?? "solana"), t0: o.t, price0: Number(o.price), done: [] });
    } else if (o.type === "outcome" && typeof o.t0 === "number") {
      map.get(`${mint}@${o.t0}`)?.done.push(Number(o.h));
    }
  }
  return [...map.values()].filter((p) => dueHorizons(p, Infinity).length > 0);
}

/** Record every not-yet-seen candidate with its features and the model's verdict. */
export function recordShadowCandidates(
  candidates: TokenCandidate[],
  signals: TradeSignal[],
  sourceByAddress: Map<string, string>
): void {
  if (!CONFIG.shadowEnabled) return;
  const verdicts = new Map(signals.map((s) => [s.token.address, s]));
  const now = Date.now();
  for (const c of candidates) {
    if (seen.has(c.address)) continue;
    seen.add(c.address);
    const s = verdicts.get(c.address);
    append({
      type: "candidate",
      t: now,
      mint: c.address,
      symbol: c.symbol,
      chainId: c.chainId,
      source: sourceByAddress.get(c.address) ?? null,
      price: c.priceUsd,
      ageHours: c.ageHours,
      liquidityUsd: c.liquidityUsd,
      marketCap: c.marketCap,
      volume24h: c.volume24h,
      pc5m: c.priceChange5m,
      pc1h: c.priceChange1h,
      buys24h: c.txns24hBuys,
      sells24h: c.txns24hSells,
      boost: c.boostAmount ?? 0,
      hasX: c.hasXSocial,
      hasOtherSocial: c.hasOtherSocial,
      paidInfo: c.hasPaidDexInfo,
      ai: s
        ? {
            action: s.action,
            rawConfidence: s.entryContext?.confidenceBeforeModifiers ?? null,
            finalConfidence: s.confidence,
            trend: s.trendStrength,
            momentum: s.momentum,
            risk: s.riskLevel,
          }
        : null,
    });
    pending.push({ mint: c.address, chainId: c.chainId, t0: now, price0: c.priceUsd, done: [] });
  }
}

/** Record why a gate stopped a coin (RugCheck numbers included when known). */
export function recordShadowReject(mint: string, reason: string, extra?: Record<string, unknown>): void {
  if (!CONFIG.shadowEnabled) return;
  append({ type: "reject", t: Date.now(), mint, reason, ...extra });
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const check of pending) {
    for (const h of dueHorizons(check, now)) {
      check.done.push(h);
      let price: number | null = null;
      let liq: number | null = null;
      try {
        const live = await fetchLivePrice(check.mint, check.chainId, 8000);
        if (live) {
          price = live.priceUsd;
          liq = live.liquidityUsd ?? null;
        }
      } catch {
        /* null = unreadable, recorded as such */
      }
      append({
        type: "outcome",
        t: Date.now(),
        mint: check.mint,
        t0: check.t0,
        h,
        price,
        liquidityUsd: liq,
        ret: price !== null && check.price0 > 0 ? (price / check.price0 - 1) * 100 : null,
      });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  pending = pending.filter((p) => dueHorizons(p, Infinity).length > 0);
}

export async function startShadowLog(): Promise<void> {
  if (!CONFIG.shadowEnabled) return;
  try {
    const file = shadowFile();
    const size = (await stat(file)).size;
    const text = await readFile(file, "utf-8");
    const tail = size > 4_000_000 ? text.slice(-4_000_000) : text;
    pending = pendingFromLines(tail.split("\n").filter(Boolean), Date.now());
  } catch {
    pending = [];
  }
  logger.info(`🕶️  SHADOW_LOG: recording every candidate to ${path.basename(shadowFile())} (${pending.length} unfinished check(s) resumed).`);
  setInterval(() => {
    void tick().catch(() => undefined);
  }, 15_000);
}
