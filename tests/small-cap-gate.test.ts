import test from "node:test";
import assert from "node:assert/strict";
import { checkSmallCapGate, DEFAULT_SMALL_CAP_GATE } from "../src/small-cap-gate.js";
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
    hasHolderData: true,
    devHoldingPct: 3,
    insiderHoldingPct: 5,
    bundlerHoldingPct: 4,
    scoreNormalised: 20,
    scoreRaw: 1,
    rugged: false,
    dangerRisks: [],
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

/* --------------------------------- config -------------------------------- */

test("defaults match the operator's spec exactly", () => {
  const c = buildConfig({});
  assert.equal(c.minMarketCapUsd, 7000);
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
    SMALL_CAP_MIN_HOLDERS: "100",
    NEW_COIN_COOLDOWN_EXEMPT: "true",
  });
  assert.equal(c.minMarketCapUsd, 10_000);
  assert.equal(c.smallCapMinHolders, 100);
  assert.equal(c.newCoinCooldownExempt, true);
});

// --- Checks added 2026-09-16 after a run of rugged buys. Values in these
// tests are the real ones measured from api.rugcheck.xyz that day.

test("RugCheck's own rugged flag blocks the buy outright", () => {
  const r = checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ rugged: true }) });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /rugged/i);
});

test("a danger-level risk blocks the buy — this is the unsellable-rug signal", () => {
  // COOK carried exactly this and the position could not be exited.
  const r = checkSmallCapGate({
    ...baseInput,
    rugCheck: goodReport({ dangerRisks: ["Large Amount of LP Unlocked"] }),
  });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /Large Amount of LP Unlocked/);
});

test("danger risks can be turned off without disabling the rest of the gate", () => {
  const r = checkSmallCapGate(
    { ...baseInput, rugCheck: goodReport({ dangerRisks: ["Large Amount of LP Unlocked"] }) },
    { ...DEFAULT_SMALL_CAP_GATE, blockDangerRisks: false }
  );
  assert.equal(r.pass, true);
});

test("the raw score catches what the normalised score misses", () => {
  // PAIDLON: raw 10001 normalises to exactly 50, passing a "<=50" bar by zero
  // margin. The raw bar is what actually rejects it.
  const paidlon = goodReport({ scoreRaw: 10001, scoreNormalised: 50 });
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: paidlon }).pass, false);
  // A genuinely clean token (measured raw 1) still passes.
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ scoreRaw: 1 }) }).pass, true);
});

test("raw-score boundary is inclusive", () => {
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ scoreRaw: 5000 }) }).pass, true);
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ scoreRaw: 5001 }) }).pass, false);
});

test("unindexed holder data does not reject a fresh coin", () => {
  // A brand-new mint reports totalHolders: 0 with an empty topHolders[].
  // Treating that as "0 holders" would block every new launch — the exact
  // segment this bot is being pointed at.
  const fresh = goodReport({ totalHolders: 0, hasHolderData: false, devHoldingPct: 0, insiderHoldingPct: 0 });
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: fresh }).pass, true);
});

test("but a coin WITH holder data is still held to the distribution limits", () => {
  const concentrated = goodReport({ totalHolders: 120, hasHolderData: true, devHoldingPct: 40 });
  const r = checkSmallCapGate({ ...baseInput, rugCheck: concentrated });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /dev holds/);
});

test("an unindexed coin is still screened on authorities and rugged flag", () => {
  const fresh = { totalHolders: 0, hasHolderData: false } as Partial<RugCheckReport>;
  assert.equal(
    checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ ...fresh, mintAuthorityDisabled: false }) }).pass,
    false
  );
  assert.equal(checkSmallCapGate({ ...baseInput, rugCheck: goodReport({ ...fresh, rugged: true }) }).pass, false);
});
