/**
 * Real-time on-chain discovery: pump.fun and Stonk.fun token creations, seen the moment the
 * transaction is confirmed instead of whenever an indexer lists the pool.
 *
 * Why this exists: every other source (DexScreener, GeckoTerminal, pump.fun's
 * frontend API, Telegram) is a poll of somebody else's index, so a coin shows
 * up seconds to minutes after it exists. This subscribes to the chain itself
 * over the RPC websocket.
 *
 * How it stays cheap: pump.fun's mint-authority PDA is an account in the
 * create transaction and in no trade, so `logsSubscribe` on that one address
 * delivers creations only (~1 per second measured on mainnet) rather than
 * every pump.fun trade. The mint is read straight out of the CreateEvent that
 * the program emits as a `Program data:` log line, so no getTransaction call
 * is needed.
 *
 * Same contract as GeckoTerminal/pump.fun discovery: this returns MINT
 * ADDRESSES only. The caller resolves them through resolveMintsToCandidates(),
 * so every existing gate (liquidity, age, RugCheck, small-cap, AI) applies
 * unchanged. Fail-safe: any error is swallowed and means "no new mints";
 * nothing here can block or place a trade.
 *
 * Stonk.fun (Raydium LaunchLab) has no mint-carrying event, so its creation is
 * recognised from the instruction log and the mint read with one capped
 * getTransaction call (see onchain-launchpads.ts).
 *
 * Limits, deliberately: pump.fun and Stonk.fun launches only (not Raydium/PumpSwap
 * migrations or other launchpads), and the transport is the standard RPC
 * websocket. A Yellowstone gRPC stream is a faster transport for the same
 * parser; swap it in behind startOnchainFeed() if latency measurements justify
 * the cost.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { CONFIG } from "./config.js";
import { noteDevLaunch } from "./dev-ranking.js";
import { noteFreshLaunch } from "./fresh-coin-recorder.js";
import { logger } from "./logger.js";
import {
  LAUNCHLAB_CREATION_INSTRUCTIONS,
  LAUNCHLAB_PROGRAM,
  STONKFUN_PLATFORM_CONFIG,
  extractInitialisedMint,
  logsContainCreation,
  transactionTouches,
  type FeedSourceId,
  type ParsedTxLike,
} from "./onchain-launchpads.js";

export { PUMP_FUN_PROGRAM } from "./onchain-launchpads.js";
/** PDA that is the new mint's authority; present only in create transactions. */
export const PUMP_FUN_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

/** Anchor discriminator of pump.fun's CreateEvent (sha256("event:CreateEvent")[..8]). */
const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const PROGRAM_DATA_PREFIX = "Program data: ";

export interface CreatedMint {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  signature: string;
  slot: number;
  /** Local clock when the websocket delivered the event, epoch ms. */
  detectedAt: number;
  source?: FeedSourceId;
}

function readString(buf: Buffer, offset: number): { value: string; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const length = buf.readUInt32LE(offset);
  // A real name/symbol/uri is far below this; a huge length means a different event.
  if (length > 1_000 || offset + 4 + length > buf.length) return null;
  return { value: buf.toString("utf8", offset + 4, offset + 4 + length), next: offset + 4 + length };
}

/**
 * Pure: pull the new mint out of a transaction's logs, or null when the
 * transaction is not a creation (or the layout is not the one we know).
 */
