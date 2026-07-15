import { Router } from "express";
import { scanForCandidates } from "../../src/scanner.js";

const router = Router();

let cache: { data: unknown; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

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
        url: token.url,
      }));

    cache = { data: trending, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(trending);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: `Failed to fetch trending tokens: ${message}` });
  }
});

export default router;
