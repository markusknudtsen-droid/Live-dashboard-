import { VersionedTransaction } from "@solana/web3.js";

/**
 * Force a priority fee onto a Jupiter-assembled transaction.
 *
 * Why this exists: measured 2026-09-21, api.jup.ag/swap/v2 /order ignores
 * client-supplied fee parameters and sets prioritizationFeeLamports itself
 * (~0.0002 SOL). Three baseline runs gave 174410/213962/235163 lamports and
 * runs requesting 5,000,000 gave 173703/199335 — the same range. The only way
 * to actually control the fee is to rewrite the ComputeBudget instruction in
 * the transaction before signing it.
 *
 * The rewrite mutates instruction data in place and never changes its length
 * (a u64 is always 8 bytes), so the message still serializes correctly without
 * recompiling it — which matters because recompiling a v0 message would mean
 * resolving its address lookup tables over RPC first.
 *
 * Signing happens after this, so the signature covers the modified bytes.
 */

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** ComputeBudgetInstruction discriminators (first data byte). */
const SET_COMPUTE_UNIT_LIMIT = 2; // u32 LE units follow
const SET_COMPUTE_UNIT_PRICE = 3; // u64 LE micro-lamports per CU follow

/** Solana's default when a transaction sets no explicit limit. */
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

/** Protocol maximum for a single transaction. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

export interface PriorityFeeResult {
  /** True when a SetComputeUnitPrice instruction was found and rewritten. */
  applied: boolean;
  /** The micro-lamports-per-CU actually written. */
  microLamportsPerCu: number;
  /** The compute unit limit the fee was derived against. */
  computeUnitLimit: number;
  /** Why the rewrite did not happen, when applied is false. */
  reason?: string;
}

/**
 * Micro-lamports per compute unit that spends exactly `targetLamports` over
 * `computeUnitLimit` units.
 *
 *   fee_lamports = cuLimit * microLamportsPerCu / 1_000_000
 *
 * so microLamportsPerCu = targetLamports * 1_000_000 / cuLimit. Rounded down
 * so the fee is never more than asked for, and floored at 1 so a tiny budget
 * on a large limit still pays something rather than silently becoming free.
 */
export function microLamportsForTargetFee(targetLamports: number, computeUnitLimit: number): number {
  if (!(targetLamports > 0) || !(computeUnitLimit > 0)) return 0;
  return Math.max(1, Math.floor((targetLamports * 1_000_000) / computeUnitLimit));
}

/**
 * Rewrite `tx`'s priority fee to cost `targetLamports`. Call BEFORE signing.
 *
 * Returns applied:false (leaving the transaction untouched) when the
 * transaction carries no SetComputeUnitPrice instruction, rather than
 * inventing one — adding an instruction would require recompiling the message.
 * In practice Jupiter always includes one.
 */
export function forcePriorityFee(tx: VersionedTransaction, targetLamports: number): PriorityFeeResult {
  const none = (reason: string): PriorityFeeResult => ({
    applied: false,
    microLamportsPerCu: 0,
    computeUnitLimit: 0,
    reason,
  });

  if (!(targetLamports > 0)) return none("target fee is zero or negative");

  const keys = tx.message.staticAccountKeys;
  const budgetIndexes = new Set<number>();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toBase58() === COMPUTE_BUDGET_PROGRAM_ID) budgetIndexes.add(i);
  }
  // A program invoked by a transaction must be in the static keys, never in an
  // address lookup table, so not finding it here means it genuinely isn't used.
  if (budgetIndexes.size === 0) return none("transaction has no ComputeBudget instruction");

  let priceIx: { data: Uint8Array } | undefined;
  let computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT;

  for (const ix of tx.message.compiledInstructions) {
    if (!budgetIndexes.has(ix.programIdIndex)) continue;
    const data = ix.data;
    if (data.length === 0) continue;

    if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9) {
      priceIx = ix;
    } else if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const limit = view.getUint32(1, true);
      if (limit > 0) computeUnitLimit = Math.min(limit, MAX_COMPUTE_UNIT_LIMIT);
    }
  }

  if (!priceIx) return none("transaction has no SetComputeUnitPrice instruction");

  const microLamportsPerCu = microLamportsForTargetFee(targetLamports, computeUnitLimit);

  // Overwrite the u64 in place. Same byte length, so the serialized message
  // layout is unchanged and no recompilation is needed.
  const view = new DataView(priceIx.data.buffer, priceIx.data.byteOffset, priceIx.data.byteLength);
  view.setBigUint64(1, BigInt(microLamportsPerCu), true);

  return { applied: true, microLamportsPerCu, computeUnitLimit };
}
