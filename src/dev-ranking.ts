/**
 * Profitable-launch ranking of pump.fun creators, with SHADOW alerts.
 *
 * "Profitable" here means a launch that graduated (pump.fun's `complete` flag:
 * the bonding curve filled and the coin migrated). Creators are ranked by the
 * Wilson lower bound of their graduation rate, so 4/4 does not outrank 40/60
 * on luck alone, and a creator who stopped launching drops out.
 *
 * The ranking is rebuilt in the background from pump.fun's UNOFFICIAL API
 * (it 429s quickly, so every request is spaced out and a failed rebuild keeps
 * the previous file). The hot path never calls the API: when the on-chain feed
 * sees a launch, the creator is one Map lookup against the saved top list.
 *
 * Nothing here trades. A launch by a top creator is logged and written to a
 * JSONL file with market cap at +1/+5/+15/+60 min, next to a sampled baseline
 * of ordinary launches, so a report can show whether top creators really beat
 * the average before anyone wires a buy to it. A reading that cannot be taken
 * is stored as null, never dropped.
 *
 * Every failure is swallowed: this must never touch trading.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { fetchPumpCoinList, fetchPumpCoinSnapshot, type PumpCoinRecord } from "./dev-reputation.js";
import { logger } from "./logger.js";

export const ALERT_HORIZONS_MIN = [1, 5, 15, 60];
const DAY_MS = 86_400_000;
/** Wait before the first market-cap read; it is retried until DexScreener lists the coin. */
const OPEN_DELAY_MS = 15_000;

export interface CreatorStats {
  wallet: string;
  /** Launches among the creator's newest 100 (the API page size). */
  launches: number;
  migrated: number;
  rate: number;
  /** Wilson lower bound of the graduation rate: the ranking key. */
  score: number;
  lastLaunchAt: number | null;
  /** Highest CURRENT market cap among the creator's coins (not an all-time high). */
  bestMarketCapUsd: number | null;
  /** When this record was fetched; lets a later run skip creators it already has. */
  checkedAt?: number;
}

export interface RankingCriteria {
  topN: number;
  minLaunches: number;
  minMigrated: number;
  maxIdleDays: number;
}

export interface RankingFile {
  version: 1;
  builtAt: number;
  devs: CreatorStats[];
  /** True when the build was cut short by rate limiting; a retry is due soon. */
  partial?: boolean;
}

/** Lower bound of the Wilson score interval (z = 1.645, ~90% one-sided). */
export function wilsonLowerBound(successes: number, total: number, z = 1.645): number {
  if (!(total > 0)) return 0;
  const p = Math.min(1, Math.max(0, successes / total));
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

/** Pure: one creator's record from their coin list. Undefined when they have none. */
export function summariseCreator(wallet: string, coins: PumpCoinRecord[], checkedAt?: number): CreatorStats | undefined {
  const own = coins.filter((c) => c.creator === wallet);
  if (own.length === 0) return undefined;
  const migrated = own.filter((c) => c.complete).length;
  const created = own.map((c) => c.createdAt).filter((t): t is number => t !== null);
  const caps = own.map((c) => c.usdMarketCap).filter((v): v is number => v !== null);
  return {
    wallet,
    launches: own.length,
    migrated,
    rate: migrated / own.length,
    score: wilsonLowerBound(migrated, own.length),
    lastLaunchAt: created.length ? Math.max(...created) : null,
    bestMarketCapUsd: caps.length ? Math.max(...caps) : null,
    ...(checkedAt !== undefined ? { checkedAt } : {}),
  };
}

/**
 * Pure: the creators that qualify, best first. A creator whose last launch
 * time is unknown cannot be shown to be active, so is left out.
 */
export function rankCreators(stats: CreatorStats[], criteria: RankingCriteria, now = Date.now()): CreatorStats[] {
  return stats
    .filter(
      (s) =>
        s.launches >= criteria.minLaunches &&
        s.migrated >= criteria.minMigrated &&
        s.lastLaunchAt !== null &&
        now - s.lastLaunchAt <= criteria.maxIdleDays * DAY_MS
    )
    .sort((a, b) => b.score - a.score || b.migrated - a.migrated)
    .slice(0, criteria.topN);
}

/** Pure: creators of the seed coins, most frequent first, at most `max`. */
export function selectSeedCreators(coins: PumpCoinRecord[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const c of coins) counts.set(c.creator, (counts.get(c.creator) ?? 0) + 1);
  // Array.sort is stable, so equal counts keep first-seen (newest graduate) order.
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([wallet]) => wallet);
}

