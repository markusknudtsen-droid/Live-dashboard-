/**
 * Live price + liquidity for a held position.
 *
 * DexScreener's REST feed is what monitorPositions used, and it lags. Measured
 * 2026-09-21 against ALCH (a token doing ~$190k of 5-minute volume), polling
 * both sources every 3s for a minute:
 *
 *   DexScreener price changed:  2 times
 *   Jupiter     price changed: 16 times
 *
 * DexScreener sat frozen at 0.0566 for 25 seconds while the market moved, and
 * ended the minute reading 0.05796 against Jupiter's 0.059136 — a 2% gap. For a
 * stop-loss, and especially for the liquidity-drain check in rug-exit.ts, that
 * staleness is the whole ballgame: a Solana LP pull completes in a block or two
 * and DexScreener reports it long after the pool is empty.
 *
 * Jupiter's pool feed carries both fields and updates every few seconds, and
 * the bot already depends on Jupiter for swaps, so this adds no new key,
 * service or socket. DexScreener stays as the fallback for anything Jupiter
 * does not index.
 */

import { CONFIG } from "./config.js";

export interface LivePrice {
  priceUsd: number;
  /**
   * Undefined when the source did not report it — NOT zero. rug-exit.ts
   * distinguishes "unreadable" from "the pool is actually gone", and coercing a
   * missing field to 0 would panic-sell every position on a partial response.
   */
  liquidityUsd: number | undefined;
  source: "jupiter" | "dexscreener";
}

interface JupiterPoolsBody {
  pools?: Array<{
    liquidity?: number;
    baseAsset?: { usdPrice?: number };
  }>;
}

interface DexPair {
  priceUsd?: string | number;
  liquidity?: { usd?: string | number };
}

/** Finite number, or undefined. Shared by both parsers. */
function usable(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pure: pull price and liquidity out of a Jupiter pools response, or null when
 * it carries no usable price. Split out so the parsing is testable without a
 * network call.
 *
 * When several pools exist for the mint the deepest one wins — that is the pool
 * a real sell would route through, so its price and liquidity are the ones that
 * matter to an exit.
 */
export function parseJupiterPrice(body: unknown): LivePrice | null {
  const pools = (body as JupiterPoolsBody)?.pools;
  if (!Array.isArray(pools) || pools.length === 0) return null;

  let best: { priceUsd: number; liquidityUsd: number | undefined } | null = null;
  for (const pool of pools) {
    const priceUsd = usable(pool?.baseAsset?.usdPrice);
    if (priceUsd === undefined || priceUsd <= 0) continue;
    const liquidityUsd = usable(pool?.liquidity);
    if (best === null || (liquidityUsd ?? -1) > (best.liquidityUsd ?? -1)) {
      best = { priceUsd, liquidityUsd };
    }
  }

  return best === null ? null : { ...best, source: "jupiter" };
}

/** Pure: same, for DexScreener's array-of-pairs shape. */
export function parseDexScreenerPrice(body: unknown): LivePrice | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const pair = body[0] as DexPair;
  const priceUsd = usable(pair?.priceUsd);
  if (priceUsd === undefined || priceUsd <= 0) return null;
  return { priceUsd, liquidityUsd: usable(pair?.liquidity?.usd), source: "dexscreener" };
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Price and liquidity for one mint, Jupiter first, DexScreener as fallback.
 * Null only when BOTH sources fail — the caller then skips this tick rather
 * than acting on a price it does not have.
 */
export async function fetchLivePrice(
  tokenAddress: string,
  chainId: string,
  timeoutMs = 5000
): Promise<LivePrice | null> {
  if (CONFIG.useJupiterPriceFeed) {
    const jup = parseJupiterPrice(
      await getJson(`https://datapi.jup.ag/v1/pools?assetIds=${encodeURIComponent(tokenAddress)}`, timeoutMs)
    );
    if (jup) return jup;
  }

  return parseDexScreenerPrice(
    await getJson(
      `${CONFIG.dexScreenerApiUrl}/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      timeoutMs
    )
  );
}
