/**
 * Entry scoring and hard rug gates.
 *
 * Two separate ideas live here, and the distinction matters:
 *
 * GATES are pass/fail and cannot be outvoted. They test properties that cost
 * real money to fake — liquidity depth, holder concentration. A coin failing a
 * gate is not bought regardless of how good it looks.
 *
 * MODIFIERS nudge the model's confidence up or down. They test properties that
 * are cheap to fake — a paid boost, a linked X account, a website. A rug
 * operator can buy every one of them for a couple of hundred dollars, so their
 * combined upside is capped (maxTotalBonus). They can tip a coin that already
 * looks good over the line; they must never carry a mediocre one there alone.
 *
 * Penalties are deliberately NOT capped: nobody fakes a reason to avoid a trade.
 *
 * Pure functions only — the caller supplies already-fetched candidate data.
 */

export interface ScoreCandidate {
  /** Age of the pair in hours. */
  ageHours: number;
  /** DexScreener boost amount, 0 when unboosted. */
  boostAmount: number;
  /** True when the token links an X/Twitter account. */
  hasXSocial: boolean;
  /** True when the token links any non-X social or website. */
  hasOtherSocial: boolean;
  /** True when the token has paid for DexScreener enhanced info / ads. */
  hasPaidDexInfo: boolean;
}

export interface ScoreWeights {
  youngBonus: number;
  youngAgeHours: number;
  stalePenalty: number;
  staleAgeHours: number;
  xSocialBonus: number;
  otherSocialBonus: number;
  paidDexInfoBonus: number;
  strongBoostBonus: number;
  strongBoostThreshold: number;
  /** Ceiling on the SUM of all bonuses. Penalties are not capped. */
  maxTotalBonus: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  youngBonus: 4,
  youngAgeHours: 1,
  stalePenalty: 8,
  staleAgeHours: 6,
  xSocialBonus: 3,
  otherSocialBonus: 1,
  paidDexInfoBonus: 10,
  strongBoostBonus: 10,
  strongBoostThreshold: 100,
  maxTotalBonus: 15,
};

export interface ScoreAdjustment {
  /** Confidence after adjustment, clamped to 0..100. */
  adjustedConfidence: number;
  bonusApplied: number;
  penaltyApplied: number;
  /** Human-readable trail, for the log line that explains a buy. */
  reasons: string[];
}

/**
 * Apply modifiers to a model confidence score.
 *
 * Bonuses are summed then capped before being applied, so the cap constrains
 * the total rather than silently dropping whichever modifier was evaluated last.
 */
export function adjustConfidence(
  baseConfidence: number,
  candidate: ScoreCandidate,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS
): ScoreAdjustment {
  const reasons: string[] = [];
  let bonus = 0;
  let penalty = 0;

  if (Number.isFinite(candidate.ageHours) && candidate.ageHours < weights.youngAgeHours) {
    bonus += weights.youngBonus;
    reasons.push(`+${weights.youngBonus} under ${weights.youngAgeHours}h old`);
  }
  if (Number.isFinite(candidate.ageHours) && candidate.ageHours > weights.staleAgeHours) {
    penalty += weights.stalePenalty;
    reasons.push(`-${weights.stalePenalty} over ${weights.staleAgeHours}h old`);
  }

  // X is the stronger signal, so it supersedes rather than stacks with the
  // generic-socials bonus.
  if (candidate.hasXSocial) {
    bonus += weights.xSocialBonus;
    reasons.push(`+${weights.xSocialBonus} X linked`);
  } else if (candidate.hasOtherSocial) {
    bonus += weights.otherSocialBonus;
    reasons.push(`+${weights.otherSocialBonus} non-X socials only`);
  }

  if (candidate.hasPaidDexInfo) {
    bonus += weights.paidDexInfoBonus;
    reasons.push(`+${weights.paidDexInfoBonus} paid DexScreener info/ads`);
  }

  if (Number.isFinite(candidate.boostAmount) && candidate.boostAmount >= weights.strongBoostThreshold) {
    bonus += weights.strongBoostBonus;
    reasons.push(`+${weights.strongBoostBonus} boost >= ${weights.strongBoostThreshold}`);
  }

  const cappedBonus = Math.min(bonus, weights.maxTotalBonus);
  if (cappedBonus < bonus) {
    reasons.push(`(bonuses capped at +${weights.maxTotalBonus}, was +${bonus})`);
  }

  const adjusted = Math.max(0, Math.min(100, baseConfidence + cappedBonus - penalty));
  return { adjustedConfidence: adjusted, bonusApplied: cappedBonus, penaltyApplied: penalty, reasons };
}

