import { Router } from "express";
import { loadState } from "../../src/persistence.js";
import { loadReportedTrades, ReportedTrade } from "../reportedTrades.js";

const router = Router();

interface TradeLogItem {
  id: string;
  type: string;
  pair: string;
  amount_sol: number | undefined;
  price: number | undefined;
  paper: boolean | undefined;
  pnl_percent: number | undefined;
  timestamp: number;
  confidence: number | undefined;
  outcome: string;
  tx_signature?: string;
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

  return {
    id: trade.tx_signature ? `ingest-${trade.tx_signature}` : `ingest-${trade.timestamp}-${index}`,
    type: trade.type,
    pair: trade.symbol,
    amount_sol: trade.amount_sol,
    price: trade.price,
    paper: trade.paper,
    pnl_percent: trade.pnl_percent,
    timestamp: trade.timestamp,
    confidence: trade.confidence,
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
    amount_sol: undefined,
    price: undefined,
    paper: undefined,
    pnl_percent: undefined,
    timestamp: item.timestamp,
    confidence: item.confidence,
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

  const start = (page - 1) * pageSize;
  const items = merged.slice(start, start + pageSize);

  res.json({
    items,
    page,
    pageSize,
    total: merged.length,
    totalPages: Math.max(1, Math.ceil(merged.length / pageSize)),
  });
});

export default router;
