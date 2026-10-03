import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  bondingCurveAddress,
  clearCreatorWalletCache,
  creatorFromBondingCurve,
  devReputationBonus,
  DEFAULT_DEV_REPUTATION,
  fetchCreatorWallet,
} from "../src/dev-reputation.js";
import { buildConfig } from "../src/config.js";

const SAMPLE_MINT = "5jFTmYkKjtBJBVunxZxrQGe2nkJcUCguZCm5aT9Wpump";
const SAMPLE_CREATOR = "9LkTK8hAYZyGcoTqvG25gD42YHYtPz8BhSuS1opXQ23";

/** A BondingCurve account as pump.fun lays it out (discriminator verified on mainnet 2026-10-03). */
function curveAccount(creatorBase58: string | null, length = 151): Buffer {
  const data = Buffer.alloc(length);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(data, 0);
  if (creatorBase58) new PublicKey(creatorBase58).toBuffer().copy(data, 49);
  return data;
}

async function withStubbedFetch<T>(
  respond: (url: string) => Response | Promise<Response>,
  body: (calls: () => number) => Promise<T>
): Promise<T> {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: unknown) => {
    n += 1;
    return respond(String(input));
  }) as typeof fetch;
  try {
    return await body(() => n);
  } finally {
    globalThis.fetch = real;
  }
}

const rpcReply = (data: Buffer | null) =>
  new Response(JSON.stringify({ result: { value: data ? { data: [data.toString("base64"), "base64"] } : null } }), {
    status: 200,
  });

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

test("the BondingCurve address for a real mint is pinned, and an invalid mint has none", () => {
  // Derived the same way as the account that was read live on 2026-10-03.
  assert.equal(bondingCurveAddress(SAMPLE_MINT), "ACWuqXpKr6GJEMq85UxUtwPPon8BknqYJAhYXkQkupU1");
  assert.equal(bondingCurveAddress("not-a-mint"), undefined);
});

test("creatorFromBondingCurve reads bytes 49-81 and rejects anything that is not a BondingCurve", () => {
  assert.equal(creatorFromBondingCurve(curveAccount(SAMPLE_CREATOR)), SAMPLE_CREATOR);
  assert.equal(creatorFromBondingCurve(curveAccount(SAMPLE_CREATOR, 125)), SAMPLE_CREATOR, "older, shorter accounts too");

  const wrongType = curveAccount(SAMPLE_CREATOR);
  wrongType[0] = 0;
  assert.equal(creatorFromBondingCurve(wrongType), undefined, "wrong discriminator");
  assert.equal(creatorFromBondingCurve(curveAccount(SAMPLE_CREATOR, 80)), undefined, "too short to hold a creator");
  assert.equal(creatorFromBondingCurve(curveAccount(null)), undefined, "all-zero creator is not a creator");
});

test("fetchCreatorWallet reads the creator from the RPC and caches the hit", async () => {
  clearCreatorWalletCache();
  await withStubbedFetch(
    () => rpcReply(curveAccount(SAMPLE_CREATOR)),
    async (calls) => {
      assert.equal(await fetchCreatorWallet(SAMPLE_MINT), SAMPLE_CREATOR);
      assert.equal(await fetchCreatorWallet(SAMPLE_MINT), SAMPLE_CREATOR);
      assert.equal(calls(), 1, "the creator never changes, so the second call must not hit the RPC");
    }
  );
});

test("fetchCreatorWallet: a non-pump mint, an RPC error or garbage yields no creator, and misses are retried later", async () => {
  clearCreatorWalletCache();
  const t0 = 1_000_000;
  await withStubbedFetch(
    () => rpcReply(null),
    async (calls) => {
      assert.equal(await fetchCreatorWallet(SAMPLE_MINT, 6000, t0), undefined, "no account means not a pump coin");
      assert.equal(await fetchCreatorWallet(SAMPLE_MINT, 6000, t0 + 60_000), undefined);
      assert.equal(calls(), 1, "a miss is cached for a few minutes");
      assert.equal(await fetchCreatorWallet(SAMPLE_MINT, 6000, t0 + 6 * 60_000), undefined);
      assert.equal(calls(), 2, "and retried after that");
    }
  );

  clearCreatorWalletCache();
  await withStubbedFetch(
    () => new Response("nope", { status: 429 }),
    async () => assert.equal(await fetchCreatorWallet(SAMPLE_MINT), undefined)
  );
  clearCreatorWalletCache();
  await withStubbedFetch(
    () => new Response("not json", { status: 200 }),
    async () => assert.equal(await fetchCreatorWallet(SAMPLE_MINT), undefined)
  );
  clearCreatorWalletCache();
  await withStubbedFetch(
    () => rpcReply(Buffer.alloc(200)),
    async () => assert.equal(await fetchCreatorWallet(SAMPLE_MINT), undefined, "an account of another type")
  );
  assert.equal(await fetchCreatorWallet("not-a-mint"), undefined);
});
