import test from "node:test";
import assert from "node:assert/strict";
import { parsePairToCandidate, passesInitialFilter } from "../src/scanner.js";

test("parsePairToCandidate maps pair fields correctly", () => {
  const candidate = parsePairToCandidate({
    baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOLM", name: "Sol Meme" },
    chainId: "solana",
    pairAddress: "pair123",
    priceUsd: "0.001",
    priceChange: { m5: "2", h1: "10", h6: "20", h24: "30" },
    volume: { h24: 20000 },
    liquidity: { usd: 10000 },
    txns: { h24: { buys: 80, sells: 20 } },
    marketCap: 1200000,
    pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
    url: "https://dexscreener.com/solana/pair123",
  });

  assert.ok(candidate);
  assert.equal(candidate?.symbol, "SOLM");
  assert.equal(candidate?.buyToSellRatio, 0.8);
});

test("passesInitialFilter rejects low liquidity and invalid price", () => {
  const now = Date.now();
  const candidate = parsePairToCandidate({
    baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "BAD", name: "Bad" },
    chainId: "solana",
    pairAddress: "pair456",
    priceUsd: "0",
    volume: { h24: 20000 },
    liquidity: { usd: 1000 },
    txns: { h24: { buys: 80, sells: 20 } },
    pairCreatedAt: now - 60 * 60 * 1000,
  });

  assert.ok(candidate);
  assert.equal(passesInitialFilter(candidate!), false);
});
