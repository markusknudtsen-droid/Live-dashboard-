/**
 * The operator's stricter entry checklist for coins under a market-cap
 * threshold (default $40,000). Established coins keep using the existing
 * checkRugGates() in entry-score.ts unchanged; this is an ADDITIONAL, harder
 * bar for the riskiest segment — young, small, easy to fake.
 *
 * Pure and synchronous: the RugCheck fetch happens in rugcheck.ts, and the
 * caller passes its result in. That split is what makes this testable without
 * a network call, matching every other gate in this codebase.
 */

export interface SmallCapGateInputs {
  marketCapUsd: number;
  liquidityUsd: number;
  volume24h: number;
  hasAnySocial: boolean;
  /** undefined = the RugCheck lookup failed; see requireRugCheckData below. */
  rugCheck: import("./rugcheck.js").RugCheckReport | undefined;
}

export interface SmallCapGateConfig {
  /** This gate only applies below this market cap. */
  maxMarketCapUsd: number;
  minLiquidityUsd: number;
  minHolders: number;
  maxDevHoldingPct: number;
  maxInsiderHoldingPct: number;
  maxBundlerHoldingPct: number;
  minVolume24h: number;
  /** RugCheck score_normalised at or below this counts as "Good" (0-100, lower = safer). */
  maxRugCheckScore: number;
  /**
   * RugCheck RAW score at or below which the token passes. This is the check
   * that actually separates real coins from rugs — see RugCheckReport.scoreRaw
   * for the measured spread (clean token: 1; three losing trades: 10001, 10449,
   * 21500). The normalised score above cannot make that distinction.
   */
  maxRugCheckScoreRaw: number;
  /** Reject when RugCheck reports any danger-level risk at all. */
  blockDangerRisks: boolean;
  /** A missing RugCheck report fails the gate rather than being skipped. */
  requireRugCheckData: boolean;
}

export const DEFAULT_SMALL_CAP_GATE: SmallCapGateConfig = {
  maxMarketCapUsd: 40_000,
  minLiquidityUsd: 5000,
  minHolders: 60,
  maxDevHoldingPct: 8,
  maxInsiderHoldingPct: 22,
  maxBundlerHoldingPct: 22,
  minVolume24h: 1000,
  maxRugCheckScore: 50,
  maxRugCheckScoreRaw: 5000,
  blockDangerRisks: true,
  requireRugCheckData: true,
};

export interface SmallCapGateResult {
  pass: boolean;
  reason?: string;
}

/** Whether this gate applies at all — the caller decides which gate a candidate goes through. */
export function isSmallCap(marketCapUsd: number, config: SmallCapGateConfig = DEFAULT_SMALL_CAP_GATE): boolean {
  return Number.isFinite(marketCapUsd) && marketCapUsd < config.maxMarketCapUsd;
}

export function checkSmallCapGate(
  input: SmallCapGateInputs,
  config: SmallCapGateConfig = DEFAULT_SMALL_CAP_GATE
): SmallCapGateResult {
  if (input.liquidityUsd < config.minLiquidityUsd) {
    return { pass: false, reason: `liquidity $${Math.round(input.liquidityUsd)} below $${config.minLiquidityUsd}` };
  }
  if (input.volume24h < config.minVolume24h) {
    return { pass: false, reason: `24h volume $${Math.round(input.volume24h)} below $${config.minVolume24h}` };
  }
  if (!input.hasAnySocial) {
    return { pass: false, reason: "no social or website listed" };
  }

  if (!input.rugCheck) {
    return config.requireRugCheckData
      ? { pass: false, reason: "RugCheck data unavailable and requireRugCheckData is on" }
      : { pass: true };
  }
  const rc = input.rugCheck;

  // RugCheck's own verdict first — nothing below can redeem either of these.
  if (rc.rugged) return { pass: false, reason: "RugCheck flags this token as already rugged" };
  if (config.blockDangerRisks && rc.dangerRisks.length > 0) {
    return { pass: false, reason: `RugCheck danger risk: ${rc.dangerRisks.join("; ")}` };
  }

  if (!rc.mintAuthorityDisabled) return { pass: false, reason: "mint authority still enabled" };
  if (!rc.freezeAuthorityDisabled) return { pass: false, reason: "freeze authority still enabled" };

  if (rc.scoreRaw > config.maxRugCheckScoreRaw) {
    return {
      pass: false,
      reason: `RugCheck raw score ${rc.scoreRaw} above the ${config.maxRugCheckScoreRaw} bar`,
    };
  }
  if (rc.scoreNormalised > config.maxRugCheckScore) {
    return { pass: false, reason: `RugCheck score ${rc.scoreNormalised} above the ${config.maxRugCheckScore} "Good" bar` };
  }

  // Distribution checks require RugCheck to have actually indexed the mint.
  // A brand-new coin reports totalHolders: 0 with an empty topHolders[], and
  // rejecting on that would block precisely the fresh launches this strategy
  // exists to trade — while telling the operator "0 holders", which is false.
  // The authority, rugged, danger-risk and raw-score checks above still apply
  // to those coins, so an unindexed token is screened, just not on
  // distribution. See RugCheckReport.hasHolderData.
  if (rc.hasHolderData) {
    if (rc.totalHolders < config.minHolders) {
      return { pass: false, reason: `only ${rc.totalHolders} holders (min ${config.minHolders})` };
    }
    if (rc.devHoldingPct > config.maxDevHoldingPct) {
      return { pass: false, reason: `dev holds ${rc.devHoldingPct.toFixed(1)}% (max ${config.maxDevHoldingPct}%)` };
    }
    if (rc.insiderHoldingPct > config.maxInsiderHoldingPct) {
      return {
        pass: false,
        reason: `insiders hold ${rc.insiderHoldingPct.toFixed(1)}% (max ${config.maxInsiderHoldingPct}%)`,
      };
    }
    if (rc.bundlerHoldingPct > config.maxBundlerHoldingPct) {
      return {
        pass: false,
        reason: `bundlers hold ${rc.bundlerHoldingPct.toFixed(1)}% (max ${config.maxBundlerHoldingPct}%)`,
      };
    }
  }

  return { pass: true };
}
