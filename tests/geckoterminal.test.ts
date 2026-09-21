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

test("a second call inside the TTL is served from cache, not the network", async () => {
  const { fetchNewPoolMints, clearNewPoolCache } = await import("../src/geckoterminal.js");
  const { CONFIG } = await import("../src/config.js");

  if (CONFIG.geckoterminalCacheSeconds <= 0) return; // caching disabled by config

  const realFetch = globalThis.fetch;
  let calls = 0;
  let mode: "ok" | "ratelimited" = "ok";

  globalThis.fetch = (async () => {
    calls++;
    if (mode === "ratelimited") return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    clearNewPoolCache();

    const first = await fetchNewPoolMints("solana", 20);
    assert.equal(calls, 1, "cold cache must hit the network");
    assert.ok(first.length > 0);

    const second = await fetchNewPoolMints("solana", 20);
    assert.equal(calls, 1, "second call inside the TTL must NOT hit the network");
    assert.deepEqual(second, first);

    // A different limit is a different cache key, so it must fetch again.
    await fetchNewPoolMints("solana", 5);
    assert.equal(calls, 2, "a different limit must not read the other key's entry");

    // A 429 on a warm cache serves the last good list rather than [], so one
    // rate-limited call cannot blind the scanner for a cycle.
    mode = "ratelimited";
    const warmFail = await fetchNewPoolMints("solana", 20);
    assert.deepEqual(warmFail, first, "a warm cache must survive a rate-limited call");

    // A cold cache with a failing call has nothing to fall back on.
    clearNewPoolCache();
    const coldFail = await fetchNewPoolMints("solana", 20);
    assert.deepEqual(coldFail, [], "a cold cache with a failing call yields empty");
  } finally {
    globalThis.fetch = realFetch;
    clearNewPoolCache();
  }
});
