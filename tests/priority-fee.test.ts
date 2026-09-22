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
import { forcePriorityFee, microLamportsForTargetFee } from "../src/services/priority-fee.js";

const payer = Keypair.generate();

/** A v0 transaction shaped like Jupiter's: CU limit, CU price, then a transfer. */
function buildTx(opts: { limit?: number; price?: number; includePrice?: boolean } = {}): VersionedTransaction {
  const { limit = 238_700, price = 812_536, includePrice = true } = opts;
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: limit })];
  if (includePrice) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  }
  instructions.push(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: PublicKey.default, lamports: 1 })
  );
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Read back the fee the transaction would actually pay, in lamports. */
function feeLamports(tx: VersionedTransaction): number {
  const keys = tx.message.staticAccountKeys;
  let limit = 200_000;
  let price = 0n;
  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex]?.toBase58() !== "ComputeBudget111111111111111111111111111111") continue;
    const d = ix.data;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (d[0] === 2 && d.length === 5) limit = v.getUint32(1, true);
    if (d[0] === 3 && d.length === 9) price = v.getBigUint64(1, true);
  }
  return (limit * Number(price)) / 1_000_000;
}

test("microLamportsForTargetFee inverts the fee formula", () => {
  // fee = cuLimit * microLamportsPerCu / 1e6, so 200k CU at 1e6 µL/CU = 200k lamports.
  assert.equal(microLamportsForTargetFee(200_000, 200_000), 1_000_000);
  // The real shape from a live Jupiter order: 0.001 SOL over 238700 CU.
  assert.equal(microLamportsForTargetFee(1_000_000, 238_700), 4_189_359);
  // Degenerate inputs yield 0 rather than Infinity/NaN.
  assert.equal(microLamportsForTargetFee(0, 200_000), 0);
  assert.equal(microLamportsForTargetFee(1_000_000, 0), 0);
  // Never rounds up past the budget, and never silently becomes free.
  assert.equal(microLamportsForTargetFee(1, 1_400_000), 1);
});

test("forcePriorityFee rewrites a Jupiter-shaped transaction to cost exactly the target", () => {
  const tx = buildTx();
  // Sanity: the synthetic tx starts at Jupiter's real observed fee.
  assert.ok(Math.abs(feeLamports(tx) - 193_952) < 1, "fixture should start near Jupiter's own fee");

  const target = 1_000_000; // 0.001 SOL
  const res = forcePriorityFee(tx, target);

  assert.equal(res.applied, true);
  assert.equal(res.computeUnitLimit, 238_700);
  assert.ok(Math.abs(feeLamports(tx) - target) <= 1, `expected ~${target}, got ${feeLamports(tx)}`);
});

test("the rewritten transaction still serializes and round-trips", () => {
  const tx = buildTx();
  forcePriorityFee(tx, 1_000_000);
  // Mutating instruction data in place must not corrupt the message layout —
  // this is what makes it safe to skip recompiling (and resolving ALTs).
  const bytes = tx.serialize();
  const round = VersionedTransaction.deserialize(bytes);
  assert.ok(Math.abs(feeLamports(round) - 1_000_000) <= 1);
});

test("a transaction with no SetComputeUnitPrice is left untouched, and says why", () => {
  const tx = buildTx({ includePrice: false });
  const before = tx.serialize();

  const res = forcePriorityFee(tx, 1_000_000);

  assert.equal(res.applied, false);
  assert.match(res.reason ?? "", /SetComputeUnitPrice/);
  assert.deepEqual(tx.serialize(), before, "transaction must not be modified when the rewrite cannot apply");
});

test("a zero or negative budget is a no-op, so the fee can be turned off", () => {
  const tx = buildTx();
  const before = feeLamports(tx);

  assert.equal(forcePriorityFee(tx, 0).applied, false);
  assert.equal(forcePriorityFee(tx, -5).applied, false);
  assert.equal(feeLamports(tx), before, "Jupiter's own fee must survive a disabled override");
});

test("the fee scales with the compute unit limit, not a fixed price", () => {
  // Same target over a different limit must produce a different per-CU price
  // but the same total — otherwise the budget would silently drift.
  const small = buildTx({ limit: 100_000 });
  const large = buildTx({ limit: 1_000_000 });

  const a = forcePriorityFee(small, 1_000_000);
  const b = forcePriorityFee(large, 1_000_000);

  assert.notEqual(a.microLamportsPerCu, b.microLamportsPerCu);
  assert.ok(Math.abs(feeLamports(small) - 1_000_000) <= 1);
  assert.ok(Math.abs(feeLamports(large) - 1_000_000) <= 1);
});
