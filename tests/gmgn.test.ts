import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig, CONFIG } from "../src/config.js";
import { checkGmgn, clearGmgnCache, fetchGmgnReport, parseGmgnInfo, type GmgnLimits } from "../src/gmgn.js";

// Shapes below follow GMGN's published CLI and skill docs. They are NOT captured from a
// live call yet: once a real response exists, add it as tests/fixtures/gmgn-token-info.json.
const populated = {
  symbol: "ABC",
  holder_count: 83,
  stat: {
    holder_count: 80,
    top_bundler_trader_percentage: "0.1783",
    top70_sniper_hold_rate: "0.03",
    top_rat_trader_percentage: "0",
    bot_degen_rate: "0.41",
    fresh_wallet_rate: "0.2",
    creator_created_count: 4,
  },
};
const LIMITS: GmgnLimits = { maxBundlerPct: 30, maxSniperPct: 15, maxRatTraderPct: 5, maxBotDegenPct: 70 };

test("parses a populated stat block and converts decimal fractions to percent", () => {
  const r = parseGmgnInfo(populated);
  assert.ok(r);
  assert.equal(r.statPopulated, true);
  assert.ok(Math.abs(r.bundlerPct - 17.83) < 1e-9);
  assert.ok(Math.abs(r.botDegenPct - 41) < 1e-9);
  assert.equal(r.creatorCreatedCount, 4);
  assert.equal(r.holderCount, 83);
});

test("an address GMGN has no record for (empty symbol) or a non-object is unknown", () => {
  assert.equal(parseGmgnInfo({ ...populated, symbol: "" }), undefined);
  assert.equal(parseGmgnInfo(null), undefined);
  assert.equal(parseGmgnInfo("nope"), undefined);
});

test("all-zero stat means MISSING, not clean", () => {
  const r = parseGmgnInfo({ symbol: "NEW", holder_count: 0, stat: { holder_count: 0, top_bundler_trader_percentage: "0" } });
  assert.equal(r?.statPopulated, false);
  assert.equal(parseGmgnInfo({ symbol: "NEW", holder_count: 0 })?.statPopulated, false);
});

test("stat.holder_count of 0 while the coin has holders means the block is unpopulated", () => {
  const r = parseGmgnInfo({
    symbol: "MIRROR",
    holder_count: 500,
    stat: { holder_count: 0, top_bundler_trader_percentage: "0.4" },
  });
  assert.equal(r?.statPopulated, false);
});

test("unknown GMGN data passes: it is extra information, never a block", () => {
  assert.deepEqual(checkGmgn(undefined, LIMITS), { pass: true, known: false, reason: "GMGN has no data for this coin" });
  const v = checkGmgn(parseGmgnInfo({ symbol: "NEW", holder_count: 0 }), LIMITS);
  assert.equal(v.pass, true);
  assert.equal(v.known, false);
});

test("rejects over a limit, lists every breach, and passes exactly at the limit", () => {
  const r = parseGmgnInfo({
    symbol: "BAD",
    holder_count: 90,
    stat: { holder_count: 90, top_bundler_trader_percentage: "0.45", top70_sniper_hold_rate: "0.2", bot_degen_rate: "0.1" },
  });
  const v = checkGmgn(r, LIMITS);
  assert.equal(v.pass, false);
  assert.equal(v.known, true);
  assert.match(v.reason, /bundlers 45\.0% > 30%/);
  assert.match(v.reason, /snipers 20\.0% > 15%/);
  assert.doesNotMatch(v.reason, /bot wallets/);

  const atLimit = parseGmgnInfo({ symbol: "EDGE", holder_count: 90, stat: { holder_count: 90, top_bundler_trader_percentage: "0.3" } });
  assert.equal(checkGmgn(atLimit, LIMITS).pass, true, "strictly greater than the limit rejects");
});

test("GMGN_MODE: only an explicit shadow/gate turns it on; a typo stays off", () => {
  assert.equal(buildConfig({}).gmgnMode, "off");
  assert.equal(buildConfig({ GMGN_MODE: " GATE " }).gmgnMode, "gate");
  assert.equal(buildConfig({ GMGN_MODE: "shadow" }).gmgnMode, "shadow");
  assert.equal(buildConfig({ GMGN_MODE: "gat" }).gmgnMode, "off");
  assert.equal(buildConfig({ GMGN_API_KEY: "  k  " }).gmgnApiKey, "k");
});

test("when off (or keyless) it never touches the network", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch must not be called while GMGN is off");
  }) as typeof fetch;
  try {
    clearGmgnCache();
    assert.equal(await fetchGmgnReport("mintOff"), undefined);
    const saved = { mode: CONFIG.gmgnMode, key: CONFIG.gmgnApiKey };
    CONFIG.gmgnMode = "shadow"; // mode on but no key
    CONFIG.gmgnApiKey = "";
    try {
      assert.equal(await fetchGmgnReport("mintNoKey"), undefined);
    } finally {
      CONFIG.gmgnMode = saved.mode;
      CONFIG.gmgnApiKey = saved.key;
    }
  } finally {
    globalThis.fetch = realFetch;
    clearGmgnCache();
  }
});

test("request contract, caching, and backoff after an auth failure", async () => {
  const realFetch = globalThis.fetch;
  const saved = { mode: CONFIG.gmgnMode, key: CONFIG.gmgnApiKey };
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  let status = 200;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    calls.push({ url: new URL(String(u)), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ code: 0, data: populated }), { status });
  }) as typeof fetch;
  CONFIG.gmgnMode = "shadow";
  CONFIG.gmgnApiKey = "test-key";
  try {
    clearGmgnCache();
    const t0 = 1_000_000;
    const r = await fetchGmgnReport("MintA", 4000, t0);
    assert.equal(r?.statPopulated, true);
    assert.equal(calls.length, 1);
    const { url, headers } = calls[0]!;
    assert.equal(url.origin, "https://openapi.gmgn.ai");
    assert.equal(url.pathname, "/v1/token/info");
    assert.equal(url.searchParams.get("chain"), "sol");
    assert.equal(url.searchParams.get("address"), "MintA");
    assert.ok(url.searchParams.get("client_id"), "one-time client_id is sent");
    assert.match(url.searchParams.get("timestamp") ?? "", /^\d{10}$/);
    assert.equal(headers["X-APIKEY"], "test-key");

    await fetchGmgnReport("MintA", 4000, t0 + 1000);
    assert.equal(calls.length, 1, "second read of the same mint within the TTL is served from cache");

    status = 403;
    assert.equal(await fetchGmgnReport("MintB", 4000, t0 + 2000), undefined);
    assert.equal(calls.length, 2);
    status = 200;
    assert.equal(await fetchGmgnReport("MintC", 4000, t0 + 3000), undefined);
    assert.equal(calls.length, 2, "paused after a 403: no request while backing off");
    assert.ok(await fetchGmgnReport("MintC", 4000, t0 + 2000 + 10 * 60_000 + 1));
    assert.equal(calls.length, 3, "resumes once the pause has passed");
  } finally {
    globalThis.fetch = realFetch;
    CONFIG.gmgnMode = saved.mode;
    CONFIG.gmgnApiKey = saved.key;
    clearGmgnCache();
  }
});