export interface BuildDeps {
  fetchList: (query: string) => Promise<PumpCoinRecord[] | undefined>;
  sleep: (ms: number) => Promise<void>;
}

export interface BuildOptions {
  criteria: RankingCriteria;
  seedPages: number;
  /** Most NEW creators looked up per run; ones already in `known` do not count. */
  maxLookups: number;
  gapMs: number;
  /** A refused request is retried with a growing wait, up to this cap. */
  maxBackoffMs: number;
  /** Give up the run after this many refusals in a row. */
  maxConsecutiveFailures: number;
  /** Records from earlier runs; creators checked within knownMaxAgeMs are not fetched again. */
  known?: CreatorStats[];
  knownMaxAgeMs?: number;
  now?: number;
  onProgress?: (message: string) => void;
  /** Called every few new lookups with everything known so far, so a crash loses little. */
  onCheckpoint?: (all: CreatorStats[]) => Promise<void> | void;
}

export interface BuildResult {
  ranking: RankingFile;
  /** Every creator record held after the run (earlier runs plus this one). */
  all: CreatorStats[];
  seeded: number;
  looked: number;
  /** True when the API kept refusing and the run gave up; the ranking is then built from what was gathered. */
  aborted: boolean;
}

/**
 * Seed from recently graduated coins (their creators are the ones currently
 * producing winners), then look up each new creator's own history. Requests
 * are sequential and spaced by gapMs. A 429 says nothing about the data, so the
 * same request is retried after a growing wait; only a long run of refusals
 * aborts, and whatever was gathered still counts.
 */
export async function buildRanking(deps: BuildDeps, options: BuildOptions): Promise<BuildResult> {
  const now = options.now ?? Date.now();
  const knownMaxAgeMs = options.knownMaxAgeMs ?? 0;
  const merged = new Map<string, CreatorStats>((options.known ?? []).map((s) => [s.wallet, s]));
  let failures = 0;
  let aborted = false;

  const request = async (query: string): Promise<PumpCoinRecord[] | undefined> => {
    while (!aborted) {
      const result = await deps.fetchList(query);
      if (result !== undefined) {
        failures = 0;
        await deps.sleep(options.gapMs);
        return result;
      }
      failures += 1;
      if (failures >= options.maxConsecutiveFailures) {
        aborted = true;
        return undefined;
      }
      await deps.sleep(Math.min(options.gapMs * 2 ** failures, options.maxBackoffMs));
    }
    return undefined;
  };

  const seedCoins: PumpCoinRecord[] = [];
  for (let page = 0; page < options.seedPages && !aborted; page++) {
    const coins = await request(`complete=true&sort=created_timestamp&order=DESC&limit=50&offset=${page * 50}`);
    if (coins) seedCoins.push(...coins);
    options.onProgress?.(`seed page ${page + 1}/${options.seedPages}: ${seedCoins.length} graduated coins`);
  }

  const alreadyFresh = (wallet: string): boolean => {
    const checkedAt = merged.get(wallet)?.checkedAt;
    return checkedAt !== undefined && now - checkedAt < knownMaxAgeMs;
  };
  const wallets = selectSeedCreators(seedCoins, Number.MAX_SAFE_INTEGER)
    .filter((w) => !alreadyFresh(w))
    .slice(0, options.maxLookups);

  let looked = 0;
  for (const wallet of wallets) {
    if (aborted) break;
    const coins = await request(`creator=${encodeURIComponent(wallet)}&limit=100`);
    if (!coins) break;
    looked += 1;
    const summary = summariseCreator(wallet, coins, now);
    if (summary) merged.set(wallet, summary);
    if (looked % 10 === 0) {
      options.onProgress?.(`looked up ${looked}/${wallets.length} new creators`);
      await options.onCheckpoint?.([...merged.values()]);
    }
  }

  const all = [...merged.values()];
  return {
    ranking: { version: 1, builtAt: now, devs: rankCreators(all, options.criteria, now), ...(aborted ? { partial: true } : {}) },
    all,
    seeded: wallets.length,
    looked,
    aborted,
  };
}

