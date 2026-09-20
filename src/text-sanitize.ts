/**
 * Makes an untrusted string safe to log, display, or otherwise interpolate
 * into output the bot writes — without making its *content* trustworthy.
 * Used at every point genuinely untrusted text enters the system: DexScreener
 * token metadata (scanner.ts — permissionless Solana token creation means
 * symbol/name are fully attacker-controlled), state.json restored from a
 * previous run (persistence.ts — may predate this sanitization, or be
 * hand-edited), AI-generated analysis text (analysis-normalizer.ts —
 * reasoning is only guaranteed to be typeof "string" by the schema, not
 * free of control characters, and can itself be steered by attacker-
 * controlled prompt content), and MCP tool input (mcp-server.ts — a caller-
 * supplied token symbol for the paper-buy tool). Sanitizing once at each of
 * these boundaries, rather than at every downstream log call, is the
 * pattern this file exists to support consistently — call-site-by-call-site
 * sanitization is exactly how earlier rounds of this let a log/terminal-
 * injection vector slip through in files that weren't the original source
 * of the untrusted string.
 *
 * Strips every Unicode control character (Cc — e.g. ESC, or C1 codes like
 * U+009B which some terminals interpret as an escape-sequence introducer)
 * and format character (Cf — e.g. U+202E RIGHT-TO-LEFT OVERRIDE, the
 * Trojan-Source class of attack), collapses whitespace, and caps length —
 * truncating by Unicode code point, not UTF-16 code unit, so a boundary
 * landing inside a supplementary-plane character (most emoji, among
 * others) can't split its surrogate pair into an invalid lone one.
 */
export function sanitizeDisplayText(value: string, maxLength = 40): string {
  const collapsed = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = [...collapsed];
  return codePoints.length > maxLength ? `${codePoints.slice(0, maxLength).join("")}…` : collapsed;
}
