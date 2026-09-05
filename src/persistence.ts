import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { sanitizeDisplayText } from "./text-sanitize.js";
import type { ActivePosition } from "./trader.js";
import type { FirstTradeValidation } from "./first-trade-gate.js";

export interface TradeHistoryItem {
  timestamp: number;
  symbol: string;
  action: string;
  confidence: number;
  result: string;
  txSignature?: string;
}

export interface BotState {
  activePositions: ActivePosition[];
  tradeHistory: TradeHistoryItem[];
  /** REQUIRE_PROFITABLE_FIRST_TRADE gate state; persisted so it survives restarts. */
  firstTradeValidated: FirstTradeValidation;
}

const DEFAULT_STATE: BotState = {
  activePositions: [],
  tradeHistory: [],
  firstTradeValidated: null,
};

// Sanitizes a field in place ONLY when it's already a string — never
// coerces a malformed/missing value into a valid-looking one. Downstream
// validation (isRestorablePosition below) still needs to see a non-string
// tokenSymbol as invalid, not as something sanitization quietly turned into
// a plausible string. A non-empty string made entirely of control/format
// characters is a different case: it IS a string, so it can't be left for
// isRestorablePosition to reject the way a non-string is — but sanitizing
// it can legitimately collapse it to "", and an empty tokenSymbol would
// itself then fail that same non-empty check, dropping an otherwise valid
// restored position from monitoring (mirrors the same fallback
// scanner.ts's parsePairToCandidate needs at scan time, for the same
// reason).
function sanitizeIfString<T>(value: T): T {
  if (typeof value !== "string") return value;
  return (sanitizeDisplayText(value) || "?") as T;
}

/**
 * Token symbol is attacker-controlled (see text-sanitize.ts) and gets
 * sanitized once when a position is first opened this run — but a position
 * restored from state.json (written by a previous run, possibly an older
 * bot version predating that sanitization, or hand-edited) skips that step
 * entirely: loadState() hands it straight to trader.ts, which logs it
 * verbatim in several places, and loadStateStrict() hands it straight to
 * the positions API's JSON response. Sanitizing every string metadata
 * field here, at deserialization, closes that gap for both consumers
 * regardless of which bot version originally wrote the file.
 */
function sanitizeRestoredState(state: BotState): BotState {
  return {
    ...state,
    // This file explicitly tolerates malformed entries — a persisted null,
    // a stray primitive, anything isRestorablePosition below is specifically
    // built to individually reject — the array itself is only shape-checked
    // (Array.isArray) above, not its elements. Accessing .tokenSymbol on a
    // non-object entry would throw here, and since parseStateFile's callers
    // don't distinguish "one bad entry" from "totally broken file",
    // loadState() would discard every position (fail open to the empty
    // default) and loadStateStrict() would fail the whole read (fail
    // closed as a 500) — either way losing every OTHER, valid position too.
    // Pass a non-object entry through untouched so the existing downstream
    // validator still gets to reject it individually, same as before this
    // sanitization step existed.
    activePositions: state.activePositions.map((position) => {
      if (!position || typeof position !== "object") return position;
      return { ...position, tokenSymbol: sanitizeIfString(position.tokenSymbol) };
    }),
    tradeHistory: state.tradeHistory.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      return { ...entry, symbol: sanitizeIfString(entry.symbol) };
    }),
  };
}

function parseStateFile(raw: string): BotState {
  const parsed = JSON.parse(raw) as Partial<BotState>;
  return sanitizeRestoredState({
    activePositions: Array.isArray(parsed.activePositions) ? parsed.activePositions : [],
    tradeHistory: Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [],
    firstTradeValidated: typeof parsed.firstTradeValidated === "boolean" ? parsed.firstTradeValidated : null,
  });
}

export async function loadState(): Promise<BotState> {
  try {
    const raw = await readFile(CONFIG.stateFilePath, "utf-8");
    return parseStateFile(raw);
  } catch {
    return DEFAULT_STATE;
  }
}

/**
 * Like loadState(), but only treats a missing file (first run — nothing has
 * ever been persisted) as "no state yet"; any other failure (corrupt JSON, a
 * permissions error, a read racing a concurrent write) is rethrown instead
 * of silently degrading to an empty state. loadState()'s fail-open behavior
 * is correct for the main bot process — a broken state file at startup must
 * never block trading — but a caller that needs to tell "genuinely no
 * positions" apart from "couldn't read state" (the read-only positions API
 * in api.ts) needs this instead, so a real failure surfaces as an error
 * response rather than a misleading empty list.
 */
