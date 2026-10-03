import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test";
const { parseCreateEvent, RecentMintBuffer, toWebsocketUrl, recentOnchainMints } = await import("../src/onchain-feed.js");
const { buildConfig } = await import("../src/config.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Captured from mainnet's pump.fun mint-authority logsSubscribe on 2026-10-02.
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures/pumpfun-create-logs.json"), "utf-8")) as {
  samples: Array<{ sig: string; slot: number; logs: string[] }>;
};

test("parses the mint, symbol and creator from real captured pump.fun creations", () => {
  assert.ok(FIXTURE.samples.length > 0);
  for (const s of FIXTURE.samples) {
    const created = parseCreateEvent(s.logs, s.sig, s.slot, 123);
    assert.ok(created, "every captured create transaction must yield a mint");
    assert.match(created.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.match(created.creator, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.ok(created.symbol.length > 0);
    assert.equal(created.signature, s.sig);
    assert.equal(created.slot, s.slot);
    assert.equal(created.detectedAt, 123);
  }
  assert.equal(parseCreateEvent(FIXTURE.samples[0].logs)?.symbol, "FOLD");
});

test("returns null for logs that are not a creation or are malformed", () => {
  assert.equal(parseCreateEvent([]), null);
  assert.equal(parseCreateEvent(["Program log: Instruction: Buy"]), null);
  assert.equal(parseCreateEvent(["Program data: !!!not base64 at all"]), null);
  // Right prefix and discriminator but truncated: must not throw or invent a mint.
  const truncated = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118, 5, 0, 0, 0, 97]).toString("base64");
  assert.equal(parseCreateEvent([`Program data: ${truncated}`]), null);
  // A trade event's data (different discriminator) is ignored.
  const trade = FIXTURE.samples[0].logs.filter((l) => l.startsWith("Program data: ")).at(-1)!;
  assert.equal(parseCreateEvent([trade]), null);
});

test("buffer returns newest first, honours ttl and limit, and dedupes", () => {
  const buf = new RecentMintBuffer();
  const mk = (mint: string, detectedAt: number) => ({ mint, symbol: "S", name: "N", creator: "C", signature: "", slot: 0, detectedAt });
  buf.add(mk("old", 1_000));
  buf.add(mk("mid", 5_000));
  buf.add(mk("new", 9_000));
  buf.add(mk("new", 9_999)); // duplicate keeps the first detection time
  assert.deepEqual(buf.recent(10_000, 6_000, 10).map((c) => c.mint), ["new", "mid"]);
  assert.deepEqual(buf.recent(10_000, 60_000, 2).map((c) => c.mint), ["new", "mid"]);
  assert.equal(buf.get("new")?.detectedAt, 9_000);
});

test("buffer is bounded and drops the oldest first", () => {
  const buf = new RecentMintBuffer(3);
  for (let i = 0; i < 5; i++) buf.add({ mint: `m${i}`, symbol: "", name: "", creator: "", signature: "", slot: 0, detectedAt: i });
  assert.equal(buf.size, 3);
  assert.equal(buf.get("m0"), undefined);
  assert.ok(buf.get("m4"));
});

test("derives the websocket URL from the RPC URL", () => {
  assert.equal(toWebsocketUrl("https://api.mainnet-beta.solana.com"), "wss://api.mainnet-beta.solana.com");
  assert.equal(toWebsocketUrl("http://localhost:8899"), "ws://localhost:8899");
});

test("feed is off by default and offers nothing until enabled", () => {
  const config = buildConfig({ OPENROUTER_API_KEY: "x" });
  assert.equal(config.onchainFeedEnabled, false);
  assert.equal(config.onchainFeedTtlSeconds, 180);
  assert.equal(config.onchainFeedLimit, 30);
  assert.deepEqual(recentOnchainMints(), []);
  assert.equal(buildConfig({ OPENROUTER_API_KEY: "x", ONCHAIN_FEED_ENABLED: "true" }).onchainFeedEnabled, true);
});
