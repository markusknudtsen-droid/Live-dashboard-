import test from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";

const { dueHorizons, pendingFromLines } = await import("../src/shadow-log.js");

const T0 = 1_000_000_000_000;
const min = (n: number) => n * 60_000;

test("horizons come due on time and are never repeated", () => {
  const c = { mint: "A", chainId: "solana", t0: T0, price0: 1, done: [] as number[] };
  assert.deepEqual(dueHorizons(c, T0 + min(0.5)), []);
  assert.deepEqual(dueHorizons(c, T0 + min(6)), [1, 5]);
  c.done.push(1, 5);
  assert.deepEqual(dueHorizons(c, T0 + min(61)), [15, 60]);
});

test("restart recovery resumes only unfinished, recent candidates", () => {
  const lines = [
    JSON.stringify({ type: "candidate", t: T0, mint: "A", chainId: "solana", price: 2 }),
    JSON.stringify({ type: "outcome", t0: T0, mint: "A", h: 1 }),
    JSON.stringify({ type: "candidate", t: T0 - min(90), mint: "OLD", chainId: "solana", price: 1 }),
    JSON.stringify({ type: "reject", t: T0, mint: "A", reason: "x" }),
    "not json",
  ];
  const p = pendingFromLines(lines, T0 + min(10));
  assert.equal(p.length, 1, "the 90-minute-old candidate is dropped");
  assert.equal(p[0].mint, "A");
  assert.deepEqual(p[0].done, [1], "already-recorded horizon is not redone");
  assert.equal(p[0].price0, 2);
});
