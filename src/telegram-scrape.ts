/**
 * Zero-credential Telegram reading, via the public preview page Telegram
 * itself serves for any public channel: https://t.me/s/{channel}
 *
 * No login, no api_id/api_hash, no session string, nothing that touches an
 * account. This only works for PUBLIC channels — a private channel (a t.me/c/
 * link) has no such page and needs the MTProto path in telegram-signals.ts.
 * Unofficial and undocumented, so it can change shape without notice; every
 * failure here degrades to "no signal", same policy as the rest of this
 * feature.
 *
 * Extraction subtlety, found in a real captured message from this channel: a
 * signal-bot post commonly embeds a dozen SOLSCAN WALLET addresses alongside
 * the token mint (dev wallet, snipers, bundlers, top holders) — every one of
 * them a valid base58 Solana address, so "extract every valid address" would
 * flood the bot with wallets as if they were tokens to buy. In that real
 * message the mint appeared 5 times (in different bot-deeplink URLs) while
 * every wallet address appeared exactly once. Picking the most-frequent valid
 * address in a message is what tells the two apart.
 */

import { extractSolanaMints, recordMention, normaliseChannel } from "./telegram-signals.js";
import { logger } from "./logger.js";

/**
 * The mint most likely to be this message's actual subject, or undefined if
 * the message contains no valid address at all. Ties broken by first
 * occurrence, so a message with exactly one address (a plain call, with no
 * wallet-analysis links) still resolves correctly.
 */
export function pickPrimaryMint(text: string): string | undefined {
  const mints = extractSolanaMints(text);
  if (mints.length === 0) return undefined;
  if (mints.length === 1) return mints[0];

  const counts = new Map<string, number>();
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
    if (mints.includes(m[0])) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }

  let best = mints[0];
  let bestCount = counts.get(best) ?? 1;
  for (const mint of mints) {
    const c = counts.get(mint) ?? 1;
    if (c > bestCount) {
      best = mint;
      bestCount = c;
    }
  }
  return best;
}

export interface ScrapedMessage {
  /** e.g. "solearlytrending/454685" */
  postId: string;
  text: string;
}

/**
 * Parse the public preview page's message blocks. Regex over the page rather
 * than a full HTML parser — this repo has no DOM dependency and pulling one in
 * for an unofficial, already-fragile page is not worth the weight.
 */
export function parsePreviewPage(html: string): ScrapedMessage[] {
  const out: ScrapedMessage[] = [];
  const blockRe = /data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(blockRe)) {
    const postId = m[1];
    const rawHtml = m[2];

    // The mint is routinely carried in an <a href="..."> URL whose VISIBLE
    // text is just a bot name or a word like "CHART" (see soul_scanner_bot /
    // Soul_Sniper_Bot deeplinks) — the mint never appears in the rendered
    // text at all. href values are appended before tags are stripped, or
    // every such message loses its actual signal.
    const hrefs = [...rawHtml.matchAll(/href="([^"]+)"/g)].map((h) => h[1]);
    const visible = rawHtml.replace(/<[^>]+>/g, " ");

    // Entities are decoded on the FULL joined text (visible + hrefs), not just
    // the visible portion — this page double-encodes ampersands in tracking
    // URLs (utm_source=telegram&amp;amp;utm_medium=...), so a decode limited to
    // the visible text would leave every href's query string mangled.
    const text = [visible, ...hrefs]
      .join(" ")
      // Run twice: this page's tracking URLs are double-encoded
      // (&amp;amp;), and a single pass would leave one level intact.
      .replace(/&amp;/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/&#036;/g, "$")
      .replace(/&lrm;/g, "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ postId, text });
  }
  return out;
}

/** Highest numeric suffix already processed, per channel — the poll cursor. */
const lastSeenSeq = new Map<string, number>();

function postSeq(postId: string): number {
  const n = Number(postId.split("/").pop());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch and process one channel's public preview page once. Never throws:
 * a network failure, a 404 (private or nonexistent channel), or a page whose
 * markup no longer matches all resolve to "nothing found this poll".
 */
export async function pollPublicChannel(channelRef: string, timeoutMs = 10_000): Promise<number> {
  const channel = normaliseChannel(channelRef);
  let html: string;
  try {
    const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!res.ok) return 0;
    html = await res.text();
  } catch {
    return 0;
  }

  const messages = parsePreviewPage(html);
  const sinceSeq = lastSeenSeq.get(channel) ?? 0;
  let maxSeq = sinceSeq;
  let found = 0;
  const now = Date.now();

  for (const msg of messages) {
    const seq = postSeq(msg.postId);
    if (seq <= sinceSeq) continue;
    if (seq > maxSeq) maxSeq = seq;

    const mint = pickPrimaryMint(msg.text);
    if (mint) {
      recordMention(mint, channel, now);
      found++;
      logger.info(`📡 Telegram (public): ${channel} mentioned ${mint.slice(0, 8)}…`);
    }
  }

  // First poll of a channel: record the current high-water mark without
  // treating the whole existing history as new. An empty cursor must not look
  // like every past post just arrived.
  lastSeenSeq.set(channel, maxSeq);
  return sinceSeq === 0 ? 0 : found;
}
