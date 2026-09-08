import test from "node:test";
import assert from "node:assert/strict";
import { checkSmallCapGate, isSmallCap, DEFAULT_SMALL_CAP_GATE } from "../src/small-cap-gate.js";
import { buildConfig } from "../src/config.js";
import type { RugCheckReport } from "../src/rugcheck.js";

// Real report shape verified live against CTALnV64...ppump (TRONK) on
// 2026-09-08: mintAuthority/freezeAuthority null (disabled), totalHolders 854,
// score_normalised 30.
function goodReport(over: Partial<RugCheckReport> = {}): RugCheckReport {
  return {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    totalHolders: 200,
    devHoldingPct: 3,
    insiderHoldingPct: 5,
    bundlerHoldingPct: 4,
    scoreNormalised: 20,
    ...over,
  };
}

const baseInput = {
  marketCapUsd: 20_000,
  liquidityUsd: 9000,
  volume24h: 5000,
  hasAnySocial: true,
  rugCheck: goodReport(),
};

test("isSmallCap gates purely on market cap, below the threshold only", () => {
  assert.equal(isSmallCap(39_999), true);
  assert.equal(isSmallCap(40_000), false, "the threshold itself belongs to the normal path");
  assert.equal(isSmallCap(100), true);
});

test("a coin clearing every bar passes", () => {
  assert.equal(checkSmallCapGate(baseInput).pass, true);
});

test("the $5,000 liquidity floor is enforced on new coins too, same as everywhere else", () => {
  const r = checkSmallCapGate({ ...baseInput, liquidityUsd: 4999 });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /liquidity/);
});

test("volume floor: $1,000 minimum 24h volume", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, volume24h: 999 }).pass, false);
  assert.equal(checkSmallCapGate({ ...baseInput, volume24h: 1000 }).pass, true);
});

test("at least one social or website is required", () => {
  const r = checkSmallCapGate({ ...baseInput, hasAnySocial: false });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /social/);
});

test("mint authority must be disabled", () => {
  const r = checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ mintAuthorityDisabled: false }) });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /mint authority/);
});

test("freeze authority must be disabled", () => {
  const r = checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ freezeAuthorityDisabled: false }) });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /freeze authority/);
});

test("holder floor: 60 minimum, boundary inclusive", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ totalHolders: 59 }) }).pass, false);
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ totalHolders: 60 }) }).pass, true);
});

test("dev holding ceiling: 8% maximum, boundary inclusive", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ devHoldingPct: 8 }) }).pass, true);
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ devHoldingPct: 8.1 }) }).pass, false);
});

test("insider holding ceiling: 22% maximum", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ insiderHoldingPct: 22 }) }).pass, true);
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ insiderHoldingPct: 22.1 }) }).pass, false);
});

test("bundler holding ceiling: 22% maximum", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ bundlerHoldingPct: 22 }) }).pass, true);
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ bundlerHoldingPct: 22.1 }) }).pass, false);
});

test("RugCheck's own risk score must read as 'Good' (default: <= 50)", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ scoreNormalised: 50 }) }).pass, true);
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ scoreNormalised: 51 }) }).pass, false);
});

test("missing RugCheck data fails closed by default", () => {
  const r = checkSmallCapGate({ ...baseInput, rugCheck: undefined });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /unavailable/);
});

test("missing RugCheck data can be opted to pass instead, explicitly", () => {
  const lenient = { ...DEFAULT_SMALL_CAP_GATE, requireRugCheckData: false };
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: undefined }, lenient).pass, true);
});

/* --------------------------------- config -------------------------------- */

test("defaults match the operator's spec exactly", () => {
  const c = buildConfig({});
  assert.equal(c.minMarketCapUsd, 7000);
  assert.equal(c.smallCapMaxMarketCapUsd, 40_000);
  assert.equal(c.smallCapMinHolders, 60);
  assert.equal(c.smallCapMaxDevHoldingPct, 8);
  assert.equal(c.smallCapMaxInsiderHoldingPct, 22);
  assert.equal(c.smallCapMaxBundlerHoldingPct, 22);
  assert.equal(c.smallCapMinVolume24h, 1000);
  assert.equal(c.newCoinCooldownExempt, false, "off by default, like every other new gate this session");
});

test("every threshold is independently configurable", () => {
  const c = buildConfig({
    MIN_MARKET_CAP_USD: "10000",
    SMALL_CAP_MAX_MARKET_CAP_USD: "50000",
    SMALL_CAP_MIN_HOLDERS: "100",
    NEW_COIN_COOLDOWN_EXEMPT: "true",
  });
  assert.equal(c.minMarketCapUsd, 10_000);
  assert.equal(c.smallCapMaxMarketCapUsd, 50_000);
  assert.equal(c.smallCapMinHolders, 100);
  assert.equal(c.newCoinCooldownExempt, true);
});
