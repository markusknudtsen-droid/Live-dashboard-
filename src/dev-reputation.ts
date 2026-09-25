/**
 * Creator reputation, from pump.fun's unofficial frontend API.
 *
 * Two signals, both verified live against the real API on 2026-09-08:
 *   GET /users/{wallet}          -> { followers: number, username: string }
 *   GET /coins?creator={wallet}  -> [{ mint, complete: boolean, ... }]
 *
 * `complete: true` is pump.fun's own flag for a token whose bonding curve
 * finished — i.e. it graduated/migrated. Counting those is the migration count.
 *
 * THIS IS AN UNOFFICIAL API. pump.fun publishes no public API and offers no
 * stability guarantee, so this endpoint can change shape, start refusing
 * traffic, or disappear without notice. Every failure mode here therefore
 * resolves the same way: NO BONUS. The bot then trades exactly as it would
 * without this feature.
 *
 * The rule that keeps that safe: an unavailable signal must never become a
 * false positive. Unknown followers is not zero followers, and neither is a
 * qualifying score. A renamed field reads as undefined, undefined fails the
 * numeric check, and the bonus is withheld — the same outcome as a 404.
 */

import { fetchJson } from "./http.js";
import { setTimeout as sleep } from "node:timers/promises";

export interface DevReputation {
  followers: number;
  migratedTokens: number;
  username?: string;
}

export interface DevReputationConfig {
  /** Minimum pump.fun followers to qualify. */
  minFollowers: number;
  /** Minimum migrated ("complete") tokens to qualify. */
  minMigratedTokens: number;
  /** Score added when BOTH thresholds are met. */
  bonus: number;
}

export const DEFAULT_DEV_REPUTATION: DevReputationConfig = {
  minFollowers: 2000,
  minMigratedTokens: 3,
  bonus: 15,
};

/**
 * Whether a creator clears both bars. Undefined reputation (lookup failed,
 * API changed, creator unknown) yields no bonus rather than a default.
 */
export function devReputationBonus(
  rep: DevReputation | undefined,
  config: DevReputationConfig = DEFAULT_DEV_REPUTATION
): { bonus: number; reason?: string } {
  if (!rep) return { bonus: 0 };

  // Guard explicitly against NaN/undefined leaking in from a changed payload:
  // `undefined > 2000` is already false, but being explicit documents the
  // intent and survives a refactor that might coerce instead of compare.
  const followers = Number.isFinite(rep.followers) ? rep.followers : -1;
  const migrated = Number.isFinite(rep.migratedTokens) ? rep.migratedTokens : -1;

  if (followers >= config.minFollowers && migrated >= config.minMigratedTokens) {
    return {
      bonus: config.bonus,
      reason: `+${config.bonus} dev ${rep.username ?? "?"}: ${followers} followers, ${migrated} migrated`,
    };
  }
  return { bonus: 0 };
}

/** Shape of the pump.fun coin record this module relies on. */
interface PumpCoin {
  mint?: string;
  complete?: boolean;
  creator?: string;
}

interface PumpUser {
  followers?: number;
  username?: string;
}

const PUMP_API = "https://frontend-api-v3.pump.fun";

/**
 * Cached lookups keyed by creator wallet.
 *
 * Without this the bot would hit pump.fun twice per candidate per 15-second
 * cycle — thousands of requests an hour against an API that owes us nothing.
 * That invites a rate-limit or an IP block, which would also affect the
 * operator's own browser access from the same address. A creator's follower
 * count and migration history move on the scale of days, so a long TTL costs
 * nothing in signal quality.
 */
const cache = new Map<string, { at: number; rep: DevReputation | undefined }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * How long a FAILED lookup is remembered. Measured 2026-09-24: pump.fun
 * answers HTTP 429 to 2 of 5 back-to-back calls, so most misses are a rate
 * limit, not a missing creator. Holding one for the full 30 minutes withheld
 * the bonus for half an hour over a momentary limit; this still keeps a dead
 * endpoint from being hammered every cycle.
 */
const MISS_TTL_MS = 2 * 60 * 1000;

/**
 * mint -> creator. A coin's creator never changes, so a found one is kept for
 * the run. Before this, every signal re-fetched it every cycle, which is what
 * spent the rate limit in the first place.
 *
 * ponytail: unbounded for the life of the process (a few hundred bytes per
 * mint seen); prune it if the bot starts running for weeks at a time.
 */
const creatorCache = new Map<string, { at: number; creator: string | undefined }>();

export function clearDevReputationCache(): void {
  cache.clear();
  creatorCache.clear();
  pumpQueue = Promise.resolve();
  lastCallAt = 0;
}

