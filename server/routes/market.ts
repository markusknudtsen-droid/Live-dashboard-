import { Router } from "express";
import { scanForCandidates } from "../../src/scanner.js";

const router = Router();

let cache: { data: unknown; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

interface ScannerTokenItem {
  token_address: string;
  symbol: string;
  chain_id: string;
  price_usd: number;
  volume_24h: number;
  liquidity_usd: number;
  buy_to_sell_ratio: number;
  age_hours: number;
  boost_count: number;
  url: string;
}

interface DashboardAlert {
  id: string;
  type: "CTO" | "Boost";
  token_address: string;
  boost_count: number;
  triggered_at: number;
  status: "viewed" | "dismissed";
  detail: string;
}

function toScannerToken(candidate: Awaited<ReturnType<typeof scanForCandidates>>[number]): ScannerTokenItem {
  return {
    token_address: candidate.address,
    symbol: candidate.symbol,
    chain_id: candidate.chainId,
    price_usd: candidate.priceUsd,
    volume_24h: candidate.volume24h,
    liquidity_usd: candidate.liquidityUsd,
    buy_to_sell_ratio: candidate.buyToSellRatio,
    age_hours: candidate.ageHours,
    boost_count: Number(candidate.boostAmount || 0),
    url: candidate.url,
  };
}

function deriveAlerts(tokens: ScannerTokenItem[]): DashboardAlert[] {
  const now = Date.now();
  const alerts: DashboardAlert[] = [];

  for (const token of tokens) {
    if (token.boost_count >= 50) {
      alerts.push({
        id: `boost-${token.token_address}`,
        type: "Boost",
        token_address: token.token_address,
        boost_count: token.boost_count,
        triggered_at: now,
        status: "viewed",
        detail: `${token.symbol} reached ${token.boost_count} boosts (auto-buy threshold 50).`,
      });
    }
    const ctoHeuristic = token.age_hours <= 24 && token.buy_to_sell_ratio >= 0.7 && token.volume_24h >= 50_000;
    if (ctoHeuristic) {
      alerts.push({
        id: `cto-${token.token_address}`,
        type: "CTO",
        token_address: token.token_address,
        boost_count: token.boost_count,
        triggered_at: now,
        status: "viewed",
        detail: `${token.symbol} flagged by CTO heuristic (new token + strong buy pressure).`,
      });
    }
  }

  return alerts.sort((a, b) => b.boost_count - a.boost_count);
}

router.get("/trending", async (_req, res) => {
  try {
    if (cache && cache.expiresAt > Date.now()) {
      res.json(cache.data);
      return;
    }

    const candidates = await scanForCandidates();
    const trending = candidates
      .slice(0, 25)
      .sort((a, b) => b.volume24h - a.volume24h)
      .map((token) => ({
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
        boost_count: Number(token.boostAmount || 0),
        url: token.url,
      }));

    cache = { data: trending, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(trending);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to fetch trending tokens: ${message}` });
  }
});

router.get("/scanner", async (_req, res) => {
  try {
    const candidates = await scanForCandidates();
    const scannerFeed = candidates
      .map(toScannerToken)
      .sort((a, b) => b.boost_count - a.boost_count || b.volume_24h - a.volume_24h)
      .slice(0, 50);
    res.json({
      filters: {
        min_volume_24h: 10000,
        min_liquidity_usd: 5000,
        min_buy_ratio: 0.45,
        max_age_hours: 168,
      },
      items: scannerFeed,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to fetch scanner feed: ${message}` });
  }
});

router.get("/alerts", async (_req, res) => {
  try {
    const candidates = await scanForCandidates();
    const scannerFeed = candidates.map(toScannerToken);
    res.json({
      items: deriveAlerts(scannerFeed).slice(0, 30),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to build alerts: ${message}` });
  }
});

export default router;
