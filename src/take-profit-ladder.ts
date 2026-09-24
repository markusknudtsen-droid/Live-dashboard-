/**
 * Multi-stage take-profit: scale out of a winner in rungs instead of one exit.
 *
 * A single exit banks one slice and then never acts again, so a position
 * that keeps climbing rides the whole rest of the way on the trailing stop
 * alone. A ladder banks progressively — lock the principal early, keep
 * selling into strength, leave a runner.
 *
 * Pure: the caller supplies the gain and how many rungs are already taken.
 */

export interface LadderRung {
  /** Gain from entry, in percent, at which this rung triggers. */
  gainPercent: number;
  /** Fraction of the REMAINING position to sell, 0..1. */
  sellFraction: number;
}

/**
 * Parse "40:50,100:50,250:50" into rungs — gain percent : percent of the
 * remaining position to sell.
 *
 * Returns [] for anything unusable rather than throwing: an unparseable ladder
 * must fall back to the existing single-stage behaviour, not stop the bot.
 * Rungs are sorted ascending and deduped by gain so the ordering the caller
 * relies on cannot depend on how the operator typed it.
 */
export function parseLadder(spec: string | undefined): LadderRung[] {
  if (!spec || typeof spec !== "string") return [];
  const out: LadderRung[] = [];
  const seen = new Set<number>();

  for (const part of spec.split(",")) {
    const [rawGain, rawSell] = part.split(":");
    const gainPercent = Number(String(rawGain ?? "").trim());
    const sellPercent = Number(String(rawSell ?? "").trim());
    if (!Number.isFinite(gainPercent) || gainPercent <= 0) continue;
    if (!Number.isFinite(sellPercent) || sellPercent <= 0 || sellPercent > 100) continue;
    if (seen.has(gainPercent)) continue;
    seen.add(gainPercent);
    out.push({ gainPercent, sellFraction: sellPercent / 100 });
  }

  return out.sort((a, b) => a.gainPercent - b.gainPercent);
}

/**
 * The rung to act on now, or null.
 *
 * `taken` is how many rungs this position has already banked. Returns the
 * HIGHEST rung the gain has cleared rather than the next one up, so a position
 * that gaps straight past two rungs banks once at the higher fraction instead
 * of firing twice in consecutive ticks — and the returned count tells the
 * caller how many rungs are now consumed.
 */
export function nextLadderRung(
  gainPercent: number,
  rungs: LadderRung[],
  taken: number
): { rung: LadderRung; rungsConsumed: number } | null {
  if (!Number.isFinite(gainPercent) || rungs.length === 0) return null;
  if (taken >= rungs.length) return null;

  let highest = -1;
  for (let i = taken; i < rungs.length; i++) {
    if (gainPercent >= rungs[i].gainPercent) highest = i;
    else break;
  }
  if (highest < 0) return null;

  return { rung: rungs[highest], rungsConsumed: highest + 1 };
}

/** Human-readable ladder, for the startup banner. */
export function describeLadder(rungs: LadderRung[]): string {
  return rungs.map((r) => `+${r.gainPercent}%→${Math.round(r.sellFraction * 100)}%`).join(", ");
}
