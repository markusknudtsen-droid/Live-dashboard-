import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketSnapshot } from "../server/routes/market.js";

test("buildMarketSnapshot flags boost and CTO alerts while preserving volume feed", () => {
  const now = 1_700_000_000_000;
  const snapshot = buildMarketSnapshot(
    [
      {
        address: "Boost1111111111111111111111111111111111111",
        symbol: "BOOST",
        name: "Boost Runner",
        chainId: "solana",
        pairAddress: "pair-boost",
        priceUsd: 0.001,
        priceChange5m: 5,
        priceChange1h: 12,
        priceChange6h: 18,
        priceChange24h: 20,
        volume24h: 90000,
        volumeChange: 0,
        liquidityUsd: 40000,
        marketCap: 500000,
        txns24hBuys: 80,
        txns24hSells: 20,
        buyToSellRatio: 0.8,
        pairCreatedAt: now - 60_000,
        ageHours: 1,
        boostAmount: 55,
        url: "https://dexscreener.com/solana/pair-boost",
      },
      {
        address: "CTO11111111111111111111111111111111111111",
        symbol: "CTO",
        name: "Community Takeover",
        chainId: "solana",
        pairAddress: "pair-cto",
        priceUsd: 0.002,
        priceChange5m: 1,
        priceChange1h: 4,
        priceChange6h: 10,
        priceChange24h: 12,
        volume24h: 25000,
        volumeChange: 0,
        liquidityUsd: 11000,
        marketCap: 250000,
        txns24hBuys: 55,
        txns24hSells: 45,
        buyToSellRatio: 0.55,
        pairCreatedAt: now - 120_000,
        ageHours: 2,
        boostAmount: 3,
        url: "https://dexscreener.com/solana/pair-cto",
      },
    ],
    now
  );

  assert.equal(snapshot.scanner.boosted_threshold, 50);
  assert.equal(snapshot.trending[0]?.symbol, "BOOST");
  assert.equal(snapshot.scanner.tokens[0]?.signal_status, "buy-ready");
  assert.equal(snapshot.scanner.tokens[1]?.signal_status, "cto-watch");
  assert.deepEqual(
    snapshot.scanner.alerts.map((alert) => alert.type).sort(),
    ["BOOST", "CTO"]
  );
});