export interface InstantBuyConfig {
  enabled: boolean;
  /** Boost amount at or above which the AI analysis step is skipped. */
  boostThreshold: number;
}

export const DEFAULT_INSTANT_BUY: InstantBuyConfig = {
  enabled: false,
  boostThreshold: 500,
};

export interface InstantBuyResult {
  buy: boolean;
  /** Why it did or did not qualify, for the log. */
  reason: string;
}

/**
 * Whether a boosted candidate should be bought without waiting for model
 * analysis.
 *
 * The rug gates still apply. A large boost means someone spent real money on
 * promotion, which is a spending signal rather than a quality one — a
 * well-funded rug buys boosts too. Skipping the model is a speed decision, not
 * a licence to skip the checks that test whether the coin can actually be sold
 * again, so liquidity and holder concentration are enforced exactly as they are
 * on an analysed buy.
 */
export function qualifiesForInstantBuy(
  input: RugGateInputs & { boostAmount: number },
  instant: InstantBuyConfig = DEFAULT_INSTANT_BUY,
  gates: RugGateConfig = DEFAULT_RUG_GATES
): InstantBuyResult {
  if (!instant.enabled) return { buy: false, reason: "instant buy disabled" };

  if (!Number.isFinite(input.boostAmount) || input.boostAmount < instant.boostThreshold) {
    return {
      buy: false,
      reason: `boost ${input.boostAmount || 0} below the ${instant.boostThreshold} instant-buy threshold`,
    };
  }

  const gate = checkRugGates(input, gates);
  if (!gate.pass) {
    return { buy: false, reason: `boost ${input.boostAmount} qualified but rug gate blocked it: ${gate.reason}` };
  }

  return { buy: true, reason: `boost ${input.boostAmount} >= ${instant.boostThreshold} and rug gates passed` };
}

export interface RugGateInputs {
  liquidityUsd: number;
  marketCapUsd: number;
  /**
   * Share of supply held by the largest non-pool holders, 0..100. Undefined
   * when the check could not run (RPC failure) — an unknown distribution is not
   * a safe one, so requireHolderData decides whether that fails the gate.
   */
  topHolderPercent: number | undefined;
}

export interface RugGateConfig {
  minLiquidityUsd: number;
  /**
   * Market cap above which a coin is skipped. A small wallet moving 0.03 SOL
   * cannot influence — and gains little from — a coin already valued in the
   * millions: the upside that justifies this strategy's risk lives well below
   * it. 0 disables the ceiling.
   */
  maxMarketCapUsd: number;
  /** Concentration check applies at or above this market cap. */
  holderCheckMinMarketCapUsd: number;
  maxTopHolderPercent: number;
  requireHolderData: boolean;
}

export const DEFAULT_RUG_GATES: RugGateConfig = {
  minLiquidityUsd: 5000,
  maxMarketCapUsd: 0,
  holderCheckMinMarketCapUsd: 60000,
  maxTopHolderPercent: 30,
  requireHolderData: true,
};

export interface RugGateResult {
  pass: boolean;
  /** Why it failed, for the log. Absent when it passed. */
  reason?: string;
}

/**
 * Hard filters applied before a buy, whatever the confidence score says.
 */
export function checkRugGates(input: RugGateInputs, config: RugGateConfig = DEFAULT_RUG_GATES): RugGateResult {
  if (!Number.isFinite(input.liquidityUsd) || input.liquidityUsd < config.minLiquidityUsd) {
    return {
      pass: false,
      reason: `liquidity $${Math.round(input.liquidityUsd || 0)} below $${config.minLiquidityUsd} floor`,
    };
  }

  if (
    config.maxMarketCapUsd > 0 &&
    Number.isFinite(input.marketCapUsd) &&
    input.marketCapUsd > config.maxMarketCapUsd
  ) {
    return {
      pass: false,
      reason: `market cap $${Math.round(input.marketCapUsd).toLocaleString("en-US")} above the $${config.maxMarketCapUsd.toLocaleString("en-US")} ceiling`,
    };
  }

  const concentrationApplies =
    Number.isFinite(input.marketCapUsd) && input.marketCapUsd >= config.holderCheckMinMarketCapUsd;

  if (!concentrationApplies) return { pass: true };

  if (input.topHolderPercent === undefined || !Number.isFinite(input.topHolderPercent)) {
    return config.requireHolderData
      ? { pass: false, reason: "holder concentration unknown (RPC failed) and requireHolderData is on" }
      : { pass: true };
  }

  if (input.topHolderPercent > config.maxTopHolderPercent) {
    return {
      pass: false,
      reason: `top holders hold ${input.topHolderPercent.toFixed(1)}% (max ${config.maxTopHolderPercent}%)`,
    };
  }

  return { pass: true };
}
