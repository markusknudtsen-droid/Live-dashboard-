import test from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "true";
process.env.OPENROUTER_API_KEY = "test";

const { parseJupiterPrice, parseDexScreenerPrice } = await import("../src/live-price.js");

test("parseJupiterPrice reads price and liquidity from a pools response", () => {
  const got = parseJupiterPrice({
    pools: [{ liquidity: 12345.6, baseAsset: { usdPrice: 0.0000421 } }],
  });
  assert.deepEqual(got, { priceUsd: 0.0000421, liquidityUsd: 12345.6, source: "jupiter" });
});

test("the deepest pool wins — that is where a real sell would route", () => {
  const got = parseJupiterPrice({
    pools: [
      { liquidity: 900, baseAsset: { usdPrice: 0.01 } },
      { liquidity: 50_000, baseAsset: { usdPrice: 0.02 } },
      { liquidity: 4_000, baseAsset: { usdPrice: 0.03 } },
    ],
  });
  assert.equal(got?.priceUsd, 0.02);
  assert.equal(got?.liquidityUsd, 50_000);
});

test("missing liquidity stays undefined, never 0 — the rug check depends on that", () => {
  // Coercing an unreported field to zero would read as "the pool is gone" and
  // panic-sell on a partial API response.
  const got = parseJupiterPrice({ pools: [{ baseAsset: { usdPrice: 5 } }] });
  assert.equal(got?.priceUsd, 5);
  assert.equal(got?.liquidityUsd, undefined);

  // A genuinely reported zero is preserved, because that IS a drained pool.
  const drained = parseJupiterPrice({ pools: [{ liquidity: 0, baseAsset: { usdPrice: 5 } }] });
  assert.equal(drained?.liquidityUsd, 0);
});

test("unusable Jupiter bodies yield null rather than a bogus price", () => {
  for (const body of [
    undefined,
    null,
    {},
    { pools: [] },
    { pools: [{ baseAsset: {} }] },
    { pools: [{ baseAsset: { usdPrice: 0 } }] },
    { pools: [{ baseAsset: { usdPrice: -1 } }] },
    { pools: [{ baseAsset: { usdPrice: Number.NaN } }] },
  ]) {
    assert.equal(parseJupiterPrice(body), null, `expected null for ${JSON.stringify(body)}`);
  }
});

test("parseDexScreenerPrice handles the string-typed pair shape", () => {
  const got = parseDexScreenerPrice([{ priceUsd: "0.00004210", liquidity: { usd: "12345.6" } }]);
  assert.deepEqual(got, { priceUsd: 0.0000421, liquidityUsd: 12345.6, source: "dexscreener" });

  assert.equal(parseDexScreenerPrice([]), null);
  assert.equal(parseDexScreenerPrice([{ priceUsd: "0" }]), null);
  assert.equal(parseDexScreenerPrice([{}]), null);
  // Missing liquidity again stays undefined.
  assert.equal(parseDexScreenerPrice([{ priceUsd: "1" }])?.liquidityUsd, undefined);
});
