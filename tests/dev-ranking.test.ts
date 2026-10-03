import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlSampler,
  buildRanking,
  classifyLaunch,
  dueHorizons,
  getDevRankingStats,
  noteDevLaunch,
  parseRankingFile,
  pendingFromLines,
  pruneCreatorCache,
  rankCreators,
  resolveOpening,
  selectSeedCreators,
  summariseCreator,
  summariseOutcomes,
  wilsonLowerBound,
  type CreatorStats,
  type PendingLaunch,
  type RankingCriteria,
} from "../src/dev-ranking.js";
import { snapshotFromDexPairs, toPumpCoinRecord, type PumpCoinRecord } from "../src/dev-reputation.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const CRITERIA: RankingCriteria = { topN: 10, minLaunches: 5, minMigrated: 3, maxIdleDays: 30 };

const coin = (creator: string, complete: boolean, over: Partial<PumpCoinRecord> = {}): PumpCoinRecord => ({
  mint: `${creator}-${Math.random().toString(36).slice(2)}`,
  creator,
  complete,
  usdMarketCap: complete ? 70_000 : 4_000,
  createdAt: NOW - DAY,
  ...over,
});

const stats = (wallet: string, launches: number, migrated: number, lastLaunchAt: number | null = NOW - DAY): CreatorStats => ({
  wallet,
  launches,
  migrated,
  rate: migrated / launches,
  score: wilsonLowerBound(migrated, launches),
  lastLaunchAt,
  bestMarketCapUsd: 100_000,
});

test("wilsonLowerBound: no data is 0, small perfect samples are discounted, big samples approach the rate", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(Math.abs(wilsonLowerBound(10, 10) - 0.787) < 0.005);
  assert.ok(wilsonLowerBound(4, 4) < wilsonLowerBound(40, 50), "4/4 must not beat 40/50");
  assert.ok(wilsonLowerBound(400, 500) > 0.76 && wilsonLowerBound(400, 500) < 0.8);
});

test("toPumpCoinRecord reads defensively: missing cap is null (not 0), missing creator is rejected", () => {
  const ok = toPumpCoinRecord({ mint: "M", creator: "C", complete: true, usd_market_cap: 1234.5, created_timestamp: 1790980937000, extra: 1 });
  assert.deepEqual(ok, { mint: "M", creator: "C", complete: true, usdMarketCap: 1234.5, createdAt: 1790980937000 });
  const noCap = toPumpCoinRecord({ mint: "M", creator: "C", usd_market_cap: null });
  assert.equal(noCap?.usdMarketCap, null);
  assert.equal(noCap?.complete, false);
  assert.equal(toPumpCoinRecord({ mint: "M" }), undefined);
  assert.equal(toPumpCoinRecord(null), undefined);
  assert.equal(toPumpCoinRecord("x"), undefined);
});

test("snapshotFromDexPairs reads a bonding-curve coin: market cap present, not graduated", () => {
  // Shape captured live from DexScreener: dexId pumpfun, marketCap set, no liquidity.
  const snap = snapshotFromDexPairs([{ dexId: "pumpfun", marketCap: 4416.62, fdv: 4416.62 }]);
  assert.deepEqual(snap, { usdMarketCap: 4416.62, complete: false });
});

test("snapshotFromDexPairs marks a coin with a real pool as graduated and prefers the deepest pair", () => {
  const snap = snapshotFromDexPairs([
    { dexId: "pumpfun", marketCap: 60000, liquidity: { usd: 0 } },
    { dexId: "pumpswap", marketCap: 72000, liquidity: { usd: 18000 } },
  ]);
  assert.deepEqual(snap, { usdMarketCap: 72000, complete: true });
});

test("snapshotFromDexPairs falls back to fdv and returns undefined for anything unreadable", () => {
  assert.equal(snapshotFromDexPairs([{ dexId: "pumpfun", fdv: 5000 }])?.usdMarketCap, 5000);
  assert.equal(snapshotFromDexPairs([{ dexId: "pumpfun" }])?.usdMarketCap, null);
  assert.equal(snapshotFromDexPairs([]), undefined);
  assert.equal(snapshotFromDexPairs(null), undefined);
  assert.equal(snapshotFromDexPairs({ statusCode: 404 }), undefined);
});

test("resolveOpening keeps trying until the coin is listed, then gives up after 3 minutes", () => {
  assert.equal(resolveOpening(2500, 20_000), 2500);
  assert.equal(resolveOpening(null, 20_000), undefined);
  assert.equal(resolveOpening(null, 179_000), undefined);
  assert.equal(resolveOpening(null, 180_000), null);
  assert.equal(resolveOpening(900, 200_000), 900, "a late success still counts");
});

