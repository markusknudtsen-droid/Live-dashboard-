import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickPrimaryMint, parsePreviewPage } from "../src/telegram-scrape.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(__dirname, "fixtures/telegram-preview-page.html"), "utf-8");

// A real message captured from t.me/s/solearlytrending: the mint appears 5x in
// bot-deeplink URLs, alongside a dozen distinct solscan.io/account/<wallet>
// addresses (dev wallet, snipers, bundlers, holders) that each appear once.
const REAL_MINT = "BAdtgJ56GN8wEXqXvKECTRAUxV3vytJ9y6kkthDSpump";
const REAL_MESSAGE = `MoonCoin New Trending
Age: 4m | Security: OK
telegram.me/Soul_Sniper_Bot?start=15_etb_${REAL_MINT}
CHART soulterminal.ai/token/${REAL_MINT}
MC: $44.4K Liq: $16.1K
telegram.me/soul_scanner_bot?start=fakevol_${REAL_MINT}
telegram.me/soul_scanner_bot?start=bundle_${REAL_MINT}
Dev: solscan.io/account/8w9v4LGDRTY5xje3e8ydZaU14qu45sif5PsUYogh5qou
Bundler: solscan.io/account/GNSBVwcdbkRKH5SYn6bpp2QdvfnMNqUm8M5ixERFeTTq
Sniper: solscan.io/account/HxJwnACXtT47PU4HcJk4Zr4XMyvpCv1vYMY2UE2DHfPX
telegram.me/soul_scanner_bot?start=first20_${REAL_MINT}`;

test("the real signal-bot message: the token (mentioned 5x) beats a dozen single-mention wallets", () => {
  assert.equal(pickPrimaryMint(REAL_MESSAGE), REAL_MINT);
});

test("a plain call with exactly one address resolves to it", () => {
  assert.equal(pickPrimaryMint(`New gem: ${REAL_MINT} 🚀`), REAL_MINT);
});

test("a message with no valid address returns undefined, not a wallet by accident", () => {
  assert.equal(pickPrimaryMint("gm, market looking strong today"), undefined);
});

test("a genuine tie is resolved by first occurrence rather than thrown away", () => {
  const other = "CTALnV64vd1dkMxvtsuBgoYVhzB8tZ1XyRQFNS3ppump";
  assert.equal(pickPrimaryMint(`${REAL_MINT} then later ${other}`), REAL_MINT);
});

/* --------------------------- real fixture parsing -------------------------- */

test("parses real message blocks out of the actual t.me/s/ page", () => {
  const messages = parsePreviewPage(FIXTURE);
  assert.ok(messages.length >= 15, `expected many messages, got ${messages.length}`);
  for (const m of messages) {
    assert.match(m.postId, /^solearlytrending\/\d+$/);
    assert.equal(typeof m.text, "string");
  }
});

test("HTML tags and entities are stripped from the parsed text", () => {
  const messages = parsePreviewPage(FIXTURE);
  for (const m of messages) {
    assert.doesNotMatch(m.text, /<[a-z]/i, "no leftover tags");
    assert.doesNotMatch(m.text, /&amp;|&#036;/, "entities must be decoded");
  }
});

test("href URLs are preserved — the mint routinely lives only in a link, not the visible text", () => {
  const messages = parsePreviewPage(FIXTURE);
  const hit = messages.find((m) => m.text.includes("BAdtgJ56"));
  assert.ok(hit, "the href-carried mint must survive parsing");
  assert.match(hit!.text, /https:\/\/telegram\.me\//, "href values must be present in the parsed text");
});

test("the fixture's real mint-bearing message resolves to the mint, not a wallet", () => {
  const messages = parsePreviewPage(FIXTURE);
  const hit = messages.find((m) => m.text.includes(REAL_MINT));
  assert.ok(hit, "fixture must still contain the captured message");
  assert.equal(pickPrimaryMint(hit!.text), REAL_MINT);
});

test("the first poll of a channel records its backlog as seen, not as fresh mentions", async () => {
  const { pollPublicChannel } = await import("../src/telegram-scrape.js");
  const { recentMentionedMints, clearMentions } = await import("../src/telegram-signals.js");
  clearMentions();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(FIXTURE, { status: 200 })) as typeof fetch;
  try {
    assert.equal(await pollPublicChannel("first-poll-test"), 0);
    assert.deepEqual(recentMentionedMints(Date.now(), 30), [], "startup backlog must not become live mentions");
    assert.equal(await pollPublicChannel("first-poll-test"), 0, "the same page again has nothing new");
  } finally {
    globalThis.fetch = realFetch;
    clearMentions();
  }
});
