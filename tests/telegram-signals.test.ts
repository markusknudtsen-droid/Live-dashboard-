import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSolanaMints,
  normaliseChannel,
  recordMention,
  getTelegramSignal,
  recentMentionedMints,
  pruneMentions,
  clearMentions,
} from "../src/telegram-signals.js";
import { buildConfig } from "../src/config.js";

// Real mints from this bot's own trade history.
const FRENCHFRIES = "B3jpTbmkXbSrARGAjtJSCLQZQ4DZ1Vrb8r1ju5dfpump";
const TRONK = "CTALnV64vd1dkMxvtsuBgoYVhzB8tZ1XyRQFNS3ppump";
const NOW = 1_757_260_000_000;

/* ------------------------------- extraction ------------------------------- */

test("pulls a mint out of the prose a real call is written in", () => {
  const msg = `🚀 NEW CALL 🚀\nFRENCHFRIES\nCA: ${FRENCHFRIES}\nape fast`;
  assert.deepEqual(extractSolanaMints(msg), [FRENCHFRIES]);
});

test("a bare address with no surrounding text still parses", () => {
  assert.deepEqual(extractSolanaMints(TRONK), [TRONK]);
});

test("several mints in one message all come back, in order", () => {
  const msg = `${FRENCHFRIES} and also ${TRONK}`;
  assert.deepEqual(extractSolanaMints(msg), [FRENCHFRIES, TRONK]);
});

test("the same mint repeated is returned once", () => {
  assert.deepEqual(extractSolanaMints(`${TRONK} ${TRONK} ${TRONK}`), [TRONK]);
});

test("long base58-looking words are NOT treated as addresses", () => {
  // The regex alone would match these; PublicKey validation is what rejects
  // them. This is the false-positive case that would otherwise have the bot
  // trying to price random words out of chat.
  const junk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.deepEqual(extractSolanaMints(junk), []);
});

test("ordinary chatter yields nothing", () => {
  assert.deepEqual(extractSolanaMints("gm everyone, market looking strong today 🚀🚀"), []);
  assert.deepEqual(extractSolanaMints(""), []);
});

test("an address with an invalid base58 character is rejected", () => {
  // '0', 'O', 'I' and 'l' are not in the base58 alphabet.
  assert.deepEqual(extractSolanaMints("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"), []);
});

/* ------------------------------- channels -------------------------------- */

test("a link, an @handle and a bare name all name the same channel", () => {
  assert.equal(normaliseChannel("https://t.me/SolCalls"), "solcalls");
  assert.equal(normaliseChannel("@SolCalls"), "solcalls");
  assert.equal(normaliseChannel("  SolCalls/ "), "solcalls");
});

/* ------------------------------- freshness ------------------------------- */

test("a recent mention is a signal; a stale one is not", () => {
  clearMentions();
  recordMention(TRONK, "solcalls", NOW - 5 * 60_000);
  assert.ok(getTelegramSignal(TRONK, NOW, 30), "5 minutes old, inside a 30-minute TTL");
  assert.equal(getTelegramSignal(TRONK, NOW, 3), undefined, "5 minutes old, outside a 3-minute TTL");
});

test("an unmentioned mint is never a signal", () => {
  clearMentions();
  assert.equal(getTelegramSignal(FRENCHFRIES, NOW, 30), undefined);
});

test("a zero TTL disables the signal entirely", () => {
  clearMentions();
  recordMention(TRONK, "solcalls", NOW);
  assert.equal(getTelegramSignal(TRONK, NOW, 0), undefined);
  assert.deepEqual(recentMentionedMints(NOW, 0), []);
});

test("recent mints come back newest first, for use as a candidate source", () => {
  clearMentions();
  recordMention(TRONK, "a", NOW - 10 * 60_000);
  recordMention(FRENCHFRIES, "b", NOW - 1 * 60_000);
  assert.deepEqual(recentMentionedMints(NOW, 30), [FRENCHFRIES, TRONK]);
});

test("pruning drops mentions past the window so the map cannot grow forever", () => {
  clearMentions();
  recordMention(TRONK, "a", NOW - 5 * 60_000);
  recordMention(FRENCHFRIES, "b", NOW - 600 * 60_000);
  pruneMentions(NOW, 30);
  assert.deepEqual(recentMentionedMints(NOW, 30), [TRONK]);
});

/* --------------------------------- config -------------------------------- */

test("Telegram is off unless enabled, and channels parse from a comma list", () => {
  assert.equal(buildConfig({}).telegramEnabled, false);
  assert.deepEqual(buildConfig({}).telegramChannels, []);
  const c = buildConfig({
    TELEGRAM_ENABLED: "true",
    TELEGRAM_CHANNELS: "https://t.me/one, @two ,three",
  });
  assert.equal(c.telegramEnabled, true);
  assert.deepEqual(c.telegramChannels, ["https://t.me/one", "@two", "three"]);
  assert.equal(c.telegramMentionBonus, 6);
  assert.equal(c.telegramSignalTtlMinutes, 30);
});