test("summariseCreator counts only the creator's own coins", () => {
  const coins = [coin("A", true), coin("A", false), coin("A", true, { createdAt: NOW - 3 * DAY }), coin("B", true)];
  const s = summariseCreator("A", coins);
  assert.equal(s?.launches, 3);
  assert.equal(s?.migrated, 2);
  assert.equal(s?.lastLaunchAt, NOW - DAY);
  assert.equal(s?.bestMarketCapUsd, 70_000);
  assert.equal(summariseCreator("Z", coins), undefined);
});

test("rankCreators applies the bars, drops idle creators and orders by score", () => {
  const list = [
    stats("steady", 50, 20),
    stats("lucky", 5, 5),
    stats("few-wins", 30, 2),
    stats("too-few-launches", 4, 4),
    stats("idle", 60, 40, NOW - 40 * DAY),
    stats("unknown-activity", 60, 40, null),
    stats("big", 100, 60),
  ];
  const ranked = rankCreators(list, CRITERIA, NOW).map((s) => s.wallet);
  // Order is by the Wilson score (5/5 ~0.65, 60/100 ~0.52, 20/50 ~0.29), not by raw count or raw rate.
  assert.deepEqual(ranked, ["lucky", "big", "steady"]);
  assert.ok(!ranked.includes("idle") && !ranked.includes("unknown-activity"));
});

test("rankCreators keeps only topN", () => {
  const list = Array.from({ length: 15 }, (_, i) => stats(`w${i}`, 20, 5 + i));
  const ranked = rankCreators(list, { ...CRITERIA, topN: 10 }, NOW);
  assert.equal(ranked.length, 10);
  assert.equal(ranked[0].wallet, "w14");
});

test("selectSeedCreators orders by frequency, ties by first seen, and caps", () => {
  const coins = ["a", "b", "c", "b", "d", "c", "b"].map((c) => coin(c, true));
  assert.deepEqual(selectSeedCreators(coins, 10), ["b", "c", "a", "d"]);
  assert.deepEqual(selectSeedCreators(coins, 2), ["b", "c"]);
});

const OPTS = { criteria: CRITERIA, seedPages: 2, maxLookups: 10, gapMs: 100, maxBackoffMs: 1000, maxConsecutiveFailures: 3, now: NOW };

test("buildRanking seeds from graduated coins, looks each creator up, spaces requests and ranks", async () => {
  const sleeps: number[] = [];
  const queries: string[] = [];
  const history: Record<string, PumpCoinRecord[]> = {
    GOOD: Array.from({ length: 10 }, (_, i) => coin("GOOD", i < 6)),
    BAD: Array.from({ length: 10 }, () => coin("BAD", false)),
  };
  const result = await buildRanking(
    {
      fetchList: async (q) => {
        queries.push(q);
        if (q.startsWith("complete=true")) return [coin("GOOD", true), coin("BAD", true), coin("GOOD", true)];
        const wallet = /creator=([^&]+)/.exec(q)?.[1] ?? "";
        return history[wallet];
      },
      sleep: async (ms) => void sleeps.push(ms),
    },
    OPTS
  );
  assert.equal(result.aborted, false);
  assert.equal(result.seeded, 2);
  assert.equal(result.looked, 2);
  assert.deepEqual(result.ranking.devs.map((d) => d.wallet), ["GOOD"]);
  assert.equal(result.ranking.partial, undefined);
  assert.equal(result.ranking.builtAt, NOW);
  assert.equal(result.all.length, 2, "both creators are kept for the next run, ranked or not");
  assert.equal(result.all[0].checkedAt, NOW);
  assert.ok(queries[0].includes("offset=0") && queries[1].includes("offset=50"));
  assert.ok(sleeps.length === queries.length && sleeps.every((ms) => ms === 100), "one gap after every request");
});

test("buildRanking retries a refused request with a growing wait, then moves on", async () => {
  const sleeps: number[] = [];
  const queries: string[] = [];
  let refusals = 2;
  const result = await buildRanking(
    {
      fetchList: async (q) => {
        queries.push(q);
        if (q.startsWith("complete=true")) return [coin("A", true)];
        if (refusals-- > 0) return undefined;
        return Array.from({ length: 10 }, (_, i) => coin("A", i < 5));
      },
      sleep: async (ms) => void sleeps.push(ms),
    },
    { ...OPTS, seedPages: 1, maxConsecutiveFailures: 5 }
  );
  assert.equal(result.aborted, false);
  assert.deepEqual(result.ranking.devs.map((d) => d.wallet), ["A"]);
  const creatorQueries = queries.filter((q) => q.startsWith("creator="));
  assert.equal(creatorQueries.length, 3, "the same creator is retried, not skipped");
  assert.equal(new Set(creatorQueries).size, 1);
  assert.deepEqual(sleeps.slice(1), [200, 400, 100], "backoff doubles, then the normal gap after success");
});