/**
 * pump.fun 429'd 2 of 5 back-to-back calls (measured 2026-09-24). Every call
 * in this file funnels through here, so serializing with a minimum gap here
 * is the one place that fixes it for every caller — fetchCreatorWallet,
 * fetchDevReputation's pair, and fetchNewPumpMints.
 *
 * ponytail: a fixed gap, not adaptive backoff or a 429 retry. Add one if a
 * 429 still slips through in practice.
 */
const MIN_CALL_GAP_MS = 500;
let pumpQueue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

/** pump.fun refuses requests without a browser user-agent. */
function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const call = pumpQueue.then(async () => {
    const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fetchJson(url, timeoutMs, { "user-agent": "Mozilla/5.0" });
  });
  // A failed call must not jam the queue for every call queued behind it.
  pumpQueue = call.catch(() => undefined);
  return call;
}

/**
 * Look up a creator's reputation. Returns undefined on ANY failure, which the
 * caller must treat as "no bonus" rather than as a zero score.
 */
export async function fetchDevReputation(
  creatorWallet: string,
  timeoutMs = 6000,
  now: number = Date.now()
): Promise<DevReputation | undefined> {
  if (!creatorWallet) return undefined;

  const hit = cache.get(creatorWallet);
  if (hit && now - hit.at < (hit.rep ? CACHE_TTL_MS : MISS_TTL_MS)) return hit.rep;

  const [userRaw, coinsRaw] = await Promise.all([
    getJson(`${PUMP_API}/users/${encodeURIComponent(creatorWallet)}`, timeoutMs),
    getJson(`${PUMP_API}/coins?creator=${encodeURIComponent(creatorWallet)}&limit=100`, timeoutMs),
  ]);

  const user = (userRaw ?? undefined) as PumpUser | undefined;
  const followers = typeof user?.followers === "number" ? user.followers : undefined;

  const coins = Array.isArray(coinsRaw) ? (coinsRaw as PumpCoin[]) : undefined;
  const migratedTokens = coins ? coins.filter((c) => c?.complete === true).length : undefined;

  if (followers === undefined || migratedTokens === undefined) {
    // Cache the miss too, briefly (MISS_TTL_MS): a broken endpoint should not
    // be retried on every candidate of every cycle.
    cache.set(creatorWallet, { at: now, rep: undefined });
    return undefined;
  }

  const rep: DevReputation = {
    followers,
    migratedTokens,
    username: typeof user?.username === "string" ? user.username : undefined,
  };
  cache.set(creatorWallet, { at: now, rep });
  return rep;
}

/**
 * Newest pump.fun mints, newest first.
 *
 * Third discovery source, alongside DexScreener and GeckoTerminal. Verified
 * live 2026-09-16: GET /coins?sort=created_timestamp&order=DESC returns coins
 * seconds old, carrying mint/symbol/creator/created_timestamp inline.
 *
 * Discovery ONLY — returns mint addresses, exactly like geckoterminal.ts and
 * for the same reason: a candidate built from this payload would carry no
 * liquidity or paid-info data and would fail the RugCheck gate's social bar on
 * data that was simply never fetched. The caller resolves these through
 * resolveMintsToCandidates(), so every existing check still applies.
 *
 * `complete: true` means the bonding curve already finished, so the launch move
 * is over — dropped here rather than wasting a resolve round-trip.
 *
 * Unofficial API, so the usual rule: any failure returns [], never throws.
 */
export async function fetchNewPumpMints(limit = 20, timeoutMs = 6000): Promise<string[]> {
  const raw = await getJson(
    `${PUMP_API}/coins?sort=created_timestamp&order=DESC&limit=${Math.max(1, Math.floor(limit))}`,
    timeoutMs
  );
  if (!Array.isArray(raw)) return [];
  return (raw as PumpCoin[])
    .filter((c) => c?.complete !== true && typeof c?.mint === "string" && c.mint.length > 0)
    .map((c) => c.mint as string);
}

/**
 * Resolve the creator wallet for a mint. Only pump.fun mints have one; anything
 * else returns undefined and simply gets no dev bonus.
 */
export async function fetchCreatorWallet(
  mint: string,
  timeoutMs = 6000,
  now: number = Date.now()
): Promise<string | undefined> {
  if (!mint) return undefined;
  const hit = creatorCache.get(mint);
  if (hit && (hit.creator !== undefined || now - hit.at < MISS_TTL_MS)) return hit.creator;

  const raw = await getJson(`${PUMP_API}/coins/${encodeURIComponent(mint)}`, timeoutMs);
  const coin = (raw ?? undefined) as PumpCoin | undefined;
  const creator = typeof coin?.creator === "string" && coin.creator.length > 0 ? coin.creator : undefined;
  creatorCache.set(mint, { at: now, creator });
  return creator;
}
