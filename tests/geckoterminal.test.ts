import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractMints } from "../src/geckoterminal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures/geckoterminal-new-pools.json"), "utf-8"));

test("extracts every resolvable mint address from a real captured response", () => {
  const mints = extractMints(FIXTURE, 100);
  assert.ok(mints.length > 0, "the real fixture must yield at least one mint");
  for (const m of mints) {
    // Base58 Solana address shape, same bar used elsewhere in this codebase.
    assert.match(m, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `not address-shaped: ${m}`);
  }
});

test("respects the limit parameter", () => {
  const all = extractMints(FIXTURE, 100);
  const capped = extractMints(FIXTURE, 3);
  assert.equal(capped.length, Math.min(3, all.length));
  assert.deepEqual(capped, all.slice(0, 3), "same order, just truncated");
});

test("deduplicates addresses shared across multiple pools", () => {
  const mints = extractMints(FIXTURE, 100);
  assert.equal(new Set(mints).size, mints.length, "no duplicate address in the output");
});

test("a pool with no matching included token is skipped, not thrown", () => {
  const broken = {
    data: [{ id: "p1", type: "pool", relationships: { base_token: { data: { id: "solana_missing" } } } }],
    included: [],
  };
  assert.deepEqual(extractMints(broken, 10), []);
});

test("missing data or included entirely resolves to an empty list, never throws", () => {
  assert.deepEqual(extractMints({}, 10), []);
  assert.deepEqual(extractMints({ data: undefined, included: undefined } as never, 10), []);
});

test("malformed included entries (wrong type, missing address) are ignored", () => {
  const shape = {
    data: [{ id: "p1", type: "pool", relationships: { base_token: { data: { id: "solana_x" } } } }],
    included: [
      { id: "solana_x", type: "not-a-token", attributes: { address: "shouldnotcount1111111111111111111" } },
    ],
  };
  assert.deepEqual(extractMints(shape, 10), []);
});