export async function loadStateStrict(): Promise<BotState> {
  let raw: string;
  try {
    raw = await readFile(CONFIG.stateFilePath, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return DEFAULT_STATE;
    throw error;
  }
  return parseStateFile(raw);
}

/**
 * Which persisted positions may be restored into the current run.
 *
 * - DRY_RUN: none. Each dry-run session starts a fresh ephemeral paper wallet
 *   whose balance never paid for previously persisted positions, so restoring
 *   them would mint paper SOL when they sell.
 * - Real mode: only positions from real transactions. Paper positions
 *   (DRYRUN- signatures) were never bought on-chain, and restoring them would
 *   leave the bot stuck trying to sell tokens the wallet does not hold.
 */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Whether a persisted entry carries every field the trading loop depends on:
 * identity (txSignature, tokenAddress, tokenSymbol, chainId for lookups and
 * logging), sizing/pricing (amountSol, entryPrice), exit levels
 * (stopLoss, takeProfit) and running metrics (entryTime, currentPrice,
 * pnlPercent). The state file only guarantees activePositions is an array;
 * individual entries may be malformed (hand-edited/corrupted), and restoring
 * an incomplete one would crash or corrupt trading math later.
 *
 * Also reused by api.ts's positions route as a shape check before mapping
 * to the dashboard's response shape: parseStateFile() deliberately lets a
 * null/non-object array entry through untouched (see sanitizeRestoredState
 * above) rather than dropping it, and a shallow "is it a non-null object"
 * check alone would still let a malformed-but-object-shaped entry (an
 * empty `{}`, or one missing fields) through into the response as a record
 * full of `undefined`s. Unlike filterRestorablePositions, this alone does
 * NOT exclude DRYRUN- paper positions — the API should list every
 * currently open position, paper or real, not just ones eligible to
 * survive a restart.
 */
export function isRestorablePosition(value: unknown): value is ActivePosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return (
    typeof position.txSignature === "string" &&
    isNonEmptyString(position.tokenAddress) &&
    isNonEmptyString(position.tokenSymbol) &&
    isNonEmptyString(position.chainId) &&
    isPositiveFinite(position.amountSol) &&
    isPositiveFinite(position.entryPrice) &&
    isPositiveFinite(position.stopLoss) &&
    isPositiveFinite(position.takeProfit) &&
    isPositiveFinite(position.entryTime) &&
    isPositiveFinite(position.currentPrice) &&
    typeof position.pnlPercent === "number" &&
    Number.isFinite(position.pnlPercent)
  );
}

export function filterRestorablePositions(positions: ActivePosition[], dryRun: boolean): ActivePosition[] {
  if (dryRun) return [];
  return positions.filter(
    (position) => isRestorablePosition(position) && !position.txSignature.startsWith("DRYRUN-")
  );
}

// saveState() can now be triggered from several places that don't await each
// other (cycle-end, the SIGINT handler, and the trade listener resolving the
// first-trade gate). Serialize actual writes through this chain so two
// concurrent callers can never interleave and corrupt BOT_STATE_FILE — each
// write waits for the previous one to settle (success OR failure) before
// starting, but a failed write never blocks the ones queued behind it.
let writeQueue: Promise<void> = Promise.resolve();

export function saveState(state: BotState): Promise<void> {
  const write = async (): Promise<void> => {
    const fullPath = path.resolve(CONFIG.stateFilePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    // Write to a temp file in the same directory, then rename over the real
    // path, instead of writing fullPath directly. writeFile() truncates
    // before writing, so a direct write leaves a window where a concurrent
    // reader — e.g. the separate `npm run api` process, which is a
    // different OS process the writeQueue above can't serialize against —
    // could observe a truncated/partial file. rename() within the same
    // directory is atomic on POSIX and Windows, so a concurrent read always
    // sees either the complete old snapshot or the complete new one, never
    // a torn one. The pid+timestamp suffix is just insurance against two
    // writers (e.g. two bot instances misconfigured to share a state file)
    // colliding on the same temp name.
    const tmpPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
      await rename(tmpPath, fullPath);
    } catch (error) {
      // This runs every cycle, so a persistent failure (a full disk, a
      // read-only directory) must not accumulate .tmp-* files forever.
      // Best-effort cleanup: the temp file may never have been created (the
      // writeFile above failed before that point) or may already be gone
      // (rename() can fail after the OS actually completed the move on some
      // platforms/filesystems), so ignore ENOENT specifically rather than
      // letting a cleanup failure mask the real error being rethrown below.
      await unlink(tmpPath).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException)?.code !== "ENOENT") {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          logger.error(`Failed to clean up temp state file ${tmpPath}: ${message}`);
        }
      });
      throw error;
    }
  };
  const result = writeQueue.then(write, write);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
