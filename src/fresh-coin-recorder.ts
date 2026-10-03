/**
 * Shadow recorder for brand-new pump.fun coins. Never trades.
 *
 * Entering a coin 30 seconds after creation is only worth a rule if the data
 * says which fresh coins go on to win, so this records them. For a sample of
 * launches (plus every launch by a creator we have traded before) it appends to
 * data/shadow-fresh-coins.jsonl:
 *   launch  the mint, symbol and creator
 *   snap    +30/60/120/300 s: SOL really deposited in the curve, implied market
 *           cap in SOL, whether it graduated (read from the chain)
 *   auth    at +30 s: are the mint and freeze authorities revoked
 *   dex     at +300 s: has DexScreener listed it yet, and with what liquidity
 * A reading that cannot be taken is stored as null, never dropped.
 * `npm run fresh-report` turns the file into a table.
 *
 * Every failure is swallowed: this must never touch trading.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchCurveState } from "./bonding-curve.js";
import { parseMintAuthorities } from "./buy-gate.js";
import { CONFIG } from "./config.js";
import { fetchAccountBytes } from "./dev-reputation.js";
import { knownDevSummary } from "./dev-trade-ledger.js";
import { logger } from "./logger.js";
import { resolveMintsUnfiltered } from "./scanner.js";

export const SNAPSHOT_SECONDS = [30, 60, 120, 300];
const AUTH_AT_SECONDS = SNAPSHOT_SECONDS[0];
const DEX_AT_SECONDS = SNAPSHOT_SECONDS[SNAPSHOT_SECONDS.length - 1];
const MAX_ACTIVE_COINS = 150;

/** Pure: record every launch by a known creator, otherwise one in every `every`. */
export function shouldRecord(launchesSeen: number, every: number, knownCreator: boolean): boolean {
  return knownCreator || launchesSeen % every === 0;
}

export const freshFilePath = (): string => path.join(path.dirname(CONFIG.stateFilePath), "shadow-fresh-coins.jsonl");

let writeChain: Promise<void> = Promise.resolve();
function append(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  writeChain = writeChain
    .then(async () => {
      await mkdir(path.dirname(freshFilePath()), { recursive: true });
      await appendFile(freshFilePath(), line, "utf-8");
    })
    .catch((e) => logger.debug(`fresh recorder write failed: ${e instanceof Error ? e.message : String(e)}`));
}

let launchesSeen = 0;
let activeCoins = 0;
const seenMints = new Set<string>();

export interface FreshLaunch {
  mint: string;
  symbol: string;
  creator: string;
  detectedAt: number;
  source?: string;
}

async function snapshot(mint: string, h: number): Promise<void> {
  try {
    const curve = await fetchCurveState(mint).catch(() => undefined);
    append({
      type: "snap",
      t: Date.now(),
      mint,
      h,
      realSol: curve?.realSol ?? null,
      marketCapSol: curve?.marketCapSol ?? null,
      complete: curve?.complete ?? null,
    });
    if (h === AUTH_AT_SECONDS) {
      const bytes = await fetchAccountBytes(mint, 5000).catch(() => undefined);
      const auth = bytes ? parseMintAuthorities(bytes) : undefined;
      append({
        type: "auth",
        t: Date.now(),
        mint,
        mintAuthorityDisabled: auth?.mintAuthorityDisabled ?? null,
        freezeAuthorityDisabled: auth?.freezeAuthorityDisabled ?? null,
      });
    }
    if (h === DEX_AT_SECONDS) {
      const listed = (await resolveMintsUnfiltered([mint]).catch(() => undefined))?.[0];
      append({
        type: "dex",
        t: Date.now(),
        mint,
        h,
        listed: listed !== undefined,
        liquidityUsd: listed?.liquidityUsd ?? null,
        marketCapUsd: listed?.marketCap ?? null,
      });
    }
  } catch (error) {
    logger.debug(`fresh snapshot ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Hot path: called for every launch the on-chain feed sees. No network, no throwing. */
export function noteFreshLaunch(launch: FreshLaunch): void {
  if (!CONFIG.freshRecorderEnabled || !launch.mint || !launch.creator) return;
  if (launch.source && launch.source !== "pumpfun") return;
  try {
    if (seenMints.has(launch.mint)) return;
    launchesSeen += 1;
    const known = knownDevSummary(launch.creator) !== undefined;
    if (!shouldRecord(launchesSeen, CONFIG.freshRecorderSampleEvery, known)) return;
    if (activeCoins >= MAX_ACTIVE_COINS) return;
    seenMints.add(launch.mint);
    if (seenMints.size > 2000) seenMints.delete(seenMints.values().next().value as string);

    activeCoins += 1;
    append({
      type: "launch",
      t: Date.now(),
      detectedAt: launch.detectedAt,
      mint: launch.mint,
      symbol: launch.symbol,
      creator: launch.creator,
      knownCreator: known,
    });
    SNAPSHOT_SECONDS.forEach((h) => {
      const timer = setTimeout(() => {
        void snapshot(launch.mint, h).finally(() => {
          if (h === DEX_AT_SECONDS) activeCoins -= 1;
        });
      }, Math.max(0, launch.detectedAt + h * 1000 - Date.now()));
      timer.unref?.();
    });
  } catch (error) {
    logger.debug(`fresh launch ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
