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

export function clearDevReputationCache(): void {
  cache.clear();
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    // Network error, timeout, abort, invalid JSON — all the same outcome.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
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
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.rep;

  const [userRaw, coinsRaw] = await Promise.all([
    getJson(`${PUMP_API}/users/${encodeURIComponent(creatorWallet)}`, timeoutMs),
    getJson(`${PUMP_API}/coins?creator=${encodeURIComponent(creatorWallet)}&limit=100`, timeoutMs),
  ]);

  const user = (userRaw ?? undefined) as PumpUser | undefined;
  const followers = typeof user?.followers === "number" ? user.followers : undefined;

  const coins = Array.isArray(coinsRaw) ? (coinsRaw as PumpCoin[]) : undefined;
  const migratedTokens = coins ? coins.filter((c) => c?.complete === true).length : undefined;

  if (followers === undefined || migratedTokens === undefined) {
    // Cache the miss too: a broken endpoint should not be retried on every
    // candidate of every cycle.
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

/** The few coin fields the dev ranking needs, read defensively. */
export interface PumpCoinRecord {
  mint: string;
  creator: string;
  complete: boolean;
  usdMarketCap: number | null;
  createdAt: number | null;
}

/** Pure: one raw pump.fun coin -> record, or undefined when it lacks a mint/creator. */
export function toPumpCoinRecord(raw: unknown): PumpCoinRecord | undefined {
  const c = (raw ?? undefined) as (PumpCoin & Record<string, unknown>) | undefined;
  if (typeof c?.mint !== "string" || !c.mint || typeof c.creator !== "string" || !c.creator) return undefined;
  const cap = typeof c.usd_market_cap === "number" ? c.usd_market_cap : Number.NaN;
  const created = typeof c.created_timestamp === "number" ? c.created_timestamp : Number.NaN;
  return {
    mint: c.mint,
    creator: c.creator,
    complete: c.complete === true,
    usdMarketCap: Number.isFinite(cap) ? cap : null,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
  };
}

/**
 * A page of pump.fun coins for a raw query string (e.g. "creator=...&limit=100").
 * undefined means the request failed (including a 429), which is different from
 * an empty page: the caller backs off instead of concluding there is nothing.
 */
export async function fetchPumpCoinList(query: string, timeoutMs = 8000): Promise<PumpCoinRecord[] | undefined> {
  const raw = await getJson(`${PUMP_API}/coins?${query}`, timeoutMs);
  if (!Array.isArray(raw)) return undefined;
  return raw.map(toPumpCoinRecord).filter((c): c is PumpCoinRecord => c !== undefined);
}

const DEXSCREENER_TOKENS_API = "https://api.dexscreener.com/tokens/v1/solana";

/**
 * Pure: DexScreener's pair list for one mint -> market cap and graduation flag.
 * pump.fun removed its per-coin route (GET /coins/{mint} is now a 404), so
 * DexScreener is the reader. It lists bonding-curve coins with dexId "pumpfun"
 * and a market cap but no liquidity; any other dexId means a real pool exists,
 * i.e. the coin graduated.
 */
export function snapshotFromDexPairs(
  raw: unknown
): { usdMarketCap: number | null; complete: boolean } | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const pairs = raw as Array<{
    dexId?: unknown;
    marketCap?: unknown;
    fdv?: unknown;
    liquidity?: { usd?: unknown };
  }>;
  const liquidityOf = (p: (typeof pairs)[number]) =>
    typeof p.liquidity?.usd === "number" && Number.isFinite(p.liquidity.usd) ? p.liquidity.usd : 0;
  const best = pairs.reduce((a, b) => (liquidityOf(b) > liquidityOf(a) ? b : a));
  const cap = [best.marketCap, best.fdv].find((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    usdMarketCap: cap ?? null,
    complete: pairs.some((p) => typeof p.dexId === "string" && p.dexId !== "pumpfun"),
  };
}

/** Current market cap (USD) and graduation flag of one coin; undefined when unreadable. */
export async function fetchPumpCoinSnapshot(
  mint: string,
  timeoutMs = 6000
): Promise<{ usdMarketCap: number | null; complete: boolean } | undefined> {
  if (!mint) return undefined;
  return snapshotFromDexPairs(await getJson(`${DEXSCREENER_TOKENS_API}/${encodeURIComponent(mint)}`, timeoutMs));
}

/**
 * Resolve the creator wallet for a mint. Only pump.fun mints have one; anything
 * else returns undefined and simply gets no dev bonus.
 */
export async function fetchCreatorWallet(mint: string, timeoutMs = 6000): Promise<string | undefined> {
  if (!mint) return undefined;
  const raw = await getJson(`${PUMP_API}/coins/${encodeURIComponent(mint)}`, timeoutMs);
  const coin = (raw ?? undefined) as PumpCoin | undefined;
  return typeof coin?.creator === "string" && coin.creator.length > 0 ? coin.creator : undefined;
}