export function parseCreateEvent(
  logs: readonly string[],
  signature = "",
  slot = 0,
  now = Date.now()
): CreatedMint | null {
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), "base64");
    } catch {
      continue;
    }
    if (buf.length < 8 + 4 * 3 + 32 * 3 || !buf.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;

    const name = readString(buf, 8);
    const symbol = name && readString(buf, name.next);
    const uri = symbol && readString(buf, symbol.next);
    if (!name || !symbol || !uri || uri.next + 32 * 3 > buf.length) continue;

    try {
      const mint = new PublicKey(buf.subarray(uri.next, uri.next + 32)).toBase58();
      const creator = new PublicKey(buf.subarray(uri.next + 64, uri.next + 96)).toBase58();
      return { mint, symbol: symbol.value, name: name.value, creator, signature, slot, detectedAt: now };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Pure, bounded store of recently created mints. The scan loop asks for the
 * ones still inside the window; a mint DexScreener cannot price yet is simply
 * asked for again next cycle until it ages out.
 */
export class RecentMintBuffer {
  private readonly byMint = new Map<string, CreatedMint>();

  constructor(private readonly maxSize = 500) {}

  add(created: CreatedMint): void {
    if (this.byMint.has(created.mint)) return;
    this.byMint.set(created.mint, created);
    // Maps iterate in insertion order, so the first key is the oldest.
    while (this.byMint.size > this.maxSize) {
      const oldest = this.byMint.keys().next().value;
      if (oldest === undefined) break;
      this.byMint.delete(oldest);
    }
  }

  /** Newest first, no older than ttlMs, at most limit. */
  recent(now: number, ttlMs: number, limit: number): CreatedMint[] {
    const out: CreatedMint[] = [];
    for (const created of this.byMint.values()) {
      if (now - created.detectedAt <= ttlMs) out.push(created);
    }
    return out.sort((a, b) => b.detectedAt - a.detectedAt).slice(0, limit);
  }

  get(mint: string): CreatedMint | undefined {
    return this.byMint.get(mint);
  }

  get size(): number {
    return this.byMint.size;
  }
}

export interface FeedStats {
  running: boolean;
  detected: number;
  lastEventAt: number | null;
  stonkfunDetected: number;
  /** Stonk.fun creations skipped because the transaction lookup queue was full or failed. */
  stonkfunDropped: number;
}

const buffer = new RecentMintBuffer();
const stats: FeedStats = { running: false, detected: 0, lastEventAt: null, stonkfunDetected: 0, stonkfunDropped: 0 };
let connection: Connection | null = null;
let subscriptionIds: number[] = [];

// Stonk.fun creations need one getTransaction each (~1 per 15s measured); the
// cap keeps a burst from ever turning into an RPC flood.
const MAX_CONCURRENT_FETCHES = 2;
const MAX_PENDING_FETCHES = 40;
const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_DELAY_MS = 700;
let inFlight = 0;
const pendingFetches: Array<{ signature: string; slot: number; detectedAt: number }> = [];

/**
 * Pure: turn a fetched Stonk.fun creation transaction into a CreatedMint, or
 * null when it is not a Stonk.fun launch (LaunchLab also hosts other
 * launchpads) or the mint cannot be read unambiguously.
 */
export function stonkfunCreationFromTx(
  tx: ParsedTxLike | null | undefined,
  signature: string,
  slot: number,
  detectedAt: number
): CreatedMint | null {
  if (!transactionTouches(tx, STONKFUN_PLATFORM_CONFIG)) return null;
  const mint = extractInitialisedMint(tx);
  if (!mint) return null;
  return { mint, symbol: "", name: "", creator: "", signature, slot, detectedAt, source: "stonkfun" };
}

async function fetchParsedTransaction(signature: string): Promise<ParsedTxLike | null> {
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(CONFIG.solanaRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          // Version 1 transactions exist on mainnet now; 0 would make the RPC reject them.
          params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as { result?: ParsedTxLike | null };
      if (body.result) return body.result;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
  }
  return null;
}

function drainFetchQueue(): void {
  while (inFlight < MAX_CONCURRENT_FETCHES && pendingFetches.length > 0) {
    const job = pendingFetches.shift()!;
    inFlight += 1;
    void fetchParsedTransaction(job.signature)
      .then((tx) => {
        const created = stonkfunCreationFromTx(tx, job.signature, job.slot, job.detectedAt);
        if (!created) {
          stats.stonkfunDropped += 1;
          return;
        }
        buffer.add(created);
        stats.detected += 1;
        stats.stonkfunDetected += 1;
        stats.lastEventAt = job.detectedAt;
      })
      .catch(() => {
        stats.stonkfunDropped += 1;
      })
      .finally(() => {
        inFlight -= 1;
        drainFetchQueue();
      });
  }
}

function enqueueStonkfunCreation(signature: string, slot: number, detectedAt: number): void {
  if (pendingFetches.length >= MAX_PENDING_FETCHES) {
    stats.stonkfunDropped += 1;
    return;
  }
  pendingFetches.push({ signature, slot, detectedAt });
  drainFetchQueue();
}

export function getOnchainFeedStats(): FeedStats {
  return { ...stats };
}

/** http(s) RPC URL -> the matching websocket URL (same host, same path/key). */
export function toWebsocketUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^http/i, "ws");
}

