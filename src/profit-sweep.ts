/**
 * Profit sweep: pure sizing logic for automatically moving excess SOL out of
 * the hot wallet to WITHDRAWAL_ADDRESS once the balance grows past a reserve.
 *
 * The dashboard already has a manual withdrawal path (server/routes/vault.ts)
 * gated by a rate limit and a human-typed confirmation code. This is a
 * deliberately different, fully-automatic path with neither: the operator
 * chose that trade-off explicitly (PROFIT_SWEEP_ENABLED is off by default) in
 * exchange for not having to open the dashboard to bank profit out of the hot
 * wallet. maxSweepSol (0 = unlimited) is the only brake available on how much
 * a single automatic sweep can move.
 *
 * Pure function only: no clock, no network, no wallet access.
 */

export interface SweepDecisionInputs {
  balanceSol: number;
  /** Balance to always leave behind, so the bot can keep filling its trading slots. */
  reserveSol: number;
  /** Excess below this is left alone rather than swept, to avoid dust-sized transfers. */
  minSweepSol: number;
  /** Caps a single sweep's size. 0 disables the cap (sweep the full excess). */
  maxSweepSol: number;
}

export interface SweepDecision {
  shouldSweep: boolean;
  amountSol: number;
  /** Why nothing was swept. Absent when shouldSweep is true. */
  reason?: string;
}

function allFinite(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

export function decideSweep(inputs: SweepDecisionInputs): SweepDecision {
  const { balanceSol, reserveSol, minSweepSol, maxSweepSol } = inputs;

  if (!allFinite(balanceSol, reserveSol, minSweepSol, maxSweepSol)) {
    return { shouldSweep: false, amountSol: 0, reason: "invalid input" };
  }

  const excess = balanceSol - reserveSol;
  if (excess < minSweepSol) {
    return {
      shouldSweep: false,
      amountSol: 0,
      reason: `excess ${excess.toFixed(4)} SOL below the ${minSweepSol} SOL minimum`,
    };
  }

  const amountSol = maxSweepSol > 0 ? Math.min(excess, maxSweepSol) : excess;
  return { shouldSweep: true, amountSol };
}
