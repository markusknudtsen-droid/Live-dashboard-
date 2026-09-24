import test from "node:test";
import assert from "node:assert/strict";
import { devReputationBonus, DEFAULT_DEV_REPUTATION } from "../src/dev-reputation.js";
import { buildConfig } from "../src/config.js";

/**
 * The whole safety argument for depending on an unofficial API rests on one
 * property: no reachable failure may produce a bonus. These pin that, because
 * the failure mode that matters is not "the endpoint 404s" — that is obvious
 * and easy — it is "the payload changed shape and something coerced to a
 * passing value".
 */

test("a qualifying dev gets the bonus", () => {
  const r = devReputationBonus({ followers: 2500, migratedTokens: 4, username: "proven" });
  assert.equal(r.bonus, 15);
  assert.match(r.reason ?? "", /2500 followers, 4 migrated/);
});

test("both thresholds are required, not either", () => {
  assert.equal(devReputationBonus({ followers: 5000, migratedTokens: 2 }).bonus, 0, "followers alone is not enough");
  assert.equal(devReputationBonus({ followers: 100, migratedTokens: 9 }).bonus, 0, "migrations alone is not enough");
});

test("the boundary is inclusive, matching '2k followers and 3 migrated'", () => {
  assert.equal(devReputationBonus({ followers: 2000, migratedTokens: 3 }).bonus, 15);
  assert.equal(devReputationBonus({ followers: 1999, migratedTokens: 3 }).bonus, 0);
  assert.equal(devReputationBonus({ followers: 2000, migratedTokens: 2 }).bonus, 0);
});

test("a failed lookup (undefined) yields no bonus — the API-is-down case", () => {
  assert.equal(devReputationBonus(undefined).bonus, 0);
});

test("a changed payload cannot fake a qualifying dev", () => {
  // Every one of these is what a renamed/removed field looks like after
  // parsing. None may pass.
  const corrupted = [
    { followers: Number.NaN, migratedTokens: 5 },
    { followers: 5000, migratedTokens: Number.NaN },
    { followers: undefined as unknown as number, migratedTokens: 5 },
    { followers: 5000, migratedTokens: undefined as unknown as number },
    { followers: Number.POSITIVE_INFINITY, migratedTokens: Number.POSITIVE_INFINITY },
  ];
  for (const rep of corrupted) {
    assert.equal(devReputationBonus(rep).bonus, 0, `must not pass: ${JSON.stringify(rep)}`);
  }
});

test("thresholds are configurable without touching the fail-safe behaviour", () => {
  const strict = { minFollowers: 10_000, minMigratedTokens: 5, bonus: 25 };
  assert.equal(devReputationBonus({ followers: 2500, migratedTokens: 4 }, strict).bonus, 0);
  assert.equal(devReputationBonus({ followers: 12_000, migratedTokens: 6 }, strict).bonus, 25);
  assert.equal(devReputationBonus(undefined, strict).bonus, 0, "still no bonus when unknown");
});

test("defaults match the operator's spec: 2000 followers, 3 migrations, +15", () => {
  assert.equal(DEFAULT_DEV_REPUTATION.minFollowers, 2000);
  assert.equal(DEFAULT_DEV_REPUTATION.minMigratedTokens, 3);
  assert.equal(DEFAULT_DEV_REPUTATION.bonus, 15);
});

test("the feature is off unless explicitly enabled", () => {
  assert.equal(buildConfig({}).devReputationEnabled, false);
  assert.equal(buildConfig({ DEV_REPUTATION_ENABLED: "true" }).devReputationEnabled, true);
  assert.equal(buildConfig({}).devMinFollowers, 2000);
  assert.equal(buildConfig({ DEV_MIN_FOLLOWERS: "10000" }).devMinFollowers, 10_000);
});

test("a coin's creator is looked up once, and a rate-limited reputation lookup is retried within minutes", async () => {
  const { fetchCreatorWallet, fetchDevReputation, clearDevReputationCache } = await import("../src/dev-reputation.js");
  clearDevReputationCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let rateLimited = true;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls++;
    const u = String(url);
    if (u.includes("/coins/MINT1")) return new Response(JSON.stringify({ creator: "CREATOR1" }), { status: 200 });
    if (rateLimited) return new Response("{}", { status: 429 });
    if (u.includes("/users/")) return new Response(JSON.stringify({ followers: 5000 }), { status: 200 });
    return new Response(JSON.stringify([{ complete: true }, { complete: true }, { complete: true }]), { status: 200 });
  }) as typeof fetch;
  try {
    const t0 = 1_000_000;
    assert.equal(await fetchCreatorWallet("MINT1", 1000, t0), "CREATOR1");
    assert.equal(await fetchCreatorWallet("MINT1", 1000, t0 + 60 * 60_000), "CREATOR1");
    assert.equal(calls, 1, "a found creator is never fetched twice");

    assert.equal(await fetchDevReputation("CREATOR1", 1000, t0), undefined, "429 yields no bonus");
    rateLimited = false;
    assert.equal(await fetchDevReputation("CREATOR1", 1000, t0 + 60_000), undefined, "still inside the short miss window");
    const rep = await fetchDevReputation("CREATOR1", 1000, t0 + 3 * 60_000);
    assert.equal(rep?.followers, 5000, "retried after the miss window, not 30 minutes later");
    assert.equal(rep?.migratedTokens, 3);
  } finally {
    globalThis.fetch = realFetch;
    clearDevReputationCache();
  }
});
