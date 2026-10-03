/**
 * Build or inspect the pump.fun profitable-launch ranking.
 *
 *   npm run dev-ranking            rebuild now (slow: ~2.5 s per request) and print the top list
 *   npm run dev-ranking -- show    print the saved ranking
 *   npm run dev-ranking -- report  compare top-creator launches with the sampled baseline
 *
 * Shadow data only: nothing here trades.
 */
import { readFile } from "node:fs/promises";
import {
  alertsFilePath,
  loadRankingFile,
  rankingFilePath,
  runRankingRefresh,
  summariseOutcomes,
  type RankingFile,
} from "../src/dev-ranking.js";

function printRanking(ranking: RankingFile): void {
  const ageH = ((Date.now() - ranking.builtAt) / 3_600_000).toFixed(1);
  console.log(`\nRanking built ${ageH} h ago, ${ranking.devs.length} creator(s):\n`);
  console.log("rank  graduated  rate   score  last launch   best mcap   wallet");
  ranking.devs.forEach((d, i) => {
    const last = d.lastLaunchAt ? `${((Date.now() - d.lastLaunchAt) / 3_600_000).toFixed(1)} h ago` : "?";
    console.log(
      `${String(i + 1).padStart(4)}  ${`${d.migrated}/${d.launches}`.padStart(9)}  ${`${(d.rate * 100).toFixed(0)}%`.padStart(4)}  ` +
        `${d.score.toFixed(2).padStart(5)}  ${last.padStart(11)}   ${d.bestMarketCapUsd === null ? "?".padStart(9) : `$${Math.round(d.bestMarketCapUsd).toLocaleString()}`.padStart(9)}   ${d.wallet}`
    );
  });
  console.log(`\nSaved at ${rankingFilePath()}`);
}

async function report(): Promise<void> {
  let text = "";
  try {
    text = await readFile(alertsFilePath(), "utf-8");
  } catch {
    console.log(`No alerts file yet (${alertsFilePath()}). Run the bot with ONCHAIN_FEED_ENABLED and DEV_RANKING_ENABLED first.`);
    return;
  }
  const groups = summariseOutcomes(text.split("\n").filter(Boolean));
  if (groups.length === 0) {
    console.log("No finished outcomes yet (they land 1/5/15/60 minutes after each launch).");
    return;
  }
  console.log("\nkind     horizon  tracked  readable  median return  graduated  doubled");
  for (const g of groups) {
    const fmt = (v: number | null, suffix = "%"): string => (v === null ? "n/a" : `${v.toFixed(1)}${suffix}`);
    console.log(
      `${g.kind.padEnd(8)} ${`${g.horizonMin}m`.padStart(6)}  ${String(g.launches).padStart(7)}  ${String(g.readable).padStart(8)}  ` +
        `${fmt(g.medianReturnPct).padStart(13)}  ${fmt(g.graduatedPct).padStart(9)}  ${fmt(g.doubledPct).padStart(7)}`
    );
  }
  console.log("\nA top-creator edge only counts if 'top' beats 'control' with enough launches in both rows.");
}

const mode = process.argv[2] ?? "build";

if (mode === "show") {
  const saved = await loadRankingFile();
  if (saved) printRanking(saved);
  else console.log("No saved ranking yet. Run: npm run dev-ranking");
} else if (mode === "report") {
  await report();
} else {
  console.log("Building from pump.fun's unofficial API. It rate-limits hard, so this is slow and retries with waits (can take 30+ min).");
  console.log("Progress is saved as it goes: if it stops, run it again and it continues where it left off.");
  const result = await runRankingRefresh((m) => console.log(`  ${m}`));
  if (result.aborted) {
    console.log(`\nPump.fun kept refusing. Kept ${result.all.length} creator record(s) gathered so far (${result.looked} new). Run again later to continue.`);
    process.exitCode = 1;
  }
  if (result.all.length > 0) printRanking(result.ranking);
}