export function criteriaFromConfig(): RankingCriteria {
  return {
    topN: CONFIG.devRankingTopN,
    minLaunches: CONFIG.devRankingMinLaunches,
    minMigrated: CONFIG.devRankingMinMigrated,
    maxIdleDays: CONFIG.devRankingMaxIdleDays,
  };
}

/** Pure: a saved ranking file, or undefined if it is not exactly the shape we write. */
export function parseRankingFile(text: string): RankingFile | undefined {
  try {
    const raw = JSON.parse(text) as Partial<RankingFile>;
    if (raw?.version !== 1 || typeof raw.builtAt !== "number" || !Array.isArray(raw.devs)) return undefined;
    const devs = raw.devs.filter(
      (d): d is CreatorStats =>
        typeof d?.wallet === "string" &&
        d.wallet.length > 0 &&
        Number.isFinite(d.launches) &&
        Number.isFinite(d.migrated) &&
        Number.isFinite(d.score)
    );
    return { version: 1, builtAt: raw.builtAt, devs, ...(raw.partial === true ? { partial: true } : {}) };
  } catch {
    return undefined;
  }
}

const dataDir = (): string => path.dirname(CONFIG.stateFilePath);
export const rankingFilePath = (): string => path.join(dataDir(), "top-devs.json");
/** Every creator record gathered so far; lets an interrupted or rate-limited build resume. */
export const creatorCachePath = (): string => path.join(dataDir(), "dev-creator-cache.json");
export const alertsFilePath = (): string => path.join(dataDir(), "shadow-dev-launches.jsonl");

const CACHE_MAX_AGE_DAYS = 14;