test("buildRanking caps the backoff", async () => {
  const sleeps: number[] = [];
  await buildRanking(
    { fetchList: async () => undefined, sleep: async (ms) => void sleeps.push(ms) },
    { ...OPTS, maxConsecutiveFailures: 6, maxBackoffMs: 500 }
  );
  assert.deepEqual(sleeps, [200, 400, 500, 500, 500]);
});

test("buildRanking aborts after a run of refusals and still ranks what it already knew", async () => {
  let calls = 0;
  const known = [{ ...stats("KNOWN", 20, 10), checkedAt: NOW - 1000 }];
  const result = await buildRanking(
    {
      fetchList: async () => {
        calls += 1;
        return undefined;
      },
      sleep: async () => undefined,
    },
    { ...OPTS, known, knownMaxAgeMs: DAY }
  );
  assert.equal(result.aborted, true);
  assert.equal(calls, 3);
  assert.equal(result.looked, 0);
  assert.deepEqual(result.ranking.devs.map((d) => d.wallet), ["KNOWN"]);
  assert.equal(result.ranking.partial, true);
});

test("buildRanking does not fetch creators it already has fresh records for", async () => {
  const queries: string[] = [];
  const known = [{ ...stats("OLD", 20, 10), checkedAt: NOW - 1000 }, { ...stats("STALE", 20, 10), checkedAt: NOW - 3 * DAY }];
  const result = await buildRanking(
    {
      fetchList: async (q) => {
        queries.push(q);
        if (q.startsWith("complete=true")) return [coin("OLD", true), coin("STALE", true), coin("NEW", true)];
        const wallet = /creator=([^&]+)/.exec(q)?.[1] ?? "";
        return Array.from({ length: 10 }, (_, i) => coin(wallet, i < 8));
      },
      sleep: async () => undefined,
    },
    { ...OPTS, seedPages: 1, known, knownMaxAgeMs: DAY }
  );
  const looked = queries.filter((q) => q.startsWith("creator=")).map((q) => /creator=([^&]+)/.exec(q)?.[1]);
  assert.deepEqual(looked.sort(), ["NEW", "STALE"], "fresh OLD is skipped, STALE and NEW are fetched");
  assert.equal(result.looked, 2);
  assert.equal(result.all.length, 3);
});

test("buildRanking checkpoints every 10 new lookups with everything known so far", async () => {
  const checkpoints: number[] = [];
  await buildRanking(
    {
      fetchList: async (q) => {
        if (q.startsWith("complete=true")) return Array.from({ length: 25 }, (_, i) => coin(`W${i}`, true));
        const wallet = /creator=([^&]+)/.exec(q)?.[1] ?? "";
        return Array.from({ length: 6 }, (_, i) => coin(wallet, i < 3));
      },
      sleep: async () => undefined,
    },
    {
      ...OPTS,
      criteria: { ...CRITERIA, topN: 100 },
      seedPages: 1,
      maxLookups: 25,
      onCheckpoint: (all) => void checkpoints.push(all.length),
    }
  );
  assert.deepEqual(checkpoints, [10, 20]);
});

test("buildRanking stops looking up creators once topN of them qualify", async () => {
  let lookups = 0;
  const result = await buildRanking(
    {
      fetchList: async (q) => {
        if (q.startsWith("complete=true")) return Array.from({ length: 25 }, (_, i) => coin(`W${i}`, true));
        lookups += 1;
        const wallet = /creator=([^&]+)/.exec(q)?.[1] ?? "";
        return Array.from({ length: 6 }, (_, i) => coin(wallet, i < 3));
      },
      sleep: async () => undefined,
    },
    { ...OPTS, criteria: { ...CRITERIA, topN: 4 }, seedPages: 1, maxLookups: 25 }
  );
  assert.equal(lookups, 4);
  assert.equal(result.ranking.devs.length, 4);
});

test("pruneCreatorCache drops records older than 14 days but keeps undated ones", () => {
  const list = [
    { ...stats("fresh", 10, 5), checkedAt: NOW - DAY },
    { ...stats("old", 10, 5), checkedAt: NOW - 15 * DAY },
    stats("undated", 10, 5),
  ];
  assert.deepEqual(pruneCreatorCache(list, NOW).map((s) => s.wallet), ["fresh", "undated"]);
});
test("parseRankingFile accepts what we write and rejects anything else", () => {
  const file = { version: 1, builtAt: NOW, devs: [stats("A", 10, 5)] };
  assert.equal(parseRankingFile(JSON.stringify(file))?.devs[0].wallet, "A");
  assert.equal(parseRankingFile("not json"), undefined);
  assert.equal(parseRankingFile(JSON.stringify({ ...file, partial: true }))?.partial, true);
  assert.equal(parseRankingFile(JSON.stringify(file))?.partial, undefined);
  assert.equal(parseRankingFile(JSON.stringify({ ...file, partial: true }))?.partial, true);
  assert.equal(parseRankingFile(JSON.stringify(file))?.partial, undefined);
  assert.equal(parseRankingFile(JSON.stringify({ ...file, version: 2 })), undefined);
  assert.equal(parseRankingFile(JSON.stringify({ version: 1, builtAt: NOW })), undefined);
  const mixed = parseRankingFile(JSON.stringify({ ...file, devs: [stats("A", 10, 5), { wallet: 5 }, null, {}] }));
  assert.equal(mixed?.devs.length, 1);
});

