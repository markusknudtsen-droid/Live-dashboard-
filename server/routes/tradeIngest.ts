import { Router } from "express";
import {
  isEntryGate,
  type EntryFeatures,
  type EntryRugCheck,
} from "../../src/entry-features.js";
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

/** Only plain objects — arrays and null would otherwise pass a typeof check. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number {
  return asFiniteNumber(value) ?? 0;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Bonus maps arrive attacker-shaped, so bound both the key count and their length. */
const MAX_BONUS_KEYS = 12;

function sanitiseBonuses(value: unknown): Record<string, number> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw).slice(0, MAX_BONUS_KEYS)) {
    const n = asFiniteNumber(entry);
    if (n !== undefined) out[key.slice(0, 32)] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitiseRugCheck(value: unknown): EntryRugCheck | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  return {
    scoreRaw: num(raw.scoreRaw),
    scoreNormalised: num(raw.scoreNormalised),
    rugged: Boolean(raw.rugged),
    dangerRiskCount: num(raw.dangerRiskCount),
    mintAuthorityDisabled: Boolean(raw.mintAuthorityDisabled),
    freezeAuthorityDisabled: Boolean(raw.freezeAuthorityDisabled),
    hasHolderData: Boolean(raw.hasHolderData),
    totalHolders: num(raw.totalHolders),
    devHoldingPct: num(raw.devHoldingPct),
    insiderHoldingPct: num(raw.insiderHoldingPct),
    bundlerHoldingPct: num(raw.bundlerHoldingPct),
  };
}

/**
 * Validate the entry snapshot off the wire. Unrecognised gates become
 * "unknown" rather than being folded into "ai": mislabelling the path that
 * authorised a buy would quietly corrupt the one grouping this field exists
 * for. Absent or non-object input yields undefined, never a partial record.
 */
function sanitiseFeatures(value: unknown): EntryFeatures | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  return {
    marketCapUsd: num(raw.marketCapUsd),
    liquidityUsd: num(raw.liquidityUsd),
    volume24h: num(raw.volume24h),
    ageHours: num(raw.ageHours),
    buyToSellRatio: num(raw.buyToSellRatio),
    priceChange5m: num(raw.priceChange5m),
    priceChange1h: num(raw.priceChange1h),
    boostAmount: num(raw.boostAmount),
    hasXSocial: Boolean(raw.hasXSocial),
    hasOtherSocial: Boolean(raw.hasOtherSocial),
    hasPaidDexInfo: Boolean(raw.hasPaidDexInfo),

    trendStrength: str(raw.trendStrength, 32),
    momentum: str(raw.momentum, 32),
    riskLevel: str(raw.riskLevel, 32),
    narrative: str(raw.narrative, 64),

    finalConfidence: num(raw.finalConfidence),
    confidenceBeforeModifiers: asFiniteNumber(raw.confidenceBeforeModifiers),
    confidenceBonuses: sanitiseBonuses(raw.confidenceBonuses),

    gate: isEntryGate(raw.gate) ? raw.gate : "unknown",
    source: typeof raw.source === "string" ? raw.source.slice(0, 32) : undefined,
    rugCheck: sanitiseRugCheck(raw.rugCheck),
  };
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
    // Entry snapshots describe a buy decision, so they are only meaningful on
    // BUY rows; dropping them from SELLs keeps the store free of junk a client
    // could otherwise attach to any trade.
    features: type === "BUY" ? sanitiseFeatures(body.features) : undefined,
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
