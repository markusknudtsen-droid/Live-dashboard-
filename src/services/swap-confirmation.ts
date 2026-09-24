/**
 * Recover from an unconfirmed swap instead of assuming it never happened.
 *
 * The bug this closes: executeJupiterSwap's HTTP call already retries
 * automatically (http.ts, up to HTTP_MAX_RETRIES times) on a timeout with no
 * response. That part is SAFE on its own — Jupiter's own docs confirm
 * resubmitting the same signedTransaction + requestId cannot double-execute,
 * since the signature is identical every time and Solana dedupes by
 * signature. Verified 2026-09-21 against dev.jup.ag: "You can submit with the
 * same signedTransaction and requestId for up to 2 minutes ... The
 * transaction will not double execute since it has the same signature."
 *
 * The actual gap is what happens once ALL of those retries are also
 * exhausted: executeJupiterSwap throws, the caller in trader.ts returns
 * success:false having recorded nothing (activePositions.push / the
 * corresponding sell-side bookkeeping both sit AFTER the swap call and never
 * run), and the NEXT cycle may build a brand-new quote and a brand-new SIGNED
 * TRANSACTION for the same token — a different signature, so if the FIRST
 * attempt actually landed on-chain, this is a genuine second, independent
 * swap. Nothing before this checked for that.
 *
 * The fix has two bounded layers, cheapest first:
 * 1. One extra resubmission of the identical signed bytes — using the safety
 *    Jupiter's own docs describe, not a new mechanism.
 * 2. A direct on-chain check of the transaction's OWN signature, which is
 *    known locally the moment it is signed and needs no response from
 *    Jupiter at all.
 *
 * Both are time-bounded rather than open-ended: every swap runs on a single
 * serialized queue (withTraderLock in trader.ts), so a long stall here blocks
 * every other pending buy/sell, not just this one.
 */

import { Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { setTimeout as sleep } from "node:timers/promises";
import { executeJupiterSwap, JupiterExecuteResponse, JupiterOrderResponse } from "./jupiter-client.js";
import { logger } from "../logger.js";

export interface SwapConfirmConfig {
  /** Wait before the one extra resubmission to Jupiter. */
  resubmitDelayMs: number;
  /** How long to poll our own RPC before giving up. */
  chainConfirmTimeoutMs: number;
  /** Interval between RPC polls within that window. */
  chainPollIntervalMs: number;
}

export const DEFAULT_SWAP_CONFIRM: SwapConfirmConfig = {
  resubmitDelayMs: 2000,
  chainConfirmTimeoutMs: 20_000,
  chainPollIntervalMs: 2000,
};

export interface SwapConfirmResult {
  success: boolean;
  signature?: string;
  error?: string;
  /** True when Jupiter never confirmed but the chain shows the swap landed. */
  recoveredFromChain?: boolean;
}

/**
 * The signed transaction's own signature — known locally the instant
 * transaction.sign([wallet]) returns, independent of any network response.
 * This is what makes the on-chain fallback possible even when Jupiter never
 * answers at all.
 */
export function deriveTransactionSignature(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  // An unsigned VersionedTransaction pre-allocates a 64-byte placeholder of
  // all zeros for each expected signer — it is never simply empty — so
  // length alone cannot detect "not signed yet".
  if (!sig || sig.length === 0 || sig.every((b) => b === 0)) {
    throw new Error("deriveTransactionSignature: transaction has no signature — sign() it first.");
  }
  return bs58.encode(sig);
}

/**
 * Poll our own RPC for whether `signature` reached the chain at all, and with
 * what outcome. Answers strictly within `timeoutMs` — a transient RPC read
 * failure retries within the same bound rather than being treated as a
 * definite "did not land", since a flaky read tells us nothing either way.
 */
export async function confirmSignatureOnChain(
  connection: Connection,
  signature: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<{ landed: boolean; err: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status) {
        return { landed: status.err == null, err: status.err };
      }
    } catch {
      // Fall through to retry within the bound — an RPC hiccup is not "this
      // definitely did not land".
    }
    if (Date.now() >= deadline) return { landed: false, err: undefined };
    await sleep(pollIntervalMs);
  }
}

/**
 * Execute a swap and, if Jupiter never confirms it, find out whether it
 * landed anyway before reporting failure.
 *
 * `execute` and `connection` are parameters (not module-level imports) so
 * tests can inject a stub instead of hitting the network — same convention
 * this codebase already uses for config objects.
 */
export async function confirmOrRecoverSwap(
  connection: Connection,
  order: JupiterOrderResponse,
  signedTransaction: string,
  signature: string,
  config: SwapConfirmConfig = DEFAULT_SWAP_CONFIRM,
  execute: (o: JupiterOrderResponse, s: string) => Promise<JupiterExecuteResponse | null> = executeJupiterSwap
): Promise<SwapConfirmResult> {
  const attempt = async (): Promise<JupiterExecuteResponse | null> => {
    try {
      return await execute(order, signedTransaction);
    } catch (error) {
      logger.debug(`Jupiter /execute threw: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  let execution = await attempt();
  if (execution?.status === "Success" && execution.signature) {
    return { success: true, signature: execution.signature };
  }

  // One more resubmission of the IDENTICAL signed bytes and requestId. Safe
  // per Jupiter's own idempotency contract, not a new transaction.
  await sleep(config.resubmitDelayMs);
  execution = await attempt();
  if (execution?.status === "Success" && execution.signature) {
    return { success: true, signature: execution.signature };
  }
  // A definite Failed (not just "no response") needs no chain check — Jupiter
  // itself is reporting the outcome.
  if (execution?.status === "Failed") {
    return { success: false, error: execution.error ?? "Jupiter reported Failed" };
  }

  // Jupiter gave no usable answer either time. Ask the chain directly, using
  // the signature we already knew locally before any of this started.
  const chain = await confirmSignatureOnChain(
    connection,
    signature,
    config.chainConfirmTimeoutMs,
    config.chainPollIntervalMs
  );
  if (chain.landed) {
    logger.warn(
      `⚠️  Jupiter never confirmed this swap, but the chain shows it landed (sig ${signature}). Recovering, not retrying.`
    );
    return { success: true, signature, recoveredFromChain: true };
  }

  return {
    success: false,
    error: chain.err
      ? `Transaction landed but failed on-chain: ${JSON.stringify(chain.err)}`
      : `Jupiter execution failed${execution?.error ? `: ${execution.error}` : ""} and the transaction was not found on-chain`,
  };
}
