import type { TradeSignal } from "./analyze.js";

/** Recent model verdicts, keyed by mint address. */
export type AnalysisCache = Map<string, { at: number; signal: TradeSignal }>;

/**
 * Store a verdict, by value.
 *
 * The copy is the entire point. The cache used to hold the very object the
 * trading loop goes on to mutate: the confidence modifiers (entry score, dev
 * reputation, Telegram, narrative trend) and the position-size tiering all
 * assign straight onto the signal. So a freshly analysed verdict was cached,
 * then boosted in place, and the cache silently held the BOOSTED number as if
 * it were the model's judgement. Every reuse inside the TTL then took that
 * inflated value as its baseline and applied the same modifiers a SECOND
 * time, so a coin the model scored 62 was judged at 62 + 2x its bonuses.
 *
 * It does not run away past that: reused signals are never written back to
 * the cache (only freshly analysed ones are), so the corruption is a double
 * application per TTL window, reset each time the coin is re-analysed — not
 * an unbounded climb across cycles. Still enough to clear MIN_CONFIDENCE on
 * repetition rather than conviction.
 *
 * Copying on the way in freezes what the model actually said. A shallow copy
 * suffices: every mutation the loop performs is a top-level scalar assignment,
 * and `token` is replaced wholesale on recall rather than mutated.
 */
export function rememberVerdict(cache: AnalysisCache, signal: TradeSignal, at: number): void {
  cache.set(signal.token.address, { at, signal: { ...signal } });
}

/**
 * Fetch a verdict that is still inside its TTL, by value, or undefined.
 *
 * Copying on the way out as well means a caller that mutates what it gets back
 * — which is exactly what the modifier passes do — cannot reach into the
 * stored verdict. A ttlMs of 0 or less disables reuse entirely.
 */
export function recallVerdict(
  cache: AnalysisCache,
  address: string,
  now: number,
  ttlMs: number
): TradeSignal | undefined {
  if (ttlMs <= 0) return undefined;
  const hit = cache.get(address);
  if (!hit || now - hit.at >= ttlMs) return undefined;
  return { ...hit.signal };
}
