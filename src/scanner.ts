import { CONFIG } from "./config.js";
import { httpGet } from "./http.js";
import { logger } from "./logger.js";
import { sanitizeDisplayText } from "./text-sanitize.js";

export interface TokenCandidate {
  address: string;
  symbol: string;
  name: string;
  chainId: string;
  pairAddress: string;
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  volume24h: number;
  volumeChange: number;
  liquidityUsd: number;
  marketCap: number;
  txns24hBuys: number;
  txns24hSells: number;
  buyToSellRatio: number;
  pairCreatedAt: number;
  ageHours: number;
  boostAmount?: number;
  url: string;
}

interface DexTokenBoost {
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
}

interface DexTokenInfo {
  address?: string;
  symbol?: string;
  name?: string;
}

export interface DexPair {
  baseToken?: DexTokenInfo;
  chainId?: string;
  pairAddress?: string;
  priceUsd?: string | number;
  priceChange?: {
    m5?: string | number;
    h1?: string | number;
    h6?: string | number;
    h24?: string | number;
  };
  volume?: {
    h24?: number;
  };
  liquidity?: {
    usd?: number;
  };
  txns?: {
    h24?: {
      buys?: number;
      sells?: number;
    };
  };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  url?: string;
}

interface DexSearchResponse {
  pairs?: DexPair[];
}

