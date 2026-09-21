import test from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  confirmOrRecoverSwap,
  confirmSignatureOnChain,
  deriveTransactionSignature,
  DEFAULT_SWAP_CONFIRM,
} from "../src/services/swap-confirmation.js";
import type { JupiterExecuteResponse, JupiterOrderResponse } from "../src/services/jupiter-client.js";

const payer = Keypair.generate();

function buildSignedTx(): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: PublicKey.default, lamports: 1 }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

/** Minimal Connection stand-in — only the one method this module calls. */
function fakeConnection(statuses: (unknown | null)[]) {
  let call = 0;
  return {
    getSignatureStatuses: async () => {
      const value = [call < statuses.length ? statuses[call] : statuses[statuses.length - 1]];
      call++;
      return { value };
    },
  } as any;
}

const ORDER: JupiterOrderResponse = { requestId: "req-1", transaction: "base64tx" };
const FAST_CONFIG = { ...DEFAULT_SWAP_CONFIRM, resubmitDelayMs: 1, chainConfirmTimeoutMs: 50, chainPollIntervalMs: 5 };

test("deriveTransactionSignature reads the real signature, not a placeholder", () => {
  const tx = buildSignedTx();
  const sig = deriveTransactionSignature(tx);
  assert.equal(typeof sig, "string");
  assert.ok(sig.length > 0);
  // Same transaction, same signature every time — this is what makes the
  // on-chain lookup meaningful.
  assert.equal(sig, deriveTransactionSignature(tx));
});

test("deriveTransactionSignature refuses an unsigned transaction rather than returning garbage", () => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: PublicKey.default, lamports: 1 })],
  }).compileToV0Message();
  const unsigned = new VersionedTransaction(message);
  assert.throws(() => deriveTransactionSignature(unsigned));
});

test("a clean Success on the first attempt needs no chain check at all", async () => {
  let calls = 0;
  const execute = async (): Promise<JupiterExecuteResponse> => {
    calls++;
    return { status: "Success", signature: "sig-happy-path" };
  };
  const conn = fakeConnection([]); // would throw if ever called
  const result = await confirmOrRecoverSwap(conn, ORDER, "signed", "own-sig", FAST_CONFIG, execute);
  assert.deepEqual(result, { success: true, signature: "sig-happy-path" });
  assert.equal(calls, 1, "must not resubmit when the first attempt already succeeded");
});

test("a definite Failed from Jupiter is trusted without a chain check", async () => {
  const execute = async (): Promise<JupiterExecuteResponse> => ({ status: "Failed", error: "slippage exceeded" });
  const conn = fakeConnection([]); // never called
  const result = await confirmOrRecoverSwap(conn, ORDER, "signed", "own-sig", FAST_CONFIG, execute);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /slippage exceeded/);
});

test("no response, then no response again, but the chain shows it landed — RECOVERED, not retried", async () => {
  // This is the exact bug: Jupiter never answers, but the swap actually
  // happened. The caller must be told success so it does not buy/sell again.
  const execute = async (): Promise<JupiterExecuteResponse | null> => null;
  const conn = fakeConnection([{ err: null }]); // landed cleanly
  const result = await confirmOrRecoverSwap(conn, ORDER, "signed", "own-sig-123", FAST_CONFIG, execute);
  assert.equal(result.success, true);
  assert.equal(result.signature, "own-sig-123", "recovery uses OUR signature, not one from Jupiter");
  assert.equal(result.recoveredFromChain, true);
});

test("no response from Jupiter, and the chain genuinely never saw it — reported as failure", async () => {
  const execute = async (): Promise<JupiterExecuteResponse | null> => null;
  const conn = fakeConnection([null, null, null, null, null, null, null, null, null, null]); // never found
  const result = await confirmOrRecoverSwap(conn, ORDER, "signed", "own-sig", FAST_CONFIG, execute);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not found on-chain/);
});

test("the transaction landed but failed on-chain — a real failure, distinct from unknown", async () => {
  const execute = async (): Promise<JupiterExecuteResponse | null> => null;
  const conn = fakeConnection([{ err: { InstructionError: [0, "Custom"] } }]);
  const result = await confirmOrRecoverSwap(conn, ORDER, "signed", "own-sig", FAST_CONFIG, execute);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /landed but failed on-chain/);
});

test("an exception from execute() is swallowed and treated the same as no response", async () => {
  const execute = async (): Promise<JupiterExecuteResponse | null> => {
    throw new Error("ECONNABORTED");
  };
  const conn = fakeConnection([{ err: null }]);
  const result = await confirmOrRecoverSwap(conn, ORDER, "signed", "own-sig", FAST_CONFIG, execute);
  assert.equal(result.success, true, "a throw must still fall through to the chain check, not propagate");
  assert.equal(result.recoveredFromChain, true);
});

test("confirmSignatureOnChain survives a transient RPC error within its time budget", async () => {
  let call = 0;
  const conn = {
    getSignatureStatuses: async () => {
      call++;
      if (call === 1) throw new Error("RPC hiccup");
      return { value: [{ err: null }] };
    },
  } as any;
  const result = await confirmSignatureOnChain(conn, "sig", 200, 5);
  assert.equal(result.landed, true, "one flaky read must not be read as a definite miss");
});

test("resubmitting to Jupiter is the SAME signed bytes, never a new transaction", async () => {
  const seenSignedTx = new Set<string>();
  let calls = 0;
  const execute = async (_order: JupiterOrderResponse, signedTransaction: string) => {
    calls++;
    seenSignedTx.add(signedTransaction);
    return calls < 2 ? null : ({ status: "Success", signature: "sig-on-retry" } as JupiterExecuteResponse);
  };
  const conn = fakeConnection([]);
  const result = await confirmOrRecoverSwap(conn, ORDER, "identical-signed-bytes", "own-sig", FAST_CONFIG, execute);
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.equal(seenSignedTx.size, 1, "every resubmission must use the identical signedTransaction");
});