/**
 * Mints created within the freshness window, newest first, as plain addresses
 * ready for resolveMintsToCandidates(). Empty when the feed is off or down.
 */
export function recentOnchainMints(now = Date.now()): string[] {
  if (!CONFIG.onchainFeedEnabled) return [];
  return buffer
    .recent(now, CONFIG.onchainFeedTtlSeconds * 1000, CONFIG.onchainFeedLimit)
    .map((created) => created.mint);
}

/** Seconds between on-chain creation being seen and now; null if never seen. */
export function onchainDetectionAgeSeconds(mint: string, now = Date.now()): number | null {
  const created = buffer.get(mint);
  return created ? (now - created.detectedAt) / 1000 : null;
}

export function startOnchainFeed(): void {
  if (!CONFIG.onchainFeedEnabled || stats.running) return;
  try {
    const wsEndpoint = CONFIG.onchainFeedWsUrl || toWebsocketUrl(CONFIG.solanaRpcUrl);
    // web3.js re-subscribes automatically after a dropped websocket.
    const conn = new Connection(CONFIG.solanaRpcUrl, { wsEndpoint, commitment: "confirmed" });
    connection = conn;
    const sources = CONFIG.onchainFeedSources;
    if (sources.includes("pumpfun")) {
      subscriptionIds.push(
        conn.onLogs(
          new PublicKey(PUMP_FUN_MINT_AUTHORITY),
          (logs, context) => {
            try {
              if (logs.err) return;
              const created = parseCreateEvent(logs.logs, logs.signature, context.slot);
              if (!created) return;
              buffer.add({ ...created, source: "pumpfun" });
              stats.detected += 1;
              stats.lastEventAt = created.detectedAt;
              noteDevLaunch({ ...created, source: "pumpfun" });
              noteFreshLaunch({ ...created, source: "pumpfun" });
            } catch (error) {
              logger.debug(`on-chain feed event ignored: ${error instanceof Error ? error.message : String(error)}`);
            }
          },
          "confirmed"
        )
      );
    }
    if (sources.includes("stonkfun")) {
      // Stonk.fun's platform config is in every Stonk.fun transaction (trades too),
      // so only the creation instruction in the logs triggers a lookup.
      subscriptionIds.push(
        conn.onLogs(
          new PublicKey(STONKFUN_PLATFORM_CONFIG),
          (logs, context) => {
            try {
              if (logs.err) return;
              if (!logsContainCreation(logs.logs, LAUNCHLAB_PROGRAM, LAUNCHLAB_CREATION_INSTRUCTIONS)) return;
              enqueueStonkfunCreation(logs.signature, context.slot, Date.now());
            } catch (error) {
              logger.debug(`on-chain feed event ignored: ${error instanceof Error ? error.message : String(error)}`);
            }
          },
          "confirmed"
        )
      );
    }
    stats.running = true;
    logger.info(
      `??  ONCHAIN_FEED: subscribed to ${sources.map((s) => (s === "pumpfun" ? "pump.fun" : "Stonk.fun")).join(" + ")} creations ` +
        `(window ${CONFIG.onchainFeedTtlSeconds}s).`
    );
  } catch (error) {
    logger.warn(`ONCHAIN_FEED could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function stopOnchainFeed(): Promise<void> {
  try {
    if (connection) await Promise.all(subscriptionIds.map((id) => connection!.removeOnLogsListener(id)));
  } catch {
    /* shutting down */
  }
  stats.running = false;
  subscriptionIds = [];
  pendingFetches.length = 0;
  connection = null;
}
