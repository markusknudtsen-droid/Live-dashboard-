/**
 * Read-only trade analysis from the bot logs. Starts nothing, writes nothing.
 *
 *   npm run analyze-trades                 # every logs/*.log
 *   npm run analyze-trades -- logs/x.log   # chosen files
 *
 * A trade is a SELL with its `PnL:` line, joined to the BUY signal that opened
 * it (confidence and token age at entry) and to the time it was held. Logs do
 * not mark paper vs live, so mixed runs are mixed; filter by passing files.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ClosedTrade {
  symbol: string;
  reason: string;
  pnl: number;
  exitAt: number;
  entryAt?: number;
  confidence?: number;
  ageHours?: number;
}

const LINE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[\w+\] (.*)$/;
const SIGNAL = /^🟢 (.+?): BUY \((\d+)%\)/;
const AGE = /\(?(\d+(?:\.\d+)?)h old\)/;
const BUY = /^🛒 Executing BUY: (.+)$/;
const BUY_FAILED = /^❌ (?:Instant buy|Trade) failed/;
const SELL = /^💸 Executing SELL: (.+) \((\w+)\)$/;
const PNL = /^PnL: ([+-]?\d+(?:\.\d+)?)%/;

/**
 * Pure: closed trades from log lines, oldest first. Failed buys are not entries.
 * A symbol sold again with no buy in between is a phantom-position retry loop
 * (one coin once logged 949 sells), not a trade: it is skipped and counted in
 * `skipped.repeatSells`.
 */
export function parseTrades(lines: string[], skipped = { repeatSells: 0 }): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  const closed = new Set<string>();
  const signal = new Map<string, { confidence: number; ageHours?: number }>();
  const open = new Map<string, { entryAt: number; confidence?: number; ageHours?: number }>();
  let lastBuy: string | undefined;
  let pending: { symbol: string; reason: string; at: number } | undefined;

  for (const raw of lines) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const at = Date.parse(m[1]);
    const text = m[2];

    let s = SIGNAL.exec(text);
    if (s) {
      const age = AGE.exec(text);
      signal.set(s[1], { confidence: Number(s[2]), ageHours: age ? Number(age[1]) : undefined });
      continue;
    }
    s = BUY.exec(text);
    if (s) {
      lastBuy = s[1];
      closed.delete(s[1]);
      // Add-ons keep the original entry.
      if (!open.has(s[1])) open.set(s[1], { entryAt: at, ...signal.get(s[1]) });
      continue;
    }
    if (BUY_FAILED.test(text)) {
      if (lastBuy) open.delete(lastBuy);
      lastBuy = undefined;
      continue;
    }
    s = SELL.exec(text);
    if (s) {
      pending = { symbol: s[1], reason: s[2], at };
      continue;
    }
    s = PNL.exec(text);
    if (s && pending) {
      if (closed.has(pending.symbol)) {
        skipped.repeatSells += 1;
      } else {
        const entry = open.get(pending.symbol);
        trades.push({ symbol: pending.symbol, reason: pending.reason, pnl: Number(s[1]), exitAt: pending.at, ...entry });
        open.delete(pending.symbol);
        closed.add(pending.symbol);
      }
      pending = undefined;
    }
  }
  return trades;
}

/** Pure: one trade per symbol+exit time, so overlapping log files do not double count. */
export function dedupeTrades(trades: ClosedTrade[]): ClosedTrade[] {
  const seen = new Set<string>();
  return trades
    .filter((t) => {
      const key = `${t.symbol}|${t.exitAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.exitAt - b.exitAt);
}

export interface GroupStats {
  group: string;
  n: number;
  winPct: number;
  avgPnl: number;
  medianPnl: number;
  sumPnl: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Pure: stats per group; `key` returns the group name (or undefined for "unknown"). */
export function groupStats(trades: ClosedTrade[], key: (t: ClosedTrade) => string | undefined): GroupStats[] {
  const buckets = new Map<string, number[]>();
  for (const t of trades) {
    const k = key(t) ?? "unknown";
    buckets.set(k, [...(buckets.get(k) ?? []), t.pnl]);
  }
  return [...buckets.entries()]
    .map(([group, pnls]) => ({
      group,
      n: pnls.length,
      winPct: (pnls.filter((p) => p > 0).length / pnls.length) * 100,
      avgPnl: pnls.reduce((a, b) => a + b, 0) / pnls.length,
      medianPnl: median(pnls),
      sumPnl: pnls.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

export const confidenceBucket = (t: ClosedTrade): string | undefined =>
  t.confidence === undefined ? undefined : t.confidence >= 95 ? "95-100" : t.confidence >= 90 ? "90-94" : t.confidence >= 85 ? "85-89" : "<85";

export const ageBucket = (t: ClosedTrade): string | undefined =>
  t.ageHours === undefined ? undefined : t.ageHours < 1 ? "a <1h" : t.ageHours < 6 ? "b 1-6h" : t.ageHours < 24 ? "c 6-24h" : "d >24h";

export const holdBucket = (t: ClosedTrade): string | undefined => {
  if (t.entryAt === undefined) return undefined;
  const min = (t.exitAt - t.entryAt) / 60_000;
  return min < 5 ? "a <5m" : min < 30 ? "b 5-30m" : min < 120 ? "c 30-120m" : "d >2h";
};

const f = (n: number): string => (n >= 0 ? "+" : "") + n.toFixed(1);
function print(title: string, rows: GroupStats[]): void {
  console.log(`\n${title}`);
  console.log("group".padEnd(14) + "n".padStart(5) + "win%".padStart(7) + "avg%".padStart(9) + "median%".padStart(9) + "sum%".padStart(10));
  for (const r of rows)
    console.log(r.group.padEnd(14) + String(r.n).padStart(5) + r.winPct.toFixed(0).padStart(7) + f(r.avgPnl).padStart(9) + f(r.medianPnl).padStart(9) + f(r.sumPnl).padStart(10));
}

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length ? args : readdirSync("logs").filter((n) => n.endsWith(".log")).map((n) => path.join("logs", n));
  const skipped = { repeatSells: 0 };
  const trades = dedupeTrades(files.flatMap((file) => parseTrades(readFileSync(file, "utf-8").split(/\r?\n/), skipped)));
  if (!trades.length) return void console.log("No closed trades found in", files.join(", "));
  console.log(`${trades.length} closed trades from ${files.length} log file(s); ${skipped.repeatSells} repeat-sell retries ignored`);
  print("ALL", groupStats(trades, () => "all"));
  print("BY EXIT REASON", groupStats(trades, (t) => t.reason));
  print("BY CONFIDENCE AT ENTRY", groupStats(trades, confidenceBucket));
  print("BY TOKEN AGE AT ENTRY", groupStats(trades, ageBucket));
  print("BY HOLD TIME", groupStats(trades, holdBucket));
  print("BY DAY", groupStats(trades, (t) => new Date(t.exitAt).toISOString().slice(0, 10)));
  const worst = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
  const best = [...trades].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  console.log("\nWORST: " + worst.map((t) => `${t.symbol} ${f(t.pnl)}% (${t.reason})`).join(", "));
  console.log("BEST:  " + best.map((t) => `${t.symbol} ${f(t.pnl)}% (${t.reason})`).join(", "));
}

if (process.argv[1] && /analyze-trades\.[tj]s$/.test(process.argv[1])) main();