function asNumber(value: string | number | undefined, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Scan DexScreener for high-potential memecoin candidates
 * Filters: volume > $10k, liquidity > $5k, age < 72h, buy ratio > 55%
 */
export async function scanForCandidates(): Promise<TokenCandidate[]> {
  const candidates: TokenCandidate[] = [];

  try {
    // Two boost feeds, deliberately. `top` is the leaderboard — a coin only
    // appears once it has already climbed it, which is late by definition and
    // is why entries have been landing after 400-800% moves. `latest` carries
    // boosts as they are purchased, and is the only feed that can see a coin at
    // the moment it gets boosted. Failures are independent: one feed being down
    // must not blind the scanner to the other.
    const [topBoosts, latestBoosts] = await Promise.all([
      httpGet<DexTokenBoost[]>(`${CONFIG.dexScreenerApiUrl}/token-boosts/top/v1`).catch(() => {
        logger.debug("Top boosts feed unavailable.");
        return [] as DexTokenBoost[];
      }),
      httpGet<DexTokenBoost[]>(`${CONFIG.dexScreenerApiUrl}/token-boosts/latest/v1`).catch(() => {
        logger.debug("Latest boosts feed unavailable.");
        return [] as DexTokenBoost[];
      }),
    ]);

    // Latest first so a freshly boosted coin wins de-duplication and keeps its
    // own (newer) boost amount.
    const seenBoosted = new Set<string>();
    const boostedTokens: DexTokenBoost[] = [];
    for (const t of [...(latestBoosts || []), ...(topBoosts || [])]) {
      const key = `${t.chainId}:${t.tokenAddress}`;
      if (!t.tokenAddress || seenBoosted.has(key)) continue;
      seenBoosted.add(key);
      boostedTokens.push(t);
    }

    const relevantBoosted = boostedTokens.filter((t) => CONFIG.scanChains.includes(String(t.chainId || "").toLowerCase()));

    for (const token of relevantBoosted.slice(0, 20)) {
      try {
        const pairs = await httpGet<DexPair[]>(
          `${CONFIG.dexScreenerApiUrl}/tokens/v1/${token.chainId}/${token.tokenAddress}`
        );
        if (pairs.length > 0) {
          const pair = pairs[0];
          const candidate = parsePairToCandidate(pair, token.totalAmount || token.amount);
          if (candidate && passesInitialFilter(candidate)) {
            candidates.push(candidate);
          }
        }
        await sleep(250);
      } catch {
        logger.debug("Skipping failed boosted token fetch.");
      }
    }

    for (const chain of CONFIG.scanChains) {
      try {
        await httpGet<unknown>(`${CONFIG.dexScreenerApiUrl}/token-pairs/v1/${chain}/0x0000000000000000000000000000000000000000`, {
          params: { sort: "volume24h", order: "desc" },
        });

        const memeSearch = await httpGet<DexSearchResponse>(`${CONFIG.dexScreenerApiUrl}/latest/dex/search?q=meme+${chain}`);
        const memePairs = memeSearch.pairs || [];
        for (const pair of memePairs.slice(0, 15)) {
          const candidate = parsePairToCandidate(pair);
          if (candidate && passesInitialFilter(candidate) && !candidates.find((c) => c.address === candidate.address)) {
            candidates.push(candidate);
          }
        }
      } catch {
        logger.debug(`Skipping failed chain scan for ${chain}.`);
      }
    }

    logger.info(`📡 Scanned ${candidates.length} candidates passing initial filters`);
    return candidates;
  } catch (error) {
    logger.error("Scanner error", error);
    return candidates;
  }
}

export function parsePairToCandidate(pair: DexPair, boostAmount?: number): TokenCandidate | null {
  try {
    const priceUsd = asNumber(pair.priceUsd, 0);
    const volume24h = asNumber(pair.volume?.h24, 0);
    const liquidityUsd = asNumber(pair.liquidity?.usd, 0);
    const buys = asNumber(pair.txns?.h24?.buys, 0);
    const sells = asNumber(pair.txns?.h24?.sells, 0);
    const total = buys + sells;
    const buyRatio = total > 0 ? buys / total : 0.5;
    const pairCreatedAt = asNumber(pair.pairCreatedAt, 0);
    const ageMs = pairCreatedAt ? Date.now() - pairCreatedAt : Infinity;
    const ageHours = ageMs / (1000 * 60 * 60);

    return {
      address: pair.baseToken?.address || "",
      // The "?"/"Unknown" fallback guards a missing/empty raw value, but a
      // non-empty raw value made ENTIRELY of control/format characters (or
      // whitespace) is truthy — so it skips that fallback — and then
      // sanitization can still collapse it to "". Re-apply the fallback
      // after sanitizing so that case can't produce an empty tokenSymbol: a
      // real BUY persisted with one would fail isRestorablePosition's
      // non-empty-string check after a restart, leaving an actual open
      // position unrestorable and unmonitored.
      symbol: sanitizeDisplayText(pair.baseToken?.symbol || "?") || "?",
      name: sanitizeDisplayText(pair.baseToken?.name || "Unknown") || "Unknown",
      chainId: pair.chainId || "solana",
      pairAddress: pair.pairAddress || "",
      priceUsd,
      priceChange5m: asNumber(pair.priceChange?.m5, 0),
      priceChange1h: asNumber(pair.priceChange?.h1, 0),
      priceChange6h: asNumber(pair.priceChange?.h6, 0),
      priceChange24h: asNumber(pair.priceChange?.h24, 0),
      volume24h,
      volumeChange: 0,
      liquidityUsd,
      marketCap: asNumber(pair.marketCap ?? pair.fdv, 0),
      txns24hBuys: buys,
      txns24hSells: sells,
      buyToSellRatio: buyRatio,
      pairCreatedAt,
      ageHours,
      boostAmount,
      url: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
    };
  } catch {
    return null;
  }
}

/**
 * Initial filter to remove obvious bad candidates before AI analysis
 */
export function passesInitialFilter(candidate: TokenCandidate): boolean {
  if (candidate.volume24h < 10000) return false;
  if (candidate.liquidityUsd < 5000) return false;
  if (candidate.buyToSellRatio < 0.45) return false;
  if (candidate.ageHours > 168) return false;
  if (!candidate.address || candidate.address.length < 10) return false;
  if (!Number.isFinite(candidate.priceUsd) || candidate.priceUsd <= 0) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1]?.endsWith("scanner.ts") || process.argv[1]?.endsWith("scanner.js")) {
  scanForCandidates().then((candidates) => {
    logger.info(`🔍 Found ${candidates.length} candidates`);
    for (const c of candidates.slice(0, 10)) {
      logger.info(
        `${c.symbol} (${c.chainId}) | $${c.priceUsd.toFixed(8)} | Vol: $${(c.volume24h / 1000).toFixed(1)}K | Liq: $${(c.liquidityUsd / 1000).toFixed(1)}K | B/S: ${(c.buyToSellRatio * 100).toFixed(0)}% | Age: ${c.ageHours.toFixed(1)}h`
      );
      logger.info(`CA: ${c.address}`);
      logger.info(c.url);
    }
  });
}
