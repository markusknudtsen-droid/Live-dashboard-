/**
 * Second-opinion token data from GMGN's OpenAPI (openapi.gmgn.ai), READ-ONLY.
 *
 * One GET per coin: /v1/token/info, whose `stat` block carries GMGN's analysis
 * of the coin's traders (bundlers, snipers, rat traders, bot wallets). Auth is an
 * API-key header plus a timestamp and one-time client_id. No wallet key is
 * involved, and none may ever be configured for this module.
 *
 * The response shape below comes from GMGN's published CLI and skill docs and has
 * NOT yet been captured from a live call. Every field is optional, anything
 * unexpected resolves to "unknown", and the shadow log keeps the parsed numbers so
 * the parser can be checked against the first real responses.
 *
 * The stat percentages are shares of GMGN's analysed trader cohort, NOT of supply,
 * so they are not comparable to RugCheck's bundler/insider percentages.
 *
 * Fail-safe like this bot's other data sources: every failure is "unknown", never a
 * guessed pass or a guessed rug.
 * ponytail: one endpoint, one backoff timer, no retry queue. Add /v1/token/security
 * only if shadow data shows the stat block alone misses rugs.
 */
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";

const GMGN_HOST = "https://openapi.gmgn.ai";

export interface GmgnReport {
  holderCount: number;
  /**
   * false when GMGN has no trader analysis for this coin (yet). GMGN returns a
   * full-shaped stat block of zeros in that case, so zeros mean MISSING, not clean.
   */
  statPopulated: boolean;
  bundlerPct: number;
  sniperPct: number;
  ratTraderPct: number;
  botDegenPct: number;
  freshWalletPct: number;
  entrapmentPct: number;
  creatorHoldPct: number;
  top10Pct: number;
  creatorCreatedCount: number;
}

export interface GmgnLimits {
  maxBundlerPct: number;
  maxSniperPct: number;
  maxRatTraderPct: number;
  maxBotDegenPct: number;
}

export interface GmgnVerdict {
  pass: boolean;
  /** false = no usable GMGN data, so the verdict carries no information either way. */
  known: boolean;
  reason: string;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
// GMGN rates are decimal fractions ("0.1783" is 17.83%).
const pct = (v: unknown): number => num(v) * 100;

const STAT_KEYS = [
  "creator_hold_rate",
  "top_bundler_trader_percentage",
  "top70_sniper_hold_rate",
  "top_rat_trader_percentage",
  "top_entrapment_trader_percentage",
  "bot_degen_rate",
  "fresh_wallet_rate",
  "private_vault_hold_rate",
  "creator_created_count",
  "top_10_holder_rate",
];

/** Pure: GMGN's `data` object from /v1/token/info -> a report, or undefined if unusable. */
export function parseGmgnInfo(data: unknown): GmgnReport | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  // An address GMGN has no record for still comes back full-shaped, with an empty symbol.
  if (typeof d.symbol !== "string" || d.symbol === "") return undefined;

  const stat = d.stat && typeof d.stat === "object" ? (d.stat as Record<string, unknown>) : {};
  const holderCount = num(d.holder_count);
  // Both tests are GMGN's own "block is empty" signals: a live pool cannot have zero
  // holders, and ten simultaneous zeros are a gap, not a clean coin.
  const holdersMirrorOnly = !(num(stat.holder_count) > 0) && holderCount > 0;
  const allZero = STAT_KEYS.every((k) => num(stat[k]) === 0);

  return {
    holderCount,
    statPopulated: !holdersMirrorOnly && !allZero,
    bundlerPct: pct(stat.top_bundler_trader_percentage),
    sniperPct: pct(stat.top70_sniper_hold_rate),
    ratTraderPct: pct(stat.top_rat_trader_percentage),
    botDegenPct: pct(stat.bot_degen_rate),
    freshWalletPct: pct(stat.fresh_wallet_rate),
    entrapmentPct: pct(stat.top_entrapment_trader_percentage),
    creatorHoldPct: pct(stat.creator_hold_rate),
    top10Pct: pct(stat.top_10_holder_rate),
    creatorCreatedCount: num(stat.creator_created_count),
  };
}

/**
 * Pure: would GMGN reject this coin? Unknown PASSES: this is an extra filter on top of
 * the RugCheck gate (which fails closed on its own), so "no GMGN data" only means no
 * extra information, and it must not block coins GMGN simply has not indexed yet.
 */
