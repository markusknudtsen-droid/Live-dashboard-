import { Router } from "express";
import { scanForCandidates, TokenCandidate } from "../../src/scanner.js";

const router = Router();

export interface ScannerAlert {
  type: "BOOST" | "CTO";
  token_address: string;
  symbol: string;
  boost_count: number;
  triggered_at: number;
  status: "active";
}

export interface ScannerTokenSummary {
  address: string;
  symbol: string;
  name: string;
  chain_id: string;
  price_usd: number;
  price_change_24h: number;
  volume_24h: number;
  liquidity_usd: number;
  buy_to_sell_ratio: number;
  age_hours: number;
  boost_count: number;
  auto_buy_ready: boolean;
  cto_candidate: boolean;
  signal_status: "buy-ready" | "cto-watch" | "boost-watch" | "volume-watch";
  url: string;
}

interface MarketSnapshot {
  trending: ScannerTokenSummary[];
  scanner: {
    boosted_threshold: number;
    alerts: ScannerAlert[];
    tokens: ScannerTokenSummary[];
  };
}

const BOOST_THRESHOLD = 50;
let cache: { data: MarketSnapshot; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

function isCtoCandidate(token: TokenCandidate): boolean {
  const haystack = `${token.symbol} ${token.name}`.toLowerCase();
  return /\bcto\b|community takeover/.test(haystack);
}

export function buildMarketSnapshot(candidates: TokenCandidate[], now = Date.now()): MarketSnapshot {
  const mapped = candidates.map<ScannerTokenSummary>((token) => {
    const boostCount = Math.max(0, Math.round(token.boostAmount || 0));
    const autoBuyReady = boostCount >= BOOST_THRESHOLD;
    const ctoCandidate = isCtoCandidate(token);

    return {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      chain_id: token.chainId,
      price_usd: token.priceUsd,
      price_change_24h: token.priceChange24h,
      volume_24h: token.volume24h,
      liquidity_usd: token.liquidityUsd,
      buy_to_sell_ratio: token.buyToSellRatio,
      age_hours: token.ageHours,
      boost_count: boostCount,
      auto_buy_ready: autoBuyReady,
      cto_candidate: ctoCandidate,
      signal_status: autoBuyReady ? "buy-ready" : ctoCandidate ? "cto-watch" : boostCount > 0 ? "boost-watch" : "volume-watch",
      url: token.url,
    };
  });

  const trending = mapped.slice().sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 25);
  const scannerTokens = mapped
    .slice()
    .sort((a, b) => {
      if (Number(b.auto_buy_ready) !== Number(a.auto_buy_ready)) return Number(b.auto_buy_ready) - Number(a.auto_buy_ready);
      if (b.boost_count !== a.boost_count) return b.boost_count - a.boost_count;
      if (Number(b.cto_candidate) !== Number(a.cto_candidate)) return Number(b.cto_candidate) - Number(a.cto_candidate);
      return b.volume_24h - a.volume_24h;
    })
    .slice(0, 15);

  const alerts: ScannerAlert[] = scannerTokens.flatMap((token) => {
    const tokenAlerts: ScannerAlert[] = [];
    if (token.auto_buy_ready) {
      tokenAlerts.push({
        type: "BOOST",
        token_address: token.address,
        symbol: token.symbol,
        boost_count: token.boost_count,
        triggered_at: now,
        status: "active",
      });
    }
    if (token.cto_candidate) {
      tokenAlerts.push({
        type: "CTO",
        token_address: token.address,
        symbol: token.symbol,
        boost_count: token.boost_count,
        triggered_at: now,
        status: "active",
      });
    }
    return tokenAlerts;
  });

  return {
    trending,
    scanner: {
      boosted_threshold: BOOST_THRESHOLD,
      alerts: alerts.slice(0, 20),
      tokens: scannerTokens,
    },
  };
}

async function getSnapshot(): Promise<MarketSnapshot> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.data;
  }

  const candidates = await scanForCandidates();
  const snapshot = buildMarketSnapshot(candidates);
  cache = { data: snapshot, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshot;
}

router.get("/trending", async (_req, res) => {
  try {
    const snapshot = await getSnapshot();
    res.json(snapshot.trending);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to fetch trending tokens: ${message}` });
  }
});

router.get("/scanner", async (_req, res) => {
  try {
    const snapshot = await getSnapshot();
    res.json(snapshot.scanner);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to fetch scanner snapshot: ${message}` });
  }
});

export default router;
