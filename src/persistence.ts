import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { sanitizeDisplayText } from "./text-sanitize.js";
import type { ActivePosition } from "./trader.js";
import type { FirstTradeValidation } from "./first-trade-gate.js";
import type { RecentExit } from "./position-guard.js";

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
  /**
   * Tokens recently exited, used to block immediate re-entry. Optional so state
   * files written before this existed still load; treated as empty when absent.
   */
  recentExits?: RecentExit[];
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
 * verbatim in several places, and to the dashboard server's routes.
 * Sanitizing every string metadata field here, at deserialization, closes
 * that gap for every consumer regardless of which bot version originally
 * wrote the file.
 */
/**
 * Sanitize one string field on every entry of a restored list.
 *
 * This file explicitly tolerates malformed entries — a persisted null, a
 * stray primitive, anything isRestorablePosition below is built to reject
 * individually. Accessing a field on a non-object entry would throw, and
 * since loadState() doesn't distinguish "one bad entry" from "totally broken
 * file", it would discard every OTHER, valid position too. So a non-object
 * entry passes through untouched for the downstream validator to reject.
 */
function sanitizeField<T>(list: T[], key: keyof T): T[] {
  return list.map((entry) =>
    entry && typeof entry === "object" ? { ...entry, [key]: sanitizeIfString(entry[key]) } : entry
  );
}

function sanitizeRestoredState(state: BotState): BotState {
  return {
    ...state,
    activePositions: sanitizeField(state.activePositions, "tokenSymbol"),
    tradeHistory: sanitizeField(state.tradeHistory, "symbol"),
    // canReenter() builds its block reason from this symbol and index.ts logs
    // it verbatim, so it needs the same treatment. Absent field stays absent.
    recentExits: state.recentExits && sanitizeField(state.recentExits, "tokenSymbol"),
  };
}

function parseStateFile(raw: string): BotState {
  const parsed = JSON.parse(raw) as Partial<BotState>;
  return sanitizeRestoredState({
    activePositions: Array.isArray(parsed.activePositions) ? parsed.activePositions : [],
    tradeHistory: Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [],
    firstTradeValidated: typeof parsed.firstTradeValidated === "boolean" ? parsed.firstTradeValidated : null,
    // Omitting this here silently discarded every re-entry block on restart:
    // saveState() wrote recentExits faithfully, but rebuilding the object
    // without the field meant loadState() always returned undefined, so
    // index.ts fell back to an empty list. A coin that had just rugged became
    // buyable again seconds after a restart — 2026-09-17, Schrodinger: exited
    // at a loss 08:36, blocked correctly until the 08:48 restart, re-bought
    // 08:57, closed -98%.
    recentExits: Array.isArray(parsed.recentExits) ? parsed.recentExits : [],
  });
}

/**
 * Move an unreadable state file aside instead of leaving it to be overwritten.
 *
 * loadState() deliberately fails open so a broken file can't block trading,
 * but on its own that silently DESTROYS the record: the bot starts with an
 * empty state, the first saveState() of the run renames a fresh temp file over
 * the bad one, and any position it held becomes invisible — still on-chain,
 * still real money, but no longer monitored, stop-lossed or exited.
 *
 * Observed 2026-09-22: a hard power-off left the file unreadable, startup
 * logged "Recovered state: 0 active positions, 0 history entries", and a
 * 0.15 SOL position plus 61 history entries were overwritten minutes later.
 *
 * Preserving the bytes keeps that recoverable by hand. Best-effort by design —
 * if the rename itself fails there is nothing further to do but say so, and
 * failing to quarantine must still never block startup.
 */
async function preserveUnreadableState(raw: string | undefined, reason: unknown): Promise<void> {
  const fullPath = path.resolve(CONFIG.stateFilePath);
  const why = reason instanceof Error ? reason.message : String(reason);

  // Copy rather than rename, deliberately. Renaming would leave the original
  // path missing, which turns "state unreadable" into "no state yet" for
  // every OTHER reader. Copying preserves the bytes without rewriting that
  // signal.
  if (raw === undefined) {
    // The read itself failed (permissions, I/O), so there are no bytes to
    // save. Nothing to preserve, but the operator still needs to know.
    logger.error(
      `⚠️  State file at ${fullPath} could not be READ (${why}) and could not be preserved. ` +
        `Starting with EMPTY state — inspect the wallet for open positions now.`
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preservedPath = `${fullPath}.corrupt-${stamp}`;
  try {
    await writeFile(preservedPath, raw, "utf-8");
    logger.error(
      `⚠️  State file at ${fullPath} could not be parsed (${why}). Its contents were preserved ` +
        `as ${preservedPath} and the bot is starting with EMPTY state — any position it held is ` +
        `no longer being monitored. Check the wallet for open positions before trading further.`
    );
  } catch (writeError: unknown) {
    const message = writeError instanceof Error ? writeError.message : String(writeError);
    logger.error(
      `⚠️  State file at ${fullPath} could not be parsed (${why}) AND its contents could not be ` +
        `preserved (${message}). Starting with EMPTY state — inspect the wallet now.`
    );
  }
}

export async function loadState(): Promise<BotState> {
  let raw: string;
  try {
    raw = await readFile(CONFIG.stateFilePath, "utf-8");
  } catch (error: unknown) {
    // A missing file is the ordinary first run — nothing to preserve, nothing
    // to warn about. Anything else means a file exists but cannot be read.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") await preserveUnreadableState(undefined, error);
    return DEFAULT_STATE;
  }

  try {
    return parseStateFile(raw);
  } catch (error: unknown) {
    // Readable but not parseable — the classic post-power-loss shape, where
    // the rename landed but the data blocks never made it to disk.
    await preserveUnreadableState(raw, error);
    return DEFAULT_STATE;
  }
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
    // reader — e.g. the dashboard server, which is a different OS process
    // the writeQueue above can't serialize against —
    // could observe a truncated/partial file. rename() within the same
    // directory is atomic on POSIX and Windows, so a concurrent read always
    // sees either the complete old snapshot or the complete new one, never
    // a torn one. The pid+timestamp suffix is just insurance against two
    // writers (e.g. two bot instances misconfigured to share a state file)
    // colliding on the same temp name.
    const tmpPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      // fsync the temp file before the rename publishes it. rename() is atomic
      // with respect to VISIBILITY, but not DURABILITY: without this, a hard
      // power loss can leave the filesystem having recorded the rename while
      // the file's data blocks were still only in the page cache, so the
      // "atomically replaced" state file comes back zero-length or torn. That
      // is exactly what happened on 2026-09-22 — the bot then read the
      // unreadable file, fell back to empty state, and lost a live position.
      // writeFile() alone cannot express this, so open the handle explicitly.
      const handle = await open(tmpPath, "w");
      try {
        await handle.writeFile(JSON.stringify(state, null, 2), "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
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