export function checkGmgn(report: GmgnReport | undefined, limits: GmgnLimits): GmgnVerdict {
  if (!report) return { pass: true, known: false, reason: "GMGN has no data for this coin" };
  if (!report.statPopulated) return { pass: true, known: false, reason: "GMGN has not analysed this coin's traders yet" };
  const hits: string[] = [];
  if (report.bundlerPct > limits.maxBundlerPct) hits.push(`bundlers ${report.bundlerPct.toFixed(1)}% > ${limits.maxBundlerPct}%`);
  if (report.sniperPct > limits.maxSniperPct) hits.push(`snipers ${report.sniperPct.toFixed(1)}% > ${limits.maxSniperPct}%`);
  if (report.ratTraderPct > limits.maxRatTraderPct) hits.push(`rat traders ${report.ratTraderPct.toFixed(1)}% > ${limits.maxRatTraderPct}%`);
  if (report.botDegenPct > limits.maxBotDegenPct) hits.push(`bot wallets ${report.botDegenPct.toFixed(1)}% > ${limits.maxBotDegenPct}%`);
  return hits.length
    ? { pass: false, known: true, reason: hits.join("; ") }
    : { pass: true, known: true, reason: "within limits" };
}

export function gmgnLimitsFromConfig(): GmgnLimits {
  return {
    maxBundlerPct: CONFIG.gmgnMaxBundlerPct,
    maxSniperPct: CONFIG.gmgnMaxSniperPct,
    maxRatTraderPct: CONFIG.gmgnMaxRatTraderPct,
    maxBotDegenPct: CONFIG.gmgnMaxBotDegenPct,
  };
}

/** One-line summary for the log. */
export function describeGmgn(r: GmgnReport | undefined): string {
  if (!r) return "no data";
  if (!r.statPopulated) return `traders not analysed yet (holders ${r.holderCount})`;
  return (
    `bundlers ${r.bundlerPct.toFixed(1)}% snipers ${r.sniperPct.toFixed(1)}% rats ${r.ratTraderPct.toFixed(1)}% ` +
    `bots ${r.botDegenPct.toFixed(1)}% fresh ${r.freshWalletPct.toFixed(1)}% (holders ${r.holderCount}, creator launches ${r.creatorCreatedCount})`
  );
}

const cache = new Map<string, { at: number; report: GmgnReport | undefined }>();
const CACHE_TTL_MS = 2 * 60_000; // short: a young coin's trader mix moves fast
const MAX_BACKOFF_MS = 10 * 60_000;
let backoffUntil = 0;

export function clearGmgnCache(): void {
  cache.clear();
  backoffUntil = 0;
}

/** True when GMGN lookups are switched on and have a key. */
export function gmgnActive(): boolean {
  return CONFIG.gmgnMode !== "off" && CONFIG.gmgnApiKey !== "";
}

/**
 * Fetch and parse GMGN's view of a mint. Returns undefined on ANY failure (network,
 * timeout, non-200, GMGN error code, unexpected shape), which callers must treat as
 * "unknown". An auth or rate-limit response pauses all lookups so a bad key or a hot
 * loop cannot hammer GMGN.
 */
export async function fetchGmgnReport(
  mint: string,
  timeoutMs = 4000,
  now: number = Date.now()
): Promise<GmgnReport | undefined> {
  if (!mint || !gmgnActive() || now < backoffUntil) return undefined;

  const hit = cache.get(mint);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.report;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const query = new URLSearchParams({
      chain: "sol",
      address: mint,
      // GMGN rejects timestamps more than ~5s off and replayed client_ids.
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: randomUUID(),
    });
    const res = await fetch(`${GMGN_HOST}/v1/token/info?${query}`, {
      signal: controller.signal,
      headers: { "X-APIKEY": CONFIG.gmgnApiKey, accept: "application/json" },
    });

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const resetMs = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = res.status === 429 && Number.isFinite(resetMs) && resetMs > now ? resetMs - now : MAX_BACKOFF_MS;
      backoffUntil = now + Math.min(Math.max(wait, 30_000), MAX_BACKOFF_MS);
      logger.warn(
        `GMGN: HTTP ${res.status}` +
          (res.status === 429 ? " (rate limited)" : " (check GMGN_API_KEY, and that this machine reaches GMGN over IPv4)") +
          `; pausing GMGN lookups for ${Math.round((backoffUntil - now) / 1000)}s.`
      );
      return undefined;
    }

    let report: GmgnReport | undefined;
    if (res.ok) {
      const body = (await res.json()) as { code?: number; data?: unknown };
      report = body?.code === 0 ? parseGmgnInfo(body.data) : undefined;
    }
    cache.set(mint, { at: now, report });
    return report;
  } catch {
    cache.set(mint, { at: now, report: undefined });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