async function readJsonFile(file: string): Promise<RankingFile | undefined> {
  try {
    return parseRankingFile(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Write via a temp file so a crash never leaves a half-written file. */
async function writeJsonFile(file: string, data: RankingFile): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, file);
}

export const loadRankingFile = (): Promise<RankingFile | undefined> => readJsonFile(rankingFilePath());
export const saveRankingFile = (ranking: RankingFile): Promise<void> => writeJsonFile(rankingFilePath(), ranking);

/** Pure: cache entries young enough to trust, so dead creators fall out over time. */
export function pruneCreatorCache(all: CreatorStats[], now: number): CreatorStats[] {
  return all.filter((s) => s.checkedAt === undefined || now - s.checkedAt <= CACHE_MAX_AGE_DAYS * DAY_MS);
}

/** The default settings: one request per 2.5 s, refusals retried with up to 90 s waits, 8 in a row aborts the run. */
export function realBuildDeps(): BuildDeps {
  return {
    fetchList: (query) => fetchPumpCoinList(query),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function defaultBuildOptions(onProgress?: (message: string) => void): BuildOptions {
  return {
    criteria: criteriaFromConfig(),
    seedPages: 8,
    maxLookups: 150,
    gapMs: 2500,
    maxBackoffMs: 90_000,
    maxConsecutiveFailures: 8,
    knownMaxAgeMs: CONFIG.devRankingRefreshHours * 3_600_000,
    onProgress,
  };
}

/**
 * One full refresh: load the cache, build, save the cache and the ranking.
 * A rate-limited run still saves what it gathered (flagged partial), unless it
 * gathered nothing at all, in which case the existing files are left alone.
 */
export async function runRankingRefresh(
  onProgress?: (message: string) => void,
  deps: BuildDeps = realBuildDeps()
): Promise<BuildResult> {
  const now = Date.now();
  const cache = await readJsonFile(creatorCachePath());
  const known = pruneCreatorCache(cache?.devs ?? [], now);
  const saveCache = (all: CreatorStats[]): Promise<void> =>
    writeJsonFile(creatorCachePath(), { version: 1, builtAt: Date.now(), devs: all });

  const result = await buildRanking(deps, {
    ...defaultBuildOptions(onProgress),
    known,
    now,
    onCheckpoint: (all) => saveCache(all).catch(() => undefined),
  });
  if (!result.aborted || result.all.length > 0) {
    await saveCache(result.all);
    await saveRankingFile(result.ranking);
  }
  return result;
}

// ---------- shadow alerts ----------

export type LaunchKind = "top" | "control";

export interface TopDevEntry {
  rank: number;
  dev: CreatorStats;
}

/** Lets one launch through per interval; everyMs <= 0 lets none through. */
export class ControlSampler {
  private last = 0;
  constructor(private readonly everyMs: number) {}
  take(now: number): boolean {
    if (this.everyMs <= 0 || now - this.last < this.everyMs) return false;
    this.last = now;
    return true;
  }
}

/** Pure: is this launch a top-creator launch, a sampled baseline launch, or neither. */
export function classifyLaunch(
  creator: string,
  top: ReadonlyMap<string, TopDevEntry>,
  sampler: ControlSampler,
  now: number
): { kind: "top"; entry: TopDevEntry } | { kind: "control" } | null {
  const entry = top.get(creator);
  if (entry) return { kind: "top", entry };
  return sampler.take(now) ? { kind: "control" } : null;
}

export interface PendingLaunch {
  mint: string;
  kind: LaunchKind;
  t0: number;
  /** undefined = not read yet, null = read and unreadable, number = opening cap. */
  cap0: number | null | undefined;
  done: number[];
}

/**
 * The opening market cap is the first readable one. DexScreener lists a new
 * coin 30-80 s after launch, so an empty read is retried each tick and only
 * recorded as unreadable once the coin is this old.
 */
const OPEN_GIVE_UP_MS = 3 * 60_000;

/** Pure: undefined = keep trying, otherwise the opening cap (null = gave up). */
export function resolveOpening(cap: number | null, ageMs: number): number | null | undefined {
  if (cap !== null) return cap;
  return ageMs >= OPEN_GIVE_UP_MS ? null : undefined;
}

/** Pure: horizons (minutes) that are due and not recorded yet. */
export function dueHorizons(check: PendingLaunch, now: number): number[] {
  return ALERT_HORIZONS_MIN.filter((h) => !check.done.includes(h) && now - check.t0 >= h * 60_000);
}

/** Pure: rebuild unfinished checks from file lines (restart recovery). */
export function pendingFromLines(lines: string[], now: number): PendingLaunch[] {
  const map = new Map<string, PendingLaunch>();
  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const mint = String(o.mint ?? "");
    if (o.type === "launch" && typeof o.detectedAt === "number" && now - o.detectedAt < 61 * 60_000) {
      map.set(mint, { mint, kind: o.kind === "top" ? "top" : "control", t0: o.detectedAt, cap0: undefined, done: [] });
    } else if (o.type === "open") {
      const check = map.get(mint);
      if (check) check.cap0 = typeof o.capUsd === "number" ? o.capUsd : null;
    } else if (o.type === "outcome") {
      map.get(mint)?.done.push(Number(o.h));
    }
  }
  return [...map.values()].filter((p) => dueHorizons(p, Infinity).length > 0);
}

export interface OutcomeLine {
  type: "outcome";
  kind: LaunchKind;
  h: number;
  capUsd: number | null;
  complete: boolean | null;
  ret: number | null;
}

export interface GroupSummary {
  kind: LaunchKind;
  horizonMin: number;
  launches: number;
  readable: number;
  medianReturnPct: number | null;
  graduatedPct: number | null;
  doubledPct: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pure: top vs baseline per horizon. `launches` counts every tracked launch at
 * that horizon, `readable` only those whose market cap could be read, so a
 * large gap between them is visible instead of quietly improving the average.
 */
export function summariseOutcomes(lines: string[]): GroupSummary[] {
  const buckets = new Map<string, OutcomeLine[]>();
  for (const line of lines) {
    let o: Partial<OutcomeLine>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "outcome" || (o.kind !== "top" && o.kind !== "control") || typeof o.h !== "number") continue;
    const key = `${o.kind}|${o.h}`;
    const list = buckets.get(key) ?? [];
    list.push(o as OutcomeLine);
    buckets.set(key, list);
  }
  const out: GroupSummary[] = [];
  for (const [key, list] of buckets) {
    const [kind, h] = key.split("|");
    const rets = list.map((o) => o.ret).filter((r): r is number => typeof r === "number");
    const readable = list.filter((o) => typeof o.capUsd === "number");
    out.push({
      kind: kind as LaunchKind,
      horizonMin: Number(h),
      launches: list.length,
      readable: readable.length,
      medianReturnPct: median(rets),
      graduatedPct: readable.length ? (readable.filter((o) => o.complete === true).length / readable.length) * 100 : null,
      doubledPct: rets.length ? (rets.filter((r) => r >= 100).length / rets.length) * 100 : null,
    });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.horizonMin - b.horizonMin : a.kind === "top" ? -1 : 1));
}

// ---------- runtime state ----------

let topByWallet = new Map<string, TopDevEntry>();
let rankingBuiltAt = 0;
let rankingPartial = false;
let sampler = new ControlSampler(0);
let pending: PendingLaunch[] = [];
let writeChain: Promise<void> = Promise.resolve();
let ticking = false;
let refreshing = false;
const seenMints = new Set<string>();

function append(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  writeChain = writeChain
    .then(async () => {
      await mkdir(dataDir(), { recursive: true });
      await appendFile(alertsFilePath(), line, "utf-8");
    })
    .catch((e) => logger.debug(`dev ranking write failed: ${e instanceof Error ? e.message : String(e)}`));
}

function applyRanking(ranking: RankingFile): void {
  topByWallet = new Map(ranking.devs.map((dev, i) => [dev.wallet, { rank: i + 1, dev }]));
  rankingBuiltAt = ranking.builtAt;
  rankingPartial = ranking.partial === true;
}

export function getDevRankingStats(): { tracked: number; builtAt: number; pending: number } {
  return { tracked: topByWallet.size, builtAt: rankingBuiltAt, pending: pending.length };
}

export interface LaunchEvent {
  mint: string;
  symbol: string;
  creator: string;
  detectedAt: number;
  source?: string;
}

/** Hot path: called for every launch the feed sees. No network, no throwing. */
export function noteDevLaunch(launch: LaunchEvent): void {
  if (!CONFIG.devRankingEnabled || !launch.creator || !launch.mint) return;
  try {
    if (seenMints.has(launch.mint)) return;
    const cls = classifyLaunch(launch.creator, topByWallet, sampler, launch.detectedAt);
    if (!cls) return;
    seenMints.add(launch.mint);
    if (seenMints.size > 2000) seenMints.delete(seenMints.values().next().value as string);

    append({
      type: "launch",
      t: Date.now(),
      detectedAt: launch.detectedAt,
      kind: cls.kind,
      mint: launch.mint,
      symbol: launch.symbol,
      creator: launch.creator,
      source: launch.source ?? null,
      ...(cls.kind === "top"
        ? {
            rank: cls.entry.rank,
            devLaunches: cls.entry.dev.launches,
            devMigrated: cls.entry.dev.migrated,
            devScore: Number(cls.entry.dev.score.toFixed(3)),
          }
        : {}),
    });
    pending.push({ mint: launch.mint, kind: cls.kind, t0: launch.detectedAt, cap0: undefined, done: [] });

    if (cls.kind === "top") {
      const d = cls.entry.dev;
      logger.info(
        `🏅 DEV ALERT (shadow, no trade): #${cls.entry.rank} creator ${launch.creator} launched ` +
          `${launch.symbol || "?"} ${launch.mint} — ${d.migrated}/${d.launches} past launches graduated`
      );
    }
  } catch (error) {
    logger.debug(`dev ranking launch ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const check of pending) {
      if (check.cap0 === undefined && now - check.t0 >= OPEN_DELAY_MS) {
        const snap = await fetchPumpCoinSnapshot(check.mint).catch(() => undefined);
        const opening = resolveOpening(snap?.usdMarketCap ?? null, now - check.t0);
        if (opening !== undefined) {
          check.cap0 = opening;
          append({ type: "open", t: Date.now(), mint: check.mint, kind: check.kind, capUsd: opening });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      for (const h of dueHorizons(check, now)) {
        check.done.push(h);
        const snap = await fetchPumpCoinSnapshot(check.mint).catch(() => undefined);
        const cap = snap?.usdMarketCap ?? null;
        append({
          type: "outcome",
          t: Date.now(),
          mint: check.mint,
          kind: check.kind,
          t0: check.t0,
          h,
          capUsd: cap,
          complete: snap ? snap.complete : null,
          ret: cap !== null && cap > 0 && check.cap0 && check.cap0 > 0 ? (cap / check.cap0 - 1) * 100 : null,
        });
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    pending = pending.filter((p) => dueHorizons(p, Infinity).length > 0);
  } finally {
    ticking = false;
  }
}

async function refreshRanking(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    logger.info("🏅 DEV RANKING: refreshing from pump.fun (slow on purpose, runs in the background)...");
    const result = await runRankingRefresh();
    if (result.aborted && result.all.length === 0) {
      logger.warn(`DEV RANKING: pump.fun kept refusing and nothing was gathered; will retry in 30 min.`);
      return;
    }
    applyRanking(result.ranking);
    logger.info(
      `🏅 DEV RANKING: ${result.ranking.devs.length} creator(s) qualify from ${result.all.length} known ` +
        `(${result.looked} new this run${result.aborted ? "; pump.fun rate-limited the run, retrying in 30 min" : ""}).`
    );
  } catch (error) {
    logger.warn(`DEV RANKING refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refreshing = false;
  }
}

export async function startDevRanking(): Promise<void> {
  if (!CONFIG.devRankingEnabled) return;
  try {
    sampler = new ControlSampler(CONFIG.devRankingControlEveryMinutes * 60_000);
    const saved = await loadRankingFile();
    if (saved) applyRanking(saved);
    try {
      const text = await readFile(alertsFilePath(), "utf-8");
      pending = pendingFromLines(text.slice(-2_000_000).split("\n").filter(Boolean), Date.now());
    } catch {
      pending = [];
    }
    logger.info(
      `🏅 DEV_RANKING: shadow alerts only (never trades). ${topByWallet.size} top creator(s) loaded, ` +
        `${pending.length} unfinished check(s) resumed. Needs ONCHAIN_FEED_ENABLED to see launches.`
    );
    const staleMs = CONFIG.devRankingRefreshHours * 3_600_000;
    const refreshIfStale = (): void => {
      // A rate-limited (partial) ranking is topped up every 30 min instead of waiting the full interval.
      const due = rankingPartial ? 30 * 60_000 : staleMs;
      if (Date.now() - rankingBuiltAt >= due) void refreshRanking();
    };
    refreshIfStale();
    setInterval(refreshIfStale, 30 * 60_000);
    setInterval(() => void tick().catch(() => undefined), 15_000);
  } catch (error) {
    logger.warn(`DEV_RANKING failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
}
