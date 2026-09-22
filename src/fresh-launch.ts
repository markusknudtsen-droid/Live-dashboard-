/**
 * Side scanner for brand-new launches, independent of the main DexScreener
 * pipeline and of the AI analyst.
 *
 * The main scan is tuned for coins that already have a footprint: it needs
 * DexScreener data, a model call, and a rug round-trip. A token five minutes
 * old has none of that yet, so this path judges it purely on hard, on-chain-
 * derived facts from Jupiter's pool feed — age, liquidity, mint/freeze
 * authority, and how much of the buying looks organic rather than botted.
 *
 * Fail-safe like the other optional sources: any failure resolves to an empty
 * list, never throws.
 *
 * NOTE on the "pro traders" bar. Jupiter's web UI shows a Pro Traders figure,
 * but it is NOT in the public API — probed 2026-09-21 across datapi /v1/pools,
 * /v1/pools/toptrending, /v1/holders, lite-api /tokens/v2/search, and
 * /v1/traders (404). The closest published signal is Jupiter's own split of
 * buy volume into organic vs total, so that is what the threshold reads.
 * Rename/retarget it here if the real definition turns out to be different.
 */

import { CONFIG } from "./config.js";
import { logger } from "./logger.js";

const JUPITER_POOLS_API = "https://datapi.jup.ag/v1/pools";

export interface FreshLaunchAudit {
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  botHoldersPercentage?: number;
  sniperPct?: number;
  devBalancePercentage?: number;
}

export interface FreshLaunchStats {
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
}

export interface FreshLaunchPool {
  id?: string;
  createdAt?: string;
  liquidity?: number;
  baseAsset?: {
    id?: string;
    symbol?: string;
    name?: string;
    usdPrice?: number;
    mcap?: number;
    audit?: FreshLaunchAudit;
    organicScore?: number;
    stats5m?: FreshLaunchStats;
  };
}

export interface FreshLaunchConfig {
  maxAgeMinutes: number;
  minLiquidityUsd: number;
  minBuyVolume5m: number;
  /** Minimum share of 5m buy volume that Jupiter classes as organic, 0-100. */
  minOrganicBuyPercent: number;
}

export interface FreshLaunchVerdict {
  pass: boolean;
  reason: string;
  organicBuyPercent?: number;
  ageMinutes?: number;
}

/** The fields the gate needs, flattened out of the nested pool shape. */
export interface FreshLaunchCandidate {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  ageMinutes: number;
  buyVolume5m: number;
  organicBuyPercent: number;
  mintDisabled: boolean;
  freezeDisabled: boolean;
}

/**
 * Flatten a pool into the fields the gate reads, or null when anything
 * required is missing or unusable.
 *
 * Deliberately strict: a token this young with absent data is unknowable, not
 * merely unproven, and this path buys without a model or a rug check to catch
 * a mistake afterwards.
 */
