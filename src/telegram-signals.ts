/**
 * Telegram signal channels as a candidate source.
 *
 * Unlike X (login-walled, anti-scraping) and pump.fun (no public API at all),
 * Telegram has a real documented protocol, so this is read through the official
 * MTProto client rather than scraped.
 *
 * Why a channel mention is treated as a CANDIDATE SOURCE first and a scoring
 * input second: signal channels are frequently paid promotion, and a caller's
 * audience is often the exit liquidity for the caller's own position. The value
 * is surfacing coins DexScreener's volume-biased feeds never show — not
 * endorsing them. Everything a mention produces still passes the liquidity
 * floor, holder concentration, market-cap ceiling and re-entry cooldown
 * unchanged.
 *
 * Failure policy matches dev-reputation.ts: no session, a disconnect, a bad
 * channel name or a parse failure all resolve to "no signal". The bot then
 * behaves exactly as it does with the feature switched off.
 */

import { PublicKey } from "@solana/web3.js";
import { logger } from "./logger.js";

export interface TelegramSignal {
  mint: string;
  /** Channel the mention came from, for the log line that explains a buy. */
  channel: string;
  /** Unix epoch, milliseconds. */
  seenAt: number;
}

/**
 * Solana addresses are base58 and 32-44 characters. That pattern also matches
 * ordinary long words, so every candidate is validated through PublicKey —
 * which additionally rejects strings whose decoded length is not 32 bytes.
 *
 * Deliberately NOT anchored to the whole string: real messages embed the
 * address in prose ("CA: <addr> 🚀"), so matches are scanned out of the text.
 */
const BASE58_CANDIDATE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * Every valid Solana mint address in a message, de-duplicated and in order.
 *
 * Pure and synchronous so the parsing rules can be tested without a network or
 * a Telegram session.
 */
export function extractSolanaMints(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.match(BASE58_CANDIDATE) ?? []) {
    if (seen.has(match)) continue;
    try {
      // Throws on anything that is not a well-formed 32-byte key, which is what
      // separates a real mint from a long base58-looking word.
      const key = new PublicKey(match);
      if (key.toBase58() !== match) continue;
      seen.add(match);
      out.push(match);
    } catch {
      // Not an address; ignore.
    }
  }
  return out;
}

/** mint -> most recent mention. */
const mentions = new Map<string, TelegramSignal>();

export function recordMention(mint: string, channel: string, seenAt: number): void {
  if (!mint) return;
  mentions.set(mint, { mint, channel, seenAt });
}

/**
 * A mention, if one is recent enough to still be actionable. A stale call is
 * not a signal — by then the move it referred to has happened.
 */
export function getTelegramSignal(
  mint: string,
  now: number,
  ttlMinutes: number
): TelegramSignal | undefined {
  const hit = mentions.get(mint);
  if (!hit) return undefined;
  if (ttlMinutes <= 0) return undefined;
  return now - hit.seenAt <= ttlMinutes * 60_000 ? hit : undefined;
}

/** Mints mentioned within the TTL, newest first — the candidate source. */
export function recentMentionedMints(now: number, ttlMinutes: number): string[] {
  if (ttlMinutes <= 0) return [];
  const cutoff = now - ttlMinutes * 60_000;
  return [...mentions.values()]
    .filter((m) => m.seenAt >= cutoff)
    .sort((a, b) => b.seenAt - a.seenAt)
    .map((m) => m.mint);
}

/** Drop mentions too old to matter, so the map cannot grow without bound. */
export function pruneMentions(now: number, ttlMinutes: number): void {
  const cutoff = now - Math.max(ttlMinutes, 1) * 60_000;
  for (const [mint, sig] of mentions) {
    if (sig.seenAt < cutoff) mentions.delete(mint);
  }
}

export function clearMentions(): void {
  mentions.clear();
}

/**
 * Telegram links come in two shapes that identify channels completely
 * differently, and conflating them silently breaks private-channel matching:
 *
 *   https://t.me/solearlytrending      public  -> matched by username
 *   https://t.me/c/3494506298/102060   PRIVATE -> matched by numeric channel id
 *
 * The `/c/` form carries an internal channel id (and a message id, which is not
 * part of the channel's identity and is discarded). A private channel has no
 * username at all, so a username-only matcher would never match it.
 *
 * Numeric ids are returned prefixed with `id:` so the two namespaces cannot
 * collide — a channel literally named "3494506298" is a different thing.
 */
