import { Router } from "express";
import { loadState } from "../../src/persistence.js";

const router = Router();

router.get("/", async (req, res) => {
  const state = await loadState();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const sorted = [...state.tradeHistory].sort((a, b) => b.timestamp - a.timestamp);
  const start = (page - 1) * pageSize;
  const items = sorted.slice(start, start + pageSize).map((item, index) => ({
    id: `${item.timestamp}-${start + index}`,
    type: item.action,
    pair: item.symbol,
    amount_sol: undefined,
    price: undefined,
    timestamp: item.timestamp,
    confidence: item.confidence,
    outcome: item.result,
    tx_signature: item.txSignature,
  }));

  res.json({
    items,
    page,
    pageSize,
    total: sorted.length,
    totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)),
  });
});

export default router;
