import { Router } from "express";
import { loadState } from "../../src/persistence.js";
import { loadReportedTrades, ReportedTrade } from "../reportedTrades.js";

const router = Router();

interface TradeLogItem {
  id: string;
  type: string;
  pair: string;
  token_address: string;
  amount_sol: number | undefined;
  entry_price: number | undefined;
  exit_price: number | undefined;
  profit_sol: number;
  paper: boolean | undefined;
  pnl_percent: number | undefined;
  timestamp: number;
  confidence: number | undefined;
  status: "pending" | "completed" | "failed";
  outcome: string;
  tx_signature?: string;
}

function toStatus(outcome: string): "pending" | "completed" | "failed" {
  const normalized = outcome.toUpperCase();
  if (normalized.includes("FAIL")) return "failed";
  if (normalized.includes("PENDING")) return "pending";
  return "completed";
}

function reportedToItem(trade: ReportedTrade, index: number): TradeLogItem {
  const outcome =
    trade.type === "SELL"
      ? `${trade.paper ? "PAPER " : ""}${trade.reason ?? "SELL"}${
          trade.pnl_percent !== undefined ? ` ${trade.pnl_percent >= 0 ? "+" : ""}${trade.pnl_percent.toFixed(2)}%` : ""
        }`
      : `${trade.paper ? "PAPER " : ""}BUY ${trade.amount_sol} SOL${
          trade.confidence !== undefined ? ` @ ${trade.confidence}% conf` : ""
        }`;
  const estimatedProfitSol =
    trade.type === "SELL" && trade.pnl_percent !== undefined ? (trade.amount_sol * trade.pnl_percent) / 100 : 0;

  return {
    id: trade.tx_signature ? `ingest-${trade.tx_signature}` : `ingest-${trade.timestamp}-${index}`,
    type: trade.type,
    pair: trade.symbol,
    token_address: trade.token_address,
    amount_sol: trade.amount_sol,
    entry_price: trade.type === "BUY" ? trade.price : undefined,
    exit_price: trade.type === "SELL" ? trade.price : undefined,
    profit_sol: estimatedProfitSol,
    paper: trade.paper,
    pnl_percent: trade.pnl_percent,
    timestamp: trade.timestamp,
    confidence: trade.confidence,
    status: toStatus(outcome),
    outcome,
    tx_signature: trade.tx_signature || undefined,
  };
}

router.get("/", async (req, res) => {
  const [state, reported] = await Promise.all([loadState(), loadReportedTrades()]);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const fromState: TradeLogItem[] = state.tradeHistory.map((item, index) => ({
    id: `state-${item.timestamp}-${index}`,
    type: item.action,
    pair: item.symbol,
    token_address: "",
    amount_sol: undefined,
    entry_price: undefined,
    exit_price: undefined,
    profit_sol: 0,
    paper: undefined,
    pnl_percent: undefined,
    timestamp: item.timestamp,
    confidence: item.confidence,
    status: toStatus(item.result),
    outcome: item.result,
    tx_signature: item.txSignature,
  }));

  const fromReported: TradeLogItem[] = reported.map(reportedToItem);

  // Merge both sources newest-first, de-duplicating by tx signature (a bot may
  // both persist to state.json and push to the dashboard).
  const seen = new Set<string>();
  const merged: TradeLogItem[] = [];
  for (const item of [...fromReported, ...fromState].sort((a, b) => b.timestamp - a.timestamp)) {
    const key = item.tx_signature || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  const searchQuery = String(req.query.q || "").trim().toLowerCase();
  const filtered = searchQuery
    ? merged.filter((item) => {
        return (
          item.pair.toLowerCase().includes(searchQuery) ||
          item.token_address.toLowerCase().includes(searchQuery) ||
          (item.tx_signature || "").toLowerCase().includes(searchQuery) ||
          item.outcome.toLowerCase().includes(searchQuery)
        );
      })
    : merged;

  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  res.json({
    items,
    page,
    pageSize,
    total: filtered.length,
    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
  });
});

export default router;
