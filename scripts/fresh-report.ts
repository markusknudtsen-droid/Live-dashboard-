/**
 * Table from data/shadow-fresh-coins.jsonl (see src/fresh-coin-recorder.ts).
 *
 *   npm run fresh-report [-- path/to/shadow-fresh-coins.jsonl]
 *
 * Coins are grouped by how much SOL was really in the curve at +30 s. For each
 * group: how many were read at both +30 s and +5 min, how many at least doubled
 * their implied market cap, how many lost at least half, and how many
 * DexScreener had listed by +5 min.
 */
import { readFileSync } from "node:fs";

export interface FreshCoin {
  mint: string;
  realSol30?: number;
  mcap30?: number;
  mcap300?: number;
  listed300?: boolean;
  mintRevoked?: boolean;
  freezeRevoked?: boolean;
}

export interface FreshGroup {
  group: string;
  coins: number;
  readable: number;
  doubledPct: number | null;
  halvedPct: number | null;
  listedPct: number | null;
  revokedPct: number | null;
}

/** Pure: one record per mint from the JSONL lines; unparsable lines are skipped. */
export function collectFreshCoins(lines: string[]): FreshCoin[] {
  const byMint = new Map<string, FreshCoin>();
  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.mint !== "string") continue;
    if (o.type === "launch" && !byMint.has(o.mint)) byMint.set(o.mint, { mint: o.mint });
    const coin = byMint.get(o.mint);
    if (!coin) continue;
    if (o.type === "snap" && o.h === 30) {
      if (typeof o.realSol === "number") coin.realSol30 = o.realSol;
      if (typeof o.marketCapSol === "number") coin.mcap30 = o.marketCapSol;
    }
    if (o.type === "snap" && o.h === 300 && typeof o.marketCapSol === "number") coin.mcap300 = o.marketCapSol;
    if (o.type === "dex" && typeof o.listed === "boolean") coin.listed300 = o.listed;
    if (o.type === "auth") {
      if (typeof o.mintAuthorityDisabled === "boolean") coin.mintRevoked = o.mintAuthorityDisabled;
      if (typeof o.freezeAuthorityDisabled === "boolean") coin.freezeRevoked = o.freezeAuthorityDisabled;
    }
  }
  return [...byMint.values()];
}

export const solBucket = (c: FreshCoin): string =>
  c.realSol30 === undefined ? "unread" : c.realSol30 < 0.1 ? "a <0.1 SOL" : c.realSol30 < 1 ? "b 0.1-1" : c.realSol30 < 5 ? "c 1-5" : "d >5";

const pct = (n: number, d: number): number | null => (d > 0 ? (n / d) * 100 : null);

/** Pure: per-bucket outcome table, bucket names sorted. */
export function summariseFresh(coins: FreshCoin[]): FreshGroup[] {
  const buckets = new Map<string, FreshCoin[]>();
  for (const c of coins) buckets.set(solBucket(c), [...(buckets.get(solBucket(c)) ?? []), c]);
  return [...buckets.entries()]
    .map(([group, list]) => {
      const readable = list.filter((c) => c.mcap30 !== undefined && c.mcap300 !== undefined && c.mcap30 > 0);
      const ratio = (c: FreshCoin): number => (c.mcap300 as number) / (c.mcap30 as number);
      const withDex = list.filter((c) => c.listed300 !== undefined);
      const withAuth = list.filter((c) => c.mintRevoked !== undefined && c.freezeRevoked !== undefined);
      return {
        group,
        coins: list.length,
        readable: readable.length,
        doubledPct: pct(readable.filter((c) => ratio(c) >= 2).length, readable.length),
        halvedPct: pct(readable.filter((c) => ratio(c) <= 0.5).length, readable.length),
        listedPct: pct(withDex.filter((c) => c.listed300).length, withDex.length),
        revokedPct: pct(withAuth.filter((c) => c.mintRevoked && c.freezeRevoked).length, withAuth.length),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

const f = (n: number | null): string => (n === null ? "-" : n.toFixed(0) + "%");

function main(): void {
  const file = process.argv[2] ?? "data/shadow-fresh-coins.jsonl";
  const coins = collectFreshCoins(readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean));
  console.log(`${coins.length} recorded launches from ${file}`);
  console.log("real SOL @30s".padEnd(16) + "coins".padStart(7) + "readable".padStart(10) + "2x+".padStart(7) + "-50%".padStart(7) + "on dex".padStart(8) + "revoked".padStart(9));
  for (const g of summariseFresh(coins))
    console.log(g.group.padEnd(16) + String(g.coins).padStart(7) + String(g.readable).padStart(10) + f(g.doubledPct).padStart(7) + f(g.halvedPct).padStart(7) + f(g.listedPct).padStart(8) + f(g.revokedPct).padStart(9));
}

if (process.argv[1] && /fresh-report\.[tj]s$/.test(process.argv[1])) main();