test("ControlSampler lets one launch through per interval and none when off", () => {
  const s = new ControlSampler(60_000);
  assert.equal(s.take(NOW), true);
  assert.equal(s.take(NOW + 59_999), false);
  assert.equal(s.take(NOW + 60_000), true);
  const off = new ControlSampler(0);
  assert.equal(off.take(NOW), false);
});

test("classifyLaunch: top creator always alerts, others only via the sampler", () => {
  const top = new Map([["TOP", { rank: 3, dev: stats("TOP", 20, 10) }]]);
  const sampler = new ControlSampler(60_000);
  const a = classifyLaunch("TOP", top, sampler, NOW);
  assert.equal(a?.kind, "top");
  assert.equal(a?.kind === "top" ? a.entry.rank : -1, 3);
  assert.equal(classifyLaunch("rando", top, sampler, NOW)?.kind, "control");
  assert.equal(classifyLaunch("rando2", top, sampler, NOW + 1000), null);
  assert.equal(classifyLaunch("TOP", top, sampler, NOW + 1000)?.kind, "top");
});

test("dueHorizons returns only elapsed, unrecorded horizons", () => {
  const check: PendingLaunch = { mint: "M", kind: "top", t0: NOW, cap0: 5000, done: [1] };
  assert.deepEqual(dueHorizons(check, NOW + 6 * 60_000), [5]);
  assert.deepEqual(dueHorizons(check, NOW + 61 * 60_000), [5, 15, 60]);
  assert.deepEqual(dueHorizons(check, NOW), []);
});

test("pendingFromLines resumes unfinished launches with their opening cap and finished horizons", () => {
  const lines = [
    JSON.stringify({ type: "launch", detectedAt: NOW - 10 * 60_000, kind: "top", mint: "A" }),
    JSON.stringify({ type: "open", mint: "A", capUsd: 4200 }),
    JSON.stringify({ type: "outcome", mint: "A", h: 1 }),
    JSON.stringify({ type: "outcome", mint: "A", h: 5 }),
    JSON.stringify({ type: "launch", detectedAt: NOW - 90 * 60_000, kind: "control", mint: "OLD" }),
    JSON.stringify({ type: "launch", detectedAt: NOW - 2 * 60_000, kind: "control", mint: "NEW" }),
    "garbage",
  ];
  const resumed = pendingFromLines(lines, NOW);
  assert.deepEqual(resumed.map((p) => p.mint).sort(), ["A", "NEW"]);
  const a = resumed.find((p) => p.mint === "A");
  assert.equal(a?.cap0, 4200);
  assert.deepEqual(a?.done, [1, 5]);
  assert.equal(resumed.find((p) => p.mint === "NEW")?.cap0, undefined);
});

test("summariseOutcomes separates top from control and counts unreadable readings", () => {
  const o = (kind: string, h: number, capUsd: number | null, complete: boolean | null, ret: number | null): string =>
    JSON.stringify({ type: "outcome", kind, h, capUsd, complete, ret });
  const lines = [
    o("top", 15, 20000, true, 300),
    o("top", 15, 8000, false, 60),
    o("top", 15, null, null, null),
    o("control", 15, 3000, false, -30),
    o("control", 15, 4000, false, 5),
    "bad line",
    JSON.stringify({ type: "launch", kind: "top" }),
  ];
  const [top, control] = summariseOutcomes(lines);
  assert.equal(top.kind, "top");
  assert.equal(top.launches, 3);
  assert.equal(top.readable, 2);
  assert.equal(top.medianReturnPct, 180);
  assert.equal(top.graduatedPct, 50);
  assert.equal(top.doubledPct, 50);
  assert.equal(control.kind, "control");
  assert.equal(control.launches, 2);
  assert.equal(control.doubledPct, 0);
});

test("noteDevLaunch does nothing while DEV_RANKING_ENABLED is off", () => {
  const before = getDevRankingStats().pending;
  noteDevLaunch({ mint: "M", symbol: "S", creator: "C", detectedAt: Date.now() });
  assert.equal(getDevRankingStats().pending, before);
});
