import test from "node:test";
import assert from "node:assert/strict";
import { parsePairToCandidate, type DexPair } from "../src/scanner.js";

/**
 * Confirmed against DexScreener's live response for CTALnV64...ppump (TRONK,
 * a real memecoin) on 2026-09-08: info.socials/websites are populated only
 * once a project pays for the "Update Token Info" listing — imageUrl/header
 * can come from free on-chain Metaplex metadata, but a mint has no on-chain
 * concept of a Twitter link, so socials/websites presence is real evidence of
 * the paid listing.
 */
function pair(overrides: Partial<DexPair> = {}): DexPair {
  return {
    baseToken: { address: "MintAddr111111111111111111111111111111111", symbol: "TEST", name: "Test Token" },
    chainId: "solana",
    pairAddress: "Pair11111111111111111111111111111111111111",
    priceUsd: "0.001",
    liquidity: { usd: 9000 },
    volume: { h24: 50000 },
    txns: { h24: { buys: 60, sells: 40 } },
    pairCreatedAt: Date.now(),
    ...overrides,
  };
}

test("no info block: all three signals false, exactly today's behaviour", () => {
  const c = parsePairToCandidate(pair());
  assert.equal(c?.hasXSocial, false);
  assert.equal(c?.hasOtherSocial, false);
  assert.equal(c?.hasPaidDexInfo, false);
});

test("an X/Twitter social sets hasXSocial and hasPaidDexInfo, not hasOtherSocial", () => {
  const c = parsePairToCandidate(
    pair({ info: { socials: [{ url: "https://x.com/test", type: "twitter" }] } })
  );
  assert.equal(c?.hasXSocial, true);
  assert.equal(c?.hasOtherSocial, false);
  assert.equal(c?.hasPaidDexInfo, true);
});

test("a website with no X social sets hasOtherSocial, not hasXSocial", () => {
  const c = parsePairToCandidate(pair({ info: { websites: [{ url: "https://example.com" }] } }));
  assert.equal(c?.hasXSocial, false);
  assert.equal(c?.hasOtherSocial, true);
  assert.equal(c?.hasPaidDexInfo, true);
});

test("telegram alone (a real social, not X) counts as hasOtherSocial", () => {
  const c = parsePairToCandidate(
    pair({ info: { socials: [{ url: "https://t.me/test", type: "telegram" }] } })
  );
  assert.equal(c?.hasXSocial, false);
  assert.equal(c?.hasOtherSocial, true);
});

test("X plus other socials together: X wins, no double-counting as 'other'", () => {
  // Mirrors the real TRONK payload: twitter + telegram together.
  const c = parsePairToCandidate(
    pair({
      info: {
        socials: [
          { url: "https://x.com/test", type: "twitter" },
          { url: "https://t.me/test", type: "telegram" },
        ],
      },
    })
  );
  assert.equal(c?.hasXSocial, true);
  assert.equal(c?.hasOtherSocial, false, "hasOtherSocial and hasXSocial must be mutually exclusive");
});

test("an empty info block (present but no arrays) behaves like no info at all", () => {
  const c = parsePairToCandidate(pair({ info: {} }));
  assert.equal(c?.hasPaidDexInfo, false);
});