export function toFreshCandidate(pool: FreshLaunchPool, now: number): FreshLaunchCandidate | null {
  const base = pool.baseAsset;
  const address = base?.id ?? pool.id;
  if (!address || !base) return null;

  const createdMs = pool.createdAt ? Date.parse(pool.createdAt) : NaN;
  if (!Number.isFinite(createdMs)) return null;
  const ageMinutes = (now - createdMs) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return null;

  const priceUsd = base.usdPrice;
  if (typeof priceUsd !== "number" || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const liquidityUsd = pool.liquidity;
  if (typeof liquidityUsd !== "number" || !Number.isFinite(liquidityUsd)) return null;

  const stats = base.stats5m ?? {};
  const buyVolume5m =
    typeof stats.buyVolume === "number" && Number.isFinite(stats.buyVolume) ? stats.buyVolume : 0;
  // An absent organic figure is treated as zero rather than skipped, so the
  // gate fails closed: unknown provenance must not pass a "how real is this
  // buying" test.
  const organicVolume =
    typeof stats.buyOrganicVolume === "number" && Number.isFinite(stats.buyOrganicVolume)
      ? stats.buyOrganicVolume
      : 0;
  const organicBuyPercent = buyVolume5m > 0 ? (organicVolume / buyVolume5m) * 100 : 0;

  return {
    address,
    symbol: base.symbol ?? "?",
    name: base.name ?? base.symbol ?? "?",
    priceUsd,
    marketCapUsd: typeof base.mcap === "number" && Number.isFinite(base.mcap) ? base.mcap : 0,
    liquidityUsd,
    ageMinutes,
    buyVolume5m,
    organicBuyPercent,
    // Absent authority flags are NOT assumed safe.
    mintDisabled: base.audit?.mintAuthorityDisabled === true,
    freezeDisabled: base.audit?.freezeAuthorityDisabled === true,
  };
}

/**
 * Whether a fresh launch clears every bar. Pure, so the thresholds are
 * testable without a network or a wallet.
 *
 * Order matters only for which reason is reported first; the most
 * disqualifying checks come first so the logs name the real problem.
 */
export function passesFreshLaunchGate(
  candidate: FreshLaunchCandidate,
  config: FreshLaunchConfig
): FreshLaunchVerdict {
  const shared = { organicBuyPercent: candidate.organicBuyPercent, ageMinutes: candidate.ageMinutes };

  if (candidate.ageMinutes > config.maxAgeMinutes) {
    return { pass: false, reason: `${candidate.ageMinutes.toFixed(1)}m old (max ${config.maxAgeMinutes}m)`, ...shared };
  }
  if (!candidate.mintDisabled) {
    return { pass: false, reason: "mint authority still enabled", ...shared };
  }
  if (!candidate.freezeDisabled) {
    return { pass: false, reason: "freeze authority still enabled", ...shared };
  }
  if (candidate.liquidityUsd < config.minLiquidityUsd) {
    return {
      pass: false,
      reason: `liquidity $${candidate.liquidityUsd.toFixed(0)} < $${config.minLiquidityUsd}`,
      ...shared,
    };
  }
  if (candidate.buyVolume5m < config.minBuyVolume5m) {
    return {
      pass: false,
      reason: `5m buy volume $${candidate.buyVolume5m.toFixed(0)} < $${config.minBuyVolume5m}`,
      ...shared,
    };
  }
  if (candidate.organicBuyPercent < config.minOrganicBuyPercent) {
    return {
      pass: false,
      reason: `organic buys ${candidate.organicBuyPercent.toFixed(1)}% < ${config.minOrganicBuyPercent}%`,
      ...shared,
    };
  }

  return {
    pass: true,
    reason:
      `${candidate.ageMinutes.toFixed(1)}m old, $${candidate.liquidityUsd.toFixed(0)} liq, ` +
      `$${candidate.buyVolume5m.toFixed(0)} 5m buys, ${candidate.organicBuyPercent.toFixed(1)}% organic, ` +
      `mint+freeze disabled`,
    ...shared,
  };
}

/** Newest pools from Jupiter, newest first. Empty on any failure. */
export async function fetchFreshLaunches(limit = 50, timeoutMs = 8000): Promise<FreshLaunchPool[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${JUPITER_POOLS_API}?sortBy=timestamp&sortDir=desc&limit=${limit}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { pools?: FreshLaunchPool[] };
    return Array.isArray(body.pools) ? body.pools : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch, flatten and filter in one call. Logs near-misses — a token that
 * cleared every hard gate and failed only on the organic-buy bar is exactly
 * the signal needed to tell whether that threshold is set sanely, and without
 * it a silent scanner looks identical to a broken one.
 */
export async function findFreshLaunches(now = Date.now()): Promise<FreshLaunchCandidate[]> {
  const config: FreshLaunchConfig = {
    maxAgeMinutes: CONFIG.freshLaunchMaxAgeMinutes,
    minLiquidityUsd: CONFIG.freshLaunchMinLiquidityUsd,
    minBuyVolume5m: CONFIG.freshLaunchMinBuyVolume5m,
    minOrganicBuyPercent: CONFIG.freshLaunchMinOrganicBuyPercent,
  };

  const pools = await fetchFreshLaunches();
  const passed: FreshLaunchCandidate[] = [];

  for (const pool of pools) {
    const candidate = toFreshCandidate(pool, now);
    if (!candidate) continue;
    // Only consider things inside the age window at all; older pools are the
    // bulk of the feed and are not near-misses worth logging.
    if (candidate.ageMinutes > config.maxAgeMinutes) continue;

    const verdict = passesFreshLaunchGate(candidate, config);
    if (verdict.pass) {
      passed.push(candidate);
      continue;
    }
    if (verdict.reason.startsWith("organic buys")) {
      logger.info(`🌱 ${candidate.symbol}: cleared every hard gate but ${verdict.reason}`);
    } else {
      logger.debug(`🌱 ${candidate.symbol}: ${verdict.reason}`);
    }
  }

  return passed;
}
