/**
 * Token risk data from RugCheck's public API (api.rugcheck.xyz).
 *
 * Free, no API key, verified live against a real mint on 2026-09-08. Unlike
 * pump.fun this IS a documented public product, but it is still a third party
 * with no uptime contract with this bot — every failure resolves to
 * "unknown", never a guessed pass. checkSmallCapGate() then fails closed on
 * unknown data, matching this project's rug-gate policy.
 *
 * RugCheck's own site shows a Good/Warning/Danger badge, but the API returns
 * no such field directly — only risks[] and score_normalised (0-100, higher
 * is riskier). The score threshold used to approximate "Good" is configurable
 * rather than hardcoded to a guess at their exact banding.
 */

import { fetchJson } from "./http.js";

const RUGCHECK_API = "https://api.rugcheck.xyz/v1";

export interface RugCheckReport {
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  totalHolders: number;
  /**
   * Whether RugCheck actually has holder data for this mint. A freshly
   * launched coin routinely comes back with totalHolders: 0 and an empty
   * topHolders[] because RugCheck has not indexed it yet — that is MISSING
   * data, not a token with no holders, and treating it as "0 holders" makes
   * a minimum-holder rule reject every new coin. Verified against four live
   * mints on 2026-09-16: three returned 0/[] while trading actively.
   */
  hasHolderData: boolean;
  /** Share of supply held by the token's creator wallet, 0-100. */
  devHoldingPct: number;
  /** Share held by wallets RugCheck flags individually as insiders, 0-100. */
  insiderHoldingPct: number;
  /** Share held by RugCheck's detected linked-wallet ("bundle") clusters, 0-100. */
  bundlerHoldingPct: number;
  /** RugCheck's own composite score, 0-100, higher = riskier. */
  scoreNormalised: number;
  /**
   * RugCheck's RAW score, and by far the better discriminator of the two.
   * score_normalised squashes the range badly: measured live, a clean token
   * scored raw 1 / normalised 1, while three losing trades scored raw 10001,
   * 10449 and 21500 — normalising to 50, 51 and 61. A "normalised <= 50" rule
   * therefore passes a raw-10001 token by an exact zero margin.
   */
  scoreRaw: number;
  /** RugCheck's own "this token has rugged" flag. */
  rugged: boolean;
  /**
   * Names of risks RugCheck rates at danger level — e.g. "Large Amount of LP
   * Unlocked", which is the precondition for the liquidity pull that makes a
   * position unsellable rather than merely losing.
   */
  dangerRisks: string[];
}

interface RcTopHolder {
  pct?: number;
  owner?: string;
  address?: string;
  insider?: boolean;
}
interface RcInsiderNetwork {
  tokenAmount?: number;
}
interface RcRisk {
  name?: string;
  level?: string;
}
interface RcReport {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  totalHolders?: number;
  creator?: string;
  token?: { supply?: number };
  topHolders?: RcTopHolder[];
  insiderNetworks?: RcInsiderNetwork[];
  score_normalised?: number;
  score?: number;
  rugged?: boolean;
  risks?: RcRisk[];
}

const cache = new Map<string, { at: number; report: RugCheckReport | undefined }>();
const CACHE_TTL_MS = 5 * 60_000; // short: a young coin's distribution moves fast

export function clearRugCheckCache(): void {
  cache.clear();
}

/**
 * Fetch and normalise a token's RugCheck report. Returns undefined on ANY
 * failure — network error, timeout, non-200, unexpected shape — which the
 * caller must treat as "unknown", not as a passing or failing verdict.
 */
export async function fetchRugCheckReport(
  mint: string,
  timeoutMs = 8000,
  now: number = Date.now()
): Promise<RugCheckReport | undefined> {
  if (!mint) return undefined;

  const hit = cache.get(mint);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.report;

  const j = (await fetchJson(`${RUGCHECK_API}/tokens/${encodeURIComponent(mint)}/report`, timeoutMs)) as RcReport | null;
  if (!j || typeof j !== "object") {
    cache.set(mint, { at: now, report: undefined });
    return undefined;
  }
  try {

    const supply = typeof j.token?.supply === "number" && j.token.supply > 0 ? j.token.supply : undefined;
    const holders = Array.isArray(j.topHolders) ? j.topHolders : [];

    const devEntry = holders.find((h) => h.owner === j.creator || h.address === j.creator);
    const devHoldingPct = typeof devEntry?.pct === "number" ? devEntry.pct : 0;

    const insiderHoldingPct = holders
      .filter((h) => h.insider === true)
      .reduce((sum, h) => sum + (typeof h.pct === "number" ? h.pct : 0), 0);

    const networks = Array.isArray(j.insiderNetworks) ? j.insiderNetworks : [];
    const bundlerTokens = networks.reduce((sum, n) => sum + (typeof n.tokenAmount === "number" ? n.tokenAmount : 0), 0);
    const bundlerHoldingPct = supply ? (bundlerTokens / supply) * 100 : 0;

    const totalHolders = typeof j.totalHolders === "number" ? j.totalHolders : 0;
    const dangerRisks = (Array.isArray(j.risks) ? j.risks : [])
      .filter((r) => String(r?.level ?? "").toLowerCase() === "danger")
      .map((r) => String(r?.name ?? "unnamed risk"));

    const report: RugCheckReport = {
      mintAuthorityDisabled: j.mintAuthority === null || j.mintAuthority === undefined,
      freezeAuthorityDisabled: j.freezeAuthority === null || j.freezeAuthority === undefined,
      totalHolders,
      // Either signal proves RugCheck indexed this mint's distribution; both
      // empty means "not indexed yet", which the caller must not read as zero.
      hasHolderData: totalHolders > 0 || holders.length > 0,
      devHoldingPct,
      insiderHoldingPct,
      bundlerHoldingPct,
      scoreNormalised: typeof j.score_normalised === "number" ? j.score_normalised : 100,
      // Missing raw score fails closed, matching scoreNormalised's default of
      // 100: an unscored token is not a safe one.
      scoreRaw: typeof j.score === "number" ? j.score : Number.POSITIVE_INFINITY,
      rugged: j.rugged === true,
      dangerRisks,
    };
    cache.set(mint, { at: now, report });
    return report;
  } catch {
    cache.set(mint, { at: now, report: undefined });
    return undefined;
  }
}