export function normaliseChannel(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");

  const privateMatch = trimmed.match(/^c\/(\d+)/i);
  if (privateMatch) return `id:${privateMatch[1]}`;

  // A bare numeric id, or one already in id: form.
  const bareId = trimmed.match(/^(?:id:)?(-?\d{6,})$/);
  if (bareId) return `id:${bareId[1].replace(/^-100/, "")}`;

  return trimmed.replace(/\/$/, "").toLowerCase();
}

/**
 * MTProto reports private channels with a -100 prefix on the internal id, which
 * the t.me/c/ link omits. Normalising both to the bare digits is what lets a
 * link the operator pasted match a message the client actually delivers.
 */
export function channelIdToRef(chatId: unknown): string | undefined {
  if (chatId === undefined || chatId === null) return undefined;
  const digits = String(chatId).replace(/^-100/, "").replace(/^-/, "");
  return /^\d{6,}$/.test(digits) ? `id:${digits}` : undefined;
}

export interface TelegramWatcherConfig {
  apiId: number;
  apiHash: string;
  session: string;
  /** Channel usernames or invite links. */
  channels: string[];
  ttlMinutes: number;
}

let watcherStarted = false;

/**
 * Connect and subscribe to the configured channels.
 *
 * gramjs is imported dynamically so the dependency is only loaded when the
 * feature is actually enabled — a bot running without Telegram should not pay
 * the startup cost, and a missing or broken install must not stop it booting.
 *
 * Never throws: a failure here disables the signal and leaves trading untouched.
 */
export async function startTelegramWatcher(config: TelegramWatcherConfig): Promise<boolean> {
  if (watcherStarted) return true;
  if (!config.session || !config.apiId || !config.apiHash || config.channels.length === 0) {
    logger.warn(
      "📡 Telegram signals enabled but not configured (need TELEGRAM_API_ID, TELEGRAM_API_HASH, " +
        "TELEGRAM_SESSION and TELEGRAM_CHANNELS). Continuing without them."
    );
    return false;
  }

  try {
    // Dynamic import: an absent dependency must degrade, not crash the bot.
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");
    const { NewMessage } = await import("telegram/events/index.js");

    const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
      connectionRetries: 5,
    });
    await client.connect();

    const wanted = new Set(config.channels.map((c) => normaliseChannel(c)));

    client.addEventHandler(async (event: unknown) => {
      try {
        const ev = event as { message?: { message?: string }; getChat?: () => Promise<unknown> };
        const text = ev.message?.message;
        if (!text) return;

        // A channel may be identified by username (public) or numeric id
        // (private); accept a match on either, since the operator's links can
        // be of either kind.
        let channel = "unknown";
        const refs: string[] = [];
        if (typeof ev.getChat === "function") {
          const chat = (await ev.getChat()) as { username?: string; id?: unknown } | undefined;
          if (chat?.username) {
            channel = normaliseChannel(chat.username);
            refs.push(channel);
          }
          const idRef = channelIdToRef(chat?.id);
          if (idRef) {
            refs.push(idRef);
            if (channel === "unknown") channel = idRef;
          }
        }
        // Only act on the channels the operator listed.
        if (wanted.size > 0 && refs.length > 0 && !refs.some((r) => wanted.has(r))) return;

        const now = Date.now();
        for (const mint of extractSolanaMints(text)) {
          recordMention(mint, channel, now);
          logger.info(`📡 Telegram: ${channel} mentioned ${mint.slice(0, 8)}…`);
        }
        pruneMentions(now, config.ttlMinutes);
      } catch {
        // A single malformed message must not kill the subscription.
      }
    }, new NewMessage({}));

    watcherStarted = true;
    logger.info(`📡 Telegram watcher connected, following ${config.channels.length} channel(s).`);
    return true;
  } catch (error) {
    logger.warn(
      `📡 Telegram watcher unavailable (${
        error instanceof Error ? error.message : String(error)
      }); continuing without Telegram signals.`
    );
    return false;
  }
}
