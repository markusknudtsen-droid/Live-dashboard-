import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.js";
import {
  bonusForChannels,
  clearMentions,
  getTelegramChannels,
  getTelegramSignal,
  recordMention,
} from "../src/telegram-signals.js";

const NOW = 1_800_000_000_000;
const MINT = "MintForChannelBonusTests";

test("TELEGRAM_CHANNEL_BONUS defaults to no overrides", () => {
  assert.deepEqual(buildConfig({}).telegramChannelBonus, {});
  assert.deepEqual(buildConfig({ TELEGRAM_CHANNEL_BONUS: "  " }).telegramChannelBonus, {});
});

test("parses name:bonus pairs, URL and @ forms included (split on the LAST colon)", () => {
  assert.deepEqual(buildConfig({ TELEGRAM_CHANNEL_BONUS: "solearlytrending:3" }).telegramChannelBonus, {
    solearlytrending: 3,
  });
  assert.deepEqual(
    buildConfig({ TELEGRAM_CHANNEL_BONUS: "https://t.me/SolEarlyTrending:3, @other : 8, id:3494506298:0" })
      .telegramChannelBonus,
    { "https://t.me/SolEarlyTrending": 3, "@other": 8, "id:3494506298": 0 }
  );
});

test("a malformed entry fails loudly at startup instead of leaving a channel on the wrong bonus", () => {
  for (const bad of ["solearlytrending", "x:abc", "x:101", "x:-1", ":5", "x:", "https://t.me/x"]) {
    assert.throws(() => buildConfig({ TELEGRAM_CHANNEL_BONUS: bad }), /TELEGRAM_CHANNEL_BONUS/, `should reject "${bad}"`);
  }
});

test("listed channels use their own bonus, unlisted ones the default", () => {
  const perChannel = { solearlytrending: 3 };
  assert.equal(bonusForChannels(["solearlytrending"], perChannel, 6), 3);
  assert.equal(bonusForChannels(["yeaknoya"], perChannel, 6), 6);
  assert.equal(bonusForChannels([], perChannel, 6), 6, "no channel info falls back to the default");
});

test("a coin posted in several channels takes the HIGHEST bonus, whatever the order", () => {
  const perChannel = { solearlytrending: 3 };
  assert.equal(bonusForChannels(["solearlytrending", "yeaknoya"], perChannel, 6), 6);
  assert.equal(bonusForChannels(["yeaknoya", "solearlytrending"], perChannel, 6), 6);
});

test("keys match however the operator pasted the channel, and a listed 0 is respected", () => {
  assert.equal(bonusForChannels(["solearlytrending"], { "https://t.me/SolEarlyTrending": 3 }, 6), 3);
  assert.equal(bonusForChannels(["solearlytrending"], { "@SolEarlyTrending": 3 }, 6), 3);
  assert.equal(bonusForChannels(["quiet"], { quiet: 0 }, 6), 0, "0 is a real bonus, not 'unset'");
});

test("getTelegramChannels lists every fresh channel and judges each on its own latest mention", () => {
  clearMentions();
  recordMention(MINT, "solearlytrending", NOW - 40 * 60_000);
  recordMention(MINT, "yeaknoya", NOW - 5 * 60_000);
  assert.deepEqual(getTelegramChannels(MINT, NOW, 60).sort(), ["solearlytrending", "yeaknoya"]);
  assert.deepEqual(getTelegramChannels(MINT, NOW, 30), ["yeaknoya"], "the 40-minute-old mention has expired");
  assert.deepEqual(getTelegramChannels(MINT, NOW, 0), []);
  assert.deepEqual(getTelegramChannels("unknown-mint", NOW, 30), []);
  assert.equal(getTelegramSignal(MINT, NOW, 30)?.channel, "yeaknoya", "the existing latest-mention signal is unchanged");
  clearMentions();
  assert.deepEqual(getTelegramChannels(MINT, NOW, 60), [], "clearMentions also clears the per-channel record");
});
