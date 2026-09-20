import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplayText } from "../src/text-sanitize.js";

// Untrusted text enters the system at several points — DexScreener token
// metadata (scanner.ts), state.json restored from a prior run
// (persistence.ts), AI-generated analysis text (analysis-normalizer.ts),
// and MCP tool input (mcp-server.ts) — all of which get logged verbatim by
// a logger with no escaping of its own. This file tests the shared
// sanitizer those boundaries all use, independent of any one of them.

test("sanitizeDisplayText strips control characters, collapses whitespace, and truncates", () => {
  assert.equal(sanitizeDisplayText("BONK"), "BONK");
  assert.equal(sanitizeDisplayText("BO\nNK\t!"), "BO NK !");
  assert.equal(sanitizeDisplayText("a".repeat(50)), `${"a".repeat(40)}…`);
});

// String.prototype.slice() counts UTF-16 code units, not Unicode code
// points — truncating with it can split a supplementary-plane character's
// surrogate pair (most emoji, among others) right down the middle, leaving
// a lone/invalid surrogate that renders as corrupted text.
test("sanitizeDisplayText truncates by Unicode code point, not UTF-16 code unit", () => {
  const emoji = String.fromCodePoint(0x1f600); // outside the BMP: a 2-unit surrogate pair
  const value = "a".repeat(39) + emoji + "more text that should be cut off";
  const result = sanitizeDisplayText(value);
  assert.equal(result, `${"a".repeat(39)}${emoji}…`);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result), false, "no lone surrogate");
});

// A hand-rolled ASCII-only control-character range (0x00-0x1F, 0x7F) missed
// the Unicode C1 control range (0x80-0x9F) — U+009B (CSI) in particular is
// interpreted by some terminals as an escape-sequence introducer exactly
// like ESC+"[", the same log/terminal manipulation this sanitizer exists to
// rule out. Matching the full Unicode "Cc" category catches both ranges.
test("sanitizeDisplayText strips Unicode C1 control characters, not just ASCII ones", () => {
  const csi = String.fromCharCode(0x9b); // U+009B, a C1 control code
  assert.equal(sanitizeDisplayText(`evil${csi}[31mred`), "evil [31mred");
  assert.equal(/\p{Cc}/u.test(sanitizeDisplayText(`evil${csi}[31mred`)), false);
});

// Bidi/format controls (Unicode category "Cf") are a distinct class from
// control characters ("Cc") — invisible, but capable of visually reordering
// or disguising text wherever it's displayed (the "Trojan Source" class of
// attack), so they need their own regression coverage.
test("sanitizeDisplayText strips Unicode bidi/format control characters", () => {
  const rlo = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
  const lri = String.fromCodePoint(0x2066); // LEFT-TO-RIGHT ISOLATE
  const cleanedRlo = sanitizeDisplayText(`evil${rlo}gnp.exe`);
  const cleanedLri = sanitizeDisplayText(`evil${lri}text`);
  assert.equal(/[\p{Cc}\p{Cf}]/u.test(cleanedRlo), false);
  assert.equal(/[\p{Cc}\p{Cf}]/u.test(cleanedLri), false);
  assert.equal(cleanedRlo, "evil gnp.exe");
  assert.equal(cleanedLri, "evil text");
});

test("sanitizeDisplayText accepts a custom maxLength (e.g. for longer AI-generated reasoning text)", () => {
  const long = "word ".repeat(200).trim();
  const result = sanitizeDisplayText(long, 500);
  assert.equal([...result.replace(/…$/, "")].length <= 500, true);
});
