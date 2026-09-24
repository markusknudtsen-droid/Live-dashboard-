import type { TradeSignal } from "./analyze.js";
import type { RugCheckReport } from "./rugcheck.js";

/**
 * Which code path authorised a buy. The gates screen wildly differently —
 * instant-buy skips both RugCheck and the model, fresh-launch skips the model —
 * so when asking later which entries actually worked, this is the first field
 * to group by.
 */
export const ENTRY_GATES = ["ai", "instant-buy", "fresh-launch", "add-on", "unknown"] as const;
export type EntryGate = (typeof ENTRY_GATES)[number];

export function isEntryGate(value: unknown): value is EntryGate {
  return typeof value === "string" && (ENTRY_GATES as readonly string[]).includes(value);
}

/** The RugCheck fields worth keeping per trade: the risk list is reduced to a count. */
export type EntryRugCheck = Omit<RugCheckReport, "dangerRisks"> & { dangerRiskCount: number };

/**
 * What a coin looked like at the moment the bot decided to buy it.
 *
 * The trade log already records how a position ENDED (price, pnlPercent,
 * reason). It recorded almost nothing about how it STARTED, which made the
 * history unusable for asking "what do my winners have in common?" — the only
 * entry-side field stored was `confidence`, and that is the one number known to
 * be unreliable (instant-buy and fresh-launch both hardcode it to 100).
 *
 * Recorded on BUY events only. Join to the matching SELL on token_address.
 */
export interface EntryFeatures {
  // Market state, straight off the candidate.
  marketCapUsd: number;
  liquidityUsd: number;
  volume24h: number;
  ageHours: number;
  buyToSellRatio: number;
  priceChange5m: number;
  priceChange1h: number;
  boostAmount: number;
  hasXSocial: boolean;
  hasOtherSocial: boolean;
  hasPaidDexInfo: boolean;

  // The model's qualitative read, kept as-is.
  trendStrength: string;
  momentum: string;
  riskLevel: string;
  narrative: string;

  /** What actually cleared MIN_CONFIDENCE. */
  finalConfidence: number;
  /**
   * The model's own verdict, before any modifier pass ran. Compare against
   * finalConfidence to see how much of an entry was model judgement versus
   * stacked bonuses.
   *
   * Trustworthy as of the analysis-cache fix: the cache stores and returns
   * verdicts by value, so a signal reused from it starts from the same
   * untouched number a freshly analysed one does. Before that fix the cache
   * held the already-boosted figure, and this baseline would have been
   * inflated for any reused coin.
   */
  confidenceBeforeModifiers?: number;
  /** Per-modifier contribution, e.g. { entryScore: 8, devReputation: 15 }. */
  confidenceBonuses?: Record<string, number>;

  gate: EntryGate;
  /** Which scan source surfaced the candidate, when known. */
  source?: string;
  /**
   * Absent means no RugCheck report was fetched for this buy — which is itself
   * the feature worth knowing, since the instant-buy path is exempt by design.
   */
  rugCheck?: EntryRugCheck;
}

/**
 * The entry-side facts that live in the trading loop rather than on the signal:
 * gate path, scan source, the RugCheck report the gate fetched, and the
 * confidence bookkeeping. index.ts fills this in as a signal moves through the
 * modifiers; trader.ts folds it into the recorded features at buy time.
 */
export interface EntryContext {
  confidenceBeforeModifiers?: number;
  confidenceBonuses?: Record<string, number>;
  gate?: EntryGate;
  source?: string;
  rugCheck?: RugCheckReport;
}

/** Flatten a full RugCheck report down to the fields kept per trade. */
export function summariseRugCheck(report: RugCheckReport): EntryRugCheck {
  // Optional-chained deliberately: this runs as an argument to emitTrade,
  // i.e. AFTER the swap has settled. A throw here would crash the trade path
  // with the money already spent, so the snapshot degrades instead.
  const { dangerRisks, ...rest } = report;
  return { ...rest, dangerRiskCount: dangerRisks?.length ?? 0 };
}

/**
 * Snapshot a buy decision. Most fields come off the signal the buy is executing,
 * so the three entry paths need no extra plumbing; `gateOverride` exists for the
 * add-on path, which reuses whatever signal triggered it.
 *
 * Never throws: a missing context degrades to fewer recorded fields, never to a
 * failed trade.
 */
export function buildEntryFeatures(signal: TradeSignal, gateOverride?: EntryGate): EntryFeatures {
  const ctx = signal.entryContext ?? {};
  const token = signal.token;

  return {
    marketCapUsd: token.marketCap,
    liquidityUsd: token.liquidityUsd,
    volume24h: token.volume24h,
    ageHours: token.ageHours,
    buyToSellRatio: token.buyToSellRatio,
    priceChange5m: token.priceChange5m,
    priceChange1h: token.priceChange1h,
    boostAmount: token.boostAmount ?? 0,
    hasXSocial: token.hasXSocial,
    hasOtherSocial: token.hasOtherSocial,
    hasPaidDexInfo: token.hasPaidDexInfo,

    trendStrength: signal.trendStrength,
    momentum: signal.momentum,
    riskLevel: signal.riskLevel,
    narrative: signal.narrative,

    finalConfidence: signal.confidence,
    confidenceBeforeModifiers: ctx.confidenceBeforeModifiers,
    confidenceBonuses:
      ctx.confidenceBonuses && Object.keys(ctx.confidenceBonuses).length > 0
        ? { ...ctx.confidenceBonuses }
        : undefined,

    gate: gateOverride ?? ctx.gate ?? "ai",
    source: ctx.source,
    rugCheck: ctx.rugCheck ? summariseRugCheck(ctx.rugCheck) : undefined,
  };
}

/** Record a modifier's contribution on the signal, creating the context if needed. */
export function recordConfidenceBonus(signal: TradeSignal, modifier: string, delta: number): void {
  if (delta === 0) return;
  const ctx = (signal.entryContext ??= {});
  ctx.confidenceBonuses ??= {};
  ctx.confidenceBonuses[modifier] = (ctx.confidenceBonuses[modifier] ?? 0) + delta;
}
