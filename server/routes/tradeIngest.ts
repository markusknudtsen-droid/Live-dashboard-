import { Router } from "express";
import { appendReportedTrade, ReportedTrade } from "../reportedTrades.js";

const router = Router();

function asFiniteNumber(value: unknown): number | undefined {
  // Accept only real numbers or numeric strings; reject booleans, null and
  // other types that Number() would silently coerce (e.g. true -> 1).
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * POST /api/trades/ingest — receive a single executed trade pushed by the bot.
 * Authenticated by requireIngestKey (mounted in app.ts). Validates the payload
 * and appends it to the reported-trades store so it appears in GET /api/trades.
 */
router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const type = String(body.type || "").toUpperCase();
  if (type !== "BUY" && type !== "SELL") {
    res.status(400).json({ error: "`type` must be 'BUY' or 'SELL'." });
    return;
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.slice(0, 32) : "";
  if (!symbol) {
    res.status(400).json({ error: "`symbol` is required." });
    return;
  }

  const amountSol = asFiniteNumber(body.amount_sol);
  const price = asFiniteNumber(body.price);
  if (amountSol === undefined || amountSol < 0) {
    res.status(400).json({ error: "`amount_sol` must be a non-negative number." });
    return;
  }
  if (price === undefined || price < 0) {
    res.status(400).json({ error: "`price` must be a non-negative number." });
    return;
  }

  const timestamp = asFiniteNumber(body.timestamp) ?? Date.now();

  const trade: ReportedTrade = {
    type,
    symbol,
    token_address: typeof body.token_address === "string" ? body.token_address.slice(0, 128) : "",
    chain_id: typeof body.chain_id === "string" ? body.chain_id.slice(0, 32) : "solana",
    amount_sol: amountSol,
    price,
    paper: body.paper === undefined ? true : Boolean(body.paper),
    tx_signature: typeof body.tx_signature === "string" ? body.tx_signature.slice(0, 128) : "",
    timestamp,
    confidence: asFiniteNumber(body.confidence),
    pnl_percent: asFiniteNumber(body.pnl_percent),
    reason: typeof body.reason === "string" ? body.reason.slice(0, 48) : undefined,
    received_at: Date.now(),
  };

  try {
    await appendReportedTrade(trade);
    res.status(201).json({ ok: true, stored: { type: trade.type, symbol: trade.symbol, paper: trade.paper } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to store trade: ${message}` });
  }
});

export default router;
