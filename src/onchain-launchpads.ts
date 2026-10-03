/**
 * Pure helpers for spotting Stonk.fun launches on-chain.
 *
 * Stonk.fun runs on Raydium's LaunchLab program, which (unlike pump.fun) does
 * not emit an event carrying the mint. So the feed first recognises a creation
 * from the program's own instruction log (no RPC), and only then fetches that
 * single transaction to read the mint and confirm it is a Stonk.fun launch.
 * Trades and everything else are discarded from the logs alone.
 *
 * Program ids and instruction names were observed on mainnet (2026-10-02).
 */

/** Raydium LaunchLab: the program behind Stonk.fun (and LetsBonk) launches. */
export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
/** LaunchLab instructions that create a new token + curve. */
export const LAUNCHLAB_CREATION_INSTRUCTIONS: readonly string[] = ["InitializeWithToken2022", "InitializeV2"];
/** Stonk.fun's platform config on LaunchLab: present in its creation transactions. */
export const STONKFUN_PLATFORM_CONFIG = "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt";

/** Bases that are never the new token. */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export type FeedSourceId = "pumpfun" | "stonkfun";
export const DEFAULT_FEED_SOURCES: readonly FeedSourceId[] = ["pumpfun", "stonkfun"];

export function parseFeedSources(raw: string | undefined): FeedSourceId[] {
  if (!raw || !raw.trim()) return [...DEFAULT_FEED_SOURCES];
  const out: FeedSourceId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if ((id === "pumpfun" || id === "stonkfun") && !out.includes(id)) out.push(id);
  }
  return out;
}

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (?:success|failed)/;
const INSTRUCTION = /^Program log: Instruction: (\w+)$/;

/**
 * True when `programId` itself (not a program it called) logged one of the
 * given instruction names. Needed because token-program instructions such as
 * "InitializeMint2" also appear inside creation and trade transactions.
 */
export function logsContainCreation(logs: readonly string[], programId: string, names: readonly string[]): boolean {
  const stack: string[] = [];
  for (const line of logs) {
    let m = INVOKE.exec(line);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    m = INSTRUCTION.exec(line);
    if (m && stack[stack.length - 1] === programId && names.includes(m[1])) return true;
  }
  return false;
}

/** Subset of a jsonParsed getTransaction result that we read. */
export interface ParsedTxLike {
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }>; instructions?: ParsedIx[] } };
  meta?: { innerInstructions?: Array<{ instructions?: ParsedIx[] }> };
}
interface ParsedIx {
  parsed?: { type?: string; info?: { mint?: string } };
}

/**
 * The mint initialised in the transaction. More than one (or none) is
 * ambiguous and returns null: guessing would feed wrong addresses to the scanner.
 */
export function extractInitialisedMint(tx: ParsedTxLike | null | undefined): string | null {
  if (!tx) return null;
  const instructions = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []),
  ];
  const initialised = new Set<string>();
  for (const ix of instructions) {
    const type = ix.parsed?.type;
    const mint = ix.parsed?.info?.mint;
    if (mint && type && /^initializeMint/i.test(type) && !QUOTE_MINTS.has(mint)) initialised.add(mint);
  }
  return initialised.size === 1 ? [...initialised][0] : null;
}

export function transactionTouches(tx: ParsedTxLike | null | undefined, address: string): boolean {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  return keys.some((key) => (typeof key === "string" ? key : key.pubkey) === address);
}
